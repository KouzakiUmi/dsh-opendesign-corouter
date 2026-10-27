// Host integration tests for the model-refresh lifetime of OpenDesignCoRouterService.
//
// 只经公共 `status()` / `refreshModels()` 观察私有逻辑；所有 I/O 都是合成桩：
// MemoryCredentials 只存在内存里，`fetchModels` 通过真实 `fetchModelCatalog` 接到合成 fetch，
// 因此既有真实的发现归一化/错误分类，也绝不发出网络请求或读取任何真实凭据、主机 Profile。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { CredentialProvider, type CredentialKey, type CredentialRecord, type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { OpenDesignCoRouterService, type HostDependencies } from '../src/index.js';
import type { RuntimeConfig } from '../src/config.js';
import { fetchModelCatalog } from '../src/model-discovery.js';
import { MODELS } from '../src/catalog.js';
import { ConsoleError, type QuotaSnapshot } from '../src/quota.js';
import type { Status } from '../src/remote.js';

/**
 * Same in-memory credential seam as test/host.test.ts (not exported there): records live in
 * a Map, references never resolve, so no environment variable or real credential store is read.
 */
class MemoryCredentials extends CredentialProvider {
  readonly data = new Map<CredentialKey, CredentialRecord>();
  constructor(ctx: Context) { super(ctx); }
  async resolve(_ref: CredentialRef) { return undefined; }
  async describe(_ref: CredentialRef) { return { configured: false, writable: true }; }
  async set(_ref: CredentialRef, _value: string) { throw new Error('references are not written'); }
  async unset(_ref: CredentialRef) { throw new Error('references are not written'); }
  async readRecord(key: CredentialKey) { return structuredClone(this.data.get(key)); }
  async describeRecord(key: CredentialKey) { const value = this.data.get(key); return { configured: value !== undefined, writable: true, ...(value ? { kind: value.kind } : {}) }; }
  async listRecords() { return [...this.data.entries()].map(([key, value]) => ({ key, kind: value.kind })); }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) { const next = await mutate(await this.readRecord(key)); if (next) this.data.set(key, structuredClone(next)); return this.readRecord(key); }
  async deleteRecord(key: CredentialKey) { this.data.delete(key); }
}

const BASE = 'https://amr-link.open-design.ai/v1';
const KEY = 'fixture-model-key';
/** 任何失败信息都不得出现这些标记。 */
const SECRET = 'PRIVATE_SERVER_BODY';
const quota: QuotaSnapshot = { state: 'ok', source: 'login', updatedAt: '2026-10-26T08:00:00Z', windows: [], balances: {} };

function runtimeConfig(): RuntimeConfig {
  return {
    apiKeyEnv: 'FIXTURE_KEY', baseURL: BASE, useDesktopCredential: false, emptyTurnGuard: true,
    requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, apiProtocol: 'chat-completions', modelSettings: {}, quotaRefreshSeconds: 60,
  };
}

interface Wire { url: string; init: RequestInit }
type Responder = (call: Wire) => Response | Promise<Response>;

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A `fetch` replacement that records the wire request and answers from `respond`. */
function recordedFetch(calls: Wire[], respond: Responder): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Wire = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
}

/**
 * The host's `fetchModels` seam, wired to the real discovery function with a synthetic
 * transport: the service still validates the base URL, sends `GET {base}/models` with Bearer
 * auth and normalizes/classifies through src/model-discovery.ts, but nothing leaves the process.
 */
/** The host's discovery seam; the optional property is unwrapped so assignment stays exact. */
type ModelFetch = NonNullable<HostDependencies['fetchModels']>;

function modelDiscovery(calls: Wire[], respond: Responder): ModelFetch {
  const fetcher = recordedFetch(calls, respond);
  return (base, key, signal) => fetchModelCatalog(base, key, signal, fetcher);
}

function hostDependencies(calls: Wire[], respond: Responder, changed?: () => void): HostDependencies {
  return {
    resolveSession: async () => ({ state: 'ready', warnings: [], session: { source: 'login', via: 'login', apiUrl: 'https://amr-api.open-design.ai', headers: { cookie: 'fixture=session' } } }),
    readQuota: async () => structuredClone(quota),
    readDesktopQuota: async () => { throw new ConsoleError('auth', 401); },
    fetchModels: modelDiscovery(calls, respond),
    ...(changed ? { modelsChanged: changed } : {}),
  };
}

