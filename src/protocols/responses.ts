/**
 * OpenAI Responses 协议（无状态：`store: false` + 每次发送完整 `input`）。
 *
 * 为什么坚持无状态：DSH 的请求是会话日志的纯函数，适配器不持久化 `previous_response_id`，
 * 因此重放、重试与并行分支都不会依赖服务端会话；代价是 reasoning 项无法回放——Responses
 * 只在带 `encrypted_content` 时允许跨轮重放推理项，本插件不保存该内容，所以历史推理只映射
 * 为本轮可见的 reasoning 块，再次请求时不会伪装成已签名的上下文。
 *
 * 终止语义（官方 `response.completed` / `response.incomplete` / `response.failed`）：
 * - `completed`：有 `function_call` 项 → tool-calls，否则 stop；
 * - `incomplete`：`max_tokens`/`max_output_tokens` → max-tokens（截断**不**当成功全文），
 *   `content_filter` 与其它原因 → 直接失败，绝不产出 finish；
 * - `failed` 或流内 `error` 事件 → 按固定分类抛错，不回显上游正文。
 */

import {
  LlmError, ToolCallId,
  type FinishReason, type StreamChunk, type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { record } from '../util.js';
import { inBandError } from './errors.js';
import { streamHeaders } from './headers.js';
import { inferenceEndpoint } from '../protocol-options.js';
import { protocolAcceptsEffort } from '../reasoning.js';
import { projectContent, type ImageLookup } from './parts.js';
import { sseFrames } from './sse.js';
import { openAiUsage } from './usage.js';
import type { Protocol, ProtocolContext, WireRequest } from './types.js';

type InputPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' };

function userContent(text: string, images: readonly string[]): string | InputPart[] {
  if (!images.length) return text;
  return [
    ...(text ? [{ type: 'input_text' as const, text }] : []),
    ...images.map(url => ({ type: 'input_image' as const, image_url: url, detail: 'auto' as const })),
  ];
}

/**
 * 构造 Responses 请求。
 *
 * 消息投影：system/developer 文本进 `instructions`（DSH 未声明 in-history 系统提示更新，
 * 完整系统提示每轮都在开头，合并后语义不变）；assistant 文本 + `function_call` 项；
 * tool 结果变 `function_call_output`，其中的图片提升到紧随其后的 user 输入项。
 */
export function buildResponsesRequest(ctx: ProtocolContext): WireRequest {
  const { options, model } = ctx;
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  const lookup: ImageLookup | undefined = ctx.images.size ? ref => ctx.images.get(ref.attachmentId) : undefined;
  let lifted: string[] = [];
  const flushLifted = (): void => {
    if (!lifted.length) return;
    input.push({ role: 'user', content: userContent('(Image content from the preceding tool result.)', lifted) });
    lifted = [];
  };

  for (const message of options.messages) {
    if (message.role !== 'tool') flushLifted();
    const projected = projectContent(message.content, message.role === 'user' || message.role === 'tool' ? lookup : undefined);
    switch (message.role) {
      case 'system':
      case 'developer':
        if (projected.text) instructions.push(projected.text);
        break;
      case 'user':
        if (projected.text || projected.images.length) input.push({ role: 'user', content: userContent(projected.text, projected.images) });
        break;
      case 'assistant': {
        if (projected.text) input.push({ role: 'assistant', content: projected.text });
        for (const block of message.content) {
          if (block.type === 'tool-call') input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments });
        }
        break;
      }
      case 'tool': {
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: projected.text || (projected.images.length ? '(Image content follows in the next user message.)' : ''),
        });
        lifted.push(...projected.images);
        break;
      }
    }
  }
  flushLifted();
  if (options.system?.trim()) instructions.unshift(options.system);

  const body: Record<string, unknown> = { model: model.id, input, stream: true, store: false };
  if (instructions.length) body.instructions = instructions.join('\n\n');
  if (options.tools?.length) body.tools = options.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (ctx.topP !== undefined) body.top_p = ctx.topP;
  if (options.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) throw new LlmError('maxTokens 必须是正整数', 'INVALID_REQUEST');
    body.max_output_tokens = options.maxTokens;
  }
  if (options.reasoningEffort !== undefined) {
    const effort = String(options.reasoningEffort);
    if (!protocolAcceptsEffort('responses', effort)) throw new LlmError(`Responses 协议不接受思考深度「${effort}」`, 'UNSUPPORTED_OPTION');
    // 同时请求摘要，才能把推理映射成 reasoning 块；否则推理不可见。
    body.reasoning = { effort, summary: 'auto' };
  }
  if (options.stop?.length) throw new LlmError('Responses 协议不支持 stop 序列', 'UNSUPPORTED_OPTION');
  return { url: inferenceEndpoint(ctx.baseURL, 'responses'), headers: streamHeaders(ctx.apiKey), body };
}

