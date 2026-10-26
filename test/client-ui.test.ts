import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Advanced,
  Models,
  QuotaView,
  SettingsPage,
  formatTime,
  formatUsd,
  modelEnabled,
  nextWindowResetAt,
  parseNumberInput,
  protocolEndpoint,
  quotaAutoRefresh,
  tabAfter,
  writeModelSettings,
  type FormSnapshot,
  type RpcCaller,
  type SettingsProps,
} from '../src/client.js';
import type { Status, StatusModel } from '../src/remote.js';
import type { QuotaSnapshot } from '../src/quota.js';

const h = React.createElement;

const models: readonly StatusModel[] = [
  {
    id: 'gpt-6-luna', name: 'GPT-6 Luna', group: 'plan', enabled: true,
    contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoningEfforts: ['low', 'medium', 'high'],
  },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', group: 'paid', enabled: false },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', group: 'paid', enabled: true, contextWindow: 200_000, maxOutputTokens: 8_192 },
];

const quota: QuotaSnapshot = {
  state: 'partial',
  source: 'desktop',
  updatedAt: '2026-10-26T08:00:00.000Z',
  subscriptionPeriodStart: '2026-10-01T00:00:00.000Z',
  subscriptionPeriodEnd: '2026-11-01T00:00:00.000Z',
  nextRefreshAt: '2026-10-26T13:00:00.000Z',
  windows: [],
  balances: {},
  note: '桌面权限不足时，将整体使用已保存的完整独立会话。',
};

const status: Status = {
  revision: 'revision-for-test',
  apiKeyConfigured: false,
  quota,
  login: { jobId: null, state: 'idle' },
  config: {
    emptyTurnGuard: true,
    useDesktopCredential: true,
    baseURL: 'https://example.invalid/v1',
    apiKeyEnv: 'COROUTER_API_KEY',
    apiProtocol: 'chat-completions',
    modelSettings: {},
    quotaRefreshSeconds: 60,
    requestTimeoutMs: 1_800_000,
    streamIdleTimeoutMs: 300_000,
  },
  guardedTurns: 2,
  models,
  modelsSource: 'openai',
  modelsUpdatedAt: '2026-10-26T09:30:00.000Z',
  modelsError: '模型发现响应不符合 OpenAI 模型列表格式',
};

const caller: RpcCaller = async <T>(): Promise<T> => {
  throw new Error('Server rendering must not call RPC');
};

let snapshot: FormSnapshot = {
  status: 'ready',
  writable: true,
  value: {
    emptyTurnGuard: true,
    useDesktopCredential: true,
    baseURL: 'https://example.invalid/v1',
    apiKeyEnv: 'COROUTER_API_KEY',
    apiProtocol: 'chat-completions',
    modelSettings: {},
    quotaRefreshSeconds: 60,
    requestTimeoutMs: 1_800_000,
    streamIdleTimeoutMs: 300_000,
  },
};
const form: SettingsProps['form'] = {
  getSnapshot: () => snapshot,
  subscribe: () => () => { snapshot = { ...snapshot }; },
  set: async () => true,
};

function renderOverview(nextStatus: Status = status): string {
  const rpc: RpcCaller = async <T>(method: Parameters<RpcCaller>[0]): Promise<T> => {
    if (method === 'status') return nextStatus as T;
    return await caller<T>(method);
  };
  return renderToStaticMarkup(h(SettingsPage, { caller: rpc, form }));
}

function renderModels(nextStatus: Status = status, nextSnapshot: FormSnapshot = snapshot): string {
  return renderToStaticMarkup(h(Models, {
    status: nextStatus,
    formSnapshot: nextSnapshot,
    setFormField: async () => true,
    pendingField: [],
    onRefreshModels: () => {},
    refreshingModels: false,
    notice: null,
  }));
}

function renderAdvanced(nextStatus: Status = status, nextSnapshot: FormSnapshot = snapshot): string {
  return renderToStaticMarkup(h(Advanced, {
    status: nextStatus,
    formSnapshot: nextSnapshot,
    setFormField: async () => true,
    pendingField: [],
  }));
}

