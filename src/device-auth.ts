// OpenDesign device-authorization protocol. This module is also safe to import in the UI.
// Protocol evidence: opencode-opendesign-auth@0.1.4/index.mjs (third-party, not an
// official compatibility guarantee). No browser automation or credential discovery.
export interface DeviceTokens { controlKey: string; runtimeKey: string }
export const DEVICE_AUTH_ENDPOINT = 'https://amr-api.open-design.ai/api/v1/cli/device-authorizations';
export const DEVICE_AUTH_PLUGIN_VERSION = '0.1.11';
export const DEVICE_REQUEST_TIMEOUT_MS = 20_000;
/** One bounded launch step of the temporary activation window. */
export const DEVICE_OPEN_TIMEOUT_MS = 30_000;
export const DEVICE_RESPONSE_MAX_BYTES = 65_536;
export const DEVICE_POLL_MIN_MS = 1_000;
// Intervals above the local lifetime need no request: waiting reaches the deadline.
// This cap must never shorten a live attempt's server-prescribed polling interval.
export const DEVICE_POLL_MAX_MS = 300_000;

export class DeviceAuthError extends Error {
  constructor(readonly code: string) { super('设备授权未完成，请重新开始'); }
}

/** Strict public-link allowlist: a legacy code or the public deviceId/userCode pair. */
export function validateActivationUrl(value: unknown, userCode?: string, deviceId?: string): string | null {
  if (typeof value !== 'string' || value.length > 512 || !/^https:\/\/open-design\.ai\/cloud\/cli\/activate(?:\?[^#]*)?$/u.test(value) || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://open-design.ai' || url.pathname !== '/cloud/cli/activate' || url.username || url.password || url.hash) return null;
    const entries = [...url.searchParams];
    if (entries.length === 2) {
      // The live authorization endpoint returns this pair. Neither field is the private
      // polling credential; bind both to the response when parsing the Host snapshot.
      if (entries.some(([key]) => key !== 'deviceId' && key !== 'userCode')) return null;
      const id = url.searchParams.get('deviceId');
      const code = url.searchParams.get('userCode');
      if (!validDeviceId(id) || !validUserCode(code) || (deviceId !== undefined && id !== deviceId) || (userCode !== undefined && code !== userCode)) return null;
    } else if (entries.length === 1) {
      const entry = entries[0]!;
      if (!['code', 'user_code'].includes(entry[0]) || !validUserCode(entry[1]) || (userCode !== undefined && entry[1] !== userCode)) return null;
    } else if (entries.length > 2) return null;
    return url.href;
  } catch { return null; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,200}$/iu.test(value);
}
function validUserCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{3,31}$/iu.test(value);
}
function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value);
}

export interface DeviceAuthorization {
  deviceId: string;
  deviceSecret: string;
  userCode: string;
  activationUrl: string;
  pollMs: number;
  expiresAt: number;
}

export function parseDeviceAuthorization(value: unknown): DeviceAuthorization {
  if (!object(value) || !validDeviceId(value.deviceId) || !secret(value.deviceSecret) || !validUserCode(value.userCode)) throw new DeviceAuthError('opendesign/login-response');
  const activationUrl = validateActivationUrl(value.activationUrl, value.userCode, value.deviceId);
  // The server's public fields must never echo the private polling credential.
  if (!activationUrl || value.userCode.toLowerCase().includes(value.deviceSecret.toLowerCase()) || decodeURIComponent(activationUrl).toLowerCase().includes(value.deviceSecret.toLowerCase())) throw new DeviceAuthError('opendesign/login-response');
  const expiresAt = typeof value.expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value.expiresAt) ? Date.parse(value.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || typeof value.pollIntervalSeconds !== 'number' || !Number.isFinite(value.pollIntervalSeconds) || value.pollIntervalSeconds <= 0) throw new DeviceAuthError('opendesign/login-response');
  return {
    deviceId: value.deviceId, deviceSecret: value.deviceSecret, userCode: value.userCode,
    activationUrl, expiresAt,
    pollMs: Math.max(DEVICE_POLL_MIN_MS, Math.min(DEVICE_POLL_MAX_MS, value.pollIntervalSeconds * 1000)),
  };
}

