// Host-only activation-page opener. The DSH Desktop shell denies `target="_blank"`
// navigation from its renderer, so a settings-page link cannot reach the user's browser
// there. This module launches one short-lived Chrome window through playwright-core and
// navigates it to the official activation page — nothing else. It never creates, controls
// or reads the user's own browser profile: the temporary context is playwright's.
//
// Adaptation of the launch strategy in dsh-subusage 0.16.3 (lib/cookie-login.js): a
// non-headless Chrome window without the automation-reported blink feature. The user
// approves the device code themselves; this module never types, clicks or reads the page.
import { validateActivationUrl } from './device-auth.js';

/** Bounds on one navigation; the window stays open for the user afterwards. */
export const ACTIVATION_NAVIGATE_TIMEOUT_MS = 15_000;
/**
 * End-to-end budget for one open request: launch + newPage + navigate. Kept below the
 * client's 30 s RPC wait so a successful open is reported to the user, not a timeout.
 */
export const ACTIVATION_OPEN_BUDGET_MS = 20_000;
/** Bound on closing a window; a wedged browser must not pin disposal. */
export const ACTIVATION_CLOSE_TIMEOUT_MS = 5_000;

/** Why the window could not be offered. Codes are public; no URL or error text is echoed. */
export type ActivationOpenCode = 'opened' | 'invalid-url' | 'unavailable' | 'failed';

export interface ActivationOpenResult {
  code: ActivationOpenCode;
  /** True only when a Chrome window is showing the activation page. */
  opened: boolean;
}

/** The subset of playwright-core this module uses, so tests can inject a stand-in. */
export interface ActivationPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  /** playwright's Page.close(); default does not run unload handlers. */
  close?(): Promise<void>;
}
export interface ActivationBrowser {
  close(): Promise<unknown>;
  isConnected(): boolean;
  newPage(): Promise<ActivationPage>;
  on?(event: 'disconnected', listener: () => void): unknown;
}
export interface ActivationLauncherOptions {
  /** Injected for offline tests; production resolves playwright-core lazily. */
  launch?: () => Promise<ActivationBrowser>;
  timeoutMs?: number;
  /** Reports whether a launch is even possible, e.g. a missing Chrome install. */
  available?: () => boolean;
}

/**
 * Chrome without the automation flag subusage found counterproductive on guarded pages.
 * `chromiumSandbox: true` is explicit on purpose: playwright otherwise appends
 * `--no-sandbox` (verified in playwright-core 1.63.0), and this window renders a page
 * this plugin does not control.
 */
