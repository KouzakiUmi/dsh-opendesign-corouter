/**
 * 协议无关的 SSE 分帧。
 *
 * 只负责传输层：把字节流按 SSE 行协议切成 `event:` + 多行 `data:` 帧，并统一强制
 * 取消、空闲超时与大小上限。事件语义（JSON 结构、终止、usage）由各协议模块解释。
 *
 * 边界与既有 Chat Completions 实现一致，便于回归：
 * - CRLF 可能被拆到两个传输块之间，保留尾部 CR。
 * - 单事件累计 `data` 与单行缓冲都不得超过 4 MiB；超限按格式错误拒绝，不截断解析。
 * - 空闲超过 `idleMs` 抛 TIMEOUT；`signal` 中止时抛出 signal 的原因。
 * - 无论成功、异常还是消费方提前 `break`，都会 cancel 并释放上游 reader。
 */

import { LlmError } from '@deepseek-ai/dsh-llm';

/** 一帧 SSE 事件：`event:` 名（可选）+ 合并后的 `data` 载荷。 */
export interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

/** 单行 / 单事件的字符上限（以 UTF-16 码元计，与既有实现保持一致）。 */
const MAX_FRAME_CHARS = 4 * 1024 * 1024;

/**
 * 逐帧产出 SSE 事件。
 *
 * @param body 上游响应体；结束时由本生成器负责 cancel。
 * @param signal 调用方取消信号（已与超时合并）。
 * @param idleMs 两次读到数据之间的最长等待毫秒数。
 */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleMs: number,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let dataSize = 0;
  let name: string | undefined;

  /** 派发当前累积的事件；没有 data 行时不产出（注释、空行）。 */
  function dispatch(): SseFrame[] {
    const payload = data.join('\n');
    const event = name;
    data = [];
    dataSize = 0;
    name = undefined;
    return payload ? [{ ...(event === undefined ? {} : { event }), data: payload }] : [];
  }

  function line(value: string): SseFrame[] {
    if (!value) return dispatch();
    if (value.startsWith(':')) return [];
    if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /u, '');
      dataSize += part.length;
      if (dataSize > MAX_FRAME_CHARS) throw new LlmError('OpenDesign：流式事件超过大小限制', 'INVALID_RESPONSE');
      data.push(part);
      return [];
    }
    if (value.startsWith('event:')) {
      const event = value.slice(6).trim();
      name = event === '' ? undefined : event;
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
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  try {
    while (true) {
      const result = await read();
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      // CRLF 可能被拆到两个传输块之间；保留尾部单个 CR 等待下一块。
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r(?!$)/u.exec(buffer))) {
        const at = match.index;
        const value = buffer.slice(0, at);
        buffer = buffer.slice(at + match[0].length);
        for (const frame of line(value)) yield frame;
      }
      if (buffer.length > MAX_FRAME_CHARS) throw new LlmError('OpenDesign：流式行超过大小限制', 'INVALID_RESPONSE');
      if (result.done) {
        if (buffer) for (const frame of line(buffer.replace(/\r$/u, ''))) yield frame;
        for (const frame of dispatch()) yield frame;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined); // 清理失败不得覆盖原始错误
    reader.releaseLock();
  }
}
