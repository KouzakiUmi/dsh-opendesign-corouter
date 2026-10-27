/**
 * Anthropic Messages 协议。
 *
 * 端点：Base URL 可以是网关根（官方 `ANTHROPIC_BASE_URL` 形式）或已带 `/v1` 的推理 Base，
 * 两种都会补成 `<base>/v1/messages`。鉴权沿用 CoRouter 官方 Claude Code 配置里的
 * `Authorization: Bearer`，外加标准 `anthropic-version`；不额外发送第二个密钥头。
 *
 * 不支持项按显式失败处理，不静默丢弃：
 * - 请求无 `max_tokens` 时用保守默认 4096（适配器元数据同步该默认值，用户可按模型覆盖）；
 * - `reasoningEffort` 按现代 Messages 标准投影为 `thinking: {type:'adaptive'}` +
 *   `output_config.effort`；`none` 投影为 `thinking: {type:'disabled'}`；`minimal`/`ultra`
 *   等没有对应 effort 的档位抛 UNSUPPORTED_OPTION；
 * - `temperature`/`top_p` 等采样参数原样透传，其取值限制（只针对特定 Claude 代际）与
 *   「仅接受 enabled + budget_tokens 的 legacy 模型」能否使用，都由上游按实际模型判定，
 *   本模块不做本地推断，而是把上游拒绝分类上报；
 * - 历史 assistant 的 reasoning 块没有 Anthropic 签名，**不回放**（伪造签名会污染上下文），
 *   只把本轮 `thinking_delta` 映射成 reasoning 输出块。
 */