interface TextState { index: number; text: string; started: boolean }
interface CallState { index: number; id: string; name: string; args: string; started: boolean }

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 从终态 Response 对象里读出 usage（`input_tokens` 含缓存，按 OpenAI 口径折成不相交计数）。 */
function responseUsage(response: Record<string, unknown>): TokenUsage | undefined {
  if (!record(response.usage)) return undefined;
  const usage = response.usage;
  const input = record(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const output = record(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return openAiUsage({
    input: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    output: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
    cacheRead: typeof input.cached_tokens === 'number' ? input.cached_tokens : undefined,
    cacheWrite: typeof input.cache_write_tokens === 'number' ? input.cache_write_tokens : undefined,
    reasoning: typeof output.reasoning_tokens === 'number' ? output.reasoning_tokens : undefined,
  });
}

/**
 * 把 Responses 的 SSE 事件翻译成 DSH 流式块。
 *
 * 支持交错输出项（文本 / 工具调用 / 推理），按首次出现顺序分配块索引；
 * 只出现在终态 `output` 里的项也会补成块，避免“终态才给内容”的网关被误判为空响应。
 */
export async function* streamResponses(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleMs: number,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let count = 0;
  let usage: TokenUsage | undefined;
  let finish: FinishReason | undefined;
  const texts = new Map<string, TextState>();
  const reasonings = new Map<string, TextState>();
  const calls = new Map<string, CallState>();
  const keyByOutput = new Map<number, string>();

  function textState(key: string): TextState {
    let state = texts.get(key);
    if (!state) {
      state = { index: nextIndex++, text: '', started: false };
      texts.set(key, state);
      count++;
    }
    return state;
  }

  function reasoningState(key: string): TextState {
    let state = reasonings.get(key);
    if (!state) {
      state = { index: nextIndex++, text: '', started: false };
      reasonings.set(key, state);
      count++;
    }
    return state;
  }

  function appendText(state: TextState, delta: string, out: StreamChunk[]): void {
    if (!state.started) {
      state.started = true;
      out.push({ type: 'block-start', index: state.index, blockType: 'text' });
    }
    state.text += delta;
    out.push({ type: 'text-delta', index: state.index, text: delta });
  }

  function appendReasoning(state: TextState, delta: string, out: StreamChunk[]): void {
    if (!state.started) {
      state.started = true;
      out.push({ type: 'block-start', index: state.index, blockType: 'reasoning' });
    }
    state.text += delta;
    out.push({ type: 'reasoning-delta', index: state.index, text: delta });
  }

  function callState(key: string, item?: Record<string, unknown>, out?: StreamChunk[]): CallState {
    let call = calls.get(key);
    if (!call) {
      call = { index: nextIndex++, id: '', name: '', args: '', started: false };
      calls.set(key, call);
      count++;
      out?.push({ type: 'block-start', index: call.index, blockType: 'tool-call' });
    }
    if (item) {
      const id = str(item.call_id) ?? str(item.id);
      if (id && !call.id) call.id = id;
      const name = str(item.name);
      if (name) call.name = name;
    }
    return call;
  }

  /** 只在 id 已知时投递工具调用增量；id 迟到时一次性补上已累积参数。 */
  function flushCall(call: CallState, delta: string, out: StreamChunk[]): void {
    if (!call.id) return;
    const name = call.name ? { name: call.name } : {};
    if (!call.started) {
      call.started = true;
      out.push({ type: 'tool-call-delta', index: call.index, id: ToolCallId(call.id), ...name, argumentsDelta: call.args });
      return;
    }
    out.push({ type: 'tool-call-delta', index: call.index, id: ToolCallId(call.id), ...name, argumentsDelta: delta });
  }

  /** 完整项是权威快照；已发增量只能追加，不能回退或改写。 */
  function completeCall(call: CallState, item: Record<string, unknown>, out: StreamChunk[]): void {
    const args = item.arguments;
    let delta = '';
    if (args !== undefined) {
      // 空字符串也是权威值，不能用 str() 当作“字段缺失”跳过矛盾校验。
      if (typeof args !== 'string' || !args.startsWith(call.args)) {
        throw new LlmError('OpenDesign：工具调用完整参数与流式增量不一致', 'INVALID_RESPONSE');
      }
      delta = args.slice(call.args.length);
      call.args = args;
    }
    flushCall(call, delta, out);
  }

  function keyFor(value: Record<string, unknown>, kind: string, outputIndex?: number): string {
    const itemId = str(value.item_id) ?? (outputIndex === undefined ? undefined : keyByOutput.get(outputIndex));
    return `${kind}:${itemId ?? `idx:${outputIndex ?? -1}`}`;
  }

  /** 终态 `output` 补齐已有工具调用，也把仅在终态出现的输出项补成块。 */
  function hydrate(output: unknown, out: StreamChunk[]): void {
    if (!Array.isArray(output)) return;
    for (const item of output) {
      if (!record(item)) continue;
      if (item.type === 'function_call') {
        const itemId = str(item.id) ?? str(item.call_id);
        const callId = str(item.call_id) ?? itemId;
        if (!callId) continue;
        const existing = [...calls].find(([, call]) => call.id === callId);
        const call = callState(existing?.[0] ?? `call:${itemId ?? callId}`, item, out);
        completeCall(call, item, out);
        continue;
      }
      if (item.type === 'message') {
        const key = `text:${str(item.id) ?? 'unknown'}:0`;
        if (texts.has(key)) continue;
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content
          .map(part => record(part) && (part.type === 'output_text' || part.type === 'refusal') ? str(part.text) ?? '' : '')
          .join('');
        if (!text) continue;
        appendText(textState(key), text, out);
        continue;
      }
      if (item.type === 'reasoning') {
        const key = `reasoning:${str(item.id) ?? 'unknown'}:s0`;
        if (reasonings.has(key)) continue;
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const text = summary.map(part => record(part) ? str(part.text) ?? '' : '').join('');
        if (!text) continue;
        appendReasoning(reasoningState(key), text, out);
      }
    }
  }

  function close(): StreamChunk[] {
    const out: StreamChunk[] = [];
    for (const state of texts.values()) if (state.started) out.push({ type: 'block-end', index: state.index, block: { type: 'text', text: state.text } });
    for (const state of reasonings.values()) if (state.started) out.push({ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } });
    for (const call of calls.values()) {
      if (!call.id || !call.name) throw new LlmError('OpenDesign：工具调用缺少标识或名称', 'INVALID_RESPONSE');
      out.push({ type: 'block-end', index: call.index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.args } });
    }
    return out.sort((a, b) => ('index' in a ? a.index : 0) - ('index' in b ? b.index : 0));
  }

  function reasonOf(type: string, response: Record<string, unknown>): FinishReason {
    if (type === 'response.incomplete') {
      const details = record(response.incomplete_details) ? response.incomplete_details : {};
      const why = str(details.reason) ?? '';
      if (why === 'max_tokens' || why === 'max_output_tokens') return { kind: 'max-tokens' };
      if (why === 'content_filter') throw new LlmError('OpenDesign：模型响应被内容过滤', 'INVALID_RESPONSE');
      throw new LlmError('OpenDesign：模型响应未完成，上游中断', 'SERVER');
    }
    const output = Array.isArray(response.output) ? response.output : [];
    return output.some(item => record(item) && item.type === 'function_call') || calls.size > 0
      ? { kind: 'tool-calls' }
      : { kind: 'stop' };
  }

  for await (const frame of sseFrames(body, signal, idleMs)) {
    if (frame.data.trim() === '[DONE]') break; // Responses 不要求该哨兵，容忍网关补齐
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      throw new LlmError('OpenDesign：无效的流式 JSON', 'INVALID_RESPONSE');
    }
    if (!record(value)) throw new LlmError('OpenDesign：流式事件不是对象', 'INVALID_RESPONSE');
    const type = str(value.type) ?? frame.event;
    if (!type) throw new LlmError('OpenDesign：流式事件缺少类型', 'INVALID_RESPONSE');
    const out: StreamChunk[] = [];

    switch (type) {
      case 'response.output_item.added': {
        const outputIndex = int(value.output_index);
        const item = record(value.item) ? value.item : undefined;
        if (item && outputIndex !== undefined) {
          // 事件里的 `item_id` 是输出项自身 id（fc_/msg_/rs_），所以这里也按 item.id 建索引；
          // DSH 的工具调用 id 仍取 `call_id`，两者不混用。
          const itemId = str(item.id) ?? str(item.call_id);
          if (itemId) keyByOutput.set(outputIndex, itemId);
        }
        if (item?.type === 'function_call') callState(keyFor({ item: value.item }, 'call', outputIndex), item, out);
        break;
      }
      case 'response.output_text.delta':
      case 'response.output_text.done': {
        if (type.endsWith('.done')) break; // 增量已完整重建，done 只用于校验
        const delta = str(value.delta);
        if (!delta) break;
        const outputIndex = int(value.output_index);
        const contentIndex = int(value.content_index) ?? 0;
        const itemId = str(value.item_id) ?? (outputIndex === undefined ? undefined : keyByOutput.get(outputIndex));
        appendText(textState(`text:${itemId ?? `idx:${outputIndex ?? -1}`}:${contentIndex}`), delta, out);
        break;
      }
      case 'response.refusal.delta': {
        const delta = str(value.delta);
        if (!delta) break;
        const outputIndex = int(value.output_index);
        const contentIndex = int(value.content_index) ?? 0;
        const itemId = str(value.item_id) ?? (outputIndex === undefined ? undefined : keyByOutput.get(outputIndex));
        appendText(textState(`text:${itemId ?? `idx:${outputIndex ?? -1}`}:${contentIndex}`), delta, out);
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        const delta = str(value.delta);
        if (!delta) break;
        const key = keyFor(value, 'reasoning', int(value.output_index));
        appendReasoning(reasoningState(`${key}:s${int(value.summary_index) ?? 0}`), delta, out);
        break;
      }
      case 'response.reasoning_text.delta': {
        const delta = str(value.delta);
        if (!delta) break;
        const key = keyFor(value, 'reasoning', int(value.output_index));
        appendReasoning(reasoningState(`${key}:t`), delta, out);
        break;
      }
      case 'response.function_call_arguments.delta': {
        const call = callState(keyFor(value, 'call', int(value.output_index)), undefined, out);
        const delta = str(value.delta) ?? '';
        call.args += delta;
        flushCall(call, delta, out);
        break;
      }
      case 'response.output_item.done': {
        const item = record(value.item) ? value.item : undefined;
        if (!item) break;
        const outputIndex = int(value.output_index);
        if (item.type === 'function_call') {
          const call = callState(keyFor(value, 'call', outputIndex), item, out);
          completeCall(call, item, out);
        } else if (item.type === 'message') {
          const key = `text:${str(item.id) ?? `idx:${outputIndex ?? -1}`}:0`;
          if (!texts.has(key)) {
            const content = Array.isArray(item.content) ? item.content : [];
            const text = content.map(part => record(part) && (part.type === 'output_text' || part.type === 'refusal') ? str(part.text) ?? '' : '').join('');
            if (text) appendText(textState(key), text, out);
          }
        } else if (item.type === 'reasoning') {
          const key = `reasoning:${str(item.id) ?? `idx:${outputIndex ?? -1}`}:s0`;
          if (!reasonings.has(key)) {
            const summary = Array.isArray(item.summary) ? item.summary : [];
            const text = summary.map(part => record(part) ? str(part.text) ?? '' : '').join('');
            if (text) appendReasoning(reasoningState(key), text, out);
          }
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const response = record(value.response) ? value.response : {};
        if (type === 'response.failed') throw inBandError(record(response.error) ? response.error : {}, 'SERVER');
        usage = responseUsage(response) ?? usage;
        hydrate(response.output, out);
        const reason = reasonOf(type, response);
        // finish 之前完成全部校验：消费者收到 finish 可能立即 return，之后的检查不会执行。
        if (reason.kind === 'tool-calls' && calls.size === 0) throw new LlmError('OpenDesign：响应声明工具调用，但未返回任何工具块', 'INVALID_RESPONSE');
        if (!count) throw new LlmError('OpenDesign：模型返回空响应', 'EMPTY_RESPONSE');
        out.push(...close());
        if (usage) out.push({ type: 'usage', usage });
        finish = reason;
        out.push({ type: 'finish', reason });
        break;
      }
      case 'error':
        throw inBandError(value);
      default:
        // 其它事件（created/in_progress/content_part.*/annotation.* 等）不影响块语义。
        break;
    }

    for (const chunk of out) yield chunk;
    if (finish) break;
  }

  signal.throwIfAborted();
  if (!finish) throw new LlmError('OpenDesign：响应流提前中断，未收到结束事件', 'INVALID_RESPONSE');
}

export const responses: Protocol = {
  id: 'responses',
  build: buildResponsesRequest,
  stream: streamResponses,
};
