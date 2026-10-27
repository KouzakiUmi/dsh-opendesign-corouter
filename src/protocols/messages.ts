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
 * - 已确认的八个 Claude 模型先校验 Messages 采样默认值与 128000 输出上限；
 *   其余模型的采样限制及 legacy thinking 兼容性由上游按实际模型判定；
 * - 签名与密态仅保存在 adapter-private replay metadata；历史无签名 reasoning 不回放。
 */

import {
  LlmError, ToolCallId,
  type FinishReason, type ReplayEnvelope, type RequestMessage, type StreamChunk, type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { record } from '../util.js';
import { anthropicError, PrematureEndError } from './errors.js';
import { streamHeaders } from './headers.js';
import { inferenceEndpoint } from '../protocol-options.js';
import { protocolAcceptsEffort } from '../reasoning.js';
import { projectContent } from './parts.js';
import { sseFrames } from './sse.js';
import { anthropicUsage } from './usage.js';
import { validateClaudeOutput, validateClaudeSampling } from '../claude-parameters.js';
import type { Protocol, ProtocolContext, ProtocolStreamContext, WireRequest } from './types.js';

/** 未显式给出 `max_tokens` 时的保守默认值（与适配器元数据一致）。 */
export const MESSAGES_DEFAULT_MAX_TOKENS = 4096;
/** Anthropic 要求的版本头；缺省会 400，即使本网关注释里未出现也必须发送。 */
const ANTHROPIC_VERSION = '2023-06-01';
const DATA_URL = /^data:([^;,]+);base64,(.*)$/su;

type ContentPart = Record<string, unknown>;

const REPLAY_FORMAT = 'opendesign.anthropic-messages';
const MAX_REPLAY_CHARS = 8 * 1024 * 1024;
const MAX_BLOCKS = 4096;
type ReplayBlock =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/** The whole alignment is checked before any private block is sent. */
function replayBlocks(message: RequestMessage, ctx: ProtocolContext): readonly ReplayBlock[] | undefined {
  if (message.role !== 'assistant' || message.source.provider !== ctx.options.provider || message.source.model !== ctx.options.model) return;
  const envelope = message.source.replayState;
  if (!record(envelope) || !record(envelope.response) || !Array.isArray(envelope.blocks)) return;
  const response = envelope.response;
  if (response.format !== REPLAY_FORMAT || response.version !== 1 || response.protocol !== 'messages'
    || response.provider !== ctx.options.provider || response.model !== ctx.options.model
    || envelope.blocks.length !== message.content.length) return;
  let size = 0;
  const entries: ReplayBlock[] = [];
  for (const [index, block] of message.content.entries()) {
    const entry: unknown = envelope.blocks[index];
    if (!record(entry)) return;
    if ((entry.type === 'text' || entry.type === 'reasoning') && block.type === entry.type
      && typeof entry.text === 'string' && entry.text === block.text) {
      entries.push({ type: entry.type, text: entry.text }); size += entry.text.length;
    } else if (entry.type === 'tool-call' && block.type === 'tool-call'
      && entry.id === block.id && entry.name === block.name && entry.arguments === block.arguments) {
      entries.push({ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments });
      size += block.id.length + block.name.length + block.arguments.length;
    } else if (entry.type === 'thinking' && block.type === 'reasoning'
      && typeof entry.thinking === 'string' && entry.thinking === block.text
      && typeof entry.signature === 'string' && entry.signature.length > 0) {
      entries.push({ type: 'thinking', thinking: entry.thinking, signature: entry.signature });
      size += entry.thinking.length + entry.signature.length;
    } else if (entry.type === 'redacted_thinking' && block.type === 'reasoning' && block.text === ''
      && typeof entry.data === 'string' && entry.data.length > 0) {
      entries.push({ type: 'redacted_thinking', data: entry.data }); size += entry.data.length;
    } else return;
    if (size > MAX_REPLAY_CHARS || entries.length > MAX_BLOCKS) return;
  }
  if (entries.some(entry => entry.type === 'thinking' || entry.type === 'redacted_thinking')
    && (response.origin !== new URL(ctx.baseURL).origin
      || typeof ctx.credentialIdentity !== 'string' || ctx.credentialIdentity.length === 0
      || response.credentialIdentity !== ctx.credentialIdentity)) {
    throw new LlmError('无法验证历史 Claude 思考数据属于当前凭据。请恢复原凭据及回放绑定记录后重试；若仅使用内存绑定且已重启，请新建会话，或先压缩移除旧思考及其工具续接历史。', 'INVALID_REQUEST');
  }
  return entries;
}

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
  validateClaudeSampling(model.id, options.temperature, ctx.topP);
  const maxTokens = options.maxTokens ?? MESSAGES_DEFAULT_MAX_TOKENS;
  validateClaudeOutput(model.id, maxTokens);
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
        const replay = replayBlocks(message, ctx);
        for (const [index, block] of message.content.entries()) {
          const entry = replay?.[index];
          if (entry?.type === 'thinking') content.push({ type: 'thinking', thinking: entry.thinking, signature: entry.signature });
          else if (entry?.type === 'redacted_thinking') content.push({ type: 'redacted_thinking', data: entry.data });
          else if (block.type === 'text' && block.text !== '') content.push({ type: 'text', text: block.text });
          else if (block.type === 'tool-call') content.push({ type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) });
          else if (block.type === 'image') {
            const placeholder = projectContent([block]).text;
            if (placeholder) content.push({ type: 'text', text: placeholder });
          }
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
  // 已确认 Claude 模型的采样与输出限制已在入口校验，通过后保留调用方参数；
  // 其他模型及 legacy thinking 的兼容性仍由上游判定，不发送 top_k。
  return { url: messagesURL(ctx.baseURL), headers: streamHeaders(ctx.apiKey, { 'anthropic-version': ANTHROPIC_VERSION }), body };
}