export function chromeLaunchOptions() {
  return {
    channel: 'chrome' as const, headless: false, chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
}

export class ActivationLauncher {
  private browser: ActivationBrowser | undefined;
  private page: ActivationPage | undefined;
  private pending: Promise<ActivationOpenResult> | undefined;
  private disposal: Promise<void> | undefined;
  /** In-flight window closure, shared so disposal can join it. */
  private closing: Promise<void> | undefined;
  /** Closures of handles that were never adopted; disposal joins them too. */
  private tracked: Promise<void>[] = [];
  /** Chrome starts in flight, so disposal waits for the handle they will produce. */
  private starting: Promise<ActivationBrowser>[] = [];
  private disposed = false;
  /** Bumped by `close()`: an attempt from an older session must not resurrect a window. */
  private session = 0;
  private readonly options: ActivationLauncherOptions;
  constructor(options: ActivationLauncherOptions = {}) { this.options = options; }

  /**
   * Show `url` in the temporary window, reusing one already open. Concurrent calls share
   * a single attempt: the caller's button stays honest about what actually happened.
   */
  async open(url: string): Promise<ActivationOpenResult> {
    if (validateActivationUrl(url) === null) return { code: 'invalid-url', opened: false };
    if (this.disposed) return { code: 'failed', opened: false };
    if (this.pending) return this.pending;
    const attempt = this.attempt(url);
    this.pending = attempt;
    try { return await attempt; }
    finally { if (this.pending === attempt) this.pending = undefined; }
  }

  /**
   * Close the temporary window and stay usable: a cancelled or expired job takes its
   * window away, while the next login may open a new one.
   */
  async close(): Promise<void> {
    // Invalidate first: a launch still in flight belongs to the job that just ended.
    this.session++;
    await this.closeCurrent();
  }

  /**
   * Retire the launcher for good. Cleanup is best-effort and bounded: it joins in-flight
   * starts and closures, but a browser that ignores `close()` may outlive the 5 s wait.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.session++;
    if (this.disposal) return this.disposal;
    this.disposal = (async () => {
      // Join the Chrome starts in flight first: they must not adopt a window after
      // retirement, and their handles must still be closed by someone.
      await this.bounded<void>(Date.now() + ACTIVATION_CLOSE_TIMEOUT_MS, async () => {
        await Promise.allSettled(this.starting);
      });
      // Then join a closure a cancelled job already started, so retirement does not report
      // completion while that window is still going away.
      await this.closing;
      await this.closeCurrent();
      // Finally join closures of handles that arrived too late to be adopted.
      await this.bounded<void>(Date.now() + ACTIVATION_CLOSE_TIMEOUT_MS, async () => { await Promise.all(this.tracked); });
    })();
    return this.disposal;
  }

  /**
   * Close the window this launcher owns right now. Ownership is taken before the async
   * close, so a job that adopts a new window afterwards is not affected by this closure.
   * The closure promise is shared so a later `dispose()` joins it.
   */
  private async closeCurrent(): Promise<void> {
    if (this.closing === undefined) {
      const browser = this.browser;
      this.browser = undefined;
      this.page = undefined;
      if (browser === undefined) return;
      this.closing = closeBounded(browser);
    }
    const closing = this.closing;
    try { await closing; }
    finally { if (this.closing === closing) this.closing = undefined; }
  }

  private async attempt(url: string): Promise<ActivationOpenResult> {
    const session = this.session;
    const budget = this.options.timeoutMs ?? ACTIVATION_OPEN_BUDGET_MS;
    const deadline = Date.now() + budget;
    try {
      if (this.options.available?.() === false) return { code: 'unavailable', opened: false };
      const browser = await this.ensureBrowser(session, deadline);
      // A job that ended while Chrome was starting is cancelled, not "no Chrome installed".
      if (browser === undefined) return { code: this.stale(session) ? 'failed' : 'unavailable', opened: false };
      if (this.stale(session)) { await this.bounded(deadline, () => this.closeCurrent()); return { code: 'failed', opened: false }; }
      const page = await this.ensurePage(browser, session, deadline);
      if (page === undefined) { await this.bounded(deadline, () => this.closeCurrent()); return { code: 'failed', opened: false }; }
      const remaining = Math.max(1, Math.min(ACTIVATION_NAVIGATE_TIMEOUT_MS, deadline - Date.now()));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining });
      if (this.stale(session)) { await this.bounded(deadline, () => this.closeCurrent()); return { code: 'failed', opened: false }; }
      return { code: 'opened', opened: true };
    } catch {
      // A refused navigation or a vanished window leaves no reusable browser behind.
      // Cleanup shares this attempt's deadline, so one open still ends within its budget.
      await this.bounded(deadline, () => this.closeCurrent());
      return { code: 'failed', opened: false };
    }
  }

  /** The job that started this attempt ended, or the launcher retired. */
  private stale(session: number): boolean { return this.disposed || session !== this.session; }

  private async ensureBrowser(session: number, deadline: number): Promise<ActivationBrowser | undefined> {
    const open = this.browser;
    if (open !== undefined) {
      try { if (open.isConnected()) return open; } catch { /* treat as gone */ }
      // Replacing a dead window shares this attempt's deadline too.
      await this.bounded(deadline, () => this.closeCurrent());
    }
    // Windows from earlier jobs may still be closing. Settle the starts first, then read
    // the cleanup sets again: a start that finishes after the first read registers a new
    // closure that a single snapshot would miss. Both phases share this attempt's budget.
    for (let round = 0; round < 2; round++) {
      await this.bounded(deadline, async () => {
        await Promise.allSettled([this.closing, ...this.tracked, ...this.starting]);
      });
      if (this.stale(session) || Date.now() >= deadline) return undefined;
      if (this.closing === undefined && this.tracked.length === 0 && this.starting.length === 0) break;
    }
    if (this.stale(session) || Date.now() >= deadline) return undefined;
    const launch = this.options.launch ?? defaultLaunch;
    const starting = launch();
    this.starting.push(starting);
    const browser = await this.bounded(deadline, () => starting);
    // Whatever this launch produces is owned here: if the attempt already gave up on it
    // (timeout or a closed/retired session), the handle is closed rather than leaked.
    void starting
      .then(handle => { if (handle !== browser) void this.trackClose(handle); })
      .catch(() => undefined)
      .finally(() => { this.starting = this.starting.filter(item => item !== starting); });
    if (browser === undefined) return undefined;
    // A window that arrives after its job ended is closed, never adopted: otherwise a
    // cancelled approval would pop up a browser the user just dismissed.
    // Not adopted, so the caller need not wait for the closure: track the ownership and
    // report the attempt as finished now, keeping `open` inside its own budget.
    if (this.stale(session)) { void this.trackClose(browser); return undefined; }
    this.adopt(browser);
    return browser;
  }

  private async ensurePage(browser: ActivationBrowser, session: number, deadline: number): Promise<ActivationPage | undefined> {
    if (this.page !== undefined) return this.page;
    // Browsers close their pages, but a page that arrives late belongs to no closed
    // browser, so it is closed directly instead of being left open.
    const page = await this.bounded(deadline, () => browser.newPage(), late => { void this.trackPageClose(late); });
    if (page === undefined) return undefined;
    if (this.stale(session) || this.browser !== browser) { await this.bounded(deadline, () => this.closeCurrent()); return undefined; }
    this.page = page;
    return page;
  }

  /** A handle that arrived too late is closed, and still counts as work disposal joins. */
  private trackClose(browser: ActivationBrowser): Promise<void> {
    const closing = closeBounded(browser);
    this.tracked.push(closing);
    void closing.finally(() => { this.tracked = this.tracked.filter(item => item !== closing); });
    return closing;
  }

  private trackPageClose(page: ActivationPage): Promise<void> {
    // A page can reject when it is closed after its browser: never leave that unhandled.
    try { return Promise.resolve(page.close?.()).catch(() => undefined); }
    catch { return Promise.resolve(); }
  }

  private adopt(browser: ActivationBrowser): void {
    this.browser = browser;
    browser.on?.('disconnected', () => { if (this.browser === browser) { this.browser = undefined; this.page = undefined; } });
  }

  /**
   * Bound one launch step by the attempt's shared deadline. A step that settles only
   * after that deadline still hands its handle back: dropping it would leak a Chrome
   * process nobody can close.
   */
  private async bounded<T>(deadline: number, start: () => Promise<T>, discardOnLate?: (value: T) => void): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const work = (async () => {
      try { return await start(); }
      catch { return undefined; }
    })().then(value => {
      if (expired && value !== undefined) discardOnLate?.(value);
      return value;
    });
    const timeout = new Promise<undefined>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(undefined); }, Math.max(1, deadline - Date.now()));
    });
    try { return await Promise.race([work, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

/**
 * Close a browser within one bounded budget. A wedged browser must never pin a caller,
 * whichever cleanup path reached it.
 */
function closeBounded(browser: ActivationBrowser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    (async () => { try { await browser.close(); } catch { /* already gone */ } })(),
    new Promise<void>(resolve => { timer = setTimeout(resolve, ACTIVATION_CLOSE_TIMEOUT_MS); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); }) as Promise<void>;
}

async function defaultLaunch(): Promise<ActivationBrowser> {
  const playwright = await import('playwright-core');
  return playwright.chromium.launch(chromeLaunchOptions()) as unknown as ActivationBrowser;
}
