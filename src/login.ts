// Device authorization state machine: bounded polling, cancellation and atomic token commit.
// Approval-window ownership is managed separately by the Host's activation launcher.
import { randomUUID } from 'node:crypto';
import { sleep } from './util.js';
import {
  DEVICE_AUTH_ENDPOINT, DEVICE_AUTH_PLUGIN_VERSION, DeviceAuthError,
  parseDeviceAuthorization, parseDevicePoll, postDeviceJson,
  type DeviceTokens,
} from './device-auth.js';
export type { DeviceTokens } from './device-auth.js';

/** Host operations. No quota verification: the authorization server issues the identity. */
export interface LoginCallbacks {
  capture(expectedRevision: string): unknown | Promise<unknown>;
  /** Re-check signal under the Host's atomic store mutex before accepting the write.
   * Once accepted, resolve: success is the linearization point, even after cancellation. */
  commit(tokens: DeviceTokens, captured: unknown, signal: AbortSignal): Promise<unknown>;
}
export type LoginPhase = 'idle' | 'launching' | 'waiting' | 'verifying' | 'success' | 'cancelled' | 'error';
export interface LoginStatus {
  jobId: string | null;
  state: LoginPhase;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  errorCode?: string;
  activationUrl?: string;
  userCode?: string;
  expiresAt?: string;
}
export interface LoginStartRequest { expectedRevision: string }
export interface LoginJobRequest { jobId: string }
export interface LoginOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** May shorten, but cannot extend, the local five-minute maximum. */
  timeoutMs?: number;
  /**
   * Called once whenever an approval job leaves `waiting` — success, cancel, expiry or
   * failure — including on a timer with nobody polling. Resource cleanup lives here
   * instead of in a status getter, whose side effect depends on someone reading it.
   */
  onSettled?: () => void;
}
export class LoginError extends Error {
  constructor(readonly code: 'opendesign/login-state' | 'opendesign/login-disposed' | 'opendesign/login-capture') {
    super(code === 'opendesign/login-disposed' ? '登录服务已卸载' : '登录任务不存在或状态已改变');
  }
}
const ACTIVE = new Set<LoginPhase>(['launching', 'waiting', 'verifying']);
const MAX_TIMEOUT_MS = 300_000;
const SAFE_HOST_CODES = new Set(['opendesign/revision-conflict', 'opendesign/invalid-request', 'opendesign/config', 'opendesign/login-disposed']);
interface Job {
  id: string;
  status: LoginStatus;
  controller: AbortController;
  deadline: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  captured: unknown;
  committing: boolean;
  cancelRequested: boolean;
  settled: boolean;
  cancellationMessage?: string;
}