test('settings renders four accessible tabs and one associated tabpanel', () => {
  const html = renderOverview();
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 1);
  assert.match(html, /aria-label="CoRouter 设置分类"/);
  assert.match(html, /aria-selected="true"/);
  for (const label of ['概览', '模型', '连接与登录', '高级']) assert.match(html, new RegExp(`>${label}<`));
});

test('unknown quota stays unknown and never becomes zero', () => {
  const html = renderToStaticMarkup(h(QuotaView, { quota }));
  for (const label of ['套餐余额', '充值 / 赠送金额', '总额度']) assert.match(html, new RegExp(label));
  for (const label of ['订阅账期结束', '下次额度恢复', '下次自动刷新']) assert.match(html, new RegExp(label));
  assert.ok((html.match(/>—</g) ?? []).length >= 6);
  assert.doesNotMatch(html, /\$0\.00/u);
  assert.match(html, /桌面权限不足时/);
  assert.match(html, /只读展示/);
  // The Host's next cache read is described as a read, never as quota recovery.
});

test('zero is a real amount rather than an unknown value', () => {
  assert.notEqual(formatUsd(0), '—');
  assert.match(formatUsd(0), /0\.00/u);
  assert.equal(formatUsd(undefined), '—');
  assert.equal(formatUsd(Number.NaN), '—');
});

test('subscription end, window resets and the auto refresh are separate timestamps', () => {
  const reset = '2030-01-01T00:00:00.000Z';
  const laterReset = '2030-01-02T00:00:00.000Z';
  const autoAt = '2026-10-26T13:00:00.000Z';
  const timed = renderToStaticMarkup(h(QuotaView, {
    quota: {
      ...quota,
      state: 'ok',
      windows: [
        { durationSeconds: 604800, used: 400, limit: 2000, remaining: 1600, percent: 20, resetsAt: laterReset, windowStart: '2026-10-22T00:00:00.000Z', resetMode: 'activity_triggered' },
        { durationSeconds: 18000, used: 120, limit: 500, remaining: 380, percent: 24, resetsAt: reset },
      ],
      balances: { subscriptionUsd: 60, rechargeUsd: 20, totalUsd: 80 },
    },
    nextAutoRefreshAt: autoAt,
    refreshIntervalSeconds: 60,
  }));
  assert.match(timed, new RegExp(formatTime('2026-11-01T00:00:00.000Z')));
  assert.match(timed, new RegExp(formatTime(reset)));
  assert.match(timed, new RegExp(formatTime(autoAt)));
  assert.match(timed, /每 60 秒自动刷新/u);
  assert.match(timed, /窗口开始/u);
  assert.match(timed, /按使用触发/u);
  assert.doesNotMatch(timed, /每 60 秒.*恢复/u);
  assert.equal(formatUsd(80), new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(80));
});

test('an account without Design Plan says so instead of showing a bare dash', () => {
  const noWindows: QuotaSnapshot = { state: 'partial', updatedAt: quota.updatedAt, eligible: false, windows: [], balances: {} };
  const html = renderToStaticMarkup(h(QuotaView, { quota: noWindows }));
  assert.match(html, /未开通 Design Plan/u);
  assert.match(html, /套餐资格：未开通/u);
});

test('login-required quota does not claim an automatic refresh and stale data is labelled', () => {
  const loginRequired = renderToStaticMarkup(h(QuotaView, { quota: { ...quota, state: 'need-login' }, refreshIntervalSeconds: 60 }));
  assert.match(loginRequired, /登录后自动刷新/u);
  assert.doesNotMatch(loginRequired, /每 60 秒自动刷新/u);
  const stale = renderToStaticMarkup(h(QuotaView, { quota: { ...quota, stale: true } }));
  assert.match(stale, /上次成功读数/u);
  const paused = renderToStaticMarkup(h(QuotaView, { quota: { ...quota, autoRefreshPaused: true, refreshFailures: 6 }, refreshIntervalSeconds: 60 }));
  assert.match(paused, /自动重试已暂停/u);
  assert.doesNotMatch(paused, /每 60 秒自动刷新/u);
});

