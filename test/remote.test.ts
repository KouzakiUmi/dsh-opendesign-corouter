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
  parseSaveApiKeyRequest,
  parseStartLoginRequest,
  parseStatus,
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
  config: { emptyTurnGuard: true, useDesktopCredential: true, baseURL: 'https://amr-link.open-design.ai/v1', apiKeyEnv: 'COROUTER_API_KEY' },
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

test('eight descriptors state every wire fact typert validates', () => {
  const descriptors = openDesignCoRouterRemote.descriptors;
  assert.equal(openDesignCoRouterRemote.package, REMOTE_PACKAGE);
  assert.deepEqual(descriptors.map(d => d.method), ['status', 'refreshModels', 'refreshQuota', 'refreshQuotaNow', 'startLogin', 'loginStatus', 'cancelLogin', 'saveApiKey']);
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
    config: { ...status.config, apiProtocol: 'messages', modelSettings: { 'gpt-6-astra': { enabled: false, maxTokens: 8192 } }, requestTimeoutMs: 10000, streamIdleTimeoutMs: 3000, quotaRefreshSeconds: 60 },
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