export type DevicePollResult = { state: 'pending' } | { state: 'success'; tokens: DeviceTokens };
export function parseDevicePoll(value: unknown): DevicePollResult {
  if (!object(value)) throw new DeviceAuthError('opendesign/login-response');
  const state = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (['expired', 'cancelled', 'canceled', 'denied', 'rejected', 'failed', 'error'].includes(state)) throw new DeviceAuthError(state === 'expired' ? 'opendesign/login-expired' : 'opendesign/login-denied');
  // A failure envelope with stray keys is contradictory, not an authorized account.
  if (value.error !== undefined && value.error !== null && value.error !== '') throw new DeviceAuthError('opendesign/login-response');
  const user = object(value.user) ? value.user : {};
  // The live service explicitly returns null keys while approval is pending. Only an
  // entirely empty token snapshot may keep waiting; partial/nonempty keys still fail.
  if ((state === 'pending' || state === 'authorization_pending') &&
      [value.controlKey, value.runtimeKey, user.controlKey, user.runtimeKey].every(key => key === undefined || key === null)) return { state: 'pending' };
  // Never assemble a pair from conflicting top-level/user snapshots.
  const topPresent = value.controlKey !== undefined || value.runtimeKey !== undefined;
  const source = topPresent ? value : user;
  if (source.controlKey !== undefined || source.runtimeKey !== undefined) {
    if (!secret(source.controlKey) || !secret(source.runtimeKey)) throw new DeviceAuthError('opendesign/login-incomplete');
    if (topPresent && ((user.controlKey !== undefined && user.controlKey !== source.controlKey) || (user.runtimeKey !== undefined && user.runtimeKey !== source.runtimeKey))) throw new DeviceAuthError('opendesign/login-response');
    return { state: 'success', tokens: { controlKey: source.controlKey, runtimeKey: source.runtimeKey } };
  }
  if (state === 'pending' || state === 'authorization_pending') return { state: 'pending' };
  throw new DeviceAuthError('opendesign/login-response');
}

/** Fixed official origin/path only, including for callers using an injected Host fetcher. */
function validRequestUrl(value: string): boolean {
  return value === DEVICE_AUTH_ENDPOINT || /^https:\/\/amr-api\.open-design\.ai\/api\/v1\/cli\/device-authorizations\/[a-zA-Z0-9_-]{1,200}\/token$/u.test(value);
}

/** Bound fetch *and body consumption*, even if an injected transport ignores abort. */
export async function postDeviceJson(fetcher: typeof fetch, url: string, body: unknown, signal: AbortSignal, timeoutMs = DEVICE_REQUEST_TIMEOUT_MS): Promise<unknown> {
  if (!validRequestUrl(url)) throw new DeviceAuthError('opendesign/login-url');
  signal.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => { controller.abort(); rejectAbort(new DeviceAuthError(timedOut ? 'opendesign/login-request-timeout' : 'opendesign/login-cancelled')); };
  signal.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, Math.min(DEVICE_REQUEST_TIMEOUT_MS, timeoutMs)));
  const read = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
    } catch { throw new DeviceAuthError('opendesign/login-network'); }
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw new DeviceAuthError('opendesign/login-cancelled'); }
    const rejectResponse = (code: string): never => {
      void response.body?.cancel().catch(() => undefined);
      throw new DeviceAuthError(code);
    };
    if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) return rejectResponse('opendesign/login-redirect');
    if (response.status === 401 || response.status === 403) return rejectResponse('opendesign/login-denied');
    if (response.status === 404 || response.status === 410) return rejectResponse('opendesign/login-expired');
    if (!response.ok) return rejectResponse('opendesign/login-network');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > DEVICE_RESPONSE_MAX_BYTES)) return rejectResponse('opendesign/login-response-size');
    if (!response.body) throw new DeviceAuthError('opendesign/login-response');
    const reader = response.body.getReader();
    const stopReading = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', stopReading, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (controller.signal.aborted) throw new DeviceAuthError('opendesign/login-cancelled');
        if (part.done) break;
        length += part.value.byteLength;
        if (length > DEVICE_RESPONSE_MAX_BYTES) { stopReading(); throw new DeviceAuthError('opendesign/login-response-size'); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
      catch { throw new DeviceAuthError('opendesign/login-response'); }
    } finally {
      controller.signal.removeEventListener('abort', stopReading);
      reader.releaseLock();
    }
  };
  try { return await Promise.race([read(), aborted]); }
  catch (error) { if (error instanceof DeviceAuthError) throw error; throw new DeviceAuthError('opendesign/login-network'); }
  finally { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
