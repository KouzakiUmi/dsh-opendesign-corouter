import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { setImmediate as tick } from 'node:timers/promises';
import { CredentialProvider, type CredentialKey, type CredentialRecord, type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { OpenDesignCoRouterService, type HostDependencies } from '../src/index.js';
import { parseStatus } from '../src/remote.js';
import type { RuntimeConfig } from '../src/config.js';
import { ConsoleError, type QuotaSnapshot } from '../src/quota.js';
import type { QuotaCacheRecord } from '../src/quota-cache.js';
/** Every credential store created by a fixture context, in creation order. */
const credentialStores: MemoryCredentials[] = [];
class MemoryCredentials extends CredentialProvider {
  readonly data = new Map<CredentialKey, CredentialRecord>();
  constructor(ctx: Context) { super(ctx); credentialStores.push(this); }
  readonly resolved: string[] = [];
  async resolve(ref: CredentialRef) { this.resolved.push(String(ref)); return undefined; }
  async describe(_ref: CredentialRef) { return { configured: false, writable: true }; }
  async set(_ref: CredentialRef, _value: string) { throw new Error('references are not written'); }
  async unset(_ref: CredentialRef) { throw new Error('references are not written'); }
  async readRecord(key: CredentialKey) { return structuredClone(this.data.get(key)); }
  async describeRecord(key: CredentialKey) { const value = this.data.get(key); return { configured: value !== undefined, writable: true, ...(value ? { kind: value.kind } : {}) }; }
  async listRecords() { return [...this.data.entries()].map(([key, value]) => ({ key, kind: value.kind })); }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) { const next = await mutate(await this.readRecord(key)); if (next) this.data.set(key, structuredClone(next)); return this.readRecord(key); }
  async deleteRecord(key: CredentialKey) { this.data.delete(key); }
}
const config: RuntimeConfig = { apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://amr-link.open-design.ai/v1', useDesktopCredential: true, emptyTurnGuard: true, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 };
const quota: QuotaSnapshot = { state: 'ok', source: 'login', updatedAt: '2026-10-26T08:00:00Z', eligible: false, windows: [], balances: { subscriptionUsd: 10, rechargeUsd: 2, totalUsd: 12 } };
function dependencies(calls: boolean[]): HostDependencies {
  return {
    readDesktopCredential: async () => ({ state: 'missing' }), modelAccount: async () => undefined, modelAutoRefresh: false,
    resolveSession: async deps => {
      const desktop = deps?.useDesktop !== false; calls.push(desktop);
      return { state: 'ready', warnings: [], session: { source: desktop ? 'desktop' : 'login', via: desktop ? 'desktop' : 'login', apiUrl: 'https://amr-api.open-design.ai', headers: desktop ? { authorization: 'Bearer fixture' } : { cookie: 'fixture=session' } } };
    },
    readDesktopQuota: async () => { throw new ConsoleError('auth', 401); },
    readQuota: async () => structuredClone(quota),
  };
}
test('expired desktop credentials fall back to a single console identity, and quota refresh is throttled', async () => {
  const ctx = new Context(), calls: boolean[] = [];
  const credentials = await ctx.plugin(MemoryCredentials);
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, dependencies(calls)); });
  try {
    const service = ctx.openDesignCoRouter;
    const result = await service.refreshQuota();
    assert.deepEqual(calls, [true, false]);
    const { nextRefreshAt, ...snapshot } = result;
    assert.deepEqual(snapshot, quota);
    assert.ok(nextRefreshAt && Date.parse(nextRefreshAt) > Date.now());
    await service.refreshQuota();
    assert.deepEqual(calls, [true, false]); // valid cache prevents another CLI/network burst
    assert.equal((await service.status()).sessionSource, 'login');
  } finally { await fiber.dispose(); await credentials.dispose(); }
});
test('status preserves catalog modality evidence separately from the saved override', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const current: RuntimeConfig = { ...config, modelSettings: { 'gpt-6.1-sol': { imageInput: false }, 'muse-wonder': { imageInput: true } } };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, dependencies([])); });
  try {
    const result = await ctx.openDesignCoRouter.status();
    assert.deepEqual(result.models.find(model => model.id === 'gpt-6.1-sol')?.inputModalities, ['text', 'image']);
    assert.equal(result.models.find(model => model.id === 'muse-wonder')?.inputModalities, undefined);
    assert.equal(result.config.modelSettings?.['gpt-6.1-sol']?.imageInput, false);
    assert.equal(result.config.modelSettings?.['muse-wonder']?.imageInput, true);
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('Host status and transport preserve toggle/fixed evidence without claiming unverified account coverage', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const current: RuntimeConfig = { ...config, useDesktopCredential: false, apiProtocol: 'auto' };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, dependencies([])); });
  try {
    const status = await ctx.openDesignCoRouter.status();
    const parsed = parseStatus(JSON.parse(JSON.stringify(status)));
    assert.equal(parsed.models.length, 46);
    for (const snapshot of [status, parsed]) {
      for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'qwen3.7-max', 'hy4', 'hy4-flash']) {
        const row = snapshot.models.find(model => model.id === id)!;
        assert.equal(row.reasoningMode, 'toggle', id);
        assert.deepEqual(row.catalogReasoningEfforts, ['none', 'high'], 'raw catalog evidence remains available for protocol changes');
        assert.equal(row.catalogDefaultEffort, 'high');
        assert.deepEqual(row.reasoningEfforts, id === 'hy4' || id === 'hy4-flash' ? ['high'] : ['none', 'high'], 'active controls obey the exact-model auto route');
        assert.equal(row.defaultEffort, 'high');
        assert.equal(row.coverage, 'unknown');
        assert.equal(row.group, 'paid');
      }
      const fixed = snapshot.models.find(model => model.id === 'kimi-k2.7-code')!;
      assert.equal(fixed.reasoningMode, 'fixed');
      assert.deepEqual(fixed.reasoningEfforts, []);
      for (const id of ['gemini-4-carbon', 'muse-ember-1.0', 'muse-wonder']) {
        const row = snapshot.models.find(model => model.id === id)!;
        assert.equal(row.reasoningMode, undefined);
        assert.equal(row.reasoningEfforts, undefined);
        assert.equal(row.defaultEffort, undefined);
      }
    }
    current.modelSettings = { 'qwen3.7-max': { apiProtocol: 'responses' } };
    const changed = parseStatus(JSON.parse(JSON.stringify(await ctx.openDesignCoRouter.status())));
    const qwen = changed.models.find(model => model.id === 'qwen3.7-max')!;
    assert.deepEqual(qwen.catalogReasoningEfforts, ['none', 'high']);
    assert.equal(qwen.catalogDefaultEffort, 'high');
    assert.deepEqual(qwen.reasoningEfforts, [], 'unverified Qwen Responses control is not advertised');
    assert.equal(qwen.defaultEffort, undefined, 'no inherited Chat default on an unsupported wire');
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('an unnamed reference reaches the client as an empty field while requests keep the default one', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const store = ctx.credentials as MemoryCredentials;
  // The profile names nothing: the Host model page then gets no reference to report as missing.
  const { apiKeyEnv: _named, ...unnamed } = config;
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => unnamed, dependencies([])); });
  try {
    const result = await ctx.openDesignCoRouter.status();
    assert.equal(result.config.apiKeyEnv, '');
    // Requests still resolve the plugin's own default reference with nothing named.
    assert.ok(store.resolved.includes('COROUTER_API_KEY'));
    // The browser transport accepts that empty field verbatim.
    assert.equal(parseStatus(JSON.parse(JSON.stringify(result))).config.apiKeyEnv, '');
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('manual refresh bypasses a healthy cache while ordinary reads remain cached', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const deps = dependencies([]);
  let reads = 0;
  deps.readQuota = async () => ({ ...quota, balances: { totalUsd: ++reads } });
  const current = { ...config, useDesktopCredential: false };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, deps); });
  try {
    const service = ctx.openDesignCoRouter;
    assert.equal((await service.refreshQuota()).balances.totalUsd, 1);
    assert.equal((await service.refreshQuota()).balances.totalUsd, 1);
    assert.equal((await service.refreshQuotaNow()).balances.totalUsd, 2);
    assert.equal((await service.refreshQuota()).balances.totalUsd, 2);
    assert.equal(reads, 2);
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('automatic quota retries back off, stop after six failures, and resume on manual refresh', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const deps = dependencies([]);
  let reads = 0, fail = true;
  deps.readQuota = async () => { reads++; if (fail) throw new ConsoleError('network'); return structuredClone(quota); };
  const current = { ...config, useDesktopCredential: false };
  const oldNow = Date.now;
  let clock = oldNow();
  Date.now = () => clock;
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, deps); });
  try {
    const service = ctx.openDesignCoRouter;
    let result = await service.refreshQuota();
    const delays = [5000, 10000, 20000, 40000, 60000];
    for (let attempt = 1; attempt <= 6; attempt++) {
      assert.equal(result.refreshFailures, attempt);
      if (attempt === 6) break;
      assert.ok(result.nextRefreshAt);
      assert.equal(Date.parse(result.nextRefreshAt) - clock, delays[attempt - 1]);
      await service.refreshQuota();
      assert.equal(reads, attempt, 'the backoff window must not start another request');
      clock = Date.parse(result.nextRefreshAt);
      result = await service.refreshQuota();
    }
    assert.equal(result.autoRefreshPaused, true);
    assert.equal(result.nextRefreshAt, undefined);
    clock += 3600000;
    await service.refreshQuota();
    assert.equal(reads, 6);
    const restarted = await service.refreshQuotaNow();
    assert.equal(restarted.refreshFailures, 1);
    assert.equal(restarted.autoRefreshPaused, false);
    fail = false;
    const recovered = await service.refreshQuotaNow();
    assert.equal(recovered.state, 'ok');
    assert.equal(recovered.refreshFailures, undefined);
    assert.equal(recovered.autoRefreshPaused, undefined);
  } finally { Date.now = oldNow; await fiber.dispose(); await credentials.dispose(); }
});

