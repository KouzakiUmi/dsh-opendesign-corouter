// Fully offline Host -> device protocol -> atomic credential store -> inference/quota wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { CredentialProvider, credentialKey, type CredentialKey, type CredentialRecord, type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { OpenDesignCoRouterService, name, type HostDependencies } from '../src/index.js';
import { resolveSession } from '../src/auth.js';
import { readQuota, CURRENT_URL, SUMMARY_URL, preflightUrl, usageUrl } from '../src/quota.js';
import { DEVICE_AUTH_ENDPOINT } from '../src/device-auth.js';
import type { RuntimeConfig } from '../src/config.js';
import type { ActivationBrowser, ActivationLauncherOptions } from '../src/browser-open.js';

const SESSION = credentialKey(name, 'console');
const API_KEY = credentialKey(name, 'api-key');
const tokens = { controlKey: 'fixture-device-control', runtimeKey: 'fixture-device-runtime' };
const config = (): RuntimeConfig => ({ apiKeyEnv: 'FIXTURE_DEVICE_KEY', baseURL: 'https://amr-link.open-design.ai/v1', useDesktopCredential: false, emptyTurnGuard: true, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 });
class Store extends CredentialProvider {
  readonly data = new Map<CredentialKey, CredentialRecord>();
  ambient: string | undefined;
  writes = 0;
  beforeMutate?: () => Promise<void>;
  afterAccept?: () => Promise<void>;
  reject = false;
  constructor(ctx: Context) { super(ctx); }
  async resolve(_ref: CredentialRef) { return this.ambient ? { value: this.ambient, source: 'fixture' } : undefined; }
  async describe(_ref: CredentialRef) { return { configured: !!this.ambient, writable: true }; }
  async set(_ref: CredentialRef, _value: string): Promise<void> { throw new Error('no environment writes'); }
  async unset(_ref: CredentialRef): Promise<void> { throw new Error('no environment writes'); }
  async readRecord(key: CredentialKey) { return structuredClone(this.data.get(key)); }
  async describeRecord(key: CredentialKey) { const value = this.data.get(key); return { configured: !!value, writable: true, ...(value ? { kind: value.kind } : {}) }; }
  async listRecords() { return [...this.data].map(([key, value]) => ({ key, kind: value.kind })); }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    await this.beforeMutate?.();
    if (this.reject) throw new Error('PRIVATE_STORE_ERROR');
    const next = await mutate(await this.readRecord(key));
    if (next) { this.data.set(key, structuredClone(next)); this.writes++; }
    await this.afterAccept?.();
    return this.readRecord(key);
  }
  async deleteRecord(key: CredentialKey): Promise<void> { this.data.delete(key); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function deviceFetcher(beforeToken?: () => Promise<void>): typeof fetch {
  return async (input, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    if (String(input) === DEVICE_AUTH_ENDPOINT) return Response.json({ deviceId: 'fixture-device', deviceSecret: 'fixture-poll-secret', userCode: 'TEST-1234', activationUrl: 'https://open-design.ai/cloud/cli/activate?code=TEST-1234', pollIntervalSeconds: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(String(input), `${DEVICE_AUTH_ENDPOINT}/fixture-device/token`);
    assert.deepEqual(JSON.parse(String(init?.body)), { deviceSecret: 'fixture-poll-secret' });
    await beforeToken?.();
    return Response.json({ status: 'approved', ...tokens });
  };
}
async function fixture(options: { fetcher?: typeof fetch; setup?: (store: Store) => void; configure?: (current: RuntimeConfig) => void; activation?: ActivationLauncherOptions } = {}) {
  const ctx = new Context();
  const credentialFiber = await ctx.plugin(Store);
  const store = ctx.get('credentials') as Store;
  options.setup?.(store);
  const current = config(); options.configure?.(current);
  let desktopReads = 0, quotaReads = 0, modelChanges = 0;
  const deps: HostDependencies = {
    resolveSession,
    readQuota: async (session, signal) => {
      quotaReads++;
      return readQuota(session, signal, async input => {
        if (String(input) === CURRENT_URL) return Response.json({ activeWorkspaceId: 'ws', workspaceId: 'ws', workspaceType: 'personal' });
        if (String(input) === preflightUrl('ws')) return Response.json({ codingPlan: { eligible: false }, balanceUsd: 7 });
        if (String(input) === usageUrl('ws')) return Response.json({ eligible: false });
        assert.equal(String(input), SUMMARY_URL);
        return new Response('{}', { status: 403 });
      });
    },
    readDesktopQuota: async () => { desktopReads++; throw new Error('must not invoke desktop CLI for device'); },
    fetchModels: async (_base, key) => { assert.equal(key, tokens.runtimeKey); return [{ id: 'device-model', name: 'Device model', group: 'paid' }]; },
    modelsChanged: () => { modelChanges++; },
    loginOptions: { fetcher: options.fetcher ?? deviceFetcher(), delay: async () => { await tick(); } },
    ...(options.activation === undefined ? {} : { activationOptions: options.activation }),
  };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, deps); });
  return { service: ctx.openDesignCoRouter, store, current, deps, counts: () => ({ desktopReads, quotaReads, modelChanges }), dispose: async () => { await fiber.dispose(); await credentialFiber.dispose(); } };
}
async function until(predicate: () => boolean): Promise<void> { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('fixture did not settle'); }
async function start(service: OpenDesignCoRouterService) { return service.startLogin({ expectedRevision: (await service.status()).revision }); }
function noSecrets(value: unknown) { const text = JSON.stringify(value); for (const secret of [...Object.values(tokens), 'fixture-poll-secret', 'PRIVATE_STORE_ERROR']) assert.equal(text.includes(secret), false); }

