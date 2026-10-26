// Offline device-auth regression tests: no browser, process, real login or credentials.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleLogin, LoginError, type DeviceTokens, type LoginCallbacks, type LoginOptions } from '../src/login.js';
import { DEVICE_AUTH_ENDPOINT, DEVICE_AUTH_PLUGIN_VERSION } from '../src/device-auth.js';

const START = Date.parse('2026-10-01T00:00:00Z');
const TOKENS: DeviceTokens = { controlKey: 'fixture-control-key', runtimeKey: 'fixture-runtime-key' };
const DEVICE_SECRET = 'fixture-device-secret';
const CODE = 'ABCD-1234';
const URL = `https://open-design.ai/cloud/cli/activate?code=${CODE}`;
const authorization = (changes: Record<string, unknown> = {}) => ({ deviceId: 'fixture-device-id', deviceSecret: DEVICE_SECRET, userCode: CODE, activationUrl: URL, pollIntervalSeconds: 2, expiresAt: new Date(START + 600_000).toISOString(), ...changes });
const request = { expectedRevision: 'rev-1' };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('timed out waiting for login state');
}
interface Fixture {
  login: ConsoleLogin;
  calls: { url: string; init: RequestInit | undefined }[];
  commits: { tokens: DeviceTokens; captured: unknown; signal: AbortSignal }[];
  captures: string[];
  sleeps: number[];
  time: { now: number };
}
function fixture({ replies = [authorization(), TOKENS], callbacks = {}, options = {} }: {
  replies?: unknown[];
  callbacks?: Partial<LoginCallbacks>;
  options?: LoginOptions;
} = {}): Fixture {
  const time = { now: START };
  const calls: Fixture['calls'] = [];
  const commits: Fixture['commits'] = [];
  const captures: string[] = [];
  const sleeps: number[] = [];
  const login = new ConsoleLogin({
    capture: revision => { captures.push(revision); return { revision }; },
    commit: async (tokens, captured, signal) => { signal.throwIfAborted(); commits.push({ tokens, captured, signal }); },
    ...callbacks,
  }, {
    now: () => time.now,
    fetcher: async (input, init) => {
      calls.push({ url: String(input), init });
      const reply = replies.shift();
      return reply instanceof Response ? reply : Response.json(reply ?? { status: 'pending' });
    },
    delay: async ms => { sleeps.push(ms); time.now += ms; await new Promise(resolve => setTimeout(resolve, 0)); },
    ...options,
  });
  return { login, calls, commits, captures, sleeps, time };
}
function assertNoSecrets(login: ConsoleLogin): void {
  const text = JSON.stringify(login.status());
  for (const secret of [DEVICE_SECRET, TOKENS.controlKey, TOKENS.runtimeKey]) assert.equal(text.includes(secret), false);
  for (const field of ['deviceSecret', 'controlKey', 'runtimeKey', 'cookie', 'browserOpenFailed']) assert.equal(field in login.status(), false);
}
function assertNoCode(login: ConsoleLogin): void {
  const status = login.status();
  for (const field of ['activationUrl', 'userCode', 'expiresAt']) assert.equal(field in status, false);
}

test('start returns before capture/network; complete tokens commit directly without quota verification', async () => {
  const f = fixture();
  assert.deepEqual(f.login.status(), { jobId: null, state: 'idle' });
  const started = f.login.start(request);
  assert.equal(started.state, 'launching');
  assert.equal(f.calls.length, 0);
  assert.equal(f.captures.length, 0);
  assertNoCode(f.login);
  await waitFor(() => f.login.status().state === 'success');
  assert.equal(f.login.status().jobId, started.jobId);
  assert.ok(f.login.status().finishedAt);
  assert.deepEqual(f.captures, ['rev-1']);
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.commits[0]?.tokens, TOKENS);
  assert.deepEqual(f.commits[0]?.captured, { revision: 'rev-1' });
  assert.deepEqual(f.calls.map(call => call.url), [DEVICE_AUTH_ENDPOINT, `${DEVICE_AUTH_ENDPOINT}/fixture-device-id/token`]);
  assert.deepEqual(JSON.parse(String(f.calls[0]?.init?.body)), { cliVersion: DEVICE_AUTH_PLUGIN_VERSION, host: 'DSH CoRouter', profile: 'prod' });
  assert.deepEqual(JSON.parse(String(f.calls[1]?.init?.body)), { deviceSecret: DEVICE_SECRET });
  assert.ok(f.calls.every(call => call.init?.method === 'POST' && call.init.redirect === 'error'));
  assertNoSecrets(f.login);
  assertNoCode(f.login);
});

