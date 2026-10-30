import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPERT as openDesignCoRouterHost } from '../src/generated/typert.host.js';
import openDesignCoRouterRemote from '../src/generated/typert.remote-client.js';
import {
  REMOTE_PACKAGE,
  REMOTE_SERVICE,
  parseCancelLoginRequest,
  parseLoginState,
  parseQuotaSnapshot,
  parseActivationOpenState,
  parseSaveApiKeyRequest,
  parseStartLoginRequest,
  parseStatus,
  parsePriceCatalog,
  type Status,
} from '../src/remote.js';

const status: Status = {
  revision: 'rev-1',
  apiKeyConfigured: true,
  sessionSource: 'desktop',
  quota: {
    state: 'ok',
    source: 'desktop',
    updatedAt: '2026-10-26T08:00:00.000Z',
    tier: 'pro',
    eligible: true,
    windows: [{ durationSeconds: 604800, used: 10, limit: 100, remaining: 87, percent: 10, resetsAt: '2026-10-29T12:00:00Z' }],
    balances: { subscriptionUsd: 50, rechargeUsd: 20, totalUsd: 70 },
  },
  login: { jobId: null, state: 'idle' },
  config: { emptyTurnGuard: true, turnCompletionReview: false, useDesktopCredential: true, baseURL: 'https://amr-link.open-design.ai/v1', apiKeyEnv: 'COROUTER_API_KEY' },
  guardedTurns: 3,
  models: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', group: 'plan' },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', group: 'paid' },
  ],
};

/** Round-trip one value through a descriptor's own strict parser. */
function through(method: string, value: unknown): unknown {
  const descriptor = openDesignCoRouterRemote.descriptors.find(candidate => candidate.method === method);
  assert.ok(descriptor, `missing descriptor for ${method}`);
  assert.equal(descriptor.result.mode, 'strict');
  if (descriptor.result.mode !== 'strict') throw new Error('unreachable');
  return descriptor.result.create().parse(value);
}

test('ten descriptors state every wire fact typert validates', () => {
  const descriptors = openDesignCoRouterRemote.descriptors;
  assert.equal(openDesignCoRouterRemote.package, REMOTE_PACKAGE);
  assert.deepEqual(descriptors.map(d => d.method), ['status', 'refreshModels', 'refreshPrices', 'refreshQuota', 'refreshQuotaNow', 'startLogin', 'loginStatus', 'cancelLogin', 'openActivationPage', 'saveApiKey']);
  for (const descriptor of descriptors) {
    // typert rejects an empty/#-bearing id, a foreign service, and any non-RPC segment.
    assert.equal(descriptor.id, `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/${descriptor.method}`);
    assert.equal(descriptor.service, REMOTE_SERVICE);
    assert.equal(descriptor.namespace, REMOTE_SERVICE);
    assert.deepEqual(descriptor.invocation, { kind: 'direct' });
    assert.match(descriptor.method, /^[A-Za-z0-9_$.-]+$/u);
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.source, 'json');
      assert.equal(parameter.wire, parameter.name);
      assert.match(parameter.wire, /^[A-Za-z0-9_$.-]+$/u);
      assert.equal(parameter.codec.mode, 'strict');
    }
  }
  // ${namespace}/${method} is the registry's endpoint key, so duplicates would collide.
  assert.equal(new Set(descriptors.map(d => `${d.namespace}/${d.method}`)).size, descriptors.length);
  assert.equal(new Set(descriptors.map(d => d.id)).size, descriptors.length);
  // Only the single write carries a parameter; the reads stay argument-free.
  const withRequest = descriptors.filter(d => d.parameters.length > 0).map(d => d.method);
  assert.deepEqual(withRequest, ['startLogin', 'cancelLogin', 'saveApiKey']);
  for (const descriptor of descriptors.filter(d => d.parameters.length > 0)) {
    assert.deepEqual(descriptor.parameters.map(p => p.wire), ['input']);
  }
});

test('the Host contribution reuses the mountable table verbatim', () => {
  assert.equal(openDesignCoRouterHost.package, REMOTE_PACKAGE);
  assert.equal(openDesignCoRouterHost.face, 'host');
  assert.deepEqual(openDesignCoRouterHost.schemas, []);
  assert.deepEqual(openDesignCoRouterHost.model, { services: [], events: [], objects: [] });
  // One table, two consumers: a divergence here would make Host and Client disagree.
  assert.equal(openDesignCoRouterHost.invocations, openDesignCoRouterRemote.descriptors);
});