test('Host device login saves one grant, supplies official runtime fallback, and does not verify quota before save', async () => {
  const f = await fixture();
  try {
    const before = await f.service.status();
    const job = await start(f.service);
    assert.ok(job.jobId);
    await until(() => f.service.loginStatus().state === 'success');
    assert.equal(f.store.writes, 1);
    const grant = await f.store.readRecord(SESSION);
    assert.equal(grant?.kind, 'grant');
    if (grant?.kind !== 'grant') return;
    assert.deepEqual(Object.keys(grant.payload as object).sort(), ['controlKey', 'kind', 'runtimeKey', 'savedAt']);
    assert.deepEqual({ ...(grant.payload as object), savedAt: undefined }, { kind: 'device', ...tokens, savedAt: undefined });
    assert.equal(f.counts().quotaReads, 0);
    assert.equal(f.counts().desktopReads, 0);
    assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY'), tokens.runtimeKey);
    const after = await f.service.status();
    assert.notEqual(after.revision, before.revision);
    assert.equal(after.apiKeyConfigured, true);
    assert.equal(after.apiKeySource, 'device');
    assert.equal(after.quota.state, 'partial');
    assert.doesNotMatch(after.quota.note ?? '', /登录/u);
    noSecrets(after); noSecrets(f.service.loginStatus());
    const quota = await f.service.refreshQuotaNow();
    assert.equal(quota.state, 'partial');
    assert.deepEqual(quota.balances, { totalUsd: 7 });
    assert.equal(f.counts().desktopReads, 0);
    assert.equal((await f.service.refreshModels()).modelsSource, 'openai');
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'success');
    const invalidated = await f.service.status();
    assert.equal(invalidated.quota.state, 'partial');
    assert.match(invalidated.quota.note ?? '', /额度尚未读取/u);
    assert.equal(invalidated.apiKeySource, 'device');
    assert.equal(invalidated.modelsSource, 'builtin');
    assert.equal(f.counts().modelChanges, 2);
  } finally { await f.dispose(); }
});

