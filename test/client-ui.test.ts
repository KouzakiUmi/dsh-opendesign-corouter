import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Advanced,
  DEFAULT_KEY_REF,
  Models,
  LoginApproval,
  ModelRow,
  QuotaView,
  SettingsPage,
  contextCapacityConflict,
  contextTierAvailable,
  contextTierConflict,
  contextTierWindow,
  formatRefreshCountdown,
  formatRelativeDeadline,
  formatWindowCredits,
  formatTime,
  formatUsd,
  modelEnabled,
  modelImageInput,
  nextWindowResetAt,
  parseNumberInput,
  protocolEndpoint,
  quotaAutoRefresh,
  quotaStatusView,
  selectedContextTier,
  sortModelsByEnabled,
  tabAfter,
  writeModelSettings,
  type FormSnapshot,
  type RpcCaller,
  type SettingsProps,
} from '../src/client.js';
import type { Status, StatusModel } from '../src/remote.js';
import type { TurnMonitorStatus } from '../src/turn-monitor-status.js';
import { TurnMonitorView } from '../src/client.js';
import type { QuotaSnapshot } from '../src/quota.js';
import { DEFAULT_API_KEY_REF } from '../src/config.js';

const h = React.createElement;

test('device approval offers a Host window button and keeps the official link as fallback', () => {
  const login = { jobId: 'fixture', state: 'waiting' as const, userCode: 'AB12-CD34',
    activationUrl: 'https://open-design.ai/cloud/cli/activate?code=AB12-CD34', expiresAt: '2030-01-01T00:00:00.000Z' };
  const html = renderToStaticMarkup(h(LoginApproval, { login, onOpen: () => {}, opening: false, notice: null }));
  assert.match(html, /在新窗口打开授权页/);
  assert.match(html, /<button[^>]*type="button"/);
  assert.doesNotMatch(html, /<button[^>]*disabled/, 'a ready panel leaves the window button usable');
  // The ordinary link survives as the manual path (copy, password manager, existing session).
  assert.match(html, /href="https:\/\/open-design\.ai\/cloud\/cli\/activate\?code=AB12-CD34"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /<button[^>]*>复制授权链接<\/button>/u);
  assert.match(html, />官方授权页<\/a>/u);
  assert.match(html, /AB12-CD34/);
  assert.match(html, /临时 Chrome 窗口需要单独登录/u);
  assert.match(html, /常用浏览器/u);

  const opening = renderToStaticMarkup(h(LoginApproval, { login, onOpen: () => {}, opening: true }));
  assert.match(opening, /正在打开…/);
  assert.match(opening, /<button[^>]*disabled[^>]*>正在打开…/);
  const hostless = renderToStaticMarkup(h(LoginApproval, { login }));
  assert.match(hostless, /<button[^>]*disabled[^>]*>在新窗口打开授权页/, 'a Host without the opener cannot promise it');
  assert.equal(hostless.includes('复制授权链接'), true, 'the manual link never depends on the Host');

  for (const code of ['no-link', 'invalid-url', 'unavailable', 'failed'] as const) {
    const noticed = renderToStaticMarkup(h(LoginApproval, { login, onOpen: () => {}, notice: { kind: 'error', text: code } }));
    assert.match(noticed, new RegExp(code, 'u'));
    assert.match(noticed, /role="alert"/);
  }
  const opened = renderToStaticMarkup(h(LoginApproval, { login, onOpen: () => {}, notice: { kind: 'status', text: 'opened-here' } }));
  assert.match(opened, /role="status"/);

  for (const state of ['idle', 'launching', 'verifying', 'success', 'cancelled', 'error'] as const) {
    assert.equal(renderToStaticMarkup(h(LoginApproval, { login: { ...login, state } })), '');
  }
  assert.equal(renderToStaticMarkup(h(LoginApproval, { login: { ...login, activationUrl: 'https://evil.example' } })), '');
});

const models: readonly StatusModel[] = [
  {
    id: 'gpt-6-luna', name: 'GPT-6 Luna', group: 'plan', enabled: true,
    inputModalities: ['text', 'image'], contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoningEfforts: ['low', 'medium', 'high'],
  },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', group: 'paid', enabled: false, inputModalities: ['text'] },
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

const turnMonitor: TurnMonitorStatus = {
  available: true, checks: 7, continuations: 2, requestRetries: 1,
  last: { at: '2026-10-26T10:00:00.000Z', decision: 'limited', reason: 'continuation-limit' },
};

/** Build a TurnMonitorStatus without the optional `last` field, keeping omission a real absence. */
function omitLast(base: TurnMonitorStatus, available: boolean): TurnMonitorStatus {
  const { last: _last, ...rest } = base;
  return { ...rest, available };
}

/** A Status without the optional `turnMonitor` field, matching a Host older than the monitor. */
function omitTurnMonitor(base: Status): Status {
  const { turnMonitor: _turnMonitor, ...rest } = base;
  return rest;
}

const status: Status = {
  revision: 'revision-for-test',
  apiKeyConfigured: false,
  quota,
  login: { jobId: null, state: 'idle' },
  config: {
    emptyTurnGuard: true,
    turnCompletionReview: false,
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
  turnMonitor,
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
    turnCompletionReview: true,
    useDesktopCredential: true,
    baseURL: 'https://example.invalid/v1',
    apiKeyEnv: 'COROUTER_API_KEY',
    apiProtocol: 'chat-completions',
    modelSettings: {},
    quotaRefreshSeconds: 60,
    requestTimeoutMs: 1_800_000,
    streamIdleTimeoutMs: 300_000,
    turnReviewMaxContinuations: 3,
    turnReviewNoProgressLimit: 2,
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
    clearFormField: async () => true,
    pendingField: [],
  }));
}