async function host(current: RuntimeConfig, deps: HostDependencies) {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => current, deps); });
  return {
    service: ctx.openDesignCoRouter,
    dispose: async () => { await fiber.dispose(); await credentials.dispose(); },
  };
}

/** Persist the fixture key through the owned credential record (never an environment read). */
async function saveFixtureKey(service: OpenDesignCoRouterService, value = KEY): Promise<void> {
  const { revision } = await service.status();
  await service.saveApiKey({ value, expectedRevision: revision });
}

async function waitForRequest(calls: Wire[], count: number): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (calls.length >= count) return;
    await tick();
  }
  assert.fail(`synthetic request ${count} never started`);
}

const list = (...ids: string[]): Response => Response.json({ object: 'list', data: ids.map(id => ({ id, object: 'model', name: `${id} label` })) });
const signalOf = (call: Wire): AbortSignal => {
  const signal = call.init.signal;
  assert.ok(signal instanceof AbortSignal, 'discovery must pass an AbortSignal to fetch');
  return signal;
};

test('public price reads are deduplicated, keep old quotes on error and recover', async () => {
  const calls: Wire[] = [];
  const deps = hostDependencies(calls, () => list());
  const pending = deferred<Awaited<ReturnType<NonNullable<HostDependencies['fetchPrices']>>>>();
  let attempts = 0;
  deps.fetchPrices = async options => {
    assert.ok(options?.signal instanceof AbortSignal);
    attempts += 1;
    if (attempts === 1) return pending.promise;
    if (attempts === 2) throw new Error('private server content');
    return { ...await pending.promise, fetchedAt: '2030-01-02T00:00:00Z' };
  };
  const { service, dispose } = await host(runtimeConfig(), deps);
  try {
    const first = service.refreshPrices(), second = service.refreshPrices();
    assert.equal(attempts, 1);
    pending.resolve({ status: 'ok', source: { kind: 'official-website', origin: 'https://corouter.open-design.ai', catalogUrl: 'https://corouter.open-design.ai/zh/models/' }, fetchedAt: '2030-01-01T00:00:00Z', currency: 'USD', unit: 'per_1m_tokens', issues: [], models: [{
      id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', provider: null, slug: null, detailUrl: null,
      tiers: [{ index: 0, label: '标准', currency: 'USD', unit: 'per_1m_tokens', input: 2, output: 10, cacheRead: 0.1, cacheWrite: null }],
    }] });
    assert.deepEqual(await first, await second);
    const old = await first;
    assert.equal(old.models[0]?.tiers[0]?.cacheWrite, null);
    const failed = await service.refreshPrices();
    assert.equal(failed.state, 'error');
    assert.equal(failed.stale, true);
    assert.equal(failed.fetchedAt, old.fetchedAt);
    assert.deepEqual(failed.models, old.models);
    assert.doesNotMatch(JSON.stringify(failed), /private server content/u);
    const recovered = await service.refreshPrices();
    assert.equal(recovered.state, 'ok');
    assert.equal(recovered.stale, false);
    assert.equal(recovered.fetchedAt, '2030-01-02T00:00:00Z');
    assert.equal(calls.length, 0, 'prices never invoke gateway discovery');
  } finally { await dispose(); }
});

test('selector update failure preserves the previous catalog and a later refresh can recover', async () => {
  const calls: Wire[] = [];
  let id = 'previous-model', rejectNotification = false;
  const { service, dispose } = await host(runtimeConfig(), hostDependencies(calls, () => list(id), () => {
    if (rejectNotification) throw new Error('PRIVATE_REGISTRATION_FAILURE');
  }));
  try {
    await saveFixtureKey(service);
    const previous = await service.refreshModels();
    id = 'replacement-model'; rejectNotification = true;
    const failed = await service.refreshModels();
    assert.deepEqual(failed.models, previous.models);
    assert.equal(failed.modelsUpdatedAt, previous.modelsUpdatedAt);
    assert.deepEqual(service.modelCatalog().map(row => row.id), ['previous-model']);
    assert.match(failed.modelsError ?? '', /模型选择器更新失败/u);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_REGISTRATION_FAILURE/u);
    rejectNotification = false;
    const recovered = await service.refreshModels();
    assert.deepEqual(recovered.models.map(row => row.id), ['replacement-model']);
    assert.equal(recovered.modelsError, undefined);
  } finally { await dispose(); }
});