test('tab keyboard model wraps and supports Home and End', () => {
  assert.equal(tabAfter('overview', 'ArrowLeft'), 'advanced');
  assert.equal(tabAfter('overview', 'ArrowRight'), 'models');
  assert.equal(tabAfter('models', 'ArrowDown'), 'connection');
  assert.equal(tabAfter('connection', 'ArrowUp'), 'models');
  assert.equal(tabAfter('models', 'Home'), 'overview');
  assert.equal(tabAfter('models', 'End'), 'advanced');
  assert.equal(tabAfter('models', 'Enter'), undefined);
});

test('model settings are written as one whole map without mutating the input', () => {
  const original = { 'gpt-6-astra': { enabled: false } };
  const added = writeModelSettings(original, 'gpt-6-luna', { temperature: 0.7, topP: 0.9, maxTokens: 4096, contextWindow: 200_000, reasoningEffort: 'high' });
  assert.deepEqual(original, { 'gpt-6-astra': { enabled: false } });
  assert.equal(added['gpt-6-astra']?.enabled, false);
  assert.deepEqual(added['gpt-6-luna'], { temperature: 0.7, topP: 0.9, maxTokens: 4096, contextWindow: 200_000, reasoningEffort: 'high' });
  const disabled = writeModelSettings(added, 'gpt-6-luna', { ...added['gpt-6-luna'], enabled: false });
  assert.equal(disabled['gpt-6-luna']?.enabled, false);
  assert.equal(disabled['gpt-6-luna']?.temperature, 0.7);
  const clearedOne = writeModelSettings(disabled, 'gpt-6-luna', undefined);
  assert.deepEqual(clearedOne, { 'gpt-6-astra': { enabled: false } });
  const emptyEntry = writeModelSettings(clearedOne, 'gpt-6-astra', {});
  assert.deepEqual(emptyEntry, {});
  assert.deepEqual(writeModelSettings(undefined, 'gpt-6-luna', { enabled: true }), { 'gpt-6-luna': { enabled: true } });
});

test('form overrides decide enablement before the host catalog value', () => {
  const astra = models[1]!;
  assert.equal(modelEnabled(astra, undefined), true);
  assert.equal(modelEnabled(astra, undefined, false), false);
  assert.equal(modelEnabled(astra, { enabled: true }, false), true);
  assert.equal(modelEnabled(models[0]!, { enabled: false }), false);
  assert.equal(modelEnabled(models[0]!, { temperature: 0.2 }), true);
  assert.equal(modelEnabled(models[2]!, undefined, false), true);
});

test('numeric settings accept inherit, bounds and integers only', () => {
  const temperature = { label: '温度', min: 0, max: 2, allowEmpty: true } as const;
  assert.deepEqual(parseNumberInput('', temperature), { ok: true, value: undefined });
  assert.deepEqual(parseNumberInput('0.7', temperature), { ok: true, value: 0.7 });
  assert.deepEqual(parseNumberInput('2', temperature), { ok: true, value: 2 });
  assert.equal(parseNumberInput('2.1', temperature).ok, false);
  assert.equal(parseNumberInput('-0.1', temperature).ok, false);
  assert.equal(parseNumberInput('0x10', temperature).ok, false);
  assert.equal(parseNumberInput('1e3', temperature).ok, false);
  const maxTokens = { label: '最大输出', min: 1, max: 10_000_000, integer: true, allowEmpty: true } as const;
  assert.deepEqual(parseNumberInput('4096', maxTokens), { ok: true, value: 4096 });
  assert.equal(parseNumberInput('1.5', maxTokens).ok, false);
  assert.equal(parseNumberInput('0', maxTokens).ok, false);
  assert.equal(parseNumberInput('', maxTokens).ok, true);
  const required = { label: '请求总超时', min: 1000, max: 3_600_000, integer: true } as const;
  assert.equal(parseNumberInput('', required).ok, false);
  assert.deepEqual(parseNumberInput('900000', required), { ok: true, value: 900_000 });
});

test('protocol endpoints append the standard version root only when missing', () => {
  assert.equal(protocolEndpoint('https://example.invalid/v1', 'chat-completions'), 'https://example.invalid/v1/chat/completions');
  assert.equal(protocolEndpoint('https://example.invalid/v1/', 'responses'), 'https://example.invalid/v1/responses');
  assert.equal(protocolEndpoint('https://example.invalid', 'messages'), 'https://example.invalid/v1/messages');
  assert.equal(protocolEndpoint('', 'messages'), '/messages');
});

