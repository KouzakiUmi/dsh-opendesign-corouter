// Offline activation-window tests: no Chrome is launched and no page is visited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivationLauncher, chromeLaunchOptions, type ActivationBrowser, type ActivationPage } from '../src/browser-open.js';

const URL = 'https://open-design.ai/cloud/cli/activate?code=ABCD-1234';

/** Macrotask loop: open() parks on awaits that microtasks alone will not drain. */
async function untilLaunched(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('the attempt never reached its launch');
}

interface Fake {
  browser: ActivationBrowser;
  gotos: { url: string; options: { waitUntil: string; timeout: number } }[];
  pages: number;
  closes: number;
  pageCloses?: number;
  connected: boolean;
  fireDisconnected: () => void;
}
function fakeBrowser(goto?: ActivationPage['goto']): Fake {
  const gotos: Fake['gotos'] = [];
  let listener: (() => void) | undefined;
  const fake: Partial<Fake> = { gotos, pages: 0, closes: 0, connected: true };
  const page: ActivationPage = {
    goto: goto ?? (async (url, options) => { gotos.push({ url, options }); }),
    close: async () => { fake.pageCloses = (fake.pageCloses ?? 0) + 1; },
  };
  fake.browser = {
    close: async () => { fake.closes = (fake.closes ?? 0) + 1; fake.connected = false; },
    isConnected: () => fake.connected === true,
    newPage: async () => { fake.pages = (fake.pages ?? 0) + 1; return page; },
    on: (_event, listener2) => { listener = listener2; return undefined; },
  };
  fake.fireDisconnected = () => listener?.();
  return Object.assign(fake, { fireDisconnected: fake.fireDisconnected! }) as Fake;
}

test('activation window launches once, reuses the page and stays bounded', async () => {
  const fake = fakeBrowser();
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => { launches++; return fake.browser; } });
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  assert.equal(launches, 1, 'a live window is reused, not relaunched per click');
  assert.equal(fake.pages, 1, 'one page carries every navigation');
  assert.equal(fake.gotos.length, 2);
  for (const call of fake.gotos) {
    assert.equal(call.url, URL);
    assert.equal(call.options.waitUntil, 'domcontentloaded');
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 60_000);
  }
  await launcher.dispose();
  assert.equal(fake.closes, 1);
});

test('concurrent requests share one launch instead of opening two windows', async () => {
  const fake = fakeBrowser();
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => { launches++; return fake.browser; } });
  const [first, second] = await Promise.all([launcher.open(URL), launcher.open(URL)]);
  assert.deepEqual(first, { code: 'opened', opened: true });
  assert.deepEqual(second, { code: 'opened', opened: true });
  assert.equal(launches, 1);
  await launcher.dispose();
});

test('only the official activation page is ever navigated to', async () => {
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => { launches++; return fakeBrowser().browser; } });
  for (const url of [
    'https://evil.test/cloud/cli/activate', 'http://open-design.ai/cloud/cli/activate',
    'https://open-design.ai/cloud/cli/activate?code=ABCD-1234#secret', 'javascript:alert(1)',
    `${URL}&deviceSecret=private`, 'https://open-design.ai/cloud/cli/activate/',
  ]) assert.deepEqual(await launcher.open(url), { code: 'invalid-url', opened: false }, url);
  assert.equal(launches, 0, 'a refused link must not start a browser');
  await launcher.dispose();
});

test('a launch, navigation or missing Chrome failure never leaks a handle', async () => {
  const broken = fakeBrowser(async () => { throw new Error('PRIVATE_BROWSER_ERROR'); });
  const launcher = new ActivationLauncher({ launch: async () => broken.browser });
  const result = await launcher.open(URL);
  assert.deepEqual(result, { code: 'failed', opened: false });
  assert.equal(JSON.stringify(result).includes('PRIVATE_BROWSER_ERROR'), false, 'a failure reports a code, never error text');
  assert.equal(broken.closes, 1, 'a failed navigation closes the window it used');
  await launcher.dispose();

  const missing = new ActivationLauncher({ launch: async () => { throw new Error('chrome not found'); } });
  assert.deepEqual(await missing.open(URL), { code: 'unavailable', opened: false });
  await missing.dispose();

  const refused = new ActivationLauncher({ available: () => false, launch: async () => { throw new Error('must not launch'); } });
  assert.deepEqual(await refused.open(URL), { code: 'unavailable', opened: false });
  await refused.dispose();
});