test('status validates the configurable per-request image budget', () => {
  const withBudget = { ...status, config: { ...status.config, maxRequestImageBytes: 20 * 1024 * 1024 } };
  assert.equal(parseStatus(withBudget).config.maxRequestImageBytes, 20 * 1024 * 1024);
  for (const maxRequestImageBytes of [0, 1024 * 1024 - 1, 100 * 1024 * 1024 + 1, 1.5]) {
    assert.throws(() => parseStatus({ ...status, config: { ...status.config, maxRequestImageBytes } }));
  }
});

test('status round-trips, and nothing outside the allowlist survives', () => {
  const parsed = through('status', status) as Status;
  assert.deepEqual(parsed, status);
  assert.deepEqual(parseStatus(status), status);

  const leaked = { ...status, apiKey: 'sk-live-never-return', headers: { cookie: 'secret=1' }, cookie: 'secret=1' };
  const sanitized = parseStatus(leaked);
  assert.deepEqual(Object.keys(sanitized).sort(), ['apiKeyConfigured', 'config', 'guardedTurns', 'login', 'models', 'quota', 'revision', 'sessionSource']);
  assert.equal('apiKey' in sanitized, false);
  assert.equal('cookie' in sanitized, false);
  assert.equal(JSON.stringify(sanitized).includes('sk-live'), false);
  assert.equal(JSON.stringify(sanitized).includes('secret=1'), false);
});

test('completion monitoring transports only counters and fixed decisions, with legacy payload support', () => {
  const turnMonitor = { available: true, checks: 5, continuations: 2, requestRetries: 1,
    last: { at: '2026-10-29T10:00:00Z', decision: 'limited', reason: 'no-progress' } };
  assert.deepEqual((through('status', { ...status, turnMonitor }) as Status).turnMonitor, turnMonitor);
  assert.equal(parseStatus(status).turnMonitor, undefined);
  const sanitized = parseStatus({ ...status, turnMonitor: { ...turnMonitor, modelText: 'private-output',
    last: { ...turnMonitor.last, explanation: 'private-output' } } });
  assert.equal(JSON.stringify(sanitized).includes('private-output'), false);
  for (const turnMonitor of [null, { available: true, checks: -1, continuations: 0, requestRetries: 0 },
    { available: true, checks: 0, continuations: 0, requestRetries: 0, last: { at: 'invalid', decision: 'limited', reason: 'no-progress' } },
    { available: true, checks: 0, continuations: 0, requestRetries: 0, last: { at: '2026-10-29T10:00:00Z', decision: 'private-output', reason: 'no-progress' } }]) {
    assert.throws(() => parseStatus({ ...status, turnMonitor }));
  }
  for (const config of [{ turnReviewMaxContinuations: 0 }, { turnReviewMaxContinuations: 11 }, { turnReviewNoProgressLimit: 6 }]) {
    assert.throws(() => parseStatus({ ...status, config: { ...status.config, ...config } }));
  }
  // The completion handshake switch is a plain opt-in flag, and its absence stays absent.
  assert.equal(parseStatus({ ...status, config: { ...status.config, turnCompletionReview: true } }).config.turnCompletionReview, true);
  const { turnCompletionReview: _review, ...legacyConfig } = status.config;
  assert.equal(parseStatus({ ...status, config: legacyConfig }).config.turnCompletionReview, undefined);
});

test('public price payload is bounded, sanitised and keeps missing rates unknown', () => {
  const snapshot = { state: 'ok', stale: false, fetchedAt: '2026-10-27T08:00:00Z', secret: 'never-return', models: [{
    id: 'deepseek-v4.1-flash', hidden: 'ignored', tiers: [{ label: '不按输入长度分档', currency: 'USD', unit: 'per_1m_tokens', input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: null, hidden: 'ignored' }],
  }] };
  const parsed = parsePriceCatalog(snapshot);
  assert.equal(parsed.models[0]?.tiers[0]?.cacheWrite, null);
  assert.equal(JSON.stringify(parsed).includes('never-return'), false);
  assert.equal(JSON.stringify(parsed).includes('ignored'), false);
  assert.throws(() => parsePriceCatalog({ ...snapshot, models: [...snapshot.models, snapshot.models[0]] }), /重复/u);
  assert.throws(() => parsePriceCatalog({ ...snapshot, models: [{ ...snapshot.models[0], tiers: [{ ...snapshot.models[0]!.tiers[0], input: -1 }] }] }), /价格/u);
  assert.throws(() => parsePriceCatalog({ ...snapshot, fetchedAt: undefined, stale: true }), /更新时间/u);
});

