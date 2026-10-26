// Tests for src/login.ts. No browser, network or real credential is involved: the launcher,
// clock and delay are injected, and the cookie is a literal test string.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHROME_LAUNCH_OPTIONS,
  ConsoleLogin,
  LoginError,
  consoleSite,
  extractConsoleSession,
  type BrowserLike,
  type ContextLike,
  type LoginCallbacks,
  type LoginStatus,
  type PageLike,
  type RawCookie,
} from '../src/login.js';

const COOKIE_VALUE = 'secret-cookie-value';
const SESSION_COOKIE = `__Secure-better-auth.session_token=${COOKIE_VALUE}`;
const REVISION = 'rev-1';

interface FakeBrowser {
  browser: BrowserLike;
  closed: () => boolean;
  disconnect: () => void;
  closePage: () => void;
}

function fakeBrowser(cookies: () => readonly RawCookie[]): FakeBrowser {
  let closed = false;
  let disconnected: (() => void) | undefined;
  let pageClose: (() => void) | undefined;
  const page: PageLike = {
    on(event, listener) { if (event === 'close') pageClose = listener; },
    goto: async () => undefined,
  };
  const context: ContextLike = { newPage: async () => page, cookies: async () => cookies() };
  const browser: BrowserLike = {
    on(event, listener) { if (event === 'disconnected') disconnected = listener; },
    newContext: async () => context,
    close: async () => { closed = true; },
  };
  return { browser, closed: () => closed, disconnect: () => disconnected?.(), closePage: () => pageClose?.() };
}

const fastDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));

function site() {
  return consoleSite({ loginUrl: 'https://open-design.ai/cloud/dashboard', cookieUrls: ['https://amr-api.open-design.ai/api/v1/workspaces/current'] });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the expected state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

interface Recorder {
  commits: { cookie: string; captured: unknown; expiresAt: number }[];
  verifies: string[];
  captures: string[];
}

function recorder(): Recorder { return { commits: [], verifies: [], captures: [] }; }

function callbacks(state = recorder(), overrides: Partial<LoginCallbacks> = {}): LoginCallbacks {
  return {
    capture: expectedRevision => { state.captures.push(expectedRevision); return { revision: expectedRevision }; },
    verify: async cookie => { state.verifies.push(cookie); return { balanceOk: true }; },
    commit: async (cookie, captured, _signal, expiresAt) => { state.commits.push({ cookie, captured, expiresAt }); return {}; },
    ...overrides,
  };
}

const statusOf = (login: ConsoleLogin): LoginStatus => login.status();

test('a successful verify commits immediately and reports success', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => [{ name: '__Secure-better-auth.session_token', value: COOKIE_VALUE, expires: -1 }]);
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'success');
  const done = statusOf(login);
  assert.equal(done.state, 'success');
  assert.equal(done.finishedAt !== undefined, true);
  assert.equal(JSON.stringify(done).includes(COOKIE_VALUE), false, 'status must never carry the cookie');
  assert.deepEqual(state.captures, [REVISION]);
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0]?.cookie, SESSION_COOKIE);
  assert.deepEqual(state.commits[0]?.captured, { revision: REVISION });
  // A console session cookie declares no expiry, so the seam reports 0 (not a fake deadline).
  assert.equal(state.commits[0]?.expiresAt, 0);
  assert.equal(fake.closed(), true, 'the browser is closed once the session is saved');
  assert.equal(started.jobId, done.jobId);
});

test('commit receives the earliest declared expiry of the cookie bundle in epoch ms', async () => {
  const state = recorder();
  const now = Date.now();
  const soon = Math.floor(now / 1000) + 3_600;
  const later = Math.floor(now / 1000) + 7_200;
  const fake = fakeBrowser(() => [
    { name: 'a', value: '1', expires: later },
    { name: 'b', value: '2', expires: soon },
    { name: 'session', value: '3', expires: -1 },
  ]);
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'success');
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0]?.expiresAt, soon * 1000);
  // Sanity: the value is a real deadline, not the non-persistent cookie's 0.
  assert.equal(state.commits[0]?.expiresAt > now, true);
});