import {
  LlmError, ToolCallId,
  type FinishReason, type StreamChunk, type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { record } from '../util.js';
import { anthropicError } from './errors.js';
import { streamHeaders } from './headers.js';
import { inferenceEndpoint } from '../protocol-options.js';
import { protocolAcceptsEffort } from '../reasoning.js';
import { projectContent } from './parts.js';
import { sseFrames } from './sse.js';
import { anthropicUsage } from './usage.js';
import type { Protocol, ProtocolContext, WireRequest } from './types.js';

/** 未显式给出 `max_tokens` 时的保守默认值（与适配器元数据一致）。 */
export const MESSAGES_DEFAULT_MAX_TOKENS = 4096;
/** Anthropic 要求的版本头；缺省会 400，即使本网关注释里未出现也必须发送。 */
const ANTHROPIC_VERSION = '2023-06-01';
const DATA_URL = /^data:([^;,]+);base64,(.*)$/su;

type ContentPart = Record<string, unknown>;

/** 网关根或 `/v1` Base 都补成 `/v1/messages`。 */
export function messagesURL(baseURL: string): string {
  return inferenceEndpoint(baseURL, 'messages');
}

function imagePart(url: string): ContentPart {
  const match = DATA_URL.exec(url);
  return match?.[1] && match[2]
    ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
    : { type: 'image', source: { type: 'url', url } };
}

/**
 * 历史工具调用参数 → `tool_use.input`。
 *
 * Anthropic 要求对象。空参数按 `{}` 处理（无参数调用的正常形态）；字符串不是合法 JSON 或
 * 解析结果不是对象时**显式失败**——伪造空参数会改变历史调用的含义，比拒绝这一轮更糟。
 */
function toolInput(argumentsText: string): Record<string, unknown> {
  if (argumentsText.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    throw new LlmError('历史工具调用参数不是合法 JSON，无法投影为 Anthropic tool_use.input', 'INVALID_REQUEST');
  }
  if (!record(parsed)) throw new LlmError('历史工具调用参数不是 JSON 对象，无法投影为 Anthropic tool_use.input', 'INVALID_REQUEST');
  return parsed;
}

/** 构造 Messages 请求。 */
export function buildMessagesRequest(ctx: ProtocolContext): WireRequest {
  const { options, model } = ctx;
  const maxTokens = options.maxTokens ?? MESSAGES_DEFAULT_MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new LlmError('maxTokens 必须是正整数', 'INVALID_REQUEST');

  const system: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: ContentPart[] }[] = [];
  const lookup = ctx.images.size ? (ref: { attachmentId: string }) => ctx.images.get(ref.attachmentId) : undefined;
  let results: ContentPart[] = [];
  let lifted: string[] = [];
  const flushResults = (): void => {
    if (results.length) {
      messages.push({ role: 'user', content: results });
      results = [];
    }
  };
  const flushLifted = (): void => {
    flushResults();
    if (lifted.length) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: '(Image content from the preceding tool result.)' }, ...lifted.map(imagePart)],
      });
      lifted = [];
    }
  };

  for (const message of options.messages) {
    // 整段连续 tool 结果先收集，等角色切换时再一次性落盘：这样并行工具结果同属一条 user 消息，
    // 提升的图片也排在这一组之后，不会插进并行结果中间。
    if (message.role !== 'tool') flushLifted();
    const projected = projectContent(message.content, message.role === 'user' || message.role === 'tool' ? lookup : undefined);
    switch (message.role) {
      case 'system':
      case 'developer':
        if (projected.text) system.push(projected.text);
        break;
      case 'user': {
        const content: ContentPart[] = [
          ...(projected.text ? [{ type: 'text', text: projected.text }] : []),
          ...projected.images.map(imagePart),
        ];
        if (content.length) messages.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        const content: ContentPart[] = [];
        if (projected.text) content.push({ type: 'text', text: projected.text });
        for (const block of message.content) {
          if (block.type === 'tool-call') content.push({ type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) });
        }
        if (content.length) messages.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        results.push({
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: projected.text || (projected.images.length ? '(Image content follows in the next user message.)' : ''),
        });
        lifted.push(...projected.images);
        break;
      }
    }
  }
  flushLifted();
  if (options.system?.trim()) system.unshift(options.system);

  const body: Record<string, unknown> = { model: model.id, max_tokens: maxTokens, messages, stream: true };
  if (system.length) body.system = system.join('\n\n');
  if (options.tools?.length) body.tools = options.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (ctx.topP !== undefined) body.top_p = ctx.topP;
  if (options.stop?.length) body.stop_sequences = options.stop;
  if (options.reasoningEffort !== undefined) {
    // 思考控制按现代 Messages 标准投影：`thinking.type.adaptive` + `output_config.effort`。
    const effort = String(options.reasoningEffort);
    if (effort === 'none') body.thinking = { type: 'disabled' };
    else if (protocolAcceptsEffort('messages', effort)) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort };
    } else throw new LlmError(`Anthropic Messages 协议不接受思考深度「${effort}」`, 'UNSUPPORTED_OPTION');
  }
  // 采样参数（temperature / top_p / stop_sequences）一律按调用方给定值透传：官方参数页把这些
  // 取值限制限定在「Claude Opus 4.6 之后」的具体模型上，而 CoRouter 是跨模型网关；
  // 采样兼容性与「仅支持 enabled + budget_tokens 的 legacy 模型」是否可用，一并由上游按实际
  // 模型判定并返回，本模块不在本地推断，也从不发送 top_k。
  return { url: messagesURL(ctx.baseURL), headers: streamHeaders(ctx.apiKey, { 'anthropic-version': ANTHROPIC_VERSION }), body };
}