test('credential source is an optional credential-free enum and preserves legacy status payloads', () => {
  for (const apiKeySource of ['reference', 'stored', 'device'] as const) {
    const parsed = through('status', { ...status, apiKeySource }) as Status;
    assert.equal(parsed.apiKeySource, apiKeySource);
    assert.equal('apiKey' in parsed, false);
  }
  assert.equal(parseStatus(status).apiKeySource, undefined);
  assert.throws(() => parseStatus({ ...status, apiKeyConfigured: false, apiKeySource: 'stored' }), /推理凭据来源/u);
  assert.throws(() => parseStatus({ ...status, apiKeySource: 'secret-token-value' }), /推理凭据来源/u);
});

test('status transports catalog input capabilities and separate user overrides', () => {
  const input = {
    ...status,
    config: { ...status.config, modelSettings: { 'gpt-6-astra': { imageInput: false } } },
    models: [
      { id: 'vision', name: 'Vision', group: 'plan', inputModalities: ['text', 'image'] },
      { id: 'text', name: 'Text', group: 'paid', inputModalities: ['text'] },
      { id: 'unknown', name: 'Unknown', group: 'paid' },
    ],
  };
  const parsed = through('status', input) as Status;
  assert.deepEqual(parsed.models, input.models);
  assert.equal(parsed.config.modelSettings?.['gpt-6-astra']?.imageInput, false);
  for (const inputModalities of [[], ['image'], ['text', 'text'], ['text', 'audio'], 'image']) {
    assert.throws(() => parseStatus({ ...status, models: [{ id: 'm', name: 'M', group: 'paid', inputModalities }] }), /模态/u);
  }
});

test('remote configuration lower bounds agree with accepted Host settings', () => {
  for (const [field, min] of [['requestTimeoutMs', 1000], ['streamIdleTimeoutMs', 1000], ['quotaRefreshSeconds', 5]] as const) {
    assert.throws(() => parseStatus({ ...status, config: { ...status.config, [field]: min - 1 } }), /超出范围/u);
    assert.equal(parseStatus({ ...status, config: { ...status.config, [field]: min } }).config[field], min);
  }
});

test('status rejects a malformed payload instead of repairing it', () => {
  assert.throws(() => parseStatus({ ...status, revision: '' }), /配置版本/u);
  assert.throws(() => parseStatus({ ...status, revision: 'x'.repeat(257) }), /配置版本/u);
  assert.throws(() => parseStatus({ ...status, apiKeyConfigured: 'yes' }), /凭据是否就绪/u);
  assert.throws(() => parseStatus({ ...status, guardedTurns: -1 }), /已拦截空轮数/u);
  assert.throws(() => parseStatus({ ...status, guardedTurns: 1.5 }), /已拦截空轮数/u);
  assert.throws(() => parseStatus({ ...status, sessionSource: 'browser' }), /登录态来源/u);
  assert.throws(() => parseStatus({ ...status, models: [{ id: 'm', name: 'M', group: 'free' }] }), /模型分组/u);
  assert.throws(() => parseStatus({ ...status, models: [{ id: 'm', name: 'M', group: 'plan' }, { id: 'm', name: 'M2', group: 'paid' }] }), /重复/u);
  assert.throws(() => parseStatus({ ...status, config: { ...status.config, apiKeyEnv: 'NOT-AN-IDENT' } }), /凭据引用名/u);
  // An unnamed profile travels as an empty string, so the client can leave the field blank.
  assert.equal(parseStatus({ ...status, config: { ...status.config, apiKeyEnv: '' } }).config.apiKeyEnv, '');
  assert.throws(() => parseStatus({ ...status, quota: { ...status.quota, state: 'stale' } }), /额度状态/u);
  assert.throws(() => parseStatus(null), /状态必须是对象/u);
  assert.throws(() => parseStatus([]), /状态必须是对象/u);
});