test('verifying without a readable quota keeps waiting and does not commit', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => [{ name: 'sid', value: COOKIE_VALUE }]);
  const login = new ConsoleLogin(callbacks(state, {
    verify: async cookie => { state.verifies.push(cookie); return { balanceOk: true, usageError: { code: 'opendesign/quota-unknown' } }; },
  }), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'waiting' && state.verifies.length >= 1);
  const waiting = statusOf(login);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.message?.includes('尚未保存'), true);
  assert.equal(state.commits.length, 0);
  login.cancel({ jobId: started.jobId as string });
});

test('a failed verify retries at a limited rate and stays unsaved', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => [{ name: 'sid', value: COOKIE_VALUE }]);
  const login = new ConsoleLogin(callbacks(state, {
    verify: async cookie => { state.verifies.push(cookie); throw Object.assign(new Error('nope'), { code: 'opendesign/auth' }); },
  }), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'waiting' && state.verifies.length >= 1);
  assert.equal(statusOf(login).message?.includes('未保存'), true);
  assert.equal(state.commits.length, 0);
  login.cancel({ jobId: started.jobId as string });
  assert.equal(new Set(state.verifies).size, 1, 'one verify attempt per extracted session');
});

test('cancelling while waiting writes nothing', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => []);
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'waiting');
  assert.equal(login.cancel({ jobId: started.jobId as string }).state, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(state.commits.length, 0);
  assert.equal(fake.closed(), true);
});

test('a cancel that lands before the store accepts the write cancels the attempt', async () => {
  const state = recorder();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let commitSignal: AbortSignal | undefined;
  const fake = fakeBrowser(() => [{ name: 'sid', value: COOKIE_VALUE }]);
  const login = new ConsoleLogin(callbacks(state, {
    commit: async (cookie, captured, signal, expiresAt) => {
      commitSignal = signal;
      await gate;
      // The Host's atomic mutator re-checks the signal exactly like this.
      signal.throwIfAborted();
      state.commits.push({ cookie, captured, expiresAt });
      return {};
    },
  }), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'verifying' && commitSignal !== undefined);
  const during = login.cancel({ jobId: started.jobId as string });
  // The commit is in flight: the attempt stays `verifying` and lets the store decide.
  assert.equal(during.state, 'verifying');
  assert.equal(commitSignal?.aborted, true);
  release?.();
  await waitFor(() => statusOf(login).state === 'cancelled');
  assert.equal(state.commits.length, 0, 'the aborted store write never happened');
});

test('a commit that already won the race reports success even after a cancel', async () => {
  const state = recorder();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let signalSeen: AbortSignal | undefined;
  const fake = fakeBrowser(() => [{ name: 'sid', value: COOKIE_VALUE }]);
  const login = new ConsoleLogin(callbacks(state, {
    commit: async (cookie, captured, signal, expiresAt) => {
      signalSeen = signal;
      await gate;
      // This store ignores the abort: its write is the linearization point.
      state.commits.push({ cookie, captured, expiresAt });
      return {};
    },
  }), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'verifying' && signalSeen !== undefined);
  login.cancel({ jobId: started.jobId as string });
  release?.();
  await waitFor(() => statusOf(login).state === 'success');
  assert.equal(state.commits.length, 1);
  assert.equal(statusOf(login).state, 'success');
});

test('a fatal commit failure is reported without retrying', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => [{ name: 'sid', value: COOKIE_VALUE }]);
  const login = new ConsoleLogin(callbacks(state, {
    commit: async () => { throw Object.assign(new Error('conflict'), { code: 'opendesign/revision-conflict' }); },
  }), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'error');
  const status = statusOf(login);
  assert.equal(status.errorCode, 'opendesign/revision-conflict');
  assert.equal(status.message?.includes('设置已改变'), true);
});

test('a transient commit failure keeps retrying and never reports success', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => [{ name: 'sid', value: COOKIE_VALUE }]);
  const login = new ConsoleLogin(callbacks(state, {
    commit: async () => { throw Object.assign(new Error('io'), { code: 'opendesign/io' }); },
  }), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'waiting' && statusOf(login).message?.includes('保存暂未成功') === true);
  assert.equal(state.commits.length, 0);
  login.cancel({ jobId: started.jobId as string });
});