test('a disconnected window is relaunched, and disposal leaves nothing running', async () => {
  const first = fakeBrowser(), second = fakeBrowser();
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => { launches++; return launches === 1 ? first.browser : second.browser; } });
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  first.fireDisconnected();
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  assert.equal(launches, 2, 'the user closing the window does not strand the opener');
  await launcher.dispose();
  assert.equal(second.closes, 1);
  assert.deepEqual(await launcher.open(URL), { code: 'failed', opened: false }, 'a disposed launcher refuses new work');
});

test('a hung browser start is bounded rather than pinning the caller', async () => {
  const launcher = new ActivationLauncher({ timeoutMs: 5, launch: () => new Promise(() => { /* never settles */ }) });
  assert.deepEqual(await launcher.open(URL), { code: 'unavailable', opened: false });
  await launcher.dispose();
});

test('the launch options keep Chrome non-headless, sandboxed, and the automation flag suppressed', () => {
  const options = chromeLaunchOptions();
  assert.equal(options.channel, 'chrome');
  assert.equal(options.headless, false);
  // playwright-core appends --no-sandbox unless this is explicitly true; the page is untrusted.
  assert.equal(options.chromiumSandbox, true);
  assert.deepEqual(options.args, ['--disable-blink-features=AutomationControlled']);
  assert.deepEqual(options.ignoreDefaultArgs, ['--enable-automation']);
});

test('close() takes the window away but leaves the launcher able to open a new one', async () => {
  // A cancelled or expired approval must not strand the next login.
  const first = fakeBrowser(), second = fakeBrowser();
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => { launches++; return launches === 1 ? first.browser : second.browser; } });
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  await launcher.close();
  assert.equal(first.closes, 1);
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  assert.equal(launches, 2, 'the launcher is reusable after a job ends');
  await launcher.close();
  assert.equal(second.closes, 1);
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true }, 'close() is not retirement');
  await launcher.dispose();
  assert.equal(second.closes, 2);
  assert.deepEqual(await launcher.open(URL), { code: 'failed', opened: false }, 'dispose() is retirement');
});

test('a launch that settles after its deadline is closed rather than leaked', async () => {
  const late = fakeBrowser();
  let resolveLaunch: (browser: ActivationBrowser) => void = () => undefined;
  const launcher = new ActivationLauncher({
    timeoutMs: 5,
    launch: () => new Promise<ActivationBrowser>(resolve => { resolveLaunch = resolve; }),
  });
  // The first attempt times out before Chrome answers.
  assert.deepEqual(await launcher.open(URL), { code: 'unavailable', opened: false });
  assert.equal(late.closes, 0, 'nothing has been launched yet');
  resolveLaunch(late.browser);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(late.closes, 1, 'the late handle is closed, not dropped');
  await launcher.dispose();
});

test('a window that arrives after close() is closed instead of popping up again', async () => {
  // Regression: closing a job while Chrome was still starting used to resurrect the window.
  let closes = 0, gotos = 0;
  const late = { browser: { close: async () => { closes++; }, isConnected: () => true,
    newPage: async () => ({ goto: async () => { gotos++; } }) } };
  let launched = false;
  let resolveLaunch: (browser: ActivationBrowser) => void = () => undefined;
  const launcher = new ActivationLauncher({
    launch: () => { launched = true; return new Promise<ActivationBrowser>(resolve => { resolveLaunch = resolve; }); },
  });
  const opening = launcher.open(URL);
  // Let the attempt actually reach its launch before ending the job.
  await untilLaunched(() => resolveLaunch !== undefined && launched);
  await launcher.close();
  resolveLaunch(late.browser);
  assert.deepEqual(await opening, { code: 'failed', opened: false }, 'a cancelled job reports no window');
  // The handle is closed by a tracked cleanup that the caller no longer waits on.
  for (let i = 0; i < 50 && closes === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(closes, 1, 'and the window it started is closed');
  assert.equal(gotos, 0, 'no navigation happens for a cancelled job');
  await launcher.dispose();
});

test('a launch that only starts after retirement never runs', async () => {
  // Stronger than closing it afterwards: joining the previous closure happens inside the
  // attempt's budget, so a retired launcher refuses to pay for a Chrome it cannot keep.
  const late = fakeBrowser();
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => { launches++; return late.browser; } });
  const opening = launcher.open(URL);
  const started = Date.now();
  await launcher.dispose();
  assert.deepEqual(await opening, { code: 'failed', opened: false });
  assert.equal(launches, 0, 'retirement prevented the launch entirely');
  assert.ok(Date.now() - started < 1_000, 'disposal did not wait on a needless launch');
});

