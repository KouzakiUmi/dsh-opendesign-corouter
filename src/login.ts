// OpenDesign CoRouter — independent console login.
//
// Browser-lifecycle skeleton adapted from `dsh-subusage` 0.16.2 `lib/cookie-login.js` (MIT,
// Copyright (c) 2026 KouzakiUmi). Flow and state machine are the same as that module: the
// button that starts the login says "登录并保存会话", so a successful verification commits
// without a second confirmation step.
//
// Guarantees this module owns:
//   - no credential ever appears in `status()` output;
//   - nothing is written while the attempt is in `launching`/`waiting`;
//   - `commit` is called at most once per attempt, and never after a terminal state;
//   - `commit` **success is the linearization point**: once the Host's atomic store has
//     accepted the write, a cancel that arrived earlier cannot retract it, and the attempt
//     reports `success`. A cancel that arrives before the store accepts the write aborts the
//     signal the store re-checks, and the attempt reports `cancelled`;
//   - the browser is closed on every terminal path.
import { randomUUID } from 'node:crypto';
import { sleep } from './util.js';

/** Console origin and dashboard entry the official desktop uses. */
export const CONSOLE_ORIGIN = 'https://open-design.ai';
export const CONSOLE_DASHBOARD_URL = `${CONSOLE_ORIGIN}/cloud/dashboard`;
/** The API host whose cookies matter; `context.cookies()` uses it to pick the right ones. */
export const API_COOKIE_URL = 'https://amr-api.open-design.ai/api/v1/workspaces/current';

export interface RawCookie { name?: string; value?: string; expires?: number }

/** One usable console session: the exact `Cookie` header a browser would send. */
export interface ExtractedCookie { cookie: string; expiresAt: number }

/**
 * Pick the session cookies by **URL scope**, never by name. The real cookie is
 * better-auth's `__Secure-better-auth.session_token` today, but it can be renamed at any
 * time and no third party can enumerate the alternatives; joining every unexpired cookie
 * that applies to the API URL reproduces exactly what the browser itself sends. Before
 * login completes this may also collect non-auth cookies (`od_attr`, `__cf_bm`), which is
 * harmless: such a bundle fails `verify` and is therefore never saved.
 */
export function extractConsoleSession(cookies: readonly RawCookie[], now = Date.now()): ExtractedCookie | null {
  const usable = cookies.filter(c =>
    typeof c.name === 'string' && c.name.length > 0 &&
    typeof c.value === 'string' && c.value.length > 0 &&
    (c.expires === undefined || c.expires === -1 || c.expires * 1000 > now));
  if (!usable.length) return null;
  const declared = usable
    .map(c => c.expires)
    .filter((expires): expires is number => typeof expires === 'number' && Number.isFinite(expires) && expires > 0);
  return {
    cookie: usable.map(c => `${c.name}=${c.value}`).join('; '),
    expiresAt: declared.length ? Math.min(...declared) * 1000 : 0,
  };
}

export interface LoginSite {
  origin: string;
  loginUrl: string;
  cookieUrls: readonly string[];
  extract(cookies: readonly RawCookie[], now: number): ExtractedCookie | null;
}

/** Site parameters, overridable so a rebrand (for example a new console origin) needs no code fork. */
export function consoleSite(overrides: { origin?: string; loginUrl?: string; cookieUrls?: readonly string[] } = {}): LoginSite {
  const origin = overrides.origin ?? CONSOLE_ORIGIN;
  return {
    origin,
    loginUrl: overrides.loginUrl ?? (origin === CONSOLE_ORIGIN ? CONSOLE_DASHBOARD_URL : `${origin}/cloud/dashboard`),
    cookieUrls: overrides.cookieUrls ?? [API_COOKIE_URL],
    extract: extractConsoleSession,
  };
}

export interface VerifyResult {
  /** Whether the account was read at all; a read-but-quota-unknown result still verifies. */
  balanceOk: boolean;
  /** Set when the quota endpoint failed; the cookie itself is still valid, so the host may still save it. */
  usageError?: { code: string } | undefined;
  /**
   * Caller-supplied context, echoed nowhere and used only for the success message. The Host
   * re-reads the real quota after commit, so these are never trusted as state.
   */
  coverage?: string | undefined;
  windows?: readonly unknown[] | undefined;
}