test('quota keeps its four layers and drops unknown fields', () => {
  const parsed = parseQuotaSnapshot({ ...status.quota, rawHeaders: { authorization: 'Bearer secret' }, percentExtra: 1 });
  assert.deepEqual(Object.keys(parsed).sort(), ['balances', 'eligible', 'source', 'state', 'tier', 'updatedAt', 'windows']);
  assert.deepEqual(parsed.windows[0], status.quota.windows[0]);
  // Percent is a display value only; the provider's own remaining counter wins.
  assert.equal(parseQuotaSnapshot({ ...status.quota, windows: [{ durationSeconds: 60, used: 5, limit: 10, percent: 250 }] }).windows[0]?.percent, 100);
  assert.deepEqual(parseQuotaSnapshot({ ...status.quota, balances: undefined }).balances, {});
  assert.throws(() => parseQuotaSnapshot({ ...status.quota, updatedAt: 'yesterday' }), /额度更新时间/u);
  assert.throws(() => parseQuotaSnapshot({ ...status.quota, windows: 'many' }), /额度窗口/u);
  assert.throws(() => parseQuotaSnapshot({ ...status.quota, windows: [{ durationSeconds: 0, used: 1, limit: 1, percent: 1 }] }), /时长/u);
});

test('quota periods, local refresh plans and model settings survive the actual RPC codec', () => {
  const extended: Status = {
    ...status,
    quota: {
      ...status.quota,
      subscriptionPeriodStart: '2026-10-01T00:00:00Z', subscriptionPeriodEnd: '2026-11-01T00:00:00Z',
      nextRefreshAt: '2026-10-26T08:01:00Z', stale: true, refreshFailures: 2, autoRefreshPaused: false,
      windows: [{ ...status.quota.windows[0]!, windowStart: '2026-10-22T12:00:00Z', resetMode: 'anchored_recurring' }],
    },
    config: { ...status.config, apiProtocol: 'messages', modelSettings: { 'gpt-6-astra': { enabled: false, maxTokens: 8192, contextTier: 'extended' }, legacy: { contextWindow: 500_000 } }, requestTimeoutMs: 10000, streamIdleTimeoutMs: 3000, quotaRefreshSeconds: 60 },
    models: [{ ...status.models[0]!, enabled: false, contextWindow: 100000, maxOutputTokens: 8192, reasoningEfforts: ['low', 'high'] }],
    modelsSource: 'openai', modelsUpdatedAt: '2026-10-26T08:00:00Z',
  };
  assert.deepEqual(through('status', extended), extended);
  assert.deepEqual(through('refreshQuota', extended.quota), extended.quota);
});

test('login state never carries the session it is proving', () => {
  assert.deepEqual(parseLoginState({ jobId: null, state: 'idle' }), { jobId: null, state: 'idle' });
  assert.deepEqual(
    parseLoginState({ jobId: 'job-1', state: 'waiting', startedAt: '2026-10-26T08:00:00.000Z', cookie: 'sess=1', browser: '/usr/bin/chrome' }),
    { jobId: 'job-1', state: 'waiting', startedAt: '2026-10-26T08:00:00.000Z' },
  );
  assert.deepEqual(through('loginStatus', { jobId: 'job-1', state: 'success' }), { jobId: 'job-1', state: 'success' });
  // The wire vocabulary is closed: a phase the protocol does not declare is refused,
  // never normalized into a neighbouring one.
  assert.throws(() => parseLoginState({ jobId: 'job-1', state: 'verified', verifiedAt: 'x', coverage: 'partial' }), /登录阶段/u);
  assert.throws(() => parseLoginState({ jobId: 'job-1', state: 'saved', savedAt: 'x' }), /登录阶段/u);
  assert.throws(() => parseLoginState({ jobId: 'job-1', state: 'stalled' }), /登录阶段/u);
  assert.throws(() => parseLoginState({ jobId: 7, state: 'idle' }), /登录任务 id/u);
  assert.throws(() => parseLoginState({ jobId: 'job-1', state: 'error', message: 'x'.repeat(1025) }), /登录说明/u);
});