test('retirement still joins a launch that is genuinely already in flight', async () => {
  // Here Chrome has started; its handle must be closed by someone after retirement.
  let closes = 0, gotos = 0;
  const late = { browser: { close: async () => { closes++; }, isConnected: () => true,
    newPage: async () => ({ goto: async () => { gotos++; } }) } };
  let launched = false;
  let resolveLaunch: (browser: ActivationBrowser) => void = () => undefined;
  const launcher = new ActivationLauncher({ launch: () => { launched = true; return new Promise<ActivationBrowser>(resolve => { resolveLaunch = resolve; }); } });
  void launcher.open(URL);
  await untilLaunched(() => launched && resolveLaunch !== undefined);
  const disposing = launcher.dispose();
  resolveLaunch(late.browser);
  await disposing;
  for (let i = 0; i < 50 && closes === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(closes, 1, 'the in-flight handle is closed');
  assert.equal(gotos, 0, 'a retired launcher never navigates');
});

test('a page that arrives after its deadline is closed, not left open', async () => {
  const fake = fakeBrowser();
  const slowPage = { ...fake.browser, newPage: () => new Promise<ActivationPage>(resolve => { setTimeout(() => resolve({ goto: async () => undefined, close: async () => { fake.pageCloses = (fake.pageCloses ?? 0) + 1; } }), 25); }) };
  const launcher = new ActivationLauncher({ timeoutMs: 5, launch: async () => slowPage });
  assert.deepEqual(await launcher.open(URL), { code: 'failed', opened: false });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fake.pageCloses, 1, 'the late page is closed');
  await launcher.dispose();
});

test('one open shares a single end-to-end budget instead of 30 s per step', async () => {
  // launch + newPage + goto must land inside one deadline that the client can afford to wait.
  const fake = fakeBrowser();
  const launcher = new ActivationLauncher({ timeoutMs: 40, launch: async () => fake.browser });
  const started = Date.now();
  const result = await launcher.open(URL);
  assert.deepEqual(result, { code: 'opened', opened: true });
  assert.ok(Date.now() - started < 500, 'the budget is not multiplied per step');

  let resolveLaunch: (browser: ActivationBrowser) => void = () => undefined;
  const slow = new ActivationLauncher({ timeoutMs: 10, launch: () => new Promise(resolve => { resolveLaunch = resolve; }) });
  assert.deepEqual(await slow.open(URL), { code: 'unavailable', opened: false });
  await slow.dispose();
});

test('dispose() joins a closure that a cancelled job already started', async () => {
  // Host order is: login.dispose() -> onSettled closes the window -> activation.dispose().
  // Retirement must not report completion while that window is still going away.
  let finishClose: () => void = () => undefined;
  const slow = { close: () => new Promise<void>(resolve => { finishClose = resolve; }), isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const launcher = new ActivationLauncher({ launch: async () => slow });
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  void launcher.close();
  const disposing = launcher.dispose();
  let settled = false;
  void disposing.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false, 'dispose waits for the closure it did not start');
  finishClose();
  await disposing;
  assert.equal(settled, true);
});

test('a window adopted while an earlier closure runs is still closed', async () => {
  // Regression: clearing ownership once left the newer browser open (closes2 = 0).
  let finishFirst: () => void = () => undefined;
  let secondCloses = 0;
  const first = { close: () => new Promise<void>(resolve => { finishFirst = resolve; }), isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const second = { close: async () => { secondCloses++; }, isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => (++launches === 1 ? first : second) });

  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  void launcher.close();                                  // first is still closing
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true }, 'a new job opens its own window');
  const closingAgain = launcher.close();                  // ends while the first closure runs
  finishFirst();
  await closingAgain;
  assert.equal(secondCloses, 1, 'the window adopted mid-closure is closed too');
  await launcher.dispose();
});