test('explicit environment and saved keys beat device; device fallback only reaches exact requested official origin', async () => {
  const f = await fixture({ setup: store => { store.data.set(SESSION, { kind: 'grant', payload: { kind: 'device', ...tokens } }); } });
  try {
    for (const base of ['https://custom.example/v1', 'https://amr-link.open-design.ai:8443/v1', 'http://amr-link.open-design.ai/v1', 'https://amr-link.open-design.ai.evil.example/v1']) assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY', base), undefined);
    assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY', 'https://amr-link.open-design.ai/v1'), tokens.runtimeKey);
    f.current.baseURL = 'https://custom.example/v1';
    assert.equal((await f.service.status()).apiKeyConfigured, false);
    assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY', 'https://amr-link.open-design.ai/v1'), tokens.runtimeKey, 'request snapshot, not current setting, owns the origin gate');
    f.store.data.set(API_KEY, { kind: 'api-key', key: 'fixture-manual' });
    assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY'), 'fixture-manual');
    assert.equal((await f.service.status()).apiKeySource, 'stored');
    f.store.ambient = 'fixture-environment';
    assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY'), 'fixture-environment');
    assert.equal((await f.service.status()).apiKeySource, 'reference');
    const saved = await f.service.saveApiKey({ value: 'fixture-new-manual', expectedRevision: (await f.service.status()).revision });
    assert.equal(saved.apiKeySource, 'reference');
    assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY'), 'fixture-environment');
    noSecrets(await f.service.status());
  } finally { await f.dispose(); }
});

test('Host desktop fallback uses one captured SESSION grant rather than re-reading a switched account', async () => {
  const f = await fixture({ setup: store => { store.data.set(SESSION, { kind: 'grant', payload: { kind: 'device', ...tokens } }); }, configure: current => { current.useDesktopCredential = true; } });
  const seen: string[] = [];
  f.deps.resolveSession = async input => input?.useDesktop !== false
    ? { state: 'ready', warnings: [], session: { source: 'desktop', via: 'desktop', apiUrl: 'https://amr-api.open-design.ai', headers: { authorization: 'Bearer fixture-desktop' } } }
    : resolveSession({ ...input, useDesktop: false });
  f.deps.readDesktopQuota = async () => {
    f.store.data.set(SESSION, { kind: 'grant', payload: { kind: 'device', controlKey: 'fixture-switched-control', runtimeKey: 'fixture-switched-runtime' } });
    return { state: 'partial', source: 'desktop', updatedAt: new Date().toISOString(), windows: [], balances: { totalUsd: 999 } };
  };
  f.deps.readQuota = async session => {
    seen.push(session.headers.authorization!);
    return { state: 'ok', source: 'login', updatedAt: new Date().toISOString(), eligible: false, windows: [], balances: { subscriptionUsd: 1, rechargeUsd: 2, totalUsd: 3 } };
  };
  try {
    const result = await f.service.refreshQuotaNow();
    assert.deepEqual(seen, [`Bearer ${tokens.controlKey}`]);
    assert.equal(result.source, 'login');
    assert.deepEqual(result.balances, { subscriptionUsd: 1, rechargeUsd: 2, totalUsd: 3 });
    await f.service.refreshQuotaNow();
    assert.equal(seen[1], 'Bearer fixture-switched-control');
  } finally { await f.dispose(); }
});

test('Host store rejection is not login success and never exposes store errors', async () => {
  const f = await fixture({ setup: store => { store.reject = true; } });
  try {
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'error');
    assert.equal(f.store.writes, 0);
    assert.equal(await f.store.readRecord(SESSION), undefined);
    noSecrets(await f.service.status());
  } finally { await f.dispose(); }
});

test('Host rejects changed configuration and session snapshots before atomic device save', async () => {
  for (const change of ['config', 'session'] as const) {
    const reached = deferred(), release = deferred();
    const f = await fixture({ fetcher: deviceFetcher(async () => { reached.resolve(); await release.promise; }) });
    try {
      await start(f.service); await reached.promise;
      if (change === 'config') f.current.baseURL = 'https://custom.example/v1';
      else f.store.data.set(SESSION, { kind: 'grant', payload: { cookie: 'fixture=old' } });
      release.resolve();
      await until(() => f.service.loginStatus().state === 'error');
      assert.match(f.service.loginStatus().message ?? '', /设置已改变/u);
      assert.equal(f.store.writes, 0);
      noSecrets(await f.service.status());
    } finally { release.resolve(); await f.dispose(); }
  }
});