/** Host-supplied operations. No Host type is imported: the caller wires these. */
export interface LoginCallbacks {
  /** Snapshot the state a commit must not overwrite, keyed by the revision the caller saw. */
  capture(expectedRevision: string): unknown | Promise<unknown>;
  /** Prove the cookie works. Any throw means "not usable yet"; abort is a cancel. */
  verify(cookie: string, signal: AbortSignal): Promise<VerifyResult>;
  /**
   * Persist the verified cookie. The Host's store must run its write inside a mutex and call
   * `signal.throwIfAborted()` there, so a cancel that landed before the mutex was acquired
   * wins, and one that lands afterwards does not.
   *
   * `expiresAt` is the cookie bundle's earliest declared expiry in epoch ms, or `0` when the
   * console declared none (a session cookie). It is passed through so the Host can store it and
   * let `resolveSession` expire a stale grant proactively instead of waiting for a 401.
   */
  commit(cookie: string, captured: unknown, signal: AbortSignal, expiresAt: number): Promise<unknown>;
}

/**
 * Attempt phases, matching the shared wire contract (`LoginPhase` in `remote.ts`) exactly;
 * `success`/`cancelled`/`error` are terminal. The Host maps `status()` onto the wire type.
 */
export type LoginPhase = 'idle' | 'launching' | 'waiting' | 'verifying' | 'success' | 'cancelled' | 'error';

export interface LoginStatus {
  jobId: string | null;
  state: LoginPhase;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  errorCode?: string;
  /** The page could not be opened; the UI may offer the URL instead. */
  browserOpenFailed?: boolean;
}

export interface LoginStartRequest { expectedRevision: string }
export interface LoginJobRequest { jobId: string }

/** Minimal structural browser surface, so tests need no Playwright and Host wiring stays loose. */
export interface BrowserLike {
  on?(event: 'disconnected', listener: () => void): void;
  newContext(): Promise<ContextLike>;
  close(): Promise<void>;
}
export interface ContextLike {
  newPage(): Promise<PageLike>;
  cookies(urls: readonly string[]): Promise<readonly RawCookie[]>;
}
export interface PageLike {
  on?(event: 'close', listener: () => void): void;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
}

export type Launcher = (signal: AbortSignal) => Promise<BrowserLike | null>;

export interface LoginOptions {
  site?: LoginSite;
  /** Total life of one login attempt. Default five minutes. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Injected browser launcher; the default uses `playwright-core` and a real Chrome window. */
  launch?: Launcher;
  /** Injected sleep, for tests. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class LoginError extends Error {
  constructor(readonly code: 'opendesign/login-state' | 'opendesign/login-disposed' | 'opendesign/login-capture') {
    super(code === 'opendesign/login-state' ? '登录任务不存在或状态已改变' : code === 'opendesign/login-disposed' ? '登录服务已卸载' : '无法捕获当前设置状态，登录已取消');
  }
}

const ACTIVE = new Set<LoginPhase>(['launching', 'waiting', 'verifying']);
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 1_000;
/** Codes that mean "the environment changed under us": retrying would only repeat the failure. */
const FATAL_COMMIT_CODES = new Set(['opendesign/revision-conflict', 'opendesign/invalid-request', 'opendesign/config', 'opendesign/login-disposed']);

/**
 * Chrome flags that let a *human* pass the console's bot check. The console looks at
 * `navigator.webdriver` when its Cloudflare challenge is submitted; `headless: false` alone
 * leaves it `true`, and this blink switch is what the official Playwright browser tool
 * appends for chromium. This is not a challenge bypass — the user still solves it — it only
 * avoids announcing automation before they can act. `ignoreDefaultArgs` is a no-op on
 * 1.63.0 and stays for forward compatibility.
 */
export const CHROME_LAUNCH_OPTIONS = {
  channel: 'chrome',
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
} as const;

interface Job {
  readonly id: string;
  readonly startedAt: string;
  readonly controller: AbortController;
  readonly expectedRevision: string;
  readonly status: LoginStatus;
  timer?: NodeJS.Timeout | undefined;
  browser?: BrowserLike | undefined;
  /** In memory only; never copied into `status`. */
  secret?: ExtractedCookie | undefined;
  captured: unknown;
  capturedAt?: Promise<unknown> | undefined;
  verifying: boolean;
  committing: boolean;
  /** A cancel arrived while `commit` was in flight: only the store's own abort check decides. */
  cancelRequested: boolean;
}

export class ConsoleLogin {
  private job: Job | null = null;
  private disposed = false;
  private readonly callbacks: LoginCallbacks;
  private readonly options: LoginOptions;
  private readonly now: () => number;
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(callbacks: LoginCallbacks, options: LoginOptions = {}) {
    this.callbacks = callbacks;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? sleep;
  }

  /** Idempotent, credential-free view of the current attempt. */
  status(): LoginStatus {
    if (!this.job) return { jobId: null, state: 'idle' };
    // Explicit allowlist: an added field cannot start leaking a secret by accident.
    const s = this.job.status;
    return {
      jobId: s.jobId,
      state: s.state,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
      ...(s.message ? { message: s.message } : {}),
      ...(s.errorCode ? { errorCode: s.errorCode } : {}),
      ...(s.browserOpenFailed ? { browserOpenFailed: true } : {}),
    };
  }