test('auto refresh honours the interval and the host read plan, never a past reset', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  const interval = quotaAutoRefresh(60, undefined, now);
  assert.equal(interval?.delayMs, 60_000);
  assert.equal(interval?.intervalSeconds, 60);
  assert.equal(interval?.at, new Date(now + 60_000).toISOString());
  const planned = quotaAutoRefresh(60, '2026-10-26T12:00:10.000Z', now);
  assert.equal(planned?.delayMs, 10_500);
  assert.equal(quotaAutoRefresh(5, '2026-10-26T12:01:00.000Z', now, true)?.delayMs, 60_500);
  const past = quotaAutoRefresh(60, '2026-10-26T11:59:00.000Z', now);
  assert.equal(past?.delayMs, 60_000);
  assert.equal(quotaAutoRefresh(5, undefined, now)?.delayMs, 5_000);
  assert.equal(quotaAutoRefresh(4, undefined, now), undefined);
  assert.equal(quotaAutoRefresh(3601, undefined, now), undefined);
  assert.equal(quotaAutoRefresh(1.5, undefined, now), undefined);
  assert.equal(quotaAutoRefresh(undefined, undefined, now), undefined);
  const later = quotaAutoRefresh(3600, '2026-10-26T12:30:00.000Z', now);
  assert.equal(later?.delayMs, 1_800_500);
});

test('next quota recovery only comes from future window resets', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  const windows = [
    { durationSeconds: 604800, used: 1, limit: 10, percent: 10, resetsAt: '2030-01-02T00:00:00.000Z' },
    { durationSeconds: 18000, used: 1, limit: 10, percent: 10, resetsAt: '2030-01-01T00:00:00.000Z' },
    { durationSeconds: 3600, used: 1, limit: 10, percent: 10, resetsAt: '2020-01-01T00:00:00.000Z' },
  ];
  assert.equal(nextWindowResetAt(windows, now), '2030-01-01T00:00:00.000Z');
  assert.equal(nextWindowResetAt([], now), undefined);
  assert.equal(nextWindowResetAt([{ durationSeconds: 60, used: 0, limit: 1, percent: 0 }], now), undefined);
});

test('model rows expose a switch, an editable parameter block and reset', () => {
  const html = renderModels(status, {
    ...snapshot,
    value: { ...snapshot.value, modelSettings: { 'gpt-6-astra': { enabled: false } } },
  });
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 2);
  assert.equal((html.match(/<summary[^>]*>参数设置 · (?:已自定义|使用默认值)<\/summary>/g) ?? []).length, 3);
  for (const label of ['温度', 'Top P', '最大输出（tokens）', '上下文预算（tokens）', '默认思考深度']) {
    assert.match(html, new RegExp(`<label for="[^"]+">${label}</label>`));
  }
  assert.match(html, /GPT-6 Astra/u);
  assert.match(html, /已禁用/u);
  assert.match(html, /1 \/ 2 已启用/u);
  assert.match(html, /OpenAI \/models 发现/u);
  assert.match(html, new RegExp(formatTime('2026-10-26T09:30:00.000Z')));
  assert.match(html, /模型发现响应不符合 OpenAI 模型列表格式/u);
  assert.match(html, /role="alert"/u);
  // One explicit entry: only that row's reset is enabled.
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>重置<\/button>/g) ?? []).length, 2);
});

test('an overridden model keeps its reset enabled and its values rendered', () => {
  const html = renderModels(status, {
    ...snapshot,
    value: { ...snapshot.value, modelSettings: { 'gpt-6-luna': { temperature: 0.7, maxTokens: 4096, reasoningEffort: 'high' } } },
  });
  assert.match(html, /value="0.7"/u);
  assert.match(html, /value="4096"/u);
  assert.equal((html.match(/<option value="high" selected="">high<\/option>/g) ?? []).length, 1);
  assert.equal((html.match(/>重置<\/button>/g) ?? []).length, 3);
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>重置<\/button>/g) ?? []).length, 2);
});