test('Host detects a session conflict that arrives while waiting for the credential mutex', async () => {
  const f = await fixture({ setup: store => { store.beforeMutate = async () => { store.data.set(SESSION, { kind: 'grant', payload: { cookie: 'fixture=concurrent' } }); }; } });
  try {
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'error');
    assert.equal(f.store.writes, 0);
    assert.deepEqual(await f.store.readRecord(SESSION), { kind: 'grant', payload: { cookie: 'fixture=concurrent' } });
    assert.match(f.service.loginStatus().message ?? '', /设置已改变/u);
  } finally { await f.dispose(); }
});

test('Host cancellation while waiting drops public approval data and ignores late token responses', async () => {
  const reached = deferred(), release = deferred();
  const f = await fixture({ fetcher: deviceFetcher(async () => { reached.resolve(); await release.promise; }) });
  try {
    const job = await start(f.service); await reached.promise;
    const waiting = f.service.loginStatus();
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.userCode, 'TEST-1234');
    noSecrets(waiting);
    f.service.cancelLogin({ jobId: job.jobId! });
    assert.equal(f.service.loginStatus().state, 'cancelled');
    assert.equal(f.service.loginStatus().userCode, undefined);
    assert.equal(f.service.loginStatus().activationUrl, undefined);
    release.resolve(); await tick();
    assert.equal(f.store.writes, 0);
    assert.equal(f.service.loginStatus().state, 'cancelled');
  } finally { release.resolve(); await f.dispose(); }
});

test('Host cancellation before store acceptance aborts write; cancellation after accepted atomic write reports success', async () => {
  for (const accepted of [false, true]) {
    const reached = deferred(), release = deferred();
    const f = await fixture({ setup: store => { const pause = async () => { reached.resolve(); await release.promise; }; if (accepted) store.afterAccept = pause; else store.beforeMutate = pause; } });
    try {
      const job = await start(f.service); await reached.promise;
      f.service.cancelLogin({ jobId: job.jobId! });
      release.resolve();
      await until(() => ['success', 'cancelled'].includes(f.service.loginStatus().state));
      assert.equal(f.service.loginStatus().state, accepted ? 'success' : 'cancelled');
      assert.equal(f.store.writes, accepted ? 1 : 0);
      assert.equal(!!await f.store.readRecord(SESSION), accepted);
      noSecrets(await f.service.status());
    } finally { release.resolve(); await f.dispose(); }
  }
});

test('Host legacy cookie grants stay read-only compatible and never become runtime credentials', async () => {
  const legacy = { cookie: 'fixture=legacy-cookie', expiresAt: Date.now() + 60_000 };
  const f = await fixture({ setup: store => { store.data.set(SESSION, { kind: 'grant', payload: legacy }); } });
  try {
    assert.equal(await f.service.resolveApiKey('FIXTURE_DEVICE_KEY'), undefined);
    const snapshot = await f.service.refreshQuotaNow();
    assert.equal(snapshot.source, 'login');
    assert.equal(f.store.writes, 0);
    assert.deepEqual(await f.store.readRecord(SESSION), { kind: 'grant', payload: legacy });
    noSecrets(await f.service.status());
  } finally { await f.dispose(); }
});

/** A stand-in Chrome that records navigations instead of visiting them. */
function fakeChrome() {
  const gotos: string[] = [];
  let closes = 0;
  const browser: ActivationBrowser = {
    close: async () => { closes++; },
    isConnected: () => true,
    newPage: async () => ({ goto: async url => { gotos.push(url); } }),
  };
  return { browser, gotos, closes: () => closes };
}

test('openActivationPage navigates the temporarily launched window to the Host-owned link', async () => {
  const chrome = fakeChrome();
  let launches = 0;
  const f = await fixture({ activation: { launch: async () => { launches++; return chrome.browser; } } });
  try {
    // Before an approval code exists there is nothing to show, and nothing is launched.
    assert.deepEqual(await f.service.openActivationPage(), { code: 'no-link', opened: false });
    assert.equal(launches, 0);
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'waiting');
    assert.deepEqual(await f.service.openActivationPage(), { code: 'opened', opened: true });
    assert.deepEqual(chrome.gotos, ['https://open-design.ai/cloud/cli/activate?code=TEST-1234']);
    // A second click reuses the same window instead of launching another Chrome.
    assert.deepEqual(await f.service.openActivationPage(), { code: 'opened', opened: true });
    assert.equal(launches, 1);
    noSecrets(await f.service.openActivationPage());
  } finally { await f.dispose(); }
  assert.equal(chrome.closes(), 1, 'plugin disposal closes the temporary window');
});