test('concurrent refreshes share a single discovery request and a single cache notification', async () => {
  const current = runtimeConfig(), calls: Wire[] = [];
  let notifications = 0;
  const gate = deferred<void>();
  const { service, dispose } = await host(current, hostDependencies(calls, async () => { await gate.promise; return list('new-model'); }, () => { notifications++; }));
  try {
    await saveFixtureKey(service);
    const first = service.refreshModels();
    const second = service.refreshModels();
    // 两个调用都已完成状态捕获并共用同一 pending 刷新：此时只发出一次请求。
    await waitForRequest(calls, 1);
    await tick();
    assert.equal(calls.length, 1);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls.length, 1);
    assert.equal(a.modelsSource, 'openai');
    assert.deepEqual(a.models.map(model => model.id), ['new-model']);
    assert.deepEqual(b.models, a.models);
    assert.equal(b.modelsUpdatedAt, a.modelsUpdatedAt);
    assert.equal(notifications, 1);
    assert.deepEqual(service.modelCatalog().map(model => model.id), ['new-model']);
    // 发现走固定的 OpenAI models 端点，使用配置的 base 与已保存凭据。
    assert.equal(calls[0]!.url, `${BASE}/models`);
    assert.equal(calls[0]!.init.method, 'GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(headers.accept, 'application/json');
    // pending 在结算后清空：下一次显式刷新才发出新请求。
    const third = await service.refreshModels();
    assert.equal(calls.length, 2);
    assert.equal(third.modelsSource, 'openai');
    assert.equal(notifications, 2);
  } finally { await dispose(); }
});

test('inference protocol and per-model settings never invalidate the discovered catalog', async () => {
  const current = runtimeConfig(), calls: Wire[] = [];
  let notifications = 0;
  const { service, dispose } = await host(current, hostDependencies(calls, () => list('deepseek-v4.1-flash'), () => { notifications++; }));
  try {
    await saveFixtureKey(service);
    const discovered = await service.refreshModels();
    assert.equal(discovered.modelsSource, 'openai');
    // 已知 id 继承 catalog 证据（分组/上下文/思考档位），上游显示名不覆盖。
    const row = discovered.models[0];
    assert.ok(row);
    assert.equal(row.id, 'deepseek-v4.1-flash');
    assert.equal(row.group, 'plan');
    assert.equal(row.name, 'DeepSeek V4.1 Flash');
    assert.equal(row.contextWindow, 1_000_000);
    assert.equal(row.maxOutputTokens, 384_000);
    assert.deepEqual(row.reasoningEfforts, ['low', 'high', 'max']);
    assert.equal(row.enabled, true);

    // 只改推理协议：目录来源、时间戳与通知都不变，也不会重新请求。
    current.apiProtocol = 'messages';
    const afterProtocol = await service.status();
    assert.equal(afterProtocol.modelsSource, 'openai');
    assert.equal(afterProtocol.modelsUpdatedAt, discovered.modelsUpdatedAt);
    assert.equal(afterProtocol.config.apiProtocol, 'messages');
    assert.equal(calls.length, 1);
    assert.equal(notifications, 1);

    // 只改逐模型设置：启用状态经 status 立即生效，但模型刷新缓存不被作废。
    current.modelSettings = { 'deepseek-v4.1-flash': { enabled: false, contextWindow: 500_000 } };
    const afterSettings = await service.status();
    assert.equal(afterSettings.modelsSource, 'openai');
    assert.equal(afterSettings.modelsUpdatedAt, discovered.modelsUpdatedAt);
    assert.equal(afterSettings.models[0]?.enabled, false);
    assert.deepEqual(afterSettings.config.modelSettings, { 'deepseek-v4.1-flash': { enabled: false, contextWindow: 500_000 } });
    assert.equal(calls.length, 1);
    assert.equal(notifications, 1);
    // 目录行本身保留证据值：用户覆盖只影响请求侧，不写回发现缓存。
    assert.equal(service.modelCatalog()[0]?.contextWindow, 1_000_000);
  } finally { await dispose(); }
});