test('partial desktop quota falls back as a whole to the complete independent login', async () => {
  const ctx = new Context(), calls: boolean[] = [];
  const credentials = await ctx.plugin(MemoryCredentials);
  const deps = dependencies(calls);
  deps.readDesktopQuota = async () => ({ state: 'partial', source: 'desktop', updatedAt: quota.updatedAt, windows: [], balances: { totalUsd: 999 } });
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, deps); });
  try {
    const result = await ctx.openDesignCoRouter.refreshQuota();
    assert.deepEqual(calls, [true, false]);
    assert.equal(result.source, 'login');
    assert.deepEqual(result.balances, quota.balances);
    assert.match(result.note ?? '', /独立登录/u);
    assert.ok(result.nextRefreshAt);
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('model discovery uses the OpenAI base independently of inference selection and keeps failures visible', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const current: RuntimeConfig = { ...config, apiProtocol: 'messages' };
  let requests = 0, fail = false, notifications = 0;
  const deps = dependencies([]);
  deps.modelsChanged = () => { notifications++; };
  deps.fetchModels = async (base, key) => {
    requests++;
    assert.equal(base, config.baseURL);
    assert.equal(key, 'fixture-model-key');
    if (fail) throw new Error('PRIVATE_SERVER_BODY');
    return [{ id: 'new-model', name: 'New model', group: 'paid' }];
  };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, deps); });
  try {
    const service = ctx.openDesignCoRouter;
    await service.saveApiKey({ value: 'fixture-model-key', expectedRevision: (await service.status()).revision });
    const found = await service.refreshModels();
    assert.equal(found.modelsSource, 'openai');
    assert.equal(found.models[0]?.id, 'new-model');
    assert.ok(found.modelsUpdatedAt);
    current.apiProtocol = 'responses';
    assert.equal((await service.status()).modelsSource, 'openai');
    assert.equal(requests, 1);
    fail = true;
    const failed = await service.refreshModels();
    assert.equal(failed.models[0]?.id, 'new-model');
    assert.match(failed.modelsError ?? '', /账号权益暂时无法读取/u);
    assert.equal(JSON.stringify(failed).includes('PRIVATE_SERVER_BODY'), false);
    assert.equal(notifications, 1);
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('ordinary quota refresh failures retain same-identity readings while auth or identity changes clear them', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const current = { ...config, useDesktopCredential: false };
  let failure: 'network' | 'auth' | undefined;
  let identity = 'first';
  const deps = dependencies([]);
  deps.resolveSession = async () => ({ state: 'ready', warnings: [], session: { source: 'login', via: 'login', apiUrl: 'https://amr-api.open-design.ai', headers: { cookie: `${identity}=fixture` } } });
  deps.readQuota = async () => { if (failure) throw new ConsoleError(failure); return structuredClone(quota); };
  const oldNow = Date.now;
  let clock = oldNow();
  Date.now = () => clock;
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, deps); });
  try {
    const service = ctx.openDesignCoRouter;
    await service.refreshQuota();
    clock += 61_000;
    failure = 'network';
    const stale = await service.refreshQuota();
    assert.equal(stale.stale, true);
    assert.equal(stale.updatedAt, quota.updatedAt);
    assert.deepEqual(stale.balances, quota.balances);
    assert.match(stale.note ?? '', /上次成功读数/u);
    assert.ok(stale.nextRefreshAt);
    clock += 6000;
    identity = 'other';
    const changed = await service.refreshQuota();
    assert.equal(changed.state, 'error');
    assert.deepEqual(changed.balances, {});
    assert.ok(changed.nextRefreshAt);
    clock = Date.parse(changed.nextRefreshAt);
    failure = 'auth';
    const unauthenticated = await service.refreshQuota();
    assert.equal(unauthenticated.state, 'need-login');
    assert.equal(unauthenticated.nextRefreshAt, undefined);
    assert.deepEqual(unauthenticated.balances, {});
  } finally { Date.now = oldNow; await fiber.dispose(); await credentials.dispose(); }
});