test('resetting a disabled model ignores the stale host flag once the form is ready', () => {
  const disabled: FormSnapshot = {
    ...snapshot,
    value: { ...snapshot.value, modelSettings: { 'gpt-6-astra': { enabled: false } } },
  };
  const disabledHtml = renderModels(status, disabled);
  assert.match(disabledHtml, /已禁用/u);
  assert.equal((disabledHtml.match(/type="checkbox" checked=""/g) ?? []).length, 2);
  // The Host still reports `enabled: false` until its next status refresh; the ready form owns the answer.
  const resetHtml = renderModels(status, { ...snapshot, value: { ...snapshot.value, modelSettings: {} } });
  assert.doesNotMatch(resetHtml, /已禁用/u);
  assert.equal((resetHtml.match(/type="checkbox" checked=""/g) ?? []).length, 3);
  assert.equal((resetHtml.match(/<button[^>]*disabled=""[^>]*>重置<\/button>/g) ?? []).length, 3);
});

test('models fall back to the host settings mirror before the form is ready', () => {
  const html = renderModels(
    { ...status, config: { ...status.config, modelSettings: { 'gpt-6-astra': { enabled: true } } } },
    { status: 'loading', writable: false, value: undefined },
  );
  assert.match(html, /2 \/ 2 已启用/u);
  assert.doesNotMatch(html, /已禁用/u);
});

test('advanced offers three protocols, a read-only gateway and real timeout fields', () => {
  const html = renderAdvanced();
  assert.match(html, /<select[^>]*id="odc-api-protocol"/u);
  for (const label of ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages']) assert.match(html, new RegExp(label));
  assert.equal((html.match(/selected=""/g) ?? []).length, 1);
  assert.match(html, /当前网关地址（只读）/u);
  assert.match(html, /https:\/\/example\.invalid\/v1/u);
  assert.match(html, /https:\/\/example\.invalid\/v1\/chat\/completions/u);
  assert.doesNotMatch(html, /type="url"/u);
  assert.doesNotMatch(html, /保存 Base URL/u);
  assert.match(html, /API Key 环境变量 \/ 凭据引用名/u);
  for (const label of ['请求总超时（毫秒）', '流式空闲超时（毫秒）', '额度自动刷新间隔（秒）']) {
    assert.match(html, new RegExp(`<label for="[^"]+">${label}</label>`));
  }
  assert.match(html, /启用空轮监控/u);
  assert.match(html, /本次运行已拦截 2 轮/u);
  assert.match(html, /type="checkbox" checked=""/u);
});

test('unavailable writable forms cannot expose editable controls', () => {
  const unavailable: FormSnapshot = { status: 'unavailable', writable: true, value: undefined };
  const html = renderAdvanced(status, unavailable);
  assert.match(html, /type="checkbox" disabled=""/u);
  const modelHtml = renderModels(status, unavailable);
  assert.equal((modelHtml.match(/type="checkbox" disabled=""/g) ?? []).length, models.length);
});

test('all concurrently pending fields stay disabled', () => {
  const html = renderToStaticMarkup(h(Advanced, {
    status, formSnapshot: snapshot, setFormField: async () => true,
    pendingField: ['emptyTurnGuard', 'apiProtocol'],
  }));
  assert.match(html, /type="checkbox" disabled=""/u);
  assert.match(html, /<select[^>]*id="odc-api-protocol"[^>]*disabled=""/u);
});

test('advanced shows the selected protocol path from the form snapshot', () => {
  const html = renderAdvanced(status, { ...snapshot, value: { ...snapshot.value, apiProtocol: 'messages', baseURL: 'https://gateway.example' } });
  assert.match(html, /<option value="messages" selected="">Anthropic Messages<\/option>/u);
  assert.match(html, /https:\/\/gateway\.example\/v1\/messages/u);
  assert.match(html, /https:\/\/gateway\.example/u);
});

test('an unconfigured form snapshot keeps the guard on its host value', () => {
  const html = renderAdvanced(
    { ...status, config: { ...status.config, emptyTurnGuard: false } },
    { status: 'loading', writable: false, value: undefined },
  );
  assert.doesNotMatch(html, /type="checkbox" checked=""/u);
  assert.match(html, /本次运行已拦截 2 轮/u);
});