test('an API key change aborts the in-flight request and its late result never commits', async () => {
  const current = runtimeConfig(), calls: Wire[] = [];
  const gate = deferred<void>();
  const { service, dispose } = await host(current, hostDependencies(calls, async () => { await gate.promise; return list('stale-model'); }));
  try {
    await saveFixtureKey(service, 'fixture-key-one');
    const pending = service.refreshModels();
    await waitForRequest(calls, 1);
    const signal = signalOf(calls[0]!);
    assert.equal(signal.aborted, false);

    const before = await service.status();
    await service.saveApiKey({ value: 'fixture-key-two', expectedRevision: before.revision });
    // 凭据变化作废旧发现：请求被取消，旧 epoch 失效。
    assert.equal(signal.aborted, true);

    gate.resolve();
    const settled = await pending;
    assert.equal(settled.modelsSource, 'builtin');
    assert.deepEqual(settled.models.map(model => model.id), MODELS.map(model => model.id));
    assert.equal(settled.models.some(model => model.id === 'stale-model'), false);
    assert.equal(settled.modelsError, undefined);
    assert.deepEqual(service.modelCatalog().map(model => model.id), MODELS.map(model => model.id));
    // 新凭据不会复用被取消请求的结果：再刷新才真正提交。
    assert.equal(calls.length, 1);
    assert.equal((await service.status()).apiKeyConfigured, true);
  } finally { await dispose(); }
});

test('a base URL change aborts the in-flight request, drops the cached catalog and re-targets discovery', async () => {
  const current = runtimeConfig(), calls: Wire[] = [];
  let notifications = 0;
  let hold: Promise<void> | undefined;
  const { service, dispose } = await host(current, hostDependencies(calls, async call => {
    if (hold) await hold;
    return list(call.url.includes('/v2/') ? 'v2-model' : 'v1-model');
  }, () => { notifications++; }));
  try {
    await saveFixtureKey(service);
    const first = await service.refreshModels();
    assert.deepEqual(first.models.map(model => model.id), ['v1-model']);
    assert.equal(notifications, 1);

    const gate = deferred<void>();
    hold = gate.promise;
    const pending = service.refreshModels();
    await waitForRequest(calls, 2);
    const signal = signalOf(calls[1]!);
    assert.equal(signal.aborted, false);
    // 换 base URL：旧目录立即退回内置目录并通知一次，仍在飞的请求被取消。
    current.baseURL = 'https://amr-link.open-design.ai/v2';
    const afterChange = await service.status();
    assert.equal(afterChange.modelsSource, 'builtin');
    assert.equal(afterChange.modelsUpdatedAt, undefined);
    assert.deepEqual(afterChange.models.map(model => model.id), MODELS.map(model => model.id));
    assert.equal(signal.aborted, true);
    assert.equal(notifications, 2);

    hold = undefined;
    gate.resolve();
    const settled = await pending;
    assert.equal(settled.modelsSource, 'builtin');
    assert.equal(settled.models.some(model => model.id === 'v2-model'), false);
    assert.equal(settled.modelsError, undefined);
    assert.equal(calls.length, 2);
    // 之后的刷新走新 base URL 并提交新目录。
    const refreshed = await service.refreshModels();
    assert.equal(calls.length, 3);
    assert.equal(calls[2]!.url, 'https://amr-link.open-design.ai/v2/models');
    assert.equal(refreshed.modelsSource, 'openai');
    assert.deepEqual(refreshed.models.map(model => model.id), ['v2-model']);
    assert.equal(notifications, 3);
  } finally { await dispose(); }
});