test('the attempt times out on its own without writing', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => []);
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site(), timeoutMs: 15 });
  login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'cancelled');
  assert.equal(state.commits.length, 0);
});

test('dispose during the waiting phase cancels the attempt and never commits', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => []);
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  login.start({ expectedRevision: REVISION });
  login.dispose();
  assert.equal(statusOf(login).state, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(state.commits.length, 0);
});

test('closing the login window cancels and saves nothing', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => []);
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'waiting');
  fake.disconnect();
  assert.equal(statusOf(login).state, 'cancelled');
  assert.equal(state.commits.length, 0);
});

test('a capture failure aborts the attempt before any browser work', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => []);
  const login = new ConsoleLogin(callbacks(state, {
    capture: () => { throw Object.assign(new Error('conflict'), { code: 'opendesign/revision-conflict' }); },
  }), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  login.start({ expectedRevision: REVISION });
  await waitFor(() => statusOf(login).state === 'error');
  assert.equal(statusOf(login).errorCode, 'opendesign/revision-conflict');
  assert.equal(state.commits.length, 0);
});

test('start is idempotent while an attempt is live and opens a new attempt afterwards', async () => {
  const state = recorder();
  const fake = fakeBrowser(() => []);
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fake.browser, pollMs: 1, delay: fastDelay, site: site() });
  const first = login.start({ expectedRevision: REVISION });
  const second = login.start({ expectedRevision: REVISION });
  assert.equal(first.jobId, second.jobId);
  login.cancel({ jobId: first.jobId as string });
  const third = login.start({ expectedRevision: 'rev-2' });
  assert.notEqual(third.jobId, first.jobId);
  login.dispose();
});

test('a cancel for another job id is ignored', async () => {
  const state = recorder();
  const login = new ConsoleLogin(callbacks(state), { launch: async () => fakeBrowser(() => []).browser, pollMs: 1, delay: fastDelay, site: site() });
  const started = login.start({ expectedRevision: REVISION });
  assert.equal(login.cancel({ jobId: 'someone-else' }).jobId, started.jobId);
  login.dispose();
});

test('starting after dispose throws', () => {
  const login = new ConsoleLogin(callbacks(), { launch: async () => fakeBrowser(() => []).browser, pollMs: 1, delay: fastDelay, site: site() });
  assert.deepEqual(login.status(), { jobId: null, state: 'idle' });
  login.dispose();
  assert.throws(() => login.start({ expectedRevision: REVISION }), (error: unknown) => error instanceof LoginError && error.code === 'opendesign/login-disposed');
});

test('extractConsoleSession keeps the browser cookie bundle and reports the earliest expiry', () => {
  const now = 1_000_000;
  const session = extractConsoleSession([
    { name: 'a', value: '1', expires: now / 1000 + 500 },
    { name: 'b', value: '2', expires: now / 1000 + 100 },
    { name: 'gone', value: '3', expires: now / 1000 - 1 },
    { name: 'session', value: '4', expires: -1 },
    { name: '', value: 'x' },
  ], now);
  assert.equal(session?.cookie, 'a=1; b=2; session=4');
  assert.equal(session?.expiresAt, (now / 1000 + 100) * 1000);
  assert.equal(extractConsoleSession([], now), null);
  assert.equal(extractConsoleSession([{ name: 'x', value: '' }], now), null);
  assert.equal(extractConsoleSession([{ name: 'p', value: '1', expires: -1 }], now)?.expiresAt, 0);
});

test('the Chrome launch options keep the human-in-the-loop bot-check workaround', () => {
  assert.equal(CHROME_LAUNCH_OPTIONS.channel, 'chrome');
  assert.equal(CHROME_LAUNCH_OPTIONS.headless, false);
  assert.deepEqual([...CHROME_LAUNCH_OPTIONS.args], ['--disable-blink-features=AutomationControlled']);
});