test('model discovery wording names the configured gateway, not OpenAI as the provider', () => {
  const html = renderModels({ ...status, modelsSource: 'openai', modelsUpdatedAt: '2030-01-01T00:00:00.000Z' });
  assert.match(html, />刷新模型目录<\/button>/u);
  assert.match(html, /title="从当前配置的网关读取可用模型目录"/u);
  assert.match(html, /来源：当前网关/u);
  assert.match(html, /上下文为参考预算；刷新后会采用网关报告的较小窗口，实际限制可能不同，可在模型设置中选择总窗口档位/u);
  assert.doesNotMatch(html, /从 OpenAI 刷新模型|OpenAI \/models 发现/u);
});

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
  assert.match(html, /— 表示暂无数据/u);
  // The Host's next cache read is described as a read, never as quota recovery.
});

test('zero is a real amount rather than an unknown value', () => {
  assert.notEqual(formatUsd(0), '—');
  assert.match(formatUsd(0), /0\.00/u);
  assert.equal(formatUsd(undefined), '—');
  assert.equal(formatUsd(Number.NaN), '—');
});

test('refresh countdown reflects the planned instant and handles invalid or due times', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const inMs = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(formatRefreshCountdown(inMs(1500), now), '2秒后');
  assert.equal(formatRefreshCountdown(inMs(61_000), now), '1分1秒后');
  assert.equal(formatRefreshCountdown(inMs(3_660_000), now), '1小时1分钟后');
  assert.equal(formatRefreshCountdown(inMs(90_000_000), now), '1天1小时后');
  assert.equal(formatRefreshCountdown(inMs(0), now), '即将刷新');
  assert.equal(formatRelativeDeadline(inMs(-1000), now, '已到恢复时间，等待更新'), '已到恢复时间，等待更新');
  assert.equal(formatRefreshCountdown('invalid', now), '—');
  assert.equal(formatRefreshCountdown(undefined, now), '—');
});