test('failed optional console fallback preserves the usable desktop snapshot', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const deps = dependencies([]);
  deps.readDesktopQuota = async () => ({ state: 'partial', source: 'desktop', updatedAt: quota.updatedAt, windows: [], balances: { totalUsd: 19 } });
  deps.readQuota = async () => { throw new ConsoleError('network'); };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, deps); });
  try {
    const snapshot = await ctx.openDesignCoRouter.refreshQuota();
    assert.equal(snapshot.source, 'desktop');
    assert.equal(snapshot.balances.totalUsd, 19);
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('desktop fallback cache identity follows the selected login, never the desktop that was replaced', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const deps = dependencies([]);
  let account = 'first', failure = false;
  deps.resolveSession = async input => input?.useDesktop !== false
    ? { state: 'ready', warnings: [], session: { source: 'desktop', via: 'desktop', apiUrl: 'https://amr-api.open-design.ai', headers: { authorization: 'Bearer desktop' } } }
    : { state: 'ready', warnings: [], session: { source: 'login', via: 'login', apiUrl: 'https://amr-api.open-design.ai', headers: { cookie: `${account}=fixture` } } };
  deps.readQuota = async () => { if (failure) throw new ConsoleError('network'); return structuredClone(quota); };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, deps); });
  try {
    const service = ctx.openDesignCoRouter;
    assert.equal((await service.refreshQuotaNow()).source, 'login');
    failure = true;
    const same = await service.refreshQuotaNow();
    assert.equal(same.stale, true);
    assert.deepEqual(same.balances, quota.balances);
    account = 'second';
    const changed = await service.refreshQuotaNow();
    assert.equal(changed.state, 'error');
    assert.equal(changed.stale, undefined);
    assert.deepEqual(changed.balances, {});
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

test('API key saves use owned credential records, reject stale writes and never echo values', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, dependencies([])); });
  try {
    const service = ctx.openDesignCoRouter, before = await service.status();
    const after = await service.saveApiKey({ value: 'fixture-secret-not-echoed', expectedRevision: before.revision });
    assert.equal(after.apiKeyConfigured, true);
    assert.notEqual(after.revision, before.revision);
    assert.equal(JSON.stringify(after).includes('fixture-secret-not-echoed'), false);
    assert.equal(await service.resolveApiKey('FIXTURE_KEY'), 'fixture-secret-not-echoed');
    await assert.rejects(service.saveApiKey({ value: 'fixture-stale', expectedRevision: before.revision }), { code: 'opendesign/revision-conflict' });
    assert.equal(await service.resolveApiKey('FIXTURE_KEY'), 'fixture-secret-not-echoed');
  } finally { await fiber.dispose(); await credentials.dispose(); }
});