test('a cleanup path never leaves open holding a wedged close', async () => {
  // Regression: the stale branch awaited browser.close() unbounded and pinned the request.
  let resolveLaunch: (browser: ActivationBrowser) => void = () => undefined;
  const wedged = { close: () => new Promise<void>(() => undefined), isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const launcher = new ActivationLauncher({ timeoutMs: 10, launch: () => new Promise(resolve => { resolveLaunch = resolve; }) });
  const opening = launcher.open(URL);
  await new Promise(resolve => setTimeout(resolve, 5));
  await launcher.close();
  resolveLaunch(wedged);
  const outcome = await Promise.race([
    opening.then(value => `settled:${value.code}`),
    new Promise<string>(resolve => { setTimeout(() => resolve('STILL PENDING'), 200); }),
  ]);
  assert.equal(outcome, 'settled:failed', 'a wedged close is bounded, not awaited forever');
  await launcher.dispose();
});

test('finishing an old closure does not close the window of a job still running', async () => {
  // Regression: the previous drain loop closed whatever window it found, so releasing an
  // old closure killed the live window of a job that was never cancelled.
  let finishFirst: () => void = () => undefined;
  let secondCloses = 0;
  const first = { close: () => new Promise<void>(resolve => { finishFirst = resolve; }), isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const second = { close: async () => { secondCloses++; }, isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  let launches = 0;
  const launcher = new ActivationLauncher({ launch: async () => (++launches === 1 ? first : second) });

  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  const closingFirst = launcher.close();                   // old job ends; its window is closing
  setTimeout(() => finishFirst(), 5);
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true }, 'the new job gets a window');
  await closingFirst;                                      // only the old closure completes
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(secondCloses, 0, 'a live window is not closed by an earlier job closure');
  await launcher.close();
  assert.equal(secondCloses, 1);
  await launcher.dispose();
});

test('a new open waits for the previous closure instead of running two Chromes', async () => {
  let finishFirst: () => void = () => undefined;
  let launches = 0;
  const first = { close: () => new Promise<void>(resolve => { finishFirst = resolve; }), isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const second = { close: async () => undefined, isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const launcher = new ActivationLauncher({ launch: async () => (++launches === 1 ? first : second) });
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  void launcher.close();
  const opening = launcher.open(URL);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(launches, 1, 'no second Chrome while the first is still closing');
  finishFirst();
  assert.deepEqual(await opening, { code: 'opened', opened: true });
  assert.equal(launches, 2);
  await launcher.dispose();
});

test('a failing open ends inside its budget, including cleanup', async () => {
  // Regression: failure cleanup waited its own 5 s budget on top of the open budget.
  const wedged = { close: () => new Promise<void>(() => undefined), isConnected: () => true, newPage: () => new Promise<ActivationPage>(() => undefined) };
  const launcher = new ActivationLauncher({ timeoutMs: 15, launch: async () => wedged });
  const started = Date.now();
  assert.deepEqual(await launcher.open(URL), { code: 'failed', opened: false });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `one open stayed inside its own budget (${elapsed} ms)`);
  await launcher.dispose();
});

test('a second open waits for the adopted window to finish closing', async () => {
  let release: () => void = () => undefined;
  let launches = 0;
  const adopted = { close: () => new Promise<void>(resolve => { release = resolve; }), isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const fresh = { close: async () => undefined, isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const launcher = new ActivationLauncher({ timeoutMs: 60, launch: async () => (++launches === 1 ? adopted : fresh) });
  assert.deepEqual(await launcher.open(URL), { code: 'opened', opened: true });
  const closing = launcher.close();
  const second = launcher.open(URL);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(launches, 1, 'the closed window is not replaced before it is gone');
  release();
  await closing;
  assert.deepEqual(await second, { code: 'opened', opened: true });
  assert.equal(launches, 2);
  await launcher.dispose();
});

test('a second open also waits for a handle that was never adopted', async () => {
  // Here the first attempt timed out, so its handle is only known to `tracked`.
  let release: () => void = () => undefined;
  let launches = 0;
  const tardy = { close: () => new Promise<void>(resolve => { release = resolve; }), isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  const fresh = { close: async () => undefined, isConnected: () => true, newPage: async () => ({ goto: async () => undefined }) };
  // The first launch answers later than this attempt's budget, so its handle is only ever
  // known to `tracked`; that closure must still gate the next open.
  // The first launch answers after this attempt's budget, so its handle is only ever known
  // to `tracked`; the aim is to observe that the second open waits on it.
  const launcher = new ActivationLauncher({ timeoutMs: 40, launch: async () => (++launches === 1 ? new Promise<ActivationBrowser>(resolve => { setTimeout(() => resolve(tardy), 80); }) : fresh) });
  assert.deepEqual(await launcher.open(URL), { code: 'unavailable', opened: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = launcher.open(URL);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(launches, 1, 'a second Chrome does not start while the tracked one is closing');
  release();
  assert.deepEqual(await second, { code: 'opened', opened: true });
  assert.equal(launches, 2, 'the fresh window starts once the tracked one is gone');
  await launcher.dispose();
});