test('window status distinguishes healthy, low, exhausted, stale and unknown readings', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  const window = { durationSeconds: 18000, used: 20, limit: 100, percent: 20 };
  const base = { ...quota, state: 'ok' as const, eligible: true, windows: [window] };
  assert.equal(quotaStatusView(base, now).tone, 'good');
  assert.equal(quotaStatusView({ ...base, windows: [window, { ...window, percent: 80 }] }, now).tone, 'warn');
  assert.equal(quotaStatusView({ ...base, windows: [{ ...window, percent: 91 }] }, now).title, '赠送窗口额度即将用尽');
  assert.equal(quotaStatusView({ ...base, windows: [{ ...window, percent: 100 }] }, now).tone, 'critical');
  assert.equal(quotaStatusView({ ...base, windows: [{ ...window, resetsAt: '2026-10-26T00:00:00Z' }] }, now).title, '等待更新窗口额度');
  assert.notEqual(quotaStatusView({ ...base, stale: true }, now).tone, 'good');
  assert.notEqual(quotaStatusView({ ...base, state: 'partial' }, now).tone, 'good');
  assert.notEqual(quotaStatusView({ ...base, windows: [] }, now).tone, 'good');
  assert.equal(quotaStatusView({ ...base, state: 'error', stale: true }, now).title, '暂时无法读取额度');
  assert.equal(formatWindowCredits(177900), '177.9K');
  assert.equal(formatWindowCredits(450000), '450.0K');
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

test('quota windows separate remaining, usage, recovery and optional technical details', () => {
  const html = renderToStaticMarkup(h(QuotaView, { quota: {
    ...quota, source: 'login', windows: [
      { durationSeconds: 18000, used: 120, limit: 500, remaining: 380, percent: 24, resetsAt: '2030-01-01T00:00:00.000Z', windowStart: '2026-10-22T00:00:00.000Z', resetMode: 'activity_triggered' },
      { durationSeconds: 604800, used: 500, limit: 500, percent: 100 },
    ],
  } }));
  assert.match(html, /<section class="odc-window"[^>]*aria-label="5 小时赠送窗口"/u);
  assert.match(html, /<strong>76\.0%<\/strong>/u);
  assert.match(html, /<progress[^>]*value="76"[^>]*aria-label="5 小时赠送窗口剩余额度"/u);
  assert.match(html, /<progress[^>]*value="0"/u);
  assert.equal((html.match(/class="odc-window-usage"/gu) ?? []).length, 2);
  assert.match(html, /已用 120 \/ 总计 500 积分/u);
  assert.match(html, /aria-label="窗口积分：已用 120，总计 500"/u);
  assert.match(html, /<dt>接口剩余积分<\/dt><dd>380<\/dd>/u);
  assert.match(html, /<dt>接口剩余积分<\/dt><dd>—<\/dd>/u, 'a missing remaining amount is not derived');
  assert.match(html, /class="odc-window-reset"/u);
  assert.match(html, /<time dateTime="2030-01-01T00:00:00.000Z"/u);
  assert.match(html, /<details class="odc-window-details"><summary>窗口详情<\/summary>/u);
  assert.doesNotMatch(html, /<details[^>]* open/u);
  assert.match(html, /<dt>最近更新<\/dt>/u);
  assert.match(html, /<dt>数据来源<\/dt><dd>独立登录<\/dd>/u);
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
  const busy = renderToStaticMarkup(h(QuotaView, { quota, nextAutoRefreshAt: '2030-01-01T00:00:00Z', busy: true }));
  assert.match(busy, /刷新中…/u);
  const pausedBusy = renderToStaticMarkup(h(QuotaView, { quota: { ...quota, autoRefreshPaused: true }, nextAutoRefreshAt: '2030-01-01T00:00:00Z', busy: true }));
  assert.doesNotMatch(pausedBusy, /刷新中…/u);
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
  const added = writeModelSettings(original, 'gpt-6-luna', { imageInput: true, temperature: 0.7, topP: 0.9, maxTokens: 4096, contextWindow: 200_000, reasoningEffort: 'high' });
  assert.deepEqual(original, { 'gpt-6-astra': { enabled: false } });
  assert.equal(added['gpt-6-astra']?.enabled, false);
  assert.deepEqual(added['gpt-6-luna'], { imageInput: true, temperature: 0.7, topP: 0.9, maxTokens: 4096, contextWindow: 200_000, reasoningEffort: 'high' });
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

test('model display sorting is stable, non-mutating and applied before the first-six limit', () => {
  const mixed: StatusModel[] = [
    { id: 'disabled-a', name: 'Disabled A', group: 'plan', enabled: false },
    { id: 'enabled-a', name: 'Enabled A', group: 'plan', enabled: true },
    { id: 'disabled-b', name: 'Disabled B', group: 'plan', enabled: false },
    { id: 'enabled-b', name: 'Enabled B', group: 'plan', enabled: true },
  ];
  const originalIds = mixed.map(model => model.id);
  assert.deepEqual(sortModelsByEnabled(mixed, {}, false).map(model => model.id), ['enabled-a', 'enabled-b', 'disabled-a', 'disabled-b']);
  assert.deepEqual(mixed.map(model => model.id), originalIds, 'the catalog array is not sorted in place');
  assert.deepEqual(sortModelsByEnabled(mixed, {
    'disabled-a': { enabled: true },
    'enabled-a': { enabled: false },
  }, false).map(model => model.id), ['disabled-a', 'enabled-b', 'enabled-a', 'disabled-b']);

  const paged = Array.from({ length: 8 }, (_, index): StatusModel => ({
    id: `paged-${index}`, name: `Paged ${index}`, group: 'plan', enabled: true,
  }));
  const html = renderModels({ ...status, models: paged }, {
    ...snapshot,
    value: { ...snapshot.value, modelSettings: { 'paged-0': { enabled: false } } },
  });
  assert.deepEqual([...html.matchAll(/<code>(paged-\d)<\/code>/gu)].map(match => match[1]), ['paged-1', 'paged-2', 'paged-3', 'paged-4', 'paged-5', 'paged-6']);
  assert.match(html, /7 \/ 8 已启用/u);
  assert.match(html, /显示全部 8 个模型/u);
});

test('image input distinguishes manual overrides, catalog facts and unknown-attempt automatic mode', () => {
  assert.equal(modelImageInput(models[0]!, {}), true);
  assert.equal(modelImageInput(models[0]!, { imageInput: false }), false);
  assert.equal(modelImageInput(models[1]!, {}), false);
  assert.equal(modelImageInput(models[1]!, { imageInput: true }), true);
  assert.equal(modelImageInput(models[2]!, {}), true, 'unknown attempts image delivery without claiming support');
  assert.equal(modelImageInput(models[2]!, { imageInput: false }), false);

  const row = (model: StatusModel, settings: Parameters<typeof ModelRow>[0]['settings'], pending = false, writable = true) => renderToStaticMarkup(h(ModelRow, {
    model, settings, authoritative: true, writable, pending, onCommit: async () => true,
  }));
  const unknown = row(models[2]!, {});
  assert.match(unknown, /自动 · 未知，尝试发送/u);
  assert.doesNotMatch(unknown, /自动 · 支持图片/u);
  assert.match(unknown, /<label class="odc-image-toggle">/u);
  assert.doesNotMatch(unknown.match(/<div class="odc-model-image">([\s\S]*?)<\/div>/u)?.[1] ?? '', /odc-switch/u, 'the compact image row does not reuse the full-width switch');
  const imageCheckbox = unknown.match(/<input[^>]*aria-label="GPT-6\.1 Sol 图片输入"[^>]*>/u)?.[0] ?? '';
  const imageStateId = imageCheckbox.match(/aria-describedby="([^"]+)"/u)?.[1];
  assert.ok(imageStateId);
  assert.match(unknown, new RegExp(`<small class="odc-image-state" id="${imageStateId}">自动 · 未知，尝试发送</small>`, 'u'));
  assert.ok(unknown.indexOf('图片输入') < unknown.indexOf('<details'), 'image policy stays outside advanced parameters');
  assert.match(unknown, /<details class="odc-model-details">/u, 'advanced parameters start collapsed');
  assert.doesNotMatch(unknown, />恢复自动<\/button>/u, 'unchanged defaults do not add a disabled action');

  const textOnly = row(models[1]!, {});
  const textImageControl = textOnly.match(/<div class="odc-model-image">([\s\S]*?)<\/div>/u)?.[1] ?? '';
  assert.match(textOnly, /自动 · 仅文本/u);
  assert.doesNotMatch(textImageControl, /type="checkbox" checked/u);
  assert.doesNotMatch(textImageControl, />恢复自动<\/button>/u, 'no manual override needs no restore action');
  const manualText = row(models[1]!, { imageInput: true, temperature: 0.4 });
  assert.match(manualText, /手动 · 开启/u);
  assert.match(manualText, /title="仅移除图片输入手动覆盖，保留其他模型设置"/u);
  assert.match(manualText, /aria-label="GPT-6 Astra 恢复图片输入自动"/u);
  assert.doesNotMatch(manualText.match(/<button[^>]*>恢复自动<\/button>/u)?.[0] ?? '', /disabled/u);

  const pending = row(models[0]!, { imageInput: false }, true);
  const pendingImageControl = pending.match(/<div class="odc-model-image">([\s\S]*?)<\/div>/u)?.[1] ?? '';
  assert.match(pending, /手动 · 关闭 · 正在保存/u);
  assert.match(pendingImageControl, /type="checkbox" disabled=""/u);
  assert.match(pendingImageControl, /<button[^>]*disabled=""[^>]*>恢复自动<\/button>/u);
  const readOnly = row(models[0]!, {}, false, false);
  assert.match(readOnly, /配置不可写/u);
});

test('Claude Messages sampling shows compatible values and marks stale values clearable', () => {
  const model: StatusModel = { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', group: 'paid' };
  const render = (settings: Parameters<typeof ModelRow>[0]['settings'], protocol: 'messages' | 'chat-completions') => renderToStaticMarkup(h(ModelRow, {
    model, settings, authoritative: true, writable: true, pending: false, protocol, onCommit: async () => true,
  }));
  const empty = render({}, 'messages');
  assert.match(empty, /Messages 仅接受 1；建议留空/u);
  assert.match(empty, /Messages 仅接受 0\.99；建议留空/u);
  const stale = render({ temperature: 0.4, topP: 0.5, maxTokens: 128_001 }, 'messages');
  const temperature = stale.match(/<input[^>]*id="[^"]+-temperature"[^>]*>/u)?.[0] ?? '';
  const topP = stale.match(/<input[^>]*id="[^"]+-topP"[^>]*>/u)?.[0] ?? '';
  assert.match(temperature, /aria-invalid="true"/u);
  assert.match(topP, /aria-invalid="true"/u);
  assert.doesNotMatch(temperature, /disabled/u, 'saved temperature remains clearable');
  assert.doesNotMatch(topP, /disabled/u, 'saved top P remains clearable');
  const output = stale.match(/<input[^>]*id="[^"]+-maxTokens"[^>]*>/u)?.[0] ?? '';
  assert.match(output, /aria-invalid="true"/u);
  assert.match(output, /max="128000"/u);
  assert.doesNotMatch(output, /disabled/u, 'saved output limit remains clearable');
  assert.doesNotMatch(render({ temperature: 0.4 }, 'chat-completions'), /Messages 仅接受/u);
  const opus = renderToStaticMarkup(h(ModelRow, {
    model: { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', group: 'paid' }, settings: {}, authoritative: true, writable: true, pending: false, protocol: 'messages', onCommit: async () => true,
  }));
  assert.match(opus, /厂商默认关闭思考，选择思考深度可启用/u);
  assert.match(opus, /默认最大输出 4096/u);
});

test('Claude Opus 5.5 labels the vendor context reference without changing the output default', () => {
  const html = renderToStaticMarkup(h(ModelRow, {
    model: { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', group: 'paid', contextWindow: 1_000_000 },
    settings: {}, authoritative: true, writable: true, pending: false, protocol: 'messages', onCommit: async () => true,
  }));
  assert.match(html, /上下文 1,000,000 为厂商参考，网关实际容量未验证；档位总窗口不会超过该参考容量。/u);
  assert.match(html, /Messages 默认最大输出 4096/u);
});

test('Muse Wonder identifies its unverified mapping as a tentative reference', () => {
  const html = renderToStaticMarkup(h(ModelRow, {
    model: { id: 'muse-wonder', name: 'Muse Wonder', group: 'paid', contextWindow: 1_048_576 },
    settings: {}, authoritative: true, writable: true, pending: false, protocol: 'chat-completions', onCommit: async () => true,
  }));
  assert.match(html, /上下文 1,048,576 为暂定参考，网关型号映射及实际容量未验证；档位总窗口不会超过该参考容量。/u);
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
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 6);
  assert.equal((html.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 4);
  assert.equal((html.match(/<summary[^>]*>参数设置 · (?:已自定义|使用默认值)<\/summary>/g) ?? []).length, 3);
  for (const label of ['温度', 'Top P', '最大输出（tokens）']) {
    assert.match(html, new RegExp(`<label for="[^"]+">${label}</label>`));
  }
  // The context window is a three-tier choice, not another numeric field.
  assert.doesNotMatch(html, /上下文预算（tokens）/u);
  assert.equal((html.match(/type="radio"/g) ?? []).length, models.length * 3);
  assert.equal((html.match(/<legend[^>]*>上下文窗口（输入 \+ 输出合计）<\/legend>/gu) ?? []).length, models.length);
  assert.equal((html.match(/aria-label="编辑默认思考深度"/g) ?? []).length, 3);
  assert.equal((html.match(/class="odc-effort-value">继承默认<\/p>/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<label for="[^"]+">默认思考深度<\/label>/u, 'the effort selector appears only after entering edit mode');
  assert.match(html, /GPT-6 Astra/u);
  assert.match(html, /已禁用/u);
  assert.match(html, /1 \/ 2 已启用/u);
  assert.match(html, /来源：当前网关/u);
  assert.match(html, new RegExp(formatTime('2026-10-26T09:30:00.000Z')));
  assert.match(html, /模型发现响应不符合 OpenAI 模型列表格式/u);
  assert.match(html, /role="alert"/u);
  // One explicit entry: only that row's reset is enabled.
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>重置<\/button>/g) ?? []).length, 2);
});

/** The rendered input tag of one context tier; attribute order is React's, not the test's. */
function contextRadio(html: string, preset: string): string {
  return html.match(new RegExp(`<input[^>]*value="${preset}"[^>]*>`, 'u'))?.[0] ?? '';
}

test('the context window offers three tiers and keeps the vendor reference separate', () => {
  const model: StatusModel = { id: 'gpt-6-luna', name: 'GPT-6 Luna', group: 'plan', contextWindow: 1_050_000, maxOutputTokens: 128_000 };
  const render = (settings: Parameters<typeof ModelRow>[0]['settings'], pending = false) => renderToStaticMarkup(h(ModelRow, {
    model, settings, authoritative: true, writable: true, pending, onCommit: async () => true,
  }));
  const html = render({});
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.match(contextRadio(html, 'default'), /checked=""/u, 'an absent override is the default tier');
  assert.doesNotMatch(contextRadio(html, 'extended'), /checked=""/u);
  assert.doesNotMatch(contextRadio(html, 'maximum'), /checked=""/u);
  // The vendor reference stays the evidence value; the working window is the tier.
  assert.match(html, /参考容量 1,050,000/u);
  assert.match(html, /当前总窗口 272,000（含输出预留）/u);
  assert.match(html, /当前总窗口 272,000 tokens（含输出预留）/u);
  assert.match(html, /输出能力参考 128,000/u);
  assert.match(html, /自动输出预留 68,000/u, 'the automatic reservation is a quarter of the working window');
  assert.match(html, /正整数；留空按模型与当前总窗口自动预留。/u);
  assert.doesNotMatch(html, /上下文预算（tokens）/u);

  const extended = render({ contextTier: 'extended' });
  assert.match(contextRadio(extended, 'extended'), /checked=""/u);
  assert.match(extended, /当前总窗口 500,000 tokens（含输出预留）/u);

  const maximum = render({ contextTier: 'maximum' });
  assert.match(contextRadio(maximum, 'maximum'), /checked=""/u);
  assert.match(maximum, /当前总窗口 872,000 tokens（含输出预留）/u);

  const pendingHtml = render({ contextTier: 'extended' }, true);
  assert.match(contextRadio(pendingHtml, 'extended'), /disabled=""/u, 'a pending save locks the tier control');
  // A disabled tier control explains why it is unavailable.
  assert.match(pendingHtml, /正在保存模型设置，完成后可继续选择档位。/u);
  assert.match(contextRadio(pendingHtml, 'extended'), /aria-describedby="[^"]+-reason"/u);
  const readOnly = renderToStaticMarkup(h(ModelRow, {
    model, settings: {}, authoritative: true, writable: false, pending: false, onCommit: async () => true,
  }));
  assert.match(readOnly, /配置不可写/u);
  assert.match(contextRadio(readOnly, 'default'), /aria-describedby="[^"]+-reason"/u);
});

test('a small reference limits the tiers above it and clamps the default tier', () => {
  const model: StatusModel = { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', group: 'plan', contextWindow: 262_144, maxOutputTokens: 262_144 };
  const html = renderToStaticMarkup(h(ModelRow, {
    model, settings: {}, authoritative: true, writable: true, pending: false, onCommit: async () => true,
  }));
  assert.match(contextRadio(html, 'default'), /checked=""/u, 'the default tier stays selectable');
  assert.doesNotMatch(contextRadio(html, 'default'), /disabled=""/u);
  assert.match(contextRadio(html, 'extended'), /disabled=""/u);
  assert.match(contextRadio(html, 'maximum'), /disabled=""/u);
  assert.match(html, /超过参考容量 262,144/u);
  assert.match(html, /参考容量 262,144/u);
  assert.match(html, /当前总窗口 262,144 tokens（含输出预留）；参考容量 262,144，所选档位已按参考容量限幅/u);
});

test('a selected tier is capped by a smaller reference and says so', () => {
  const model: StatusModel = { id: 'grok-4.7', name: 'Grok 4.7', group: 'paid', contextWindow: 500_000, maxOutputTokens: 128_000 };
  const render = (settings: Parameters<typeof ModelRow>[0]['settings']) => renderToStaticMarkup(h(ModelRow, {
    model, settings, authoritative: true, writable: true, pending: false, onCommit: async () => true,
  }));
  const maximum = render({ contextTier: 'maximum' });
  assert.match(maximum, /当前总窗口 500,000 tokens（含输出预留）；参考容量 500,000，所选档位已按参考容量限幅/u);
  const extended = render({ contextTier: 'extended' });
  assert.match(extended, /当前总窗口 500,000 tokens（含输出预留）。/u, 'a tier at the reference is not clamped');
  // A legacy number keeps its own value and is never described as clamped.
  const legacy = render({ contextWindow: 500_000 });
  assert.match(legacy, /当前总窗口 500,000 tokens（含输出预留）；旧自定义窗口按原值继续生效/u);
  assert.doesNotMatch(legacy, /所选档位已按参考容量限幅/u);
});

test('a legacy custom window stays visible and is never read as a tier', () => {
  const model: StatusModel = { id: 'gpt-6-luna', name: 'GPT-6 Luna', group: 'plan', contextWindow: 1_050_000, maxOutputTokens: 128_000 };
  const render = (settings: Parameters<typeof ModelRow>[0]['settings']) => renderToStaticMarkup(h(ModelRow, {
    model, settings, authoritative: true, writable: true, pending: false, onCommit: async () => true,
  }));
  const legacy = render({ contextWindow: 200_000 });
  assert.match(legacy, /旧自定义 200,000，选择档位替换/u);
  assert.doesNotMatch(contextRadio(legacy, 'default'), /checked=""/u, 'a custom window selects no tier');
  assert.match(legacy, /当前总窗口 200,000 tokens（含输出预留）/u);

  // A legacy number that happens to equal a tier's token count stays a custom window.
  const equalToTier = render({ contextWindow: 500_000 });
  assert.match(equalToTier, /旧自定义 500,000，选择档位替换/u);
  assert.doesNotMatch(contextRadio(equalToTier, 'extended'), /checked=""/u);
  assert.match(equalToTier, /当前总窗口 500,000 tokens（含输出预留）/u);
});

test('an explicit output that no longer fits the window is reported before any save', () => {
  const model: StatusModel = { id: 'gpt-6-luna', name: 'GPT-6 Luna', group: 'plan', contextWindow: 1_050_000, maxOutputTokens: 128_000 };
  const html = renderToStaticMarkup(h(ModelRow, {
    model, settings: { maxTokens: 384_000 }, authoritative: true, writable: true, pending: false, onCommit: async () => true,
  }));
  const input = html.match(/<input[^>]*id="[^"]+-maxTokens"[^>]*>/u)?.[0] ?? '';
  assert.match(input, /aria-invalid="true"/u);
  assert.doesNotMatch(input, /disabled/u, 'an invalid output limit stays clearable');
  assert.match(html, /最大输出 384,000 不小于当前总窗口 272,000（含输出预留）/u);
  assert.match(html, /可清空或减小最大输出，或改选更大的上下文档位/u);
});

test('the tier policy, the capacity conflicts and the writer agree', () => {
  assert.equal(selectedContextTier({}), 'default');
  assert.equal(selectedContextTier({ contextTier: 'extended' }), 'extended');
  assert.equal(selectedContextTier({ contextWindow: 500_000 }), undefined, 'a legacy number is never a tier');
  assert.equal(selectedContextTier({ contextWindow: 500_000, contextTier: 'maximum' }), 'maximum');

  assert.equal(contextTierAvailable('default', 262_144), true);
  assert.equal(contextTierAvailable('extended', 262_144), false);
  assert.equal(contextTierAvailable('extended', 500_000), true);
  assert.equal(contextTierAvailable('maximum', 500_000), false);
  assert.equal(contextTierAvailable('maximum', undefined), true);

  assert.equal(contextTierWindow('default', 262_144), 262_144);
  assert.equal(contextTierWindow('default', 1_050_000), 272_000);
  assert.equal(contextTierWindow('extended', 1_050_000), 500_000);
  assert.equal(contextTierWindow('maximum', undefined), 872_000);

  assert.equal(contextCapacityConflict(1_050_000, { maxTokens: 4096 }), undefined);
  assert.equal(contextCapacityConflict(1_050_000, { maxTokens: 384_000 }),
    '最大输出 384,000 不小于当前总窗口 272,000（含输出预留）；可清空或减小最大输出，或改选更大的上下文档位。');
  assert.equal(contextCapacityConflict(1_050_000, { maxTokens: 384_000, contextTier: 'maximum' }), undefined);
  assert.equal(contextCapacityConflict(1_050_000, { maxTokens: 384_000, contextWindow: 500_000 }), undefined, 'a legacy window keeps its own meaning');
  assert.equal(contextCapacityConflict(1_050_000, {}), undefined);

  assert.match(contextTierConflict(1_050_000, 'default', 384_000) ?? '', /无法切换到「默认」档/u);
  assert.match(contextTierConflict(1_050_000, 'default', 384_000) ?? '', /当前档位保持不变/u);
  assert.equal(contextTierConflict(1_050_000, 'maximum', 384_000), undefined);
  assert.equal(contextTierConflict(1_050_000, 'default', undefined), undefined);

  const tiered = writeModelSettings({}, 'gpt-6-luna', { contextTier: 'extended' });
  assert.deepEqual(tiered['gpt-6-luna'], { contextTier: 'extended' });
  const legacyKept = writeModelSettings(tiered, 'gpt-6-luna', { contextTier: 'extended', contextWindow: 200_000 });
  assert.deepEqual(legacyKept['gpt-6-luna'], { contextTier: 'extended', contextWindow: 200_000 });
});

test('invalid saved efforts remain clearable and are not presented as supported choices', () => {
  const html = renderModels(status, { ...snapshot, value: { ...snapshot.value, modelSettings: { 'gpt-6-astra': { reasoningEffort: 'ultra' } } } });
  assert.match(html, /<p class="odc-effort-value">ultra（当前不可用）<\/p>/u);
  const edit = html.match(/<button[^>]*aria-label="编辑默认思考深度"[^>]*>编辑<\/button>/u)?.[0] ?? '';
  assert.doesNotMatch(edit, /disabled/u);
  assert.match(html, /已保存的档位不适用于当前模型或协议/u);
  assert.match(html, /继承默认/u);
});

test('settings effort choices also respect the pending protocol selection', () => {
  const next = { ...status, models: [{ ...models[0]!, reasoningEfforts: ['minimal', 'low', 'ultra'] }] };
  const html = renderModels(next, { ...snapshot, value: { ...snapshot.value, apiProtocol: 'messages' } });
  assert.match(html, /思考档位 low/u);
  assert.doesNotMatch(html, /minimal|ultra/u);
  assert.match(html, /aria-label="编辑默认思考深度"/u);
});

test('an overridden model keeps its reset enabled and its values rendered', () => {
  const html = renderModels(status, {
    ...snapshot,
    value: { ...snapshot.value, modelSettings: { 'gpt-6-luna': { temperature: 0.7, maxTokens: 4096, reasoningEffort: 'high' } } },
  });
  assert.match(html, /value="0.7"/u);
  assert.match(html, /value="4096"/u);
  assert.match(html, /<p class="odc-effort-value">high<\/p>/u);
  assert.match(html, /aria-label="编辑默认思考深度"/u);
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
  assert.equal((disabledHtml.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 4);
  // The Host still reports `enabled: false` until its next status refresh; the ready form owns the answer.
  const resetHtml = renderModels(status, { ...snapshot, value: { ...snapshot.value, modelSettings: {} } });
  assert.doesNotMatch(resetHtml, /已禁用/u);
  assert.equal((resetHtml.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 5);
  assert.equal((resetHtml.match(/<button[^>]*disabled=""[^>]*>重置<\/button>/g) ?? []).length, 3);
});

test('models fall back to the host settings mirror before the form is ready', () => {
  const html = renderModels(
    { ...status, config: { ...status.config, modelSettings: { 'gpt-6-astra': { enabled: true } } } },
    { status: 'loading', writable: false, value: undefined },
  );
  assert.match(html, /2 \/ 2 已启用/u);
  assert.doesNotMatch(html, /已禁用/u);
  assert.match(html, /正在载入配置，无法编辑。/u);
});

test('effort editing explains read-only, unavailable and pending states', () => {
  const readOnly = renderModels(status, { ...snapshot, writable: false });
  assert.match(readOnly, /当前设置为只读，无法编辑。/u);
  const unavailable = renderModels(status, { status: 'unavailable', writable: true, value: undefined });
  assert.match(unavailable, /配置暂不可用，无法编辑。/u);
  const pending = renderToStaticMarkup(h(Models, {
    status, formSnapshot: snapshot, setFormField: async () => true, pendingField: ['modelSettings'],
    onRefreshModels: () => {}, refreshingModels: false, notice: null,
  }));
  assert.match(pending, /正在保存模型设置，完成后可继续编辑。/u);
  assert.equal((pending.match(/<button[^>]*disabled=""[^>]*aria-label="编辑默认思考深度"/g) ?? []).length, models.length);
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
  for (const label of ['单次请求图片预算（MiB）', '请求总超时（毫秒）', '流式空闲超时（毫秒）', '额度自动刷新间隔（秒）', '收尾核验最大续办次数', '无进展停止上限']) {
    assert.match(html, new RegExp(`<label for="[^"]+">${label}</label>`));
  }
  assert.match(html, /启用异常结束监控/u);
  assert.match(html, /已累计 2 次空响应或残留拦截/u);
  assert.match(html, /持续到成功或取消/u);
  assert.match(html, /收尾核验有界/u);
  assert.doesNotMatch(html, /所有命中无限重试|文字识别可能误判|旧统计/u);
  assert.match(html, /type="checkbox"[^>]*checked=""/u);
  // The two review limits are real numeric fields bound to the saved form values.
  const continuations = html.match(/<input[^>]*id="odc-turn-continuations"[^>]*>/u)?.[0] ?? '';
  assert.match(continuations, /value="3"/u);
  assert.match(continuations, /min="1"/u);
  assert.match(continuations, /max="10"/u);
  const noProgress = html.match(/<input[^>]*id="odc-turn-no-progress"[^>]*>/u)?.[0] ?? '';
  assert.match(noProgress, /value="2"/u);
  assert.match(noProgress, /min="1"/u);
  assert.match(noProgress, /max="5"/u);
});

test('turn monitor card separates the recovery layers without inventing zeros', () => {
  // The protocol intercept count comes from `guardedTurns` and is deliberately distinct
  // from `turnMonitor.continuations`, so a wiring mix-up shows up as wrong numbers.
  const full = renderToStaticMarkup(h(TurnMonitorView, { turnMonitor, guardedTurns: 4 }));
  for (const label of ['空响应／残留拦截', '请求重试', '结束核验', '任务续办']) assert.match(full, new RegExp(label));
  assert.match(full, /<dt title="空回答或协议标记残留的拦截次数[^"]*">空响应／残留拦截<\/dt><dd><strong class="odc-metric-value">4<\/strong><\/dd>/u);
  assert.match(full, /<dd><strong class="odc-metric-value">1<\/strong><\/dd>/u);
  assert.match(full, /<dd><strong class="odc-metric-value">7<\/strong><\/dd>/u);
  assert.match(full, /最近决定/u);
  assert.match(full, /达到上限 · 达到续办上限/u);
  assert.doesNotMatch(full, /limited|continuation-limit/u, 'model-facing identifiers stay out of the UI');
  assert.match(full, /<time class="odc-hint" dateTime="2026-10-26T10:00:00\.000Z"/u);
  assert.match(full, /title="最近决定时间：/u);
  assert.match(full, /aria-label="最近决定：达到上限/u);
  // The time is independently accessible via the native element even in dense layouts.
  const timeHtml = full.match(/<time[^>]*>[^<]*<\/time>/u)?.[0] ?? '';
  assert.match(timeHtml, /2026\/10\/26|2026-10-26/u);

  const unavailable = renderToStaticMarkup(h(TurnMonitorView, { turnMonitor: omitLast(turnMonitor, false), guardedTurns: 4 }));
  assert.match(unavailable, /仅协议保护可用；收尾核验未启用。/u);
  const disabled = renderToStaticMarkup(h(TurnMonitorView, { turnMonitor, guardedTurns: 4, enabled: false }));
  assert.match(disabled, /监控已关闭/u);
  assert.doesNotMatch(disabled, /收尾核验可用|两层恢复已运行/u);

  // Legacy status without the optional monitor keeps only the known protocol counter.
  const legacy = renderToStaticMarkup(h(TurnMonitorView, { guardedTurns: 5 }));
  assert.match(legacy, /<dt title="空回答或协议标记残留的拦截次数[^"]*">空响应／残留拦截<\/dt><dd><strong class="odc-metric-value">5<\/strong><\/dd>/u);
  assert.equal((legacy.match(/>—</g) ?? []).length, 4);
  assert.doesNotMatch(legacy, /class="odc-metric-value">0</u);
  assert.match(legacy, /仅协议拦截计数可用/u);
  // Neither value known stays unknown everywhere.
  const empty = renderToStaticMarkup(h(TurnMonitorView, {}));
  assert.equal((empty.match(/>—</g) ?? []).length, 5);
  assert.doesNotMatch(empty, /class="odc-metric-value">0</u);
  assert.match(empty, /暂无监控数据/u);
});

test('turn monitor limits save through the host form with rollback', async () => {
  const saved: Array<[string, unknown]> = [];
  const setFormField = async (field: string, value: unknown): Promise<boolean> => {
    saved.push([field, value]);
    return false;
  };
  const html = renderToStaticMarkup(h(Advanced, {
    status, formSnapshot: snapshot, setFormField, clearFormField: async () => true, pendingField: ['turnReviewMaxContinuations'],
  }));
  assert.match(html, /<input[^>]*id="odc-turn-continuations"[^>]*disabled=""/u);
  assert.equal(saved.length, 0, 'server rendering must not write configuration');
  const unbound = renderToStaticMarkup(h(Advanced, {
    status: omitTurnMonitor(status), formSnapshot: { status: 'loading', writable: false, value: undefined }, setFormField: async () => true, clearFormField: async () => true, pendingField: [],
  }));
  // Without form or host values the defaults render as the editable starting point.
  assert.match(unbound.match(/<input[^>]*id="odc-turn-continuations"[^>]*>/u)?.[0] ?? '', /value="3"/u);
  assert.match(unbound.match(/<input[^>]*id="odc-turn-no-progress"[^>]*>/u)?.[0] ?? '', /value="2"/u);
});

test('the completion review switch defaults off and gates its own limits', () => {
  const off = renderAdvanced(
    { ...status, config: { ...status.config, turnCompletionReview: false } },
    { status: 'ready', writable: true, value: { ...snapshot.value, turnCompletionReview: false } },
  );
  assert.match(off, /启用结束回合核验/u);
  assert.equal((off.match(/type="checkbox"[^>]*checked=""/gu) ?? []).length, 1, 'only the guard is enabled by default');
  assert.match(off.match(/<input[^>]*id="odc-turn-continuations"[^>]*>/u)?.[0] ?? '', /disabled=""/u);
  assert.match(off.match(/<input[^>]*id="odc-turn-no-progress"[^>]*>/u)?.[0] ?? '', /disabled=""/u);

  const on = renderAdvanced(
    { ...status, config: { ...status.config, turnCompletionReview: true } },
    { status: 'ready', writable: true, value: { ...snapshot.value, turnCompletionReview: true } },
  );
  assert.equal((on.match(/type="checkbox"[^>]*checked=""/gu) ?? []).length, 2);
  assert.doesNotMatch(on.match(/<input[^>]*id="odc-turn-continuations"[^>]*>/u)?.[0] ?? '', /disabled=""/u);

  // The guard stays the outer switch: no probe can enable a review the guard has disabled.
  const guardedOff = renderAdvanced(
    { ...status, config: { ...status.config, emptyTurnGuard: false, turnCompletionReview: true } },
    { status: 'ready', writable: true, value: { ...snapshot.value, emptyTurnGuard: false, turnCompletionReview: true } },
  );
  const boxes = guardedOff.match(/<input type="checkbox"[^>]*>/gu) ?? [];
  assert.equal(boxes.length, 2);
  assert.match(boxes[1] ?? '', /disabled=""/u);
  assert.match(boxes[1] ?? '', /checked=""/u, 'the saved value stays visible while the guard disables it');
  assert.match(guardedOff, /需要先开启异常结束监控/u, 'a disabled switch explains why');
});

test('unavailable writable forms cannot expose editable controls', () => {
  const unavailable: FormSnapshot = { status: 'unavailable', writable: true, value: undefined };
  const html = renderAdvanced(status, unavailable);
  assert.match(html, /type="checkbox" disabled=""/u);
  const modelHtml = renderModels(status, unavailable);
  assert.equal((modelHtml.match(/type="checkbox" disabled=""/g) ?? []).length, models.length * 2);
});

test('all concurrently pending fields stay disabled', () => {
  const html = renderToStaticMarkup(h(Advanced, {
    status, formSnapshot: snapshot, setFormField: async () => true, clearFormField: async () => true,
    pendingField: ['emptyTurnGuard', 'apiProtocol', 'apiKeyEnv', 'maxRequestImageBytes'],
  }));
  assert.match(html, /type="checkbox" disabled=""/u);
  assert.match(html, /<select[^>]*id="odc-api-protocol"[^>]*disabled=""/u);
  assert.match(html, /<input[^>]*id="odc-api-key-env"[^>]*disabled=""/u);
  assert.match(html, /<input[^>]*id="odc-image-budget"[^>]*disabled=""/u);
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
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked=""/u);
  assert.match(html, /已累计 2 次空响应或残留拦截/u);
});


test('an unnamed reference leaves the field blank and names the default as its placeholder', () => {
  // The browser bundle carries its own copy of the default; the two must not drift apart.
  assert.equal(DEFAULT_KEY_REF, DEFAULT_API_KEY_REF);
  const unnamed: Status = { ...status, config: { ...status.config, apiKeyEnv: '' } };
  const html = renderAdvanced(unnamed);
  const input = html.match(/<input[^>]*id="odc-api-key-env"[^>]*>/u)?.[0] ?? '';
  assert.match(input, /value=""/u);
  assert.match(input, new RegExp(`placeholder="${DEFAULT_KEY_REF}"`, 'u'));
  // A named reference still shows the saved name and needs no placeholder.
  const named = renderAdvanced({ ...status, config: { ...status.config, apiKeyEnv: 'TEAM_KEY' } });
  const namedInput = named.match(/<input[^>]*id="odc-api-key-env"[^>]*>/u)?.[0] ?? '';
  assert.match(namedInput, /value="TEAM_KEY"/u);
});