test('device approval exposes only validated public fields while waiting', () => {
  const approval = { jobId: 'job-device', state: 'waiting', userCode: 'AB12-CD34',
    activationUrl: 'https://open-design.ai/cloud/cli/activate?code=AB12-CD34', expiresAt: '2030-01-01T00:00:00.000Z' };
  const parsed = through('startLogin', { ...approval, deviceSecret: 'PRIVATE_POLL', controlKey: 'PRIVATE_CONTROL', runtimeKey: 'PRIVATE_RUNTIME' });
  assert.deepEqual(parsed, approval);
  const liveApproval = { ...approval, activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=device-1&userCode=AB12-CD34' };
  assert.deepEqual(through('startLogin', liveApproval), liveApproval);
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE/);
  for (const state of ['success', 'cancelled', 'error', 'verifying']) {
    const terminal = parseLoginState({ ...approval, state });
    assert.equal(terminal.activationUrl, undefined);
    assert.equal(terminal.userCode, undefined);
    assert.equal(terminal.expiresAt, undefined);
  }
  for (const activationUrl of ['javascript:alert(1)', 'https://evil.example/cloud/cli/activate?code=AB12-CD34',
    'https://open-design.ai/cloud/cli/activate?code=WRONG', 'https://open-design.ai/cloud/cli/activate?deviceSecret=PRIVATE']) {
    assert.throws(() => parseLoginState({ ...approval, activationUrl }), /授权链接/);
  }
  assert.throws(() => parseLoginState({ ...approval, expiresAt: 'not-a-date' }), /时间/);
});

test('login requests require the revision or job they act on', () => {
  assert.deepEqual(parseStartLoginRequest({ expectedRevision: 'rev-1', extra: true }), { expectedRevision: 'rev-1' });
  assert.deepEqual(parseCancelLoginRequest({ jobId: 'job-1' }), { jobId: 'job-1' });
  assert.throws(() => parseStartLoginRequest({}), /配置版本/u);
  assert.throws(() => parseStartLoginRequest({ expectedRevision: '' }), /配置版本/u);
  assert.throws(() => parseCancelLoginRequest({ jobId: '' }), /登录任务 id/u);
  assert.throws(() => parseCancelLoginRequest('job-1'), /取消请求必须是对象/u);
});

test('a saved key is trimmed once and must be HTTP-safe ASCII', () => {
  assert.deepEqual(parseSaveApiKeyRequest({ value: '  sk-abc  ', expectedRevision: 'rev-1' }), { value: 'sk-abc', expectedRevision: 'rev-1' });
  assert.deepEqual(parseSaveApiKeyRequest({ value: 'sk-' + 'a'.repeat(16_380), expectedRevision: 'rev-1' }).value.length, 16_383);
  assert.throws(() => parseSaveApiKeyRequest({ value: '   ', expectedRevision: 'rev-1' }), /API Key/u);
  assert.throws(() => parseSaveApiKeyRequest({ value: 'sk-密钥', expectedRevision: 'rev-1' }), /API Key/u);
  assert.throws(() => parseSaveApiKeyRequest({ value: 'sk-a b', expectedRevision: 'rev-1' }), /API Key/u);
  assert.throws(() => parseSaveApiKeyRequest({ value: 'sk-' + 'a'.repeat(16_384), expectedRevision: 'rev-1' }), /API Key/u);
  assert.throws(() => parseSaveApiKeyRequest({ value: 42, expectedRevision: 'rev-1' }), /API Key/u);
  assert.throws(() => parseSaveApiKeyRequest({ value: 'sk-abc' }), /配置版本/u);
  // The parsed request is what the Host writes; it never requests the old value back.
  assert.deepEqual(Object.keys(parseSaveApiKeyRequest({ value: 'sk-abc', expectedRevision: 'r' })).sort(), ['expectedRevision', 'value']);
});

test('the activation-window result is a closed set of public codes', () => {
  for (const code of ['opened', 'no-link', 'invalid-url', 'unavailable', 'failed'] as const) {
    assert.deepEqual(through('openActivationPage', { code, opened: code === 'opened' }), { code, opened: code === 'opened' });
  }
  // No URL, browser handle or error text may travel back through this result.
  assert.deepEqual(through('openActivationPage', { code: 'opened', opened: true, url: 'https://evil.test', error: 'PRIVATE', pid: 42 }), { code: 'opened', opened: true });
  for (const code of ['launched', 'OPENED', '', 'success']) assert.throws(() => parseActivationOpenState({ code, opened: true }), /授权页打开结果/u, code);
  assert.throws(() => parseActivationOpenState({ code: 'opened', opened: 'yes' }), /授权页是否已打开/u);
  assert.throws(() => parseActivationOpenState({ opened: true }), /授权页打开结果/u);
  assert.throws(() => parseActivationOpenState(null), /必须是对象/u);
});