test('openActivationPage refuses to open once the approval window is gone', async () => {
  const chrome = fakeChrome();
  const f = await fixture({ activation: { launch: async () => chrome.browser } });
  try {
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'waiting');
    await f.service.cancelLogin({ jobId: f.service.loginStatus().jobId! });
    assert.deepEqual(await f.service.openActivationPage(), { code: 'no-link', opened: false });
    assert.deepEqual(chrome.gotos, [], 'a cancelled job has no link left to show');
  } finally { await f.dispose(); }
});

test('a missing Chrome reports unavailable without failing the login itself', async () => {
  const f = await fixture({ activation: { available: () => false, launch: async () => { throw new Error('must not launch'); } } });
  try {
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'waiting');
    assert.deepEqual(await f.service.openActivationPage(), { code: 'unavailable', opened: false });
    assert.equal(f.service.loginStatus().state, 'waiting');
    noSecrets(await f.service.status());
  } finally { await f.dispose(); }
});

test('cancelling or expiring an approval closes the window this plugin opened', async () => {
  const chrome = fakeChrome();
  const f = await fixture({ activation: { launch: async () => chrome.browser } });
  try {
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'waiting');
    assert.deepEqual(await f.service.openActivationPage(), { code: 'opened', opened: true });
    assert.equal(chrome.closes(), 0);
    const cancelled = f.service.cancelLogin({ jobId: f.service.loginStatus().jobId! });
    assert.equal(cancelled.state, 'cancelled');
    await until(() => chrome.closes() === 1);
    // The next approval may open a new window: closing is not retirement.
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'waiting');
    assert.deepEqual(await f.service.openActivationPage(), { code: 'opened', opened: true });
  } finally { await f.dispose(); }
});

test('the approval job closes its window on every terminal transition without polling', async () => {
  const chrome = fakeChrome();
  const f = await fixture({ activation: { launch: async () => chrome.browser } });
  try {
    // Each cycle opens a window, then ends the job through a non-polling path.
    for (const end of ['cancel', 'success'] as const) {
      await start(f.service);
      await until(() => f.service.loginStatus().state === 'waiting');
      assert.deepEqual(await f.service.openActivationPage(), { code: 'opened', opened: true });
      const before = chrome.closes();
      if (end === 'cancel') f.service.cancelLogin({ jobId: f.service.loginStatus().jobId! });
      else await until(() => f.service.loginStatus().state === 'success');
      await until(() => chrome.closes() === before + 1);
    }
  } finally { await f.dispose(); }
});

test('an expiry that nobody polls still closes the window', async () => {
  // The token endpoint never answers, so only the expiry timer can end this job — a
  // successful approval is impossible. No status surface is read while waiting.
  const chrome = fakeChrome();
  const f = await fixture({
    activation: { launch: async () => chrome.browser },
    fetcher: async input => {
      if (String(input) === DEVICE_AUTH_ENDPOINT) {
        return Response.json({ deviceId: 'fixture-device', deviceSecret: 'fixture-poll-secret', userCode: 'SHORT-1',
          activationUrl: 'https://open-design.ai/cloud/cli/activate?code=SHORT-1', pollIntervalSeconds: 1,
          expiresAt: new Date(Date.now() + 60).toISOString() });
      }
      return new Promise<Response>(() => undefined);
    },
  });
  try {
    await start(f.service);
    await until(() => f.service.loginStatus().state === 'waiting');
    assert.deepEqual(await f.service.openActivationPage(), { code: 'opened', opened: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    // Assert the window closed BEFORE reading any state, so the read cannot cause it.
    // The job's exact terminal code depends on the poll/expiry race in this fixture, but
    // every path is terminal and every terminal path must take the window away.
    await until(() => chrome.closes() === 1);
    assert.notEqual(f.service.loginStatus().state, 'waiting', 'the job itself reached a terminal state');
  } finally { await f.dispose(); }
});