interface BlockState {
  /** DSH 块索引；首次产出时分配，保证 block-start 严格按索引递增。 */
  index: number;
  kind: 'text' | 'reasoning' | 'tool' | 'skip';
  text: string;
  id: string;
  name: string;
  args: string;
  started: boolean;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 把 Messages 的 SSE 事件翻译成 DSH 流式块。 */
export async function* streamMessages(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleMs: number,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let count = 0;
  let finish: FinishReason | undefined;
  let stopReason: string | undefined;
  let sawTool = false;
  const blocks = new Map<number, BlockState>();
  const raw = { input: undefined as number | undefined, output: undefined as number | undefined,
    cacheRead: undefined as number | undefined, cacheWrite: undefined as number | undefined };
  let usage: TokenUsage | undefined;

  function stateAt(index: unknown): BlockState {
    const state = typeof index === 'number' ? blocks.get(index) : undefined;
    if (!state) throw new LlmError('OpenDesign：流式内容块索引无效', 'INVALID_RESPONSE');
    return state;
  }

  function assign(state: BlockState): void {
    if (state.index < 0) {
      state.index = nextIndex++;
      count++;
    }
  }

  function close(): StreamChunk[] {
    const out: StreamChunk[] = [];
    for (const state of blocks.values()) {
      if (!state.started) continue;
      if (state.kind === 'text') out.push({ type: 'block-end', index: state.index, block: { type: 'text', text: state.text } });
      else if (state.kind === 'reasoning') out.push({ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } });
      else if (state.kind === 'tool') {
        if (!state.id || !state.name) throw new LlmError('OpenDesign：工具调用缺少标识或名称', 'INVALID_RESPONSE');
        out.push({ type: 'block-end', index: state.index, block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.args } });
      }
    }
    return out.sort((a, b) => ('index' in a ? a.index : 0) - ('index' in b ? b.index : 0));
  }

  function reasonFromStop(stop: string | undefined): FinishReason {
    switch (stop) {
      case 'end_turn':
      case 'stop_sequence':
        return { kind: 'stop' };
      case 'max_tokens':
      case 'model_context_window_exceeded':
        // 上下文窗口耗尽同样是截断：保留已产出内容，但绝不当作完整回答。
        return { kind: 'max-tokens' };
      case 'tool_use':
        return { kind: 'tool-calls' };
      case 'refusal':
        throw new LlmError('OpenDesign：模型拒绝回答（refusal）', 'INVALID_RESPONSE');
      case 'pause_turn':
        throw new LlmError('OpenDesign：模型暂停轮次，需重新发起请求', 'INVALID_RESPONSE');
      default:
        throw new LlmError('OpenDesign：模型响应被过滤或异常终止', 'INVALID_RESPONSE');
    }
  }

  for await (const frame of sseFrames(body, signal, idleMs)) {
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      throw new LlmError('OpenDesign：无效的流式 JSON', 'INVALID_RESPONSE');
    }
    if (!record(value)) throw new LlmError('OpenDesign：流式事件不是对象', 'INVALID_RESPONSE');
    const type = typeof value.type === 'string' && value.type !== '' ? value.type : frame.event;
    if (!type) throw new LlmError('OpenDesign：流式事件缺少类型', 'INVALID_RESPONSE');
    const out: StreamChunk[] = [];

    switch (type) {
      case 'message_start': {
        const message = record(value.message) ? value.message : {};
        const counters = record(message.usage) ? message.usage : {};
        raw.input = num(counters.input_tokens) ?? raw.input;
        raw.output = num(counters.output_tokens) ?? raw.output;
        raw.cacheRead = num(counters.cache_read_input_tokens) ?? raw.cacheRead;
        raw.cacheWrite = num(counters.cache_creation_input_tokens) ?? raw.cacheWrite;
        break;
      }
      case 'content_block_start': {
        const index = value.index;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw new LlmError('OpenDesign：流式内容块索引无效', 'INVALID_RESPONSE');
        const block = record(value.content_block) ? value.content_block : {};
        const kind = typeof block.type === 'string' ? block.type : '';
        const state: BlockState = { index: -1, kind: 'skip', text: '', id: '', name: '', args: '', started: false };
        if (kind === 'text') state.kind = 'text';
        else if (kind === 'thinking') state.kind = 'reasoning';
        else if (kind === 'tool_use') state.kind = 'tool';
        if (state.kind === 'tool') {
          state.id = typeof block.id === 'string' ? block.id : '';
          state.name = typeof block.name === 'string' ? block.name : '';
          sawTool = true;
        }
        if (state.kind === 'text' && typeof block.text === 'string' && block.text !== '') state.text = block.text;
        if (state.kind === 'reasoning' && typeof block.thinking === 'string' && block.thinking !== '') state.text = block.thinking;
        blocks.set(index, state);
        // 工具块一开始就有 id/name，先发 block-start 与空增量，后续只追加参数分片。
        if (state.kind === 'tool') {
          assign(state);
          state.started = true;
          out.push({ type: 'block-start', index: state.index, blockType: 'tool-call' });
          if (state.id) out.push({ type: 'tool-call-delta', index: state.index, id: ToolCallId(state.id), ...(state.name ? { name: state.name } : {}), argumentsDelta: '' });
        } else if ((state.kind === 'text' || state.kind === 'reasoning') && state.text !== '') {
          // 少数网关把首段内容直接放进 content_block_start，后续没有 delta：
          // 这里立即开块并发出首段增量，避免“有内容却按空响应处理”。
          assign(state);
          state.started = true;
          out.push({ type: 'block-start', index: state.index, blockType: state.kind === 'text' ? 'text' : 'reasoning' });
          out.push(state.kind === 'text'
            ? { type: 'text-delta', index: state.index, text: state.text }
            : { type: 'reasoning-delta', index: state.index, text: state.text });
        }
        break;
      }
      case 'content_block_delta': {
        const state = stateAt(value.index);
        const delta = record(value.delta) ? value.delta : {};
        const deltaType = typeof delta.type === 'string' ? delta.type : '';
        if (deltaType === 'text_delta') {
          const text = typeof delta.text === 'string' ? delta.text : '';
          if (!text) break;
          assign(state);
          if (!state.started) {
            state.started = true;
            out.push({ type: 'block-start', index: state.index, blockType: 'text' });
          }
          state.text += text;
          out.push({ type: 'text-delta', index: state.index, text });
          break;
        }
        if (deltaType === 'thinking_delta') {
          const text = typeof delta.thinking === 'string' ? delta.thinking : '';
          if (!text) break;
          assign(state);
          if (!state.started) {
            state.started = true;
            out.push({ type: 'block-start', index: state.index, blockType: 'reasoning' });
          }
          state.text += text;
          out.push({ type: 'reasoning-delta', index: state.index, text });
          break;
        }
        if (deltaType === 'input_json_delta') {
          if (state.kind !== 'tool') throw new LlmError('OpenDesign：工具参数分片落在非工具块上', 'INVALID_RESPONSE');
          const part = typeof delta.partial_json === 'string' ? delta.partial_json : '';
          state.args += part;
          if (state.id) out.push({ type: 'tool-call-delta', index: state.index, id: ToolCallId(state.id), ...(state.name ? { name: state.name } : {}), argumentsDelta: part });
          break;
        }
        // signature_delta / citations_delta 不进入 DSH 块：签名不可回放，引用块无对应内容类型。
        break;
      }
      case 'message_delta': {
        const delta = record(value.delta) ? value.delta : {};
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        const counters = record(value.usage) ? value.usage : {};
        raw.output = num(counters.output_tokens) ?? raw.output;
        raw.input = num(counters.input_tokens) ?? raw.input;
        raw.cacheRead = num(counters.cache_read_input_tokens) ?? raw.cacheRead;
        raw.cacheWrite = num(counters.cache_creation_input_tokens) ?? raw.cacheWrite;
        break;
      }
      case 'message_stop': {
        const reason = reasonFromStop(stopReason);
        // 所有有效性检查都必须在 finish 之前：消费者看到 finish 往往立即 return，
        // 放在循环之后的校验永远不会执行，空响应/缺工具块就会被当成成功。
        if (reason.kind === 'tool-calls' && !sawTool) throw new LlmError('OpenDesign：响应声明工具调用，但未返回任何工具块', 'INVALID_RESPONSE');
        if (!count) throw new LlmError('OpenDesign：模型返回空响应', 'EMPTY_RESPONSE');
        usage = anthropicUsage(raw) ?? usage;
        out.push(...close());
        if (usage) out.push({ type: 'usage', usage });
        finish = reason;
        out.push({ type: 'finish', reason });
        break;
      }
      case 'error':
        throw anthropicError(undefined, value);
      case 'ping':
      default:
        break;
    }

    for (const chunk of out) yield chunk;
    if (finish) break;
  }

  signal.throwIfAborted();
  if (!finish) throw new LlmError('OpenDesign：响应流提前中断，未收到结束事件', 'INVALID_RESPONSE');
}

export const messages: Protocol = {
  id: 'messages',
  build: buildMessagesRequest,
  stream: streamMessages,
};