/** Minimal settings writer: the plugin persists its saved readings through this service. */
class FakeSettings extends Service {
  readonly stored: Record<string, unknown> = {};
  updates = 0;
  private revision = 0;
  constructor(ctx: Context) { super(ctx, 'settings'); }
  describe() { return [{ ns: 'llm-opendesign-corouter', revision: this.revision }]; }
  async update(ns: string, patch: Record<string, unknown>) {
    this.updates += 1; this.revision += 1;
    Object.assign(this.stored, structuredClone(patch));
  }
}
/** A reading taken now: the saved copy is recent enough not to be rewritten immediately. */
const METERED_READ_AT = new Date().toISOString();
const meteredQuota: QuotaSnapshot = {
  state: 'ok', source: 'login', updatedAt: METERED_READ_AT, tier: 'go', eligible: true,
  windows: [{ durationSeconds: 18_000, used: 120, limit: 500, remaining: 380, percent: 24, resetsAt: '2026-11-18T13:00:00.000Z' }],
  balances: { subscriptionUsd: 12.5, rechargeUsd: 3, totalUsd: 15.5 },
};
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } assert.fail('fixture did not settle'); }
/** The binding secret lives in the credential service; a reloaded profile keeps the same store. */
function seedCredentials(target: MemoryCredentials, source: MemoryCredentials) {
  for (const [key, value] of source.data) target.data.set(key, structuredClone(value));
}
function meteredDependencies(reads: { count: number }, quota: QuotaSnapshot = meteredQuota): HostDependencies {
  return { ...dependencies([]), readDesktopQuota: async () => { reads.count += 1; throw new ConsoleError('auth', 401); }, readQuota: async () => { reads.count += 1; return structuredClone(quota); } };
}