  /**
   * Queue one attempt and return immediately: the RPC that starts a login must not wait on a
   * browser window or on a human. Re-entrant calls while an attempt is live return that
   * attempt's status instead of opening a second browser.
   */
  start(request: LoginStartRequest): LoginStatus {
    if (this.disposed) throw new LoginError('opendesign/login-disposed');
    if (this.job && ACTIVE.has(this.job.status.state)) return this.status();
    const job: Job = {
      id: randomUUID(),
      startedAt: new Date(this.now()).toISOString(),
      controller: new AbortController(),
      expectedRevision: request.expectedRevision,
      status: { jobId: '', state: 'launching', message: '正在打开临时 Chrome 登录窗口' },
      captured: undefined,
      capturedAt: undefined,
      verifying: false,
      committing: false,
      cancelRequested: false,
    };
    job.status.jobId = job.id;
    job.status.startedAt = job.startedAt;
    this.job = job;
    job.timer = setTimeout(() => this.finish(job, 'cancelled', '登录已超过五分钟，请重新开始'), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    job.timer.unref?.();
    // The capture runs before the browser opens, so a revision conflict is discovered while
    // nothing is on screen yet.
    job.capturedAt = Promise.resolve()
      .then(() => this.callbacks.capture(job.expectedRevision))
      .then(captured => { job.captured = captured; return captured; });
    void job.capturedAt
      .then(() => this.run(job))
      .catch(error => { if (this.alive(job)) this.finish(job, 'error', '登录无法开始，请重试', errorCode(error) ?? 'opendesign/login-capture'); });
    return this.status();
  }

  /**
   * Abandon the attempt. While `commit` is in flight this only aborts the signal and records
   * the request: the Host's atomic store decides, because the commit is the linearization
   * point. A cancel that wins that race reports `cancelled`; one that loses reports `success`
   * and the cookie really is stored.
   */
  cancel(request: LoginJobRequest): LoginStatus {
    const job = this.job;
    if (!job || job.status.jobId !== request.jobId) return this.status();
    if (job.committing) {
      job.cancelRequested = true;
      job.controller.abort();
      return this.status();
    }
    if (ACTIVE.has(job.status.state)) this.finish(job, 'cancelled', '登录已取消，未保存 Cookie');
    return this.status();
  }

  /** Plugin teardown: abort the attempt and close the browser. */
  dispose(): void {
    const job = this.job;
    if (job && job.committing) {
      job.cancelRequested = true;
      job.controller.abort();
    } else if (job && ACTIVE.has(job.status.state)) {
      this.finish(job, 'cancelled', '服务已卸载，登录已取消');
    }
    this.disposed = true;
  }

  private alive(job: Job): boolean {
    if (this.disposed || this.job !== job) return false;
    if (job.controller.signal.aborted && !job.committing) return false;
    return job.status.state !== 'success' && job.status.state !== 'cancelled' && job.status.state !== 'error';
  }

  private stopTimer(job: Job): void {
    if (job.timer) { clearTimeout(job.timer); job.timer = undefined; }
  }

  private async close(job: Job): Promise<void> {
    const browser = job.browser;
    job.browser = undefined;
    try { await browser?.close(); } catch { /* closing a dead browser is not an error worth surfacing */ }
  }

  private finish(job: Job, state: 'success' | 'cancelled' | 'error', message: string, errorCode?: string): void {
    if (this.job !== job) return;
    if (job.status.state === 'success' || job.status.state === 'cancelled' || job.status.state === 'error') return;
    job.status.state = state;
    job.status.finishedAt = new Date(this.now()).toISOString();
    job.status.message = message;
    if (errorCode) job.status.errorCode = errorCode;
    job.secret = undefined;
    this.stopTimer(job);
    job.controller.abort();
    void this.close(job);
  }

  private async resolveBrowser(job: Job): Promise<BrowserLike | null> {
    if (!this.alive(job)) return null;
    const launch = this.options.launch ?? defaultLaunch;
    const browser = await launch(job.controller.signal);
    if (!browser) return null;
    job.browser = browser;
    browser.on?.('disconnected', () => this.finish(job, 'cancelled', '登录窗口已关闭，未保存 Cookie'));
    return browser;
  }

  private async run(job: Job): Promise<void> {
    const site = this.options.site ?? consoleSite();
    const browser = await this.resolveBrowser(job);
    if (!browser) return;
    if (!this.alive(job)) { await this.close(job); return; }
    const context = await browser.newContext();
    if (!this.alive(job)) { await this.close(job); return; }
    const page = await context.newPage();
    page.on?.('close', () => this.finish(job, 'cancelled', '登录窗口已关闭，未保存 Cookie'));
    if (!this.alive(job)) { await this.close(job); return; }
    // Navigate to the page that actually triggers sign-in; the site home is only a fallback
    // for the times the dashboard is down, so the user can still navigate somewhere useful.
    try { await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    catch {
      if (!this.alive(job)) return;
      try { await page.goto(site.origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
      catch { job.status.browserOpenFailed = true; }
    }
    if (!this.alive(job)) return;
    job.status.state = 'waiting';
    job.status.message = '请在官方窗口自行完成登录；账户验证通过后保存，额度状态另行显示';
    let nextAttempt = 0;
    let failures = 0;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    while (this.alive(job)) {
      if (!job.verifying) {
        const session = site.extract(await context.cookies(site.cookieUrls), this.now());
        if (!this.alive(job)) return;
        if (session && this.now() >= nextAttempt) {
          job.verifying = true;
          job.status.state = 'verifying';
          job.status.message = '正在验证登录和订阅额度（尚未保存）';
          try {
            const verified = await this.callbacks.verify(session.cookie, job.controller.signal);
            if (!this.alive(job)) return;
            if (verified.usageError || !verified.balanceOk) {
              // "Logged in but the quota is not fully readable" is not a failed login: the
              // cookie is real. Keep waiting and re-check, but do not save yet.
              job.status.state = 'waiting';
              job.status.message = '已读取账户，但订阅额度尚未完整验证；尚未保存，请确认套餐或继续登录';
              nextAttempt = this.now() + 15_000;
            } else {
              const outcome = await this.commit(job, session);
              if (outcome !== 'retry') return;
              // The store rejected the write transiently: back off and verify again rather than
              // reporting success that did not happen.
              failures += 1;
              nextAttempt = this.now() + Math.max(5_000, Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
            }
          } catch (error) {
            if (!this.alive(job)) return;
            failures += 1;
            nextAttempt = this.now() + Math.max(5_000, Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)), retryAfterMs(error));
            job.status.state = 'waiting';
            job.status.message = errorCode(error) === 'opendesign/auth'
              ? '登录尚未生效，请继续在官方窗口完成登录；未保存'
              : '额度验证暂未成功，将限频重试；未保存';
          } finally {
            job.verifying = false;
          }
        }
      }
      await this.delay(pollMs, job.controller.signal);
    }
  }

  /**
   * Persist the verified session; `commit` resolving is the linearization point. Returns
   * `retry` when the store rejected the write transiently, so the caller decides when to try
   * again instead of claiming a success that did not happen.
   */
  private async commit(job: Job, session: ExtractedCookie): Promise<'success' | 'cancelled' | 'error' | 'retry'> {
    if (job.committing || !this.alive(job)) return 'cancelled';
    job.committing = true;
    job.status.state = 'verifying';
    job.status.message = '登录已验证，正在保存会话';
    try {
      await this.callbacks.commit(session.cookie, job.captured, job.controller.signal, session.expiresAt);
      job.committing = false;
      // The store accepted the write. A cancel that arrived earlier cannot retract it, so the
      // honest report is success — this is the linearization boundary.
      this.finish(job, 'success', '登录及订阅额度已验证，Cookie 已保存');
      return 'success';
    } catch (error) {
      job.committing = false;
      if (job.cancelRequested || job.controller.signal.aborted) {
        this.finish(job, 'cancelled', '登录已取消，未保存 Cookie');
        return 'cancelled';
      }
      if (FATAL_COMMIT_CODES.has(errorCode(error) ?? '')) {
        this.finish(job, 'error', '设置已改变或无法保存，请重新读取后重试', errorCode(error));
        return 'error';
      }
      job.status.state = 'waiting';
      job.status.message = '登录已验证，但保存暂未成功，将限频重试；尚未保存';
      return 'retry';
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return undefined;
}

function retryAfterMs(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return 0;
  const value = (details as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(300_000, value) : 0;
}

/** Default launcher: a real, visible Chrome via `playwright-core` (a declared dependency). */
async function defaultLaunch(signal: AbortSignal): Promise<BrowserLike | null> {
  if (signal.aborted) return null;
  const { chromium } = await import('playwright-core');
  if (signal.aborted) return null;
  return await chromium.launch({
    channel: CHROME_LAUNCH_OPTIONS.channel,
    headless: CHROME_LAUNCH_OPTIONS.headless,
    // Copied so Playwright, which wants mutable arrays, cannot freeze on the readonly literals.
    ignoreDefaultArgs: [...CHROME_LAUNCH_OPTIONS.ignoreDefaultArgs],
    args: [...CHROME_LAUNCH_OPTIONS.args],
  }) as unknown as BrowserLike;
}