interface BlockState {
  /** DSH 块索引；首次产出时分配，保证 block-start 严格按索引递增。 */
  index: number;
  kind: 'text' | 'reasoning' | 'redacted' | 'tool' | 'skip';
  text: string;
  id: string;
  name: string;
  args: string;
  started: boolean;
  ended: boolean;
  signature: string;
  data: string;
  initialInput: string;
  hasArgsDelta: boolean;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 把 Messages 的 SSE 事件翻译成 DSH 流式块。 */
export async function* streamMessages(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleMs: number,
  context?: ProtocolStreamContext,
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
  let replayChars = 0;
  function account(text: string): void {
    replayChars += text.length;
    if (replayChars > MAX_REPLAY_CHARS) throw new LlmError('OpenDesign：响应内容超过大小限制', 'INVALID_RESPONSE');
  }

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

  function close(only?: BlockState): StreamChunk[] {
    const out: StreamChunk[] = [];
    for (const state of blocks.values()) {
      if (!state.started || state.ended || (only !== undefined && state !== only)) continue;
      state.ended = true;
      if (state.kind === 'text') out.push({ type: 'block-end', index: state.index, block: { type: 'text', text: state.text } });
      else if (state.kind === 'reasoning' || state.kind === 'redacted') out.push({ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } });
      else if (state.kind === 'tool') {
        if (!state.id || !state.name) throw new LlmError('OpenDesign：工具调用缺少标识或名称', 'INVALID_RESPONSE');
        const args = state.hasArgsDelta ? state.args : state.initialInput;
        out.push({ type: 'block-end', index: state.index, block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: args } });
      }
    }
    return out.sort((a, b) => ('index' in a ? a.index : 0) - ('index' in b ? b.index : 0));
  }

  function replay(): ReplayEnvelope | undefined {
    if (!context?.credentialIdentity || ![...blocks.values()].some(state => state.signature !== '' || state.kind === 'redacted')) return;
    const entries: ReplayBlock[] = [];
    for (const state of blocks.values()) {
      if (!state.started) continue;
      if (state.kind === 'text') entries.push({ type: 'text', text: state.text });
      else if (state.kind === 'reasoning') entries.push(state.signature
        ? { type: 'thinking', thinking: state.text, signature: state.signature }
        : { type: 'reasoning', text: state.text });
      else if (state.kind === 'redacted') entries.push({ type: 'redacted_thinking', data: state.data });
      else if (state.kind === 'tool') entries.push({ type: 'tool-call', id: state.id, name: state.name, arguments: state.hasArgsDelta ? state.args : state.initialInput });
    }
    return { response: { format: REPLAY_FORMAT, version: 1, protocol: 'messages', provider: context.provider,
      model: context.model, origin: new URL(context.baseURL).origin, credentialIdentity: context.credentialIdentity }, blocks: entries };
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
    signal.throwIfAborted();
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
        if (blocks.has(index) || blocks.size >= MAX_BLOCKS) throw new LlmError('OpenDesign：内容块重复或超过数量限制', 'INVALID_RESPONSE');
        const state: BlockState = { index: -1, kind: 'skip', text: '', id: '', name: '', args: '', started: false,
          ended: false, signature: '', data: '', initialInput: '{}', hasArgsDelta: false };
        if (kind === 'text') state.kind = 'text';
        else if (kind === 'thinking') state.kind = 'reasoning';
        else if (kind === 'redacted_thinking') state.kind = 'redacted';
        else if (kind === 'tool_use') state.kind = 'tool';
        if (state.kind === 'tool') {
          state.id = typeof block.id === 'string' ? block.id : '';
          state.name = typeof block.name === 'string' ? block.name : '';
          sawTool = true;
          if (block.input !== undefined) {
            if (!record(block.input)) throw new LlmError('OpenDesign：工具初始参数不是对象', 'INVALID_RESPONSE');
            state.initialInput = JSON.stringify(block.input);
          }
        }
        if (state.kind === 'text' && typeof block.text === 'string' && block.text !== '') state.text = block.text;
        if (state.kind === 'reasoning' && typeof block.thinking === 'string' && block.thinking !== '') state.text = block.thinking;
        if (state.kind === 'reasoning' && typeof block.signature === 'string') state.signature = block.signature;
        if (state.kind === 'redacted') {
          if (typeof block.data !== 'string' || block.data === '') throw new LlmError('OpenDesign：密态思考块缺少数据', 'INVALID_RESPONSE');
          state.data = block.data;
        }
        account(state.text + state.signature + state.data + state.id + state.name + state.initialInput);
        blocks.set(index, state);
        // 工具块一开始就有 id/name，先发 block-start 与空增量，后续只追加参数分片。
        if (state.kind === 'tool') {
          assign(state);
          state.started = true;
          out.push({ type: 'block-start', index: state.index, blockType: 'tool-call' });
          if (state.id) out.push({ type: 'tool-call-delta', index: state.index, id: ToolCallId(state.id), ...(state.name ? { name: state.name } : {}), argumentsDelta: '' });
        } else if (state.kind === 'text' || state.kind === 'reasoning' || state.kind === 'redacted') {
          // 少数网关把首段内容直接放进 content_block_start，后续没有 delta：
          // 这里立即开块并发出首段增量，避免“有内容却按空响应处理”。
          assign(state);
          state.started = true;
          out.push({ type: 'block-start', index: state.index, blockType: state.kind === 'text' ? 'text' : 'reasoning' });
          if (state.text !== '') out.push(state.kind === 'text'
            ? { type: 'text-delta', index: state.index, text: state.text }
            : { type: 'reasoning-delta', index: state.index, text: state.text });
        }
        break;
      }
      case 'content_block_delta': {
        const state = stateAt(value.index);
        if (state.ended) throw new LlmError('OpenDesign：内容块结束后仍收到分片', 'INVALID_RESPONSE');
        const delta = record(value.delta) ? value.delta : {};
        const deltaType = typeof delta.type === 'string' ? delta.type : '';
        if (deltaType === 'text_delta') {
          if (state.kind !== 'text') throw new LlmError('OpenDesign：文本分片落在非文本块上', 'INVALID_RESPONSE');
          const text = typeof delta.text === 'string' ? delta.text : '';
          if (!text) break;
          assign(state);
          if (!state.started) {
            state.started = true;
            out.push({ type: 'block-start', index: state.index, blockType: 'text' });
          }
          state.text += text;
          account(text);
          out.push({ type: 'text-delta', index: state.index, text });
          break;
        }
        if (deltaType === 'thinking_delta') {
          if (state.kind !== 'reasoning') throw new LlmError('OpenDesign：思考分片落在非思考块上', 'INVALID_RESPONSE');
          const text = typeof delta.thinking === 'string' ? delta.thinking : '';
          if (!text) break;
          assign(state);
          if (!state.started) {
            state.started = true;
            out.push({ type: 'block-start', index: state.index, blockType: 'reasoning' });
          }
          state.text += text;
          account(text);
          out.push({ type: 'reasoning-delta', index: state.index, text });
          break;
        }
        if (deltaType === 'input_json_delta') {
          if (state.kind !== 'tool') throw new LlmError('OpenDesign：工具参数分片落在非工具块上', 'INVALID_RESPONSE');
          const part = typeof delta.partial_json === 'string' ? delta.partial_json : '';
          if (state.initialInput !== '{}') throw new LlmError('OpenDesign：工具参数同时包含初始对象和分片', 'INVALID_RESPONSE');
          state.hasArgsDelta = true;
          state.args += part;
          account(part);
          if (state.id) out.push({ type: 'tool-call-delta', index: state.index, id: ToolCallId(state.id), ...(state.name ? { name: state.name } : {}), argumentsDelta: part });
          break;
        }
        if (deltaType === 'signature_delta') {
          if (state.kind !== 'reasoning' || typeof delta.signature !== 'string') throw new LlmError('OpenDesign：思考签名分片无效', 'INVALID_RESPONSE');
          state.signature += delta.signature;
          account(delta.signature);
        }
        // Citations have no corresponding DSH content type.
        break;
      }
      case 'content_block_stop': {
        const state = stateAt(value.index);
        if (state.ended) throw new LlmError('OpenDesign：内容块重复结束', 'INVALID_RESPONSE');
        out.push(...close(state));
        state.ended = true;
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
        if (reason.kind !== 'max-tokens') for (const state of blocks.values()) {
          if (state.kind === 'tool') toolInput(state.hasArgsDelta ? state.args : state.initialInput);
        }
        if (!count || ![...blocks.values()].some(state => state.kind === 'tool' || state.text !== '' || state.signature !== '' || state.data !== '')) throw new LlmError('OpenDesign：模型返回空响应', 'EMPTY_RESPONSE');
        signal.throwIfAborted();
        usage = anthropicUsage(raw) ?? usage;
        out.push(...close());
        if (usage) out.push({ type: 'usage', usage });
        finish = reason;
        const replayState = replay();
        out.push({ type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) });
        break;
      }
      case 'error':
        throw anthropicError(undefined, value);
      case 'ping':
      default:
        break;
    }

    for (const chunk of out) {
      signal.throwIfAborted();
      yield chunk;
    }
    if (finish) break;
  }

  signal.throwIfAborted();
  if (!finish) throw new PrematureEndError('OpenDesign：响应流提前中断，未收到结束事件');
}

export const messages: Protocol = {
  id: 'messages',
  build: buildMessagesRequest,
  stream: streamMessages,
};