export class ConsoleLogin {
  private job: Job | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly fetcher: typeof fetch;
  constructor(private readonly callbacks: LoginCallbacks, private readonly options: LoginOptions = {}) {
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? sleep;
    this.fetcher = options.fetcher ?? fetch;
  }
  /** Explicit public allowlist. Codes are never available after waiting or expiry. */
  status(): LoginStatus {
    if (!this.job) return { jobId: null, state: 'idle' };
    const job = this.job;
    if (job.status.state === 'waiting' && this.now() >= job.deadline) this.expire(job);
    const s = job.status;
    return {
      jobId: s.jobId, state: s.state,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
      ...(s.message ? { message: s.message } : {}),
      ...(s.errorCode ? { errorCode: s.errorCode } : {}),
      ...(s.state === 'waiting' && this.now() < job.deadline ? {
        ...(s.activationUrl ? { activationUrl: s.activationUrl } : {}),
        ...(s.userCode ? { userCode: s.userCode } : {}),
        ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
      } : {}),
    };
  }
  /** Host-only: the live approval link, so the Host can open it in a bounded window. */
  activationLink(): string | undefined {
    const status = this.status();
    return status.state === 'waiting' ? status.activationUrl : undefined;
  }
  /** Synchronous/non-blocking and idempotent while capture/network/commit is pending. */
  start(request: LoginStartRequest): LoginStatus {
    if (this.disposed) throw new LoginError('opendesign/login-disposed');
    this.status();
    if (this.job && ACTIVE.has(this.job.status.state)) return this.status();
    const started = this.now();
    const requested = this.options.timeoutMs;
    const timeoutMs = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(MAX_TIMEOUT_MS, requested) : MAX_TIMEOUT_MS;
    const job: Job = {
      id: randomUUID(), controller: new AbortController(), deadline: started + timeoutMs,
      status: { jobId: null, state: 'launching', startedAt: new Date(started).toISOString(), message: '正在申请官方设备授权码' },
      captured: undefined, committing: false, cancelRequested: false, settled: false,
    };
    job.status.jobId = job.id;
    this.job = job;
    this.armExpiry(job);
    void Promise.resolve().then(async () => {
      if (!this.alive(job)) return;
      try { job.captured = await this.callbacks.capture(request.expectedRevision); }
      catch (error) {
        if (this.alive(job)) this.finish(job, 'error', '无法捕获当前设置状态，请重新读取后重试', hostCode(error) ?? 'opendesign/login-capture');
        return;
      }
      if (this.alive(job)) await this.run(job);
    }).catch(error => {
      if (this.alive(job)) this.finish(job, 'error', failureMessage(error), error instanceof DeviceAuthError ? error.code : 'opendesign/login-network');
    });
    return this.status();
  }
  cancel(request: LoginJobRequest): LoginStatus {
    if (this.job?.id === request.jobId) this.requestCancellation(this.job, '登录已取消，未保存授权');
    return this.status();
  }
  dispose(): void {
    this.disposed = true;
    const job = this.job;
    if (job) { this.requestCancellation(job, '服务已卸载，登录已取消'); this.settle(job); }
  }
  private alive(job: Job): boolean {
    return this.job === job && !this.disposed && !job.controller.signal.aborted && ACTIVE.has(job.status.state);
  }
  private stopTimer(job: Job): void {
    if (job.timer !== undefined) { clearTimeout(job.timer); job.timer = undefined; }
  }
  private armExpiry(job: Job): void {
    this.stopTimer(job);
    job.timer = setTimeout(() => this.expire(job), Math.max(1, job.deadline - this.now()));
    job.timer.unref?.();
  }
  private clearCode(job: Job): void {
    delete job.status.activationUrl;
    delete job.status.userCode;
    delete job.status.expiresAt;
  }
  private expire(job: Job): void {
    if (job.committing) this.requestCancellation(job, '授权已过期，未保存授权');
    else this.finish(job, 'error', '设备授权已过期，请重新开始', 'opendesign/login-expired');
  }
  private requestCancellation(job: Job, message: string): void {
    if (this.job !== job || !ACTIVE.has(job.status.state)) return;
    this.clearCode(job);
    if (!job.committing) { this.finish(job, 'cancelled', message); return; }
    if (!job.cancelRequested) {
      job.cancellationMessage = message;
      job.status.message = '正在确认授权保存结果';
    }
    job.cancelRequested = true;
    this.stopTimer(job);
    job.controller.abort();
  }
  private finish(job: Job, state: 'success' | 'cancelled' | 'error', message: string, errorCode?: string): void {
    if (this.job !== job || !ACTIVE.has(job.status.state)) return;
    job.status.state = state;
    job.status.finishedAt = new Date(this.now()).toISOString();
    job.status.message = message;
    if (errorCode) job.status.errorCode = errorCode;
    this.clearCode(job);
    this.stopTimer(job);
    job.controller.abort();
    this.settle(job);
  }
  /** Report one terminal transition per job, exactly once. */
  private settle(job: Job): void {
    if (job.settled) return;
    job.settled = true;
    try { this.options.onSettled?.(); }
    catch { /* A cleanup callback cannot change the job's recorded outcome. */ }
  }
  private async run(job: Job): Promise<void> {
    const signal = job.controller.signal;
    const raw = await postDeviceJson(this.fetcher, DEVICE_AUTH_ENDPOINT, {
      // The third-party protocol's official-CLI version is NOT our version. Compatibility
      // of this actual plugin version requires a real-account check outside offline tests.
      cliVersion: DEVICE_AUTH_PLUGIN_VERSION, host: 'DSH CoRouter', profile: 'prod',
    }, signal, job.deadline - this.now());
    if (!this.alive(job)) return;
    const device = parseDeviceAuthorization(raw);
    job.deadline = Math.min(job.deadline, device.expiresAt);
    if (this.now() >= job.deadline) { this.expire(job); return; }
    this.armExpiry(job);
    job.status.state = 'waiting';
    job.status.message = '请在授权窗口或常用浏览器打开官方授权页，登录并确认设备码';
    job.status.activationUrl = device.activationUrl;
    job.status.userCode = device.userCode;
    job.status.expiresAt = new Date(job.deadline).toISOString();
    while (this.alive(job)) {
      await this.delay(Math.min(device.pollMs, Math.max(1, job.deadline - this.now())), signal);
      if (!this.alive(job)) return;
      if (this.now() >= job.deadline) { this.expire(job); return; }
      const result = parseDevicePoll(await postDeviceJson(this.fetcher,
        `${DEVICE_AUTH_ENDPOINT}/${device.deviceId}/token`, { deviceSecret: device.deviceSecret }, signal, job.deadline - this.now()));
      if (!this.alive(job)) return;
      if (this.now() >= job.deadline) { this.expire(job); return; }
      if (result.state === 'success') { await this.commit(job, result.tokens); return; }
    }
  }
  private async commit(job: Job, tokens: DeviceTokens): Promise<void> {
    if (!this.alive(job) || job.committing) return;
    job.committing = true;
    this.clearCode(job);
    job.status.state = 'verifying';
    job.status.message = '官方授权已完成，正在保存授权';
    try {
      await this.callbacks.commit(tokens, job.captured, job.controller.signal);
      job.committing = false;
      // A resolved atomic store accepted the credentials. Never lie about a winning write,
      // including when cancel/dispose/expiry arrived before its promise resolved.
      this.finish(job, 'success', '设备授权已完成并保存；额度状态另行显示');
    } catch (error) {
      job.committing = false;
      if (job.cancelRequested || job.controller.signal.aborted) this.finish(job, 'cancelled', job.cancellationMessage ?? '登录已取消，未保存授权');
      else this.finish(job, 'error', hostCode(error) ? '设置已改变或无法保存，请重新读取后重试' : '授权保存失败，请重新开始', hostCode(error) ?? 'opendesign/login-commit');
    }
  }
}
function hostCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && SAFE_HOST_CODES.has(error.code)) return error.code;
  return undefined;
}
function failureMessage(error: unknown): string {
  const code = error instanceof DeviceAuthError ? error.code : '';
  if (code === 'opendesign/login-expired') return '设备授权已过期，请重新开始';
  if (code === 'opendesign/login-denied') return '设备授权被拒绝，请重新开始';
  if (code === 'opendesign/login-request-timeout') return '设备授权请求超时，请重新开始';
  return '设备授权请求失败，请重新开始';
}
