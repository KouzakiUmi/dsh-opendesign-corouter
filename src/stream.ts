// Chat Completions projection follows dsh-opendesign-go; see THIRD_PARTY_NOTICES.md.
import { LlmError, ToolCallId, type StreamChunk, type TokenUsage, type FinishReason } from '@deepseek-ai/dsh-llm';
import { record, finite } from './util.js';

export function gatewayError(status: number | undefined, body: unknown): LlmError {
  const error = record(body) && record(body.error) ? body.error : record(body) ? body : {};
  const detail = [error.code, error.type, error.message].filter(x => typeof x === 'string').join(' ').toLowerCase();
  const options = status === undefined ? {} : { status };
  if (/context.{0,30}(exceed|length|window)|too many tokens|max.*context/u.test(detail)) return new LlmError('OpenDesign：请求超过上下文限制', 'CONTEXT_WINDOW_EXCEEDED', options);
  if (/quota|insufficient.{0,20}(credit|balance)|credit.{0,20}exhaust|balance.{0,20}insufficient/u.test(detail)) return new LlmError('OpenDesign：当前计费池额度不足', 'ACCOUNT_QUOTA', options);
  if (status === 401 || status === 403 || /invalid_api_key|missing_api_key/u.test(detail)) return new LlmError('OpenDesign：认证失败，请重新登录或检查凭据', 'INVALID_CREDENTIAL', options);
  if (status === 429) return new LlmError('OpenDesign：请求过于频繁，请稍后重试', 'RATE_LIMIT', options);
  if (status === 408 || status === 504) return new LlmError('OpenDesign：请求超时', 'TIMEOUT', options);
  return new LlmError(`OpenDesign：${status !== undefined && status >= 500 ? '服务暂不可用' : '请求被拒绝'}${status === undefined ? '' : `（HTTP ${status}）`}`, status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST', options);
}

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

/** Bounded SSE framing; a broken/truncated response is never reported as success. */
export async function* consumeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleMs: number): AsyncGenerator<StreamChunk> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', data: string[] = [], dataSize = 0, done = false;
  let nextIndex = 0, count = 0, sawTool = false, text: OpenText | undefined, reasoning: OpenText | undefined;
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
  function event(): StreamChunk[] {
    const payload = data.join('\n'); data = []; dataSize = 0;
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
  function line(value: string): StreamChunk[] {
    if (!value) return event();
    if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /u, ''); dataSize += part.length;
      if (dataSize > 4 * 1024 * 1024) throw new LlmError('OpenDesign：流式事件超过大小限制', 'INVALID_RESPONSE');
      data.push(part);
    }
    return [];
  }
  async function read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LlmError('OpenDesign：流式响应长时间没有数据', 'TIMEOUT')), idleMs);
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  try {
    while (!done) {
      const result = await read();
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      // CRLF may be split between transport chunks; leave a trailing CR buffered.
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r(?!$)/u.exec(buffer))) {
        const at = match.index, value = buffer.slice(0, at);
        buffer = buffer.slice(at + match[0].length);
        for (const chunk of line(value)) yield chunk;
        if (done) break;
      }
      if (buffer.length > 4 * 1024 * 1024) throw new LlmError('OpenDesign：流式行超过大小限制', 'INVALID_RESPONSE');
      if (result.done) {
        if (buffer && !done) for (const chunk of line(buffer.replace(/\r$/u, ''))) yield chunk;
        if (!done) for (const chunk of event()) yield chunk;
        break;
      }
    }
    signal.throwIfAborted();
    if (!finish) throw new LlmError('OpenDesign：响应流提前中断，未收到结束原因', 'INVALID_RESPONSE');
    if (!count) throw new LlmError('OpenDesign：模型返回空响应', 'EMPTY_RESPONSE');
    if (finish.kind === 'tool-calls' && !sawTool) throw new LlmError('OpenDesign：响应声明工具调用，但未返回任何工具块', 'INVALID_RESPONSE');
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: finish };
  } finally {
    await reader.cancel().catch(() => undefined); // cleanup failure must not replace the original provider error
    reader.releaseLock();
  }
}
