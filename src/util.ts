export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function positive(value: unknown): number | undefined {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
}
export function safeSecret(raw: string): string {
  const value = raw.trim();
  if (!value || /[^\x20-\x7e]/u.test(value)) throw new Error('凭据为空或含有不可用于 HTTP 请求头的字符');
  return value;
}
export function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