test('waiting exposes only official public fields, and clears them on cancel', async () => {
  const sleeping = deferred<void>();
  let sleepSignal: AbortSignal | undefined;
  const f = fixture({ options: { delay: async (_ms, signal) => { sleepSignal = signal; await sleeping.promise; } } });
  const started = f.login.start(request);
  await waitFor(() => f.login.status().state === 'waiting');
  const status = f.login.status();
  assert.equal(status.activationUrl, URL);
  assert.equal(status.userCode, CODE);
  assert.equal(status.expiresAt, new Date(START + 300_000).toISOString());
  assertNoSecrets(f.login);
  // Mutating returned snapshots cannot change the internal allowlist.
  status.activationUrl = 'https://evil.test/';
  assert.equal(f.login.status().activationUrl, URL);
  assert.equal(f.login.cancel({ jobId: 'not-this-job' }).state, 'waiting');
  assert.equal(f.login.cancel({ jobId: started.jobId! }).state, 'cancelled');
  assert.equal(sleepSignal?.aborted, true);
  sleeping.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
  assert.equal(f.commits.length, 0);
  assertNoCode(f.login);
});

test('server intervals have lower/upper bounds and every pending result waits before another poll', async () => {
  for (const [interval, expected] of [[0.001, 1000], [3, 3000], [60, 60_000]] as const) {
    const f = fixture({ replies: [authorization({ pollIntervalSeconds: interval }), { status: 'pending' }, { status: 'pending' }, { user: TOKENS }] });
    f.login.start(request);
    await waitFor(() => f.login.status().state === 'success');
    assert.deepEqual(f.sleeps, [expected, expected, expected]);
    assert.equal(f.calls.length, 4);
    assert.equal(f.commits.length, 1);
  }
});

test('a server interval beyond the local lifetime expires without an early poll', async () => {
  const f = fixture({ replies: [authorization({ pollIntervalSeconds: 600 })] });
  f.login.start(request);
  await waitFor(() => f.login.status().state === 'error');
  assert.equal(f.login.status().errorCode, 'opendesign/login-expired');
  assert.deepEqual(f.sleeps, [300_000]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.commits.length, 0);
});

test('half tokens and unknown status are terminal errors rather than busy retries', async () => {
  for (const value of [{ controlKey: TOKENS.controlKey }, { runtimeKey: TOKENS.runtimeKey }, { user: { controlKey: TOKENS.controlKey } }, { status: 'unexpected' }, { status: 'success' }]) {
    const f = fixture({ replies: [authorization(), value] });
    f.login.start(request);
    await waitFor(() => f.login.status().state === 'error');
    assert.equal(f.calls.length, 2);
    assert.equal(f.commits.length, 0);
    assertNoSecrets(f.login);
    assertNoCode(f.login);
  }
});

test('device-secret echoes and malicious activation URLs never become public', async () => {
  for (const changes of [
    { activationUrl: 'https://evil.test/' }, { activationUrl: `${URL}&deviceSecret=${DEVICE_SECRET}` },
    { activationUrl: `https://open-design.ai/cloud/cli/activate?code=${DEVICE_SECRET}`, userCode: DEVICE_SECRET },
    { userCode: DEVICE_SECRET }, { activationUrl: `${URL}#${DEVICE_SECRET}` },
  ]) {
    const f = fixture({ replies: [authorization(changes)] });
    f.login.start(request);
    await waitFor(() => f.login.status().state === 'error');
    assert.equal(f.calls.length, 1);
    assert.equal(f.commits.length, 0);
    assertNoSecrets(f.login);
    assertNoCode(f.login);
  }
});

test('expired/rejected/cancelled/denied responses and HTTP 401/403 terminate without committing', async () => {
  for (const value of [
    { status: 'expired' }, { status: 'cancelled' }, { status: 'denied' },
    new Response(DEVICE_SECRET, { status: 401 }), new Response(DEVICE_SECRET, { status: 403 }),
    new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
  ]) {
    const f = fixture({ replies: [authorization(), value] });
    f.login.start(request);
    await waitFor(() => f.login.status().state === 'error');
    assert.equal(f.commits.length, 0);
    assertNoSecrets(f.login);
    assertNoCode(f.login);
  }
});

test('server expiry and local five-minute cap use the earlier deadline, with no poll after expiry', async () => {
  for (const [serverMs, timeoutMs, expected] of [[1500, 300_000, 1500], [600_000, 1000, 1000], [600_000, 900_000, 300_000]] as const) {
    const f = fixture({ replies: [authorization({ expiresAt: new Date(START + serverMs).toISOString(), pollIntervalSeconds: 30 })], options: { timeoutMs } });
    f.login.start(request);
    await waitFor(() => f.login.status().state === 'error');
    assert.equal(f.login.status().errorCode, 'opendesign/login-expired');
    assert.equal(f.time.now, START + expected);
    assert.equal(f.commits.length, 0);
    assertNoCode(f.login);
    assert.equal(f.calls.length, expected > 30_000 ? 10 : 1);
  }
  const stale = fixture({ replies: [authorization({ expiresAt: new Date(START - 1).toISOString() })] });
  stale.login.start(request);
  await waitFor(() => stale.login.status().state === 'error');
  assert.equal(stale.calls.length, 1);
  assert.equal(stale.sleeps.length, 0);
});

