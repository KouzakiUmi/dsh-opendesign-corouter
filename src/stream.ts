/**
 * Chat Completions 的流式投影与共享错误分类。
 *
 * 分帧已抽到 `protocols/sse.ts`（三种协议共用同一套取消/空闲/大小边界），这里只保留
 * Chat Completions 的事件语义；`gatewayError` 也从 `protocols/errors.ts` 统一提供，
 * 以保持既有 `import { gatewayError } from './stream.js'` 的调用点不变。
 */

import { LlmError, ToolCallId, type StreamChunk, type TokenUsage, type FinishReason } from '@deepseek-ai/dsh-llm';
import { record, finite } from './util.js';
import { gatewayError, PrematureEndError } from './protocols/errors.js';
import { sseFrames } from './protocols/sse.js';

export { gatewayError } from './protocols/errors.js';

/** Chat Completions 的 `usage` 折算（`prompt_tokens` 含缓存，按不相交口径减出）。 */
export function tokenUsage(value: Record<string, unknown>): TokenUsage | undefined {
  const prompt = finite(value.prompt_tokens), output = finite(value.completion_tokens);
  if (prompt === undefined || output === undefined || prompt < 0 || output < 0) return;
  const pd = record(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const cd = record(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const read = finite(pd.cached_tokens) ?? finite(value.prompt_cache_hit_tokens) ?? 0;
  const write = finite(pd.cache_write_tokens) ?? finite(value.prompt_cache_write_tokens) ?? finite(value.cache_creation_input_tokens) ?? 0;
  // Invalid cache counters cannot become negative or invent input usage.
  const validCache = read >= 0 && write >= 0 && read + write <= prompt;
  const reasoning = finite(cd.reasoning_tokens);
  return {
    inputTokens: validCache ? prompt - read - write : prompt,
    outputTokens: output, totalTokens: prompt + output,
    ...(validCache && read > 0 ? { cacheReadTokens: read } : {}),
    ...(validCache && write > 0 ? { cacheWriteTokens: write } : {}),
    ...(reasoning !== undefined && reasoning >= 0 && reasoning <= output ? { reasoningTokens: reasoning } : {}),
  };
}

interface OpenText { index: number; text: string }
interface OpenTool { index: number; id: string; name: string; arguments: string; started: boolean }

/** Bounded SSE projection for Chat Completions; a broken/truncated response is never reported as success. */
export async function* consumeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleMs: number): AsyncGenerator<StreamChunk> {
  let nextIndex = 0, count = 0, sawTool = false, done = false;
  let text: OpenText | undefined, reasoning: OpenText | undefined;
  const tools = new Map<number, OpenTool>();
  let finish: FinishReason | undefined, usage: TokenUsage | undefined;
  function close(): StreamChunk[] {
    const out: StreamChunk[] = [];
    if (text) out.push({ type: 'block-end', index: text.index, block: { type: 'text', text: text.text } });
    if (reasoning) out.push({ type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.text } });
    for (const call of tools.values()) {
      if (!call.id || !call.name) throw new LlmError('OpenDesign：工具调用缺少标识或名称', 'INVALID_RESPONSE');
      out.push({ type: 'block-end', index: call.index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments } });
    }
    text = reasoning = undefined; tools.clear();
    return out.sort((a, b) => ('index' in a ? a.index : 0) - ('index' in b ? b.index : 0));
  }
  function event(payload: string): StreamChunk[] {
    if (!payload) return [];
    if (payload.trim() === '[DONE]') { done = true; return []; }
    let value: unknown;
    try { value = JSON.parse(payload); } catch { throw new LlmError('OpenDesign：无效的流式 JSON', 'INVALID_RESPONSE'); }
    if (!record(value)) throw new LlmError('OpenDesign：流式事件不是对象', 'INVALID_RESPONSE');
    if (record(value.error)) throw gatewayError(undefined, value);
    if (record(value.usage)) usage = tokenUsage(value.usage) ?? usage;
    if (!Array.isArray(value.choices) || !value.choices.length) return [];
    const choice = value.choices[0];
    if (!record(choice)) throw new LlmError('OpenDesign：无效的流式选项', 'INVALID_RESPONSE');
    const delta = record(choice.delta) ? choice.delta : {};
    const out: StreamChunk[] = [];
    const hasDelta = typeof delta.content === 'string' && delta.content !== '' || typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '' || Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
    if (finish && hasDelta) throw new LlmError('OpenDesign：响应结束后仍收到内容', 'INVALID_RESPONSE');
    const thinking = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (thinking) {
      if (!reasoning) { reasoning = { index: nextIndex++, text: '' }; count++; out.push({ type: 'block-start', index: reasoning.index, blockType: 'reasoning' }); }
      reasoning.text += thinking;
      out.push({ type: 'reasoning-delta', index: reasoning.index, text: thinking });
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (!text) { text = { index: nextIndex++, text: '' }; count++; out.push({ type: 'block-start', index: text.index, blockType: 'text' }); }
      text.text += delta.content;
      out.push({ type: 'text-delta', index: text.index, text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) for (const item of delta.tool_calls) {
      if (!record(item) || typeof item.index !== 'number' || !Number.isInteger(item.index) || item.index < 0) throw new LlmError('OpenDesign：无效的工具调用索引', 'INVALID_RESPONSE');
      let call = tools.get(item.index);
      if (!call) { call = { index: nextIndex++, id: '', name: '', arguments: '', started: false }; tools.set(item.index, call); count++; sawTool = true; }
      const fn = record(item.function) ? item.function : {};
      if (typeof item.id === 'string' && item.id) {
        if (call.id && call.id !== item.id) throw new LlmError('OpenDesign：工具调用标识发生变化', 'INVALID_RESPONSE');
        call.id = item.id;
      }
      if (typeof fn.name === 'string' && fn.name) call.name = fn.name; // gateway may repeat the complete name; only arguments are deltas
      if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
      // A few gateways deliver the id after the first argument fragment.
      if (call.id) {
        const first = !call.started;
        if (first) { out.push({ type: 'block-start', index: call.index, blockType: 'tool-call' }); call.started = true; }
        out.push({ type: 'tool-call-delta', index: call.index, id: ToolCallId(call.id), ...(call.name ? { name: call.name } : {}), argumentsDelta: first ? call.arguments : typeof fn.arguments === 'string' ? fn.arguments : '' });
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      if (finish) throw new LlmError('OpenDesign：重复的响应终止事件', 'INVALID_RESPONSE');
      switch (choice.finish_reason) {
        case 'length': finish = { kind: 'max-tokens' }; break;
        case 'tool_calls': case 'function_call': finish = { kind: 'tool-calls' }; break;
        case 'stop': finish = { kind: 'stop' }; break;
        default: throw new LlmError('OpenDesign：模型响应被过滤或异常终止', 'INVALID_RESPONSE');
      }
      out.push(...close());
    }
    return out;
  }

  for await (const frame of sseFrames(body, signal, idleMs)) {
    for (const chunk of event(frame.data)) yield chunk;
    if (done) break;
  }

  signal.throwIfAborted();
  if (!finish) throw new PrematureEndError('OpenDesign：响应流提前中断，未收到结束原因');
  if (!count) throw new LlmError('OpenDesign：模型返回空响应', 'EMPTY_RESPONSE');
  if (finish.kind === 'tool-calls' && !sawTool) throw new LlmError('OpenDesign：响应声明工具调用，但未返回任何工具块', 'INVALID_RESPONSE');
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: finish };
}