test('a failed refresh keeps the last good catalog and never surfaces upstream text', async () => {
  const current = runtimeConfig(), calls: Wire[] = [];
  let notifications = 0, mode: 'ok' | 'auth' | 'network' | 'generic' = 'ok';
  const deps = hostDependencies(calls, call => {
    if (mode === 'auth') return new Response(`{"error":{"message":"${SECRET}"}}`, { status: 401 });
    if (mode === 'network') throw new TypeError(`network failure: ${SECRET}`);
    return list('glm-5.2');
  }, () => { notifications++; });
  // 发现的传输失败由 ModelDiscoveryError 分类；这里再覆盖一个「发现外的任意异常」，
  // 证明宿主把它折叠成固定文案而不是转发原文。
  const discovery = deps.fetchModels;
  assert.ok(discovery);
  deps.fetchModels = (base, key, signal) => mode === 'generic' ? Promise.reject(new Error(`upstream: ${SECRET}`)) : discovery(base, key, signal);
  const { service, dispose } = await host(current, deps);
  try {
    await saveFixtureKey(service);
    const good = await service.refreshModels();
    assert.equal(good.modelsSource, 'openai');
    assert.deepEqual(good.models.map(model => model.id), ['glm-5.2']);
    assert.ok(good.modelsUpdatedAt);
    assert.equal(notifications, 1);

    // 发现失败：上次成功目录与时间戳保留，错误是固定文案（分类来自 ModelDiscoveryError）。
    mode = 'auth';
    const failedAuth = await service.refreshModels();
    assert.equal(failedAuth.modelsSource, 'openai');
    assert.equal(failedAuth.modelsUpdatedAt, good.modelsUpdatedAt);
    assert.deepEqual(failedAuth.models.map(model => model.id), ['glm-5.2']);
    assert.equal(failedAuth.modelsError, '模型发现认证失败，请检查凭据');
    assert.equal(notifications, 1);
    assert.equal(JSON.stringify(failedAuth).includes(SECRET), false);
    assert.equal(JSON.stringify(failedAuth).includes(KEY), false);

    // 传输层异常同样分类为固定文案，不回显网络原文。
    mode = 'network';
    const failedNetwork = await service.refreshModels();
    assert.deepEqual(failedNetwork.models.map(model => model.id), ['glm-5.2']);
    assert.equal(failedNetwork.modelsError, '无法连接模型发现服务');
    assert.equal(JSON.stringify(failedNetwork).includes(SECRET), false);

    // 非发现分类的异常由宿主折叠为同一个固定文案。
    mode = 'generic';
    const failedCrash = await service.refreshModels();
    assert.deepEqual(failedCrash.models.map(model => model.id), ['glm-5.2']);
    assert.equal(failedCrash.modelsUpdatedAt, good.modelsUpdatedAt);
    assert.equal(failedCrash.modelsError, '模型列表更新失败，请稍后重试。');
    assert.equal(JSON.stringify(failedCrash).includes(SECRET), false);
    assert.equal(notifications, 1);

    // 恢复后错误被清空并提交新目录。
    mode = 'ok';
    const recovered = await service.refreshModels();
    assert.equal(recovered.modelsError, undefined);
    assert.equal(recovered.modelsSource, 'openai');
    assert.equal(notifications, 2);
  } finally { await dispose(); }
});

test('dispose cancels the in-flight request without an unhandled rejection', async () => {
  const current = runtimeConfig(), calls: Wire[] = [];
  // 模拟真实 fetch 的取消语义：只有 signal 中止时才拒绝。
  const { service, dispose } = await host(current, hostDependencies(calls, call => new Promise<Response>((_resolve, reject) => {
    const signal = call.init.signal;
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
  })));
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => { rejections.push(reason); };
  let disposed = false;
  const shutdown = async () => { if (!disposed) { disposed = true; await dispose(); } };
  process.on('unhandledRejection', onUnhandled);
  try {
    await saveFixtureKey(service);
    const pending = service.refreshModels();
    await waitForRequest(calls, 1);
    const signal = signalOf(calls[0]!);
    assert.equal(signal.aborted, false);
    assert.equal((await service.status()).modelsSource, 'builtin');

    await shutdown();
    // 生命周期中止传播到发现请求。
    assert.equal(signal.aborted, true);
    // 调用方必须拿到已分类的结果（取消不升级为用户可见错误）；内部不得留下未处理的拒绝。
    const settled = await pending.then(
      (status): Status | Error => status,
      (error: unknown): Status | Error => error instanceof Error ? error : new Error('non-error rejection'),
    );
    assert.equal(settled instanceof Error, false, settled instanceof Error ? settled.message : '');
    assert.equal((settled as Status).modelsSource, 'builtin');
    assert.equal((settled as Status).modelsError, undefined);
    await tick();
    await tick();
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await shutdown();
  }
});