test('status invalidates expired codes even while a custom delay has not returned', async () => {
  const gate = deferred<void>();
  const f = fixture({ options: { delay: async () => gate.promise } });
  f.login.start(request);
  await waitFor(() => f.login.status().state === 'waiting');
  f.time.now += 300_000;
  assert.equal(f.login.status().state, 'error');
  assertNoCode(f.login);
  gate.resolve();
});

test('duplicate starts share pending capture/network jobs and new jobs can follow cancellation', async () => {
  const gate = deferred<unknown>();
  const f = fixture({ callbacks: { capture: async () => gate.promise } });
  const first = f.login.start(request);
  assert.equal(f.login.start({ expectedRevision: 'rev-other' }).jobId, first.jobId);
  f.login.cancel({ jobId: first.jobId! });
  const second = f.login.start({ expectedRevision: 'rev-new' });
  assert.notEqual(first.jobId, second.jobId);
  gate.resolve({ revision: 'rev-new' });
  await waitFor(() => f.login.status().state === 'success');
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.commits[0]?.captured, { revision: 'rev-new' });
});

test('capture failure and unsanitized host errors cannot leak secrets or start HTTP requests', async () => {
  for (const code of ['opendesign/revision-conflict', DEVICE_SECRET]) {
    const f = fixture({ callbacks: { capture: () => { throw Object.assign(new Error(DEVICE_SECRET), { code }); } } });
    f.login.start(request);
    await waitFor(() => f.login.status().state === 'error');
    assert.equal(f.login.status().errorCode, code === DEVICE_SECRET ? 'opendesign/login-capture' : code);
    assert.equal(f.calls.length, 0);
    assertNoSecrets(f.login);
  }
});

test('cancel/dispose abort in-flight fetch and prevent late network results from committing', async () => {
  for (const dispose of [false, true]) {
    const gate = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const f = fixture({ options: { fetcher: async (_input, init) => { signal = init?.signal; return gate.promise; } } });
    const started = f.login.start(request);
    await waitFor(() => signal !== undefined);
    if (dispose) f.login.dispose(); else f.login.cancel({ jobId: started.jobId! });
    assert.equal(signal?.aborted, true);
    gate.resolve(Response.json(authorization()));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.login.status().state, 'cancelled');
    assert.equal(f.commits.length, 0);
    assertNoCode(f.login);
  }
});

test('cancel/dispose/timeout defer to atomic commit acceptance in both race orders', async t => {
  for (const trigger of ['cancel', 'dispose', 'timeout'] as const) {
    for (const accepted of [true, false]) {
      await t.test(`${trigger}: accepted=${accepted}`, async () => {
        const gate = deferred<void>();
        let commitSignal: AbortSignal | undefined;
        let writes = 0;
        const { login } = fixture({
          callbacks: { commit: async (_tokens, _captured, signal) => {
            commitSignal = signal;
            if (accepted) writes++;
            await gate.promise;
            if (!accepted) { signal.throwIfAborted(); writes++; }
          } },
          // Keep the synthetic clock inside the shortened real-time deadline so expiry
          // happens while the Host's commit is pending, not during its preceding poll.
          options: trigger === 'timeout' ? { timeoutMs: 60, delay: async () => undefined } : { timeoutMs: 10_000 },
        });
        const started = login.start(request);
        await waitFor(() => commitSignal !== undefined);
        assertNoCode(login);
        if (trigger === 'cancel') login.cancel({ jobId: started.jobId! });
        else if (trigger === 'dispose') login.dispose();
        await waitFor(() => commitSignal?.aborted === true);
        assert.equal(login.status().state, 'verifying');
        assert.equal(login.status().finishedAt, undefined);
        if (trigger !== 'dispose') assert.equal(login.start(request).jobId, started.jobId);
        gate.resolve();
        await waitFor(() => login.status().state === (accepted ? 'success' : 'cancelled'));
        assert.equal(writes, accepted ? 1 : 0);
        assertNoSecrets(login);
        assertNoCode(login);
      });
    }
  }
});

test('commit exceptions are safe terminal errors, with no duplicate write or token re-poll', async () => {
  for (const code of ['opendesign/revision-conflict', 'private-unsafe-code']) {
    let attempts = 0;
    const f = fixture({ callbacks: { commit: async () => { attempts++; throw Object.assign(new Error(DEVICE_SECRET), { code }); } } });
    f.login.start(request);
    await waitFor(() => f.login.status().state === 'error');
    assert.equal(f.login.status().errorCode, code === 'opendesign/revision-conflict' ? code : 'opendesign/login-commit');
    assert.equal(attempts, 1);
    assert.equal(f.calls.length, 2);
    assertNoSecrets(f.login);
  }
});

test('dispose during capture cancels, and starting after dispose throws', async () => {
  const gate = deferred<unknown>();
  const f = fixture({ callbacks: { capture: async () => gate.promise } });
  f.login.start(request);
  f.login.dispose();
  gate.resolve({});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.login.status().state, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.login.start(request), error => error instanceof LoginError && error.code === 'opendesign/login-disposed');
});