test('a committed quota reading survives a plugin reload and answers the status read', async () => {
  const first = new Context();
  const firstCredentials = await first.plugin(MemoryCredentials);
  const firstStore = credentialStores.at(-1)!;
  const firstSettings = await first.plugin(FakeSettings);
  const firstFiber = await first.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, meteredDependencies({ count: 0 })); });
  let saved: QuotaCacheRecord | undefined;
  try {
    await first.openDesignCoRouter.refreshQuotaNow();
    const writer = first.get('settings') as unknown as FakeSettings;
    await until(() => writer.stored.quotaCache !== undefined);
    saved = writer.stored.quotaCache as QuotaCacheRecord;
    assert.equal(saved.version, 1);
    assert.match(saved.binding, /^[a-f0-9]{64}$/u);
    assert.deepEqual(saved.snapshot.windows, meteredQuota.windows);
    assert.equal(saved.snapshot.nextRefreshAt, undefined, 'the refresh plan stays in memory');
    assert.equal(writer.updates, 1);
    // A repeated read with the same numbers does not rewrite the profile.
    await first.openDesignCoRouter.refreshQuotaNow();
    await tick();
    assert.equal(writer.updates, 1);
  } finally { await firstFiber.dispose(); await firstCredentials.dispose(); await firstSettings.dispose(); }

  const second = new Context();
  const secondCredentials = await second.plugin(MemoryCredentials);
  seedCredentials(credentialStores.at(-1)!, credentialStores.at(-2)!);
  const secondSettings = await second.plugin(FakeSettings);
  const reads = { count: 0 };
  const restoredConfig: RuntimeConfig = { ...config, quotaCache: saved };
  const secondFiber = await second.plugin(scope => { new OpenDesignCoRouterService(scope, () => restoredConfig, meteredDependencies(reads)); });
  try {
    const service = second.openDesignCoRouter;
    const status = await service.status();
    assert.equal(status.quota.stale, true, 'the saved reading is shown as the last successful read');
    assert.deepEqual(status.quota.windows, meteredQuota.windows);
    assert.deepEqual(status.quota.balances, meteredQuota.balances);
    assert.equal(status.quota.updatedAt, meteredQuota.updatedAt, 'the reading keeps its own update time');
    assert.equal(status.sessionSource, 'login');
    assert.equal(reads.count, 0, 'the UI read never waits for an upstream read');
    // A read that repeats the saved numbers must not rewrite the profile and rebuild the plugin.
    const repeated = await service.refreshQuotaNow();
    await tick();
    assert.deepEqual(repeated.windows, meteredQuota.windows);
    assert.equal((second.get('settings') as unknown as FakeSettings).updates, 0, 'unchanged numbers do not write settings');
  } finally { await secondFiber.dispose(); await secondCredentials.dispose(); await secondSettings.dispose(); }
});

test('a saved reading is not shown for another identity, an expired record or a damaged one', async () => {
  const first = new Context();
  const firstCredentials = await first.plugin(MemoryCredentials);
  const firstStore = credentialStores.at(-1)!;
  const firstSettings = await first.plugin(FakeSettings);
  const firstFiber = await first.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, meteredDependencies({ count: 0 })); });
  let saved: QuotaCacheRecord;
  try {
    await first.openDesignCoRouter.refreshQuotaNow();
    const writer = first.get('settings') as unknown as FakeSettings;
    await until(() => writer.stored.quotaCache !== undefined);
    saved = writer.stored.quotaCache as QuotaCacheRecord;
  } finally { await firstFiber.dispose(); await firstCredentials.dispose(); await firstSettings.dispose(); }

  const cases: Array<[string, RuntimeConfig]> = [
    ['another identity', { ...config, useDesktopCredential: false, quotaCache: saved }],
    ['an expired record', { ...config, quotaCache: { ...saved, readAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString() } }],
    ['a damaged record', { ...config, quotaCache: { ...saved, binding: 'broken' } as unknown as QuotaCacheRecord }],
  ];
  for (const [label, runtime] of cases) {
    const ctx = new Context();
    const credentials = await ctx.plugin(MemoryCredentials);
    seedCredentials(credentialStores.at(-1)!, firstStore);
    const reads = { count: 0 };
    const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => runtime, meteredDependencies(reads)); });
    try {
      const status = await ctx.openDesignCoRouter.status();
      assert.equal(status.quota.stale, undefined, label);
      assert.deepEqual(status.quota.windows, [], `${label} shows no foreign numbers`);
      assert.equal(reads.count, 0);
    } finally { await fiber.dispose(); await credentials.dispose(); }
  }
});

test('a failed refresh after a reload keeps the saved reading instead of replacing it with an error', async () => {
  const first = new Context();
  const firstCredentials = await first.plugin(MemoryCredentials);
  const firstStore = credentialStores.at(-1)!;
  const firstSettings = await first.plugin(FakeSettings);
  const firstFiber = await first.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, meteredDependencies({ count: 0 })); });
  let saved: QuotaCacheRecord;
  try {
    await first.openDesignCoRouter.refreshQuotaNow();
    const writer = first.get('settings') as unknown as FakeSettings;
    await until(() => writer.stored.quotaCache !== undefined);
    saved = writer.stored.quotaCache as QuotaCacheRecord;
  } finally { await firstFiber.dispose(); await firstCredentials.dispose(); await firstSettings.dispose(); }

  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  seedCredentials(credentialStores.at(-1)!, firstStore);
  const failing: HostDependencies = {
    ...dependencies([]),
    readDesktopQuota: async () => { throw new ConsoleError('network'); },
    readQuota: async () => { throw new ConsoleError('network'); },
  };
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => ({ ...config, quotaCache: saved }), failing); });
  try {
    const service = ctx.openDesignCoRouter;
    assert.equal((await service.status()).quota.stale, true);
    const afterFailure = await service.refreshQuotaNow();
    assert.deepEqual(afterFailure.windows, meteredQuota.windows, 'the saved numbers survive a failed read');
    assert.equal(afterFailure.stale, true);
    assert.match(afterFailure.note ?? '', /上次成功读数/u);
  } finally { await fiber.dispose(); await credentials.dispose(); }
});
