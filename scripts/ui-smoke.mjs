// Entirely offline browser fixture: never opens the DSH GUI, account pages or real login.
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditTheme } from './theme-audit.mjs';
import assert from 'node:assert/strict';
import { MODELS, Config } from '../lib/index.js';
import { volatileForm } from '../node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js';
const formSchema = volatileForm(Config);
const previewDir = process.env.ODC_PREVIEW_DIR || 'docs/previews';
assert.ok(formSchema);
const react = await build({ stdin: { contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client'; import Schema from '@deepseek-ai/schemastery'; window.__Schema=Schema; window.__React=React; window.__mount=(component,props)=>{window.__root=createRoot(document.getElementById('root'));window.__root.render(React.createElement(component,props));}; window.__mountInto=(container,component,props)=>{const root=createRoot(container);root.render(React.createElement(component,props));return root;};`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } });
const client = await readFile('lib/client.js', 'utf8');
const theme = await readFile('test/fixtures/dsh-theme.css', 'utf8');
assert.ok(!client.includes('node:'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // No network request is necessary or allowed in the fixture.
  await page.route('**/*', route => route.abort());
  await page.setContent(`<html><head><meta charset="utf-8"><style>
  :root{color-scheme:light}
  body{margin:0;background:var(--dsw-alias-bg-base);font-family:system-ui,'Microsoft YaHei',sans-serif;padding:38px;color:var(--dsw-alias-label-primary)} #root{max-width:900px;margin:auto} .fixture-note{max-width:900px;margin:0 auto 20px;color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.03em} #conversation-input{max-width:900px;margin:0 auto 16px;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:10px}
  </style></head><body><div class="fixture-note">离线界面预览 · 模拟数据，非真实账号</div><div id="conversation-input"></div><main id="root"></main></body></html>`);
  await page.addStyleTag({ content: theme });
  await page.addScriptTag({ content: react.outputFiles[0].text });
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(bundle) { window.__plugin = bundle.factory(name => { if (name === 'react') return window.__React; throw new Error('Unexpected external: ' + name); }); } };
  });
  await page.addScriptTag({ content: client });
const fixtureModels = MODELS.map(({ id, name, group, inputModalities, contextWindow, maxOutputTokens, reasoningEfforts }) => ({
  id, name, group,
  ...(inputModalities === undefined ? {} : { inputModalities }),
  ...(contextWindow === undefined ? {} : { contextWindow }),
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
}));
  await page.evaluate(({ rawModels, wireSchema }) => {
    // Decode the real Host-projected form, including its extra JSON serialization hop.
    const schema = new window.__Schema(wireSchema);
    const validateConfig = value => { schema(structuredClone(value)); };
    const resetAt = new Date(Date.now() + 86_400_000).toISOString();
    const initialQuota = () => ({
      state: 'ok', source: 'login', updatedAt: new Date().toISOString(), tier: 'Pro', eligible: true,
      subscriptionPeriodStart: '2026-10-01T00:00:00Z', subscriptionPeriodEnd: '2026-11-01T00:00:00Z',
      nextRefreshAt: new Date(Date.now() + 3_600_000).toISOString(),
      windows: [
        { durationSeconds: 18000, used: 120, limit: 500, remaining: 380, percent: 24, resetsAt: resetAt, windowStart: new Date(Date.now() - 3_600_000).toISOString(), resetMode: 'activity_triggered' },
        { durationSeconds: 604800, used: 400, limit: 2000, remaining: 1600, percent: 20, resetsAt: new Date(Date.now() + 172_800_000).toISOString() },
      ],
      balances: { subscriptionUsd: 60, rechargeUsd: 20, totalUsd: 80 },
    });
    let quota = initialQuota();
    let login = { jobId: null, state: 'idle' };
    let loginSequence = 0;
    let apiKeySource = 'device';
    window.__setKeySource = source => { apiKeySource = source; };
    window.__failStatusReads = false;
    let config = {
      emptyTurnGuard: true, turnCompletionReview: false, useDesktopCredential: true, baseURL: 'https://amr-link.open-design.ai/v1', apiKeyEnv: 'COROUTER_API_KEY',
      apiProtocol: 'chat-completions', modelSettings: {}, quotaRefreshSeconds: 60, requestTimeoutMs: 1800000, streamIdleTimeoutMs: 300000,
      turnReviewMaxContinuations: 3, turnReviewNoProgressLimit: 2,
    };
    validateConfig(config);
    let turnMonitor = { available: true, checks: 4, continuations: 5, requestRetries: 1,
      last: { at: new Date(Date.now() - 3_600_000).toISOString(), decision: 'continued', reason: 'pending-action' } };
    let models = rawModels.map(model => ({ ...model, enabled: true }));
    let modelsSource = 'builtin';
    let modelsUpdatedAt;
    let modelsError;
    let snapshot = { status: 'ready', writable: true, value: config };
    const listeners = new Set(), disposers = [];
    window.__holdQuota = true;
    window.__holdSaves = false;
    window.__rejectSave = false;
    window.__refreshQuotaCalls = 0;
    window.__forceRefreshCalls = 0;
    window.__statusCalls = 0;
    window.__refreshModelsCalls = 0;
    window.__refreshPricesCalls = 0;
    window.__pricesFail = false;
    window.__modelsFail = false;
    window.__autoRefreshBump = false;
    window.__config = config;
    const syncConfig = () => { window.__config = config; };
    const status = () => {
      const value = {
        revision: 'fixture-revision', apiKeyConfigured: true, apiKeySource, sessionSource: 'login', quota, login, config, guardedTurns: 2,
        ...(turnMonitor === undefined ? {} : { turnMonitor }),
        models: models.map(model => ({ ...model, enabled: config.modelSettings?.[model.id]?.enabled ?? model.enabled ?? true })),
        modelsSource,
        ...(modelsUpdatedAt === undefined ? {} : { modelsUpdatedAt }),
        ...(modelsError === undefined ? {} : { modelsError }),
      };
      window.__lastStatus = value;
      return value;
    };
    window.__setQuotaState = (state, note) => { quota = { ...quota, state, ...(note === undefined ? { note: undefined } : { note }) }; };
    window.__armAutoRefresh = () => {
      quota = { ...quota, nextRefreshAt: new Date(Date.now() + 3_000).toISOString() };
      window.__refreshQuotaCalls = 0;
      window.__autoRefreshBump = true;
    };
    window.__setQuotaUnknown = () => {
      quota = { state: 'partial', updatedAt: new Date().toISOString(), windows: [], balances: {}, note: '模拟额度数据不可用。' };
    };
    window.__setQuotaNoPlan = () => {
      quota = { state: 'partial', updatedAt: new Date().toISOString(), eligible: false, windows: [], balances: {} };
    };
    window.__restoreQuota = () => { quota = initialQuota(); };
    window.__setWindowResetSoon = () => { quota = { ...quota, windows: quota.windows.map((item, index) => index === 0 ? { ...item, resetsAt: new Date(Date.now() + 1800).toISOString() } : item) }; };
    const api = {
      status: async (...args) => { if (args.length) throw new Error('status requires zero arguments'); if (window.__failStatusReads) throw new Error('fixture-status-unavailable'); window.__statusCalls += 1; return { ok: true, value: status() }; },
      refreshPrices: async (...args) => {
        if (args.length) throw new Error('refreshPrices requires zero arguments');
        window.__refreshPricesCalls += 1;
        const base = { label: '27.2 万 Token 及以内', currency: 'USD', unit: 'per_1m_tokens', input: 2, output: 10, cacheRead: 0.1, cacheWrite: null };
        return { ok: true, value: { state: window.__pricesFail ? 'error' : 'ok', stale: window.__pricesFail, fetchedAt: '2026-10-27T08:00:00Z', models: [
          { id: 'gpt-6.1-sol', tiers: [base, { ...base, label: '超过 27.2 万 Token', input: 4, output: 15 }] },
          { id: 'gpt-6-luna', tiers: [{ ...base, label: '不按输入长度分档', input: 0.25, output: 1 }] },
        ] } };
      },
      refreshModels: async (...args) => {
        if (args.length) throw new Error('refreshModels requires zero arguments');
        window.__refreshModelsCalls += 1;
        if (window.__modelsFail) {
          // The Host keeps the previous catalog and reports a safe, fixed discovery error.
          modelsError = '模型发现请求超过 20 秒时限';
          return { ok: true, value: status() };
        }
        modelsSource = 'openai';
        modelsUpdatedAt = new Date().toISOString();
        modelsError = undefined;
        if (!models.some(model => model.id === 'gpt-6.1-sol-remote')) {
          models = [...models, { id: 'gpt-6.1-sol-remote', name: 'GPT-6.1 Sol Remote', group: 'paid', contextWindow: 200000, maxOutputTokens: 8192, reasoningEfforts: ['low', 'medium', 'high'], enabled: true }];
        }
        return { ok: true, value: status() };
      },
      refreshQuota: async (...args) => {
        if (args.length) throw new Error('refreshQuota requires zero arguments');
        window.__refreshQuotaCalls += 1;
        if (window.__holdQuota) await new Promise(resolve => { window.__releaseQuota = resolve; });
        if (window.__autoRefreshBump && window.__refreshQuotaCalls >= 2) {
          quota = { ...quota, nextRefreshAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString() };
          window.__autoRefreshBump = false;
        }
        return { ok: true, value: quota };
      },
      startLogin: async () => {
        login = { jobId: `fixture-job-${++loginSequence}`, state: 'waiting', message: '请在授权窗口确认设备授权',
          activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=fixture-device&userCode=AB12-CD34', userCode: 'AB12-CD34',
          expiresAt: new Date(Date.now() + 300_000).toISOString() };
        return { ok: true, value: login };
      },
      loginStatus: async (...args) => { if (args.length) throw new Error('loginStatus requires zero arguments'); return { ok: true, value: login }; },
      cancelLogin: async () => { login = { jobId: login.jobId, state: 'cancelled' }; return { ok: true, value: login }; },
      openActivationPage: async (...args) => {
        if (args.length) throw new Error('openActivationPage requires zero arguments');
        window.__openActivationCalls += 1;
        if (window.__holdActivation) await new Promise(resolve => { window.__releaseActivation = resolve; });
        const code = window.__activationCode ?? 'opened';
        return { ok: true, value: { code, opened: code === 'opened' } };
      },
      saveApiKey: async request => { if (request.value !== 'fixture-api-key') throw new Error('Unexpected fixture key'); if (apiKeySource !== 'reference') apiKeySource = 'stored'; return { ok: true, value: status() }; },
    };
    api.refreshQuotaNow = async (...args) => {
      if (args.length) throw new Error('refreshQuotaNow requires zero arguments');
      window.__forceRefreshCalls += 1;
      if (quota.autoRefreshPaused) quota = initialQuota();
      return api.refreshQuota();
    };
    window.__finishLogin = state => {
      login = { ...login, state, message: state === 'success' ? '设备授权已完成并保存' : '设备授权已过期，请重新开始' };
    };
    window.__setQuotaPaused = () => { quota = { ...quota, state: 'partial', autoRefreshPaused: true, refreshFailures: 6, nextRefreshAt: undefined }; };
    window.__setTurnMonitor = value => { turnMonitor = value; };
    window.__setModelsFail = value => { window.__modelsFail = value; };
    window.__openActivationCalls = 0;
    window.__setActivationCode = code => { window.__activationCode = code; };
    window.__setModelEffort = (id, reasoningEffort) => {
      config = { ...config, modelSettings: { ...config.modelSettings, [id]: { ...config.modelSettings?.[id], reasoningEffort } } };
      validateConfig(config); syncConfig();
      snapshot = { ...snapshot, value: config };
      for (const cb of listeners) cb();
    };
    // Seed a saved override the way an older configuration would carry it: the tier and the
    // legacy number are mutually exclusive, so the other one is dropped with the patch.
    window.__setModelSettings = (id, patch) => {
      const next = { ...(config.modelSettings?.[id] ?? {}), ...patch };
      if (patch.contextWindow !== undefined) delete next.contextTier;
      if (patch.contextTier !== undefined) delete next.contextWindow;
      config = { ...config, modelSettings: { ...config.modelSettings, [id]: next } };
      validateConfig(config); syncConfig();
      snapshot = { ...snapshot, value: config };
      for (const cb of listeners) cb();
    };
    window.__clearModelSettings = id => {
      const next = { ...config.modelSettings };
      delete next[id];
      config = { ...config, modelSettings: next };
      validateConfig(config); syncConfig();
      snapshot = { ...snapshot, value: config };
      for (const cb of listeners) cb();
    };
    window.__setFormState = (state, writable) => {
      snapshot = { ...snapshot, status: state, writable, value: state === 'ready' ? config : undefined };
      for (const cb of listeners) cb();
    };
    window.__setQuotaRefresh = seconds => {
      config = { ...config, quotaRefreshSeconds: seconds };
      validateConfig(config); syncConfig();
      snapshot = { ...snapshot, value: config };
      for (const cb of listeners) cb();
    };
    window.__saveCalls = [];
    window.__heldSaves = 0;
    window.__holdWaiters = [];
    // Releasing is safe at any moment: it frees every write that waits now, and a write
    // that arrives later simply runs on. A stale resolver must never strand the queue.
    window.__releaseSave = () => { for (const resolve of window.__holdWaiters.splice(0)) resolve(); };
    window.__releaseHeldSave = () => { window.__releaseSave(); };
    const form = {
      getSnapshot: () => snapshot,
      subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
      set: async (field, value) => {
        window.__saveCalls.push(field);
        if (window.__holdSaves) {
          window.__heldSaves += 1;
          await new Promise(resolve => { window.__holdWaiters.push(resolve); });
          window.__heldSaves -= 1;
        }
        if (window.__rejectSave) { window.__rejectSave = false; return false; }
        const next = { ...config, [field]: value };
        validateConfig(next);
        config = next;
        syncConfig();
        snapshot = { ...snapshot, value: config };
        for (const cb of listeners) cb();
        return true;
      },
    };
    // Conversation input slots: every session owns its own model directory store.
    const directories = new Map();
    const directoryFor = sessionId => {
      let entry = directories.get(sessionId);
      if (!entry) {
        const directoryListeners = new Set();
        let directorySnapshot = { current: null, pending: null, status: 'idle', groups: [], routable: null };
        entry = {
          store: {
            getSnapshot: () => directorySnapshot,
            subscribe: cb => { directoryListeners.add(cb); return () => directoryListeners.delete(cb); },
          },
          listenerCount: () => directoryListeners.size,
          update: patch => {
            directorySnapshot = { ...directorySnapshot, ...patch };
            for (const cb of [...directoryListeners]) cb();
          },
        };
        directories.set(sessionId, entry);
      }
      return entry;
    };
    window.__setDirectory = (sessionId, patch) => { directoryFor(sessionId).update(patch); };
    window.__quickRoots = [];
    window.__mountQuick = (sessionId, containerId = 'conversation-input') => {
      const slot = window.__quickSlot;
      if (!slot) throw new Error('the conversation input slot is not registered');
      const container = document.getElementById(containerId);
      const root = window.__mountInto(container, slot.component, slot.descriptor.inject(sessionId));
      window.__quickRoots.push(root);
      return true;
    };
    window.__unmountQuick = () => { for (const root of window.__quickRoots.splice(0)) root.unmount(); };
    window.__activeSubscriptions = () => ({ form: listeners.size, directories: [...directories.values()].reduce((sum, entry) => sum + entry.listenerCount(), 0) });
    const ctx = {
      remote: { openDesignCoRouter: api, $mount: async () => () => { window.__remoteDisposed = true; } },
      get: key => key === 'remote.openDesignCoRouter' ? api : undefined,
      effect: fn => { const result = fn(); if (result?.then) { void result.then(disposer => { if (disposer) disposers.push(disposer); }); } else if (typeof result === 'function') disposers.push(result); },
      inject: (services, fn) => {
        // The model directory is a nested scope: it is per session, never a global model.
        if (services.includes('modelDirectories')) return fn({ modelDirectories: { directoryFor }, effect: ctx.effect, slots: ctx.slots });
        return fn(ctx);
      },
      configForms: { get: () => form },
      slots: {
        inject: (_name, fn) => fn(),
        register: (descriptor, component) => {
          if (descriptor.name === 'conversation.input.right') {
            window.__quickSlot = { descriptor, component };
            return () => { window.__quickSlot = undefined; };
          }
          window.__mount(component, descriptor.inject());
          return () => {};
        },
      },
    };
    window.__cleanup = async () => { window.__root.unmount(); window.__unmountQuick(); for (const off of disposers.reverse()) await off(); };
    window.__plugin.apply(ctx);
  }, { rawModels: fixtureModels, wireSchema: JSON.parse(JSON.stringify(formSchema.toJSON())) });
  const config = () => page.evaluate(() => window.__config);
  const modelSettings = () => page.evaluate(() => window.__config.modelSettings ?? {});
  await page.getByRole('heading', { name: '额度概览', exact: true }).waitFor();
  // A blocked quota reader must not prevent the configuration page from becoming usable.
  await page.getByRole('tab', { name: '连接与登录', exact: true }).click();
  const desktopSwitch = page.getByRole('checkbox', { name: /优先使用桌面登录态/u });
  await desktopSwitch.waitFor();
  await page.waitForFunction(() => !document.querySelector('.odc-switch input').disabled, null, { timeout: 3000 });
  await page.evaluate(() => { window.__holdSaves = true; });
  await desktopSwitch.uncheck();
  assert.equal(await desktopSwitch.isChecked(), false, 'pending save shows the requested checkbox state');
  await page.getByText('正在保存设置…', { exact: true }).waitFor();
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.waitForFunction(() => window.__config.useDesktopCredential === false);
  await page.waitForFunction(() => !document.querySelector('.odc-switch input').disabled, null, { timeout: 3000 });
  assert.equal(await desktopSwitch.isEnabled(), true, 'a saved control must unlock while quota is pending');
  await desktopSwitch.check();
  await page.waitForFunction(() => window.__config.useDesktopCredential === true);
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  const pendingGuard = page.getByRole('checkbox', { name: /启用异常结束监控/u });
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await pendingGuard.uncheck();
  assert.equal(await pendingGuard.isChecked(), false);
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  assert.equal(await pendingGuard.isChecked(), true, 'rejected save restores the accepted value');
  // Namespace availability is separate from transport writability.
  await page.evaluate(() => window.__setFormState('unavailable', true));
  await page.getByText('配置暂不可用，请检查插件是否已启用。', { exact: true }).waitFor();
  assert.equal(await pendingGuard.isDisabled(), true);
  await page.evaluate(() => window.__setFormState('ready', false));
  await page.getByText('当前设置为只读，无法保存修改。', { exact: true }).waitFor();
  assert.equal(await pendingGuard.isDisabled(), true);
  await page.evaluate(() => { window.__setFormState('ready', true); window.__holdSaves = true; window.__saveCalls = []; });
  await pendingGuard.uncheck();
  const queuedProtocol = page.getByLabel('API 协议', { exact: true });
  await queuedProtocol.selectOption('responses');
  assert.equal(await pendingGuard.isDisabled(), true, 'the first pending field remains locked');
  assert.equal(await queuedProtocol.isDisabled(), true, 'the queued field is also locked');
  assert.equal(await pendingGuard.isChecked(), false);
  assert.equal(await queuedProtocol.inputValue(), 'responses');
  assert.deepEqual(await page.evaluate(() => window.__saveCalls), ['emptyTurnGuard'], 'writes enter the Host one at a time');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.waitForFunction(() => window.__config.emptyTurnGuard === false && window.__config.apiProtocol === 'responses');
  assert.deepEqual(await page.evaluate(() => window.__saveCalls), ['emptyTurnGuard', 'apiProtocol']);
  await pendingGuard.check();
  await queuedProtocol.selectOption('chat-completions');
  await page.waitForFunction(() => window.__config.apiProtocol === 'chat-completions');
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await pendingGuard.uncheck();
  await queuedProtocol.selectOption('responses');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.waitForFunction(() => window.__config.apiProtocol === 'responses');
  await page.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  assert.equal(await pendingGuard.isChecked(), true, 'a later successful write must not conceal an earlier rejection');
  await queuedProtocol.selectOption('chat-completions');
  await page.evaluate(() => { window.__holdQuota = false; window.__releaseQuota(); });
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByText('US$80.00', { exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 4);
  for (const label of ['订阅账期结束', '下次额度恢复']) {
    const metric = page.locator('.odc-metric', { hasText: label });
    assert.match(await metric.locator('.odc-metric-text').innerText(), /(?:后|已到结束时间|等待更新)/u, `${label} shows relative time`);
    assert.match(await metric.locator('time').getAttribute('title'), /\d{4}\//u, `${label} retains its exact timestamp`);
  }
  const refreshCountdown = page.locator('.odc-metric', { hasText: '下次自动刷新' }).locator('time');
  assert.match(await refreshCountdown.innerText(), /(?:\d+秒后|\d+分\d+秒后)/u);
  assert.match(await refreshCountdown.getAttribute('title'), /计划刷新时间：\d{4}\//u);
  const beforeCountdown = await refreshCountdown.innerText();
  await page.waitForFunction(before => {
    const nodes = [...document.querySelectorAll('.odc-metric')];
    return nodes.find(node => node.textContent.includes('下次自动刷新'))?.querySelector('time')?.textContent !== before;
  }, beforeCountdown, { timeout: 4000 });
  await page.getByText('套餐赠送窗口', { exact: true }).waitFor();
  const firstWindow = page.getByRole('region', { name: '5 小时赠送窗口', exact: true });
  assert.equal(await firstWindow.locator('.odc-window-remaining strong').innerText(), '76.0%');
  assert.equal(await firstWindow.getByRole('progressbar').getAttribute('value'), '76');
  assert.equal(await firstWindow.locator('.odc-window-usage').innerText(), '已用 120 / 总计 500 积分');
  assert.equal(await page.locator('.odc-quota-status').getAttribute('data-tone'), 'good');
  await page.getByText('赠送窗口额度充足', { exact: true }).waitFor();
  const windowDetails = firstWindow.locator('details');
  assert.equal(await windowDetails.getAttribute('open'), null, 'technical window details start collapsed');
  assert.equal(await windowDetails.getByText('窗口开始', { exact: true }).isVisible(), false);
  await windowDetails.locator('summary').click();
  await windowDetails.getByText('按使用触发', { exact: true }).waitFor();
  assert.equal(await windowDetails.locator('dd').first().innerText(), '380');
  await windowDetails.locator('summary').click();
  assert.equal(await page.getByLabel('额度数据来源与更新时间', { exact: true }).locator('dt').count(), 2);
  await mkdir(previewDir, { recursive: true });
  await page.screenshot({ path: join(previewDir, 'overview.png'), fullPage: true });
  // A window passing its reset time must stop claiming the previous reading is current.
  await page.evaluate(() => window.__setWindowResetSoon());
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.getByText('等待更新窗口额度', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await firstWindow.getAttribute('data-tone'), 'neutral');
  await page.evaluate(() => window.__restoreQuota());
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.getByText('赠送窗口额度充足', { exact: true }).waitFor();

  // Auto refresh follows the Host's planned read when it is earlier than the configured interval.
  await page.evaluate(() => window.__armAutoRefresh());
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.waitForFunction(() => window.__refreshQuotaCalls >= 2, null, { timeout: 15_000 });
  assert.equal(await page.evaluate(() => window.__autoRefreshBump), false);
  assert.ok(await page.evaluate(() => window.__forceRefreshCalls > 0), 'manual refresh must use the cache-bypassing endpoint');
  await page.evaluate(() => window.__setQuotaPaused());
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByText('连续失败，自动重试已暂停；点击刷新额度重试', { exact: true }).waitFor();
  const manualBefore = await page.evaluate(() => window.__forceRefreshCalls);
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.waitForFunction(before => window.__forceRefreshCalls > before, manualBefore);
  await page.getByText('US$80.00', { exact: true }).waitFor();

  // Unknown quota must stay unknown, never zero; no Design Plan must say so.
  await page.evaluate(() => window.__setQuotaUnknown());
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.locator('.odc-metric', { hasText: '订阅账期结束' }).locator('.odc-metric-text').filter({ hasText: '—' }).waitFor();
  assert.doesNotMatch(await page.locator('.odc-settings').innerText(), /\$0\.00/u);
  await page.evaluate(() => window.__setQuotaNoPlan());
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.getByText('当前账号未开通 Design Plan，没有赠送额度窗口。', { exact: true }).waitFor();
  await page.evaluate(() => window.__restoreQuota());
  await page.getByRole('button', { name: '刷新额度', exact: true }).click();
  await page.getByText('US$80.00', { exact: true }).waitFor();

  // Models: switches, whole-map persistence, parameters, reset, stale-status ordering and discovery.
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  assert.equal(await page.locator('.odc-model-item').count(), 12, 'each group starts with six models');
  // The settings pane may be narrow even in a wide browser window.
  await page.locator('#root').evaluate(root => { root.style.width = '600px'; });
  assert.equal(await page.locator('.odc-model-groups').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 1, 'model groups follow the actual pane width');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#root').evaluate(root => { root.style.width = '320px'; });
  assert.equal(await page.locator('.odc-settings').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'narrow embedded pane has no horizontal overflow');
  assert.equal(await page.locator('.odc-model-item code').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 12), true, 'model identifiers remain legible');
  assert.equal(await page.locator('.odc-button-small').first().evaluate(element => element.getBoundingClientRect().height >= 32), true, 'model actions keep a usable target size');
  const compactImage = await page.locator('.odc-image-toggle:visible').first().evaluate(label => ({
    labelHeight: label.getBoundingClientRect().height,
    inputHeight: label.querySelector('input').getBoundingClientRect().height,
  }));
  assert.ok(compactImage.labelHeight >= 24 && compactImage.labelHeight <= 32, 'the image label stays compact with an accessible pointer target');
  assert.ok(compactImage.inputHeight <= 18, 'the native image checkbox does not dominate the model row');
  await page.locator('#root').evaluate(root => { root.style.width = ''; });
  const groupCards = page.locator('.odc-model-groups > section');
  const planGroup = groupCards.first();
  const planIds = () => planGroup.locator('.odc-model-item code').allTextContents();
  const catalogOrder = await page.evaluate(() => window.__lastStatus.models.map(model => model.id));

  // Pending enablement changes reorder every view immediately; rejection restores the accepted order.
  const flashRow = planGroup.locator('.odc-model-item', { hasText: 'deepseek-v4.1-flash' });
  const flashSwitch = flashRow.locator('.odc-model-switch input[type=checkbox]');
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await flashSwitch.click();
  assert.equal(await flashRow.count(), 0, 'a pending disabled model leaves the collapsed enabled first-six view');
  assert.deepEqual(await planIds(), ['gpt-6-luna', 'claude-haiku-5.5', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'glm-5.3-flashx']);
  await planGroup.getByRole('button', { name: '显示全部 13 个模型', exact: true }).click();
  assert.equal((await planIds()).at(-1), 'deepseek-v4.1-flash', 'expanded results place the pending disabled row after every enabled row');
  await page.getByLabel('搜索套餐赠送模型', { exact: true }).fill('flash');
  assert.deepEqual(await planIds(), ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'glm-5.3-flashx', 'glm-5.3-flash', 'mimo-v2.6-flash', 'minimax-m3.1-flash', 'deepseek-v4.1-flash'], 'search follows the same enabled-first stable ordering');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['deepseek-v4.1-flash']), undefined, 'a held save has not changed the accepted configuration');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  assert.deepEqual(await planIds(), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'glm-5.3-flashx', 'glm-5.3-flash', 'mimo-v2.6-flash', 'minimax-m3.1-flash'], 'rollback restores catalog order in search results');
  assert.equal(await flashSwitch.isChecked(), true);
  assert.deepEqual(await page.evaluate(() => window.__lastStatus.models.map(model => model.id)), catalogOrder, 'display sorting never mutates the Host catalog');
  await page.getByLabel('搜索套餐赠送模型', { exact: true }).fill('');
  await planGroup.getByRole('button', { name: '收起模型列表', exact: true }).click();
  assert.equal(await planGroup.locator('.odc-model-item').count(), 6);

  await page.getByLabel('搜索套餐赠送模型', { exact: true }).fill('no-such-model');
  assert.equal(await groupCards.evaluateAll(cards => cards[0].getBoundingClientRect().height < cards[1].getBoundingClientRect().height), true, 'shorter group does not stretch to its neighbour');
  await page.getByLabel('搜索套餐赠送模型', { exact: true }).fill('');
  await page.getByLabel('搜索付费模型', { exact: true }).fill('qwen');
  await page.locator('.odc-model-item', { hasText: 'qwen3.7-max' }).waitFor();
  await page.getByLabel('搜索付费模型', { exact: true }).fill('');
  for (const group of await page.locator('.odc-model-groups > section').all()) {
    const expand = group.getByRole('button', { name: /^显示全部/u });
    if (await expand.count()) await expand.click();
  }
  assert.equal(await page.locator('.odc-model-item').count(), fixtureModels.length);
  const luna = page.locator('.odc-model-item', { hasText: 'gpt-6-luna' });
  await luna.getByText(/官网参考.*输入 \$0\.25/u).waitFor();
  assert.equal(await page.evaluate(() => window.__refreshPricesCalls), 1, 'model tab loads prices once');
  const solPrice = page.locator('.odc-model-item', { hasText: 'gpt-6.1-sol' }).first();
  await solPrice.getByText(/共 2 档/u).waitFor();
  await solPrice.locator('summary').click();
  await solPrice.getByText('超过 27.2 万 Token · 每百万 Token', { exact: true }).waitFor();
  assert.equal(await solPrice.getByText('未列出', { exact: true }).count(), 2, 'unlisted cache write prices stay unknown');
  await solPrice.locator('summary').click();
  await page.evaluate(() => { window.__pricesFail = true; });
  await page.getByRole('button', { name: '更新价格', exact: true }).click();
  await page.getByText(/读取失败，显示上次价格/u).waitFor();
  await page.evaluate(() => { window.__pricesFail = false; });
  await page.getByRole('button', { name: '更新价格', exact: true }).click();
  await page.waitForFunction(() => window.__refreshPricesCalls === 3);
  const lunaSwitch = luna.locator('.odc-model-switch input[type=checkbox]');
  assert.equal(await lunaSwitch.isChecked(), true);
  await lunaSwitch.uncheck();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.enabled === false);
  await luna.getByText('已禁用', { exact: true }).waitFor();
  assert.equal((await planIds()).at(-1), 'gpt-6-luna', 'a saved disabled model moves after enabled models immediately');
  // Force a Host status refresh while disabled, so Status.models still claims `enabled: false`.
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__lastStatus.models.find(model => model.id === 'gpt-6-luna').enabled), false);
  await planGroup.getByRole('button', { name: '显示全部 13 个模型', exact: true }).click();
  // The catalog's maximum output is not the adapter's smaller automatic reserve.
  const kimi = planGroup.locator('.odc-model-item').filter({ hasText: 'kimi-k2.7-code' });
  await kimi.locator('summary').click();
  const kimiTemperature = kimi.getByLabel('温度', { exact: true });
  await kimiTemperature.fill('0.3');
  await kimiTemperature.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['kimi-k2.7-code']?.temperature === 0.3);
  // A model whose reference is below a tier cannot select that tier; the default is clamped.
  const kimiTiers = kimi.locator('.odc-context');
  const kimiDefault = kimiTiers.getByRole('radio', { name: '默认' });
  assert.equal(await kimiDefault.isEnabled(), true, 'the default tier stays selectable for a small reference');
  assert.equal(await kimiDefault.isChecked(), true);
  assert.equal(await kimiTiers.getByRole('radio', { name: '扩展' }).isDisabled(), true, 'a tier above the reference is not selectable');
  assert.equal(await kimiTiers.getByRole('radio', { name: '最大' }).isDisabled(), true);
  await kimi.locator('.odc-context-option[data-preset=extended]').getByText('超过参考容量 262,144', { exact: false }).waitFor();
  await kimi.getByText('当前总窗口 262,144 tokens（含输出预留）', { exact: false }).waitFor();
  await kimi.getByRole('button', { name: '重置', exact: true }).click();
  await page.waitForFunction(() => !('kimi-k2.7-code' in (window.__config.modelSettings ?? {})));
  // Reset deletes the whole map entry; the ready form must win over the now-stale catalog flag.
  await luna.getByRole('button', { name: '重置', exact: true }).click();
  await page.waitForFunction(() => !('gpt-6-luna' in (window.__config.modelSettings ?? {})));
  assert.equal(await lunaSwitch.isChecked(), true);
  assert.equal(await luna.getByText('已禁用', { exact: true }).count(), 0);
  assert.equal((await planIds())[0], 'gpt-6-luna', 'reset restores the model to its original enabled position');
  // Image input stays outside the collapsed parameter editor and saves as a whole-map override.
  const imageInput = luna.getByRole('checkbox', { name: 'GPT-6 Luna 图片输入', exact: true });
  const restoreImage = luna.getByRole('button', { name: 'GPT-6 Luna 恢复图片输入自动', exact: true });
  assert.equal(await imageInput.isChecked(), true, 'catalog text+image defaults to automatic image delivery');
  assert.equal(await restoreImage.count(), 0, 'automatic mode has no redundant restore action');
  assert.equal(await luna.locator('details').evaluate(element => element.open), false, 'advanced model parameters start collapsed');
  assert.equal(await luna.getByText('自动 · 支持图片', { exact: true }).isVisible(), true, 'the source remains visible without expanding parameters');
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await imageInput.focus();
  await imageInput.press('Space');
  assert.equal(await imageInput.isChecked(), false, 'a pending image override is visible immediately');
  assert.equal(await imageInput.isDisabled(), true, 'the image switch locks while its map save is pending');
  assert.equal(await restoreImage.isDisabled(), true, 'restore-auto also locks during the same save');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  assert.equal(await imageInput.isChecked(), true, 'a rejected image save restores the accepted automatic value');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.imageInput), undefined);
  await page.evaluate(() => { window.__holdSaves = true; });
  await imageInput.uncheck();
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.imageInput === false);
  await luna.getByText('手动 · 关闭', { exact: true }).waitFor();
  await imageInput.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.imageInput === true);
  await luna.getByText('手动 · 开启', { exact: true }).waitFor();
  // Expand and edit every parameter; blanks inherit, invalid input never persists.
  await luna.locator('summary').click();
  assert.equal(await luna.locator('details').evaluate(element => element.open), true);
  const temperature = luna.getByLabel('温度', { exact: true });
  const topP = luna.getByLabel('Top P', { exact: true });
  const maxTokens = luna.getByLabel('最大输出（tokens）', { exact: true });
  const effortEditor = luna.locator('.odc-effort');
  const editEffort = luna.getByRole('button', { name: '编辑默认思考深度', exact: true });
  await temperature.fill('0.7');
  await temperature.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.temperature === 0.7);
  await topP.fill('0.9');
  await topP.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.topP === 0.9);
  await maxTokens.fill('4096');
  await maxTokens.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.maxTokens === 4096);
  // The context window is one of three mutually exclusive tiers; the default stores nothing.
  const lunaTiers = luna.locator('.odc-context');
  const lunaDefault = lunaTiers.getByRole('radio', { name: '默认' });
  const lunaExtended = lunaTiers.getByRole('radio', { name: '扩展' });
  const lunaMaximum = lunaTiers.getByRole('radio', { name: '最大' });
  assert.equal(await lunaDefault.isChecked(), true, 'an absent override is the default tier');
  await lunaExtended.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'extended');
  await lunaMaximum.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'maximum');
  await lunaDefault.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === undefined);
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.contextWindow), undefined, 'the default tier stores no numeric override');
  // A pending tier is visible immediately and locks the control until the Host answers.
  await page.evaluate(() => { window.__holdSaves = true; });
  await lunaExtended.check();
  assert.equal(await lunaExtended.isChecked(), true, 'the pending tier is visible immediately');
  assert.equal(await lunaExtended.isDisabled(), true, 'the tier control locks while its map save is pending');
  await luna.getByText('正在保存模型设置，完成后可继续选择档位。', { exact: true }).waitFor();
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'extended');
  // A rejected tier save restores the accepted tier.
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await lunaMaximum.check();
  assert.equal(await lunaMaximum.isChecked(), true, 'the requested tier shows before the Host answers');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  assert.equal(await lunaExtended.isChecked(), true, 'a rejected tier save restores the accepted tier');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier), 'extended');
  // A read-only configuration explains why the tier control is unavailable.
  await page.evaluate(() => window.__setFormState('ready', false));
  await luna.getByText('当前设置为只读', { exact: true }).waitFor();
  assert.equal(await lunaExtended.isDisabled(), true, 'a read-only form cannot change the tier');
  await page.evaluate(() => window.__setFormState('ready', true));
  await page.waitForFunction(() => !document.querySelector('.odc-context input[value=default]')?.disabled);
  // A legacy numeric window stays a custom state; choosing a tier replaces it in one write.
  await page.evaluate(() => window.__setModelSettings('gpt-6-luna', { contextWindow: 200000 }));
  await luna.getByText('旧自定义 200,000，选择档位替换', { exact: true }).waitFor();
  assert.equal(await lunaDefault.isChecked(), false, 'a custom window selects no tier');
  await lunaExtended.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'extended'
    && window.__config.modelSettings?.['gpt-6-luna']?.contextWindow === undefined);
  // A legacy number that equals a tier's token count is still a custom window.
  await page.evaluate(() => window.__setModelSettings('gpt-6-luna', { contextWindow: 500000 }));
  await luna.getByText('旧自定义 500,000，选择档位替换', { exact: true }).waitFor();
  assert.equal(await lunaExtended.isChecked(), false, 'a legacy 500,000 never selects the extended tier');
  assert.equal(await luna.getByText('当前总窗口 500,000 tokens（含输出预留）', { exact: false }).count(), 1);
  await lunaExtended.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'extended'
    && window.__config.modelSettings?.['gpt-6-luna']?.contextWindow === undefined);
  // An explicit output limit that no longer fits the window is reported before any save.
  await lunaDefault.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === undefined);
  await page.evaluate(() => window.__setModelSettings('gpt-6-luna', { maxTokens: 384000 }));
  await luna.getByText('最大输出 384,000 不小于当前总窗口 272,000（含输出预留）；可清空或减小最大输出，或改选更大的上下文档位。', { exact: true }).waitFor();
  assert.equal(await maxTokens.getAttribute('aria-invalid'), 'true');
  assert.equal(await maxTokens.isEnabled(), true, 'the invalid output limit stays clearable');
  await maxTokens.fill('');
  await maxTokens.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.maxTokens === undefined);
  // Switching to a smaller tier is rejected while an explicit output conflicts.
  await lunaMaximum.check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'maximum');
  await maxTokens.fill('400000');
  await maxTokens.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.maxTokens === 400000);
  await lunaDefault.click();
  await luna.getByText('无法切换到「默认」档：最大输出 400,000 不小于该档位的总窗口 272,000（含输出预留）；请先清空或减小最大输出，当前档位保持不变。', { exact: true }).waitFor();
  assert.equal(await lunaMaximum.isChecked(), true, 'a rejected tier change keeps the saved tier');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier), 'maximum');
  // Clearing the output frees the smaller tier again; the limit is never rewritten silently.
  await maxTokens.fill('');
  await maxTokens.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.maxTokens === undefined);
  await lunaDefault.click();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === undefined);
  await maxTokens.fill('4096');
  await maxTokens.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.maxTokens === 4096);
  // The tier group is a native radio group: arrow keys move the selection.
  await page.waitForFunction(() => {
    const input = document.querySelector('.odc-context input[value=default]');
    return Boolean(input) && !input.disabled;
  });
  await lunaDefault.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'extended');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === undefined);
  // The tier control stays readable inside a narrow settings pane.
  await page.locator('#root').evaluate(root => { root.style.width = '320px'; });
  assert.equal(await lunaTiers.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the tier control fits a narrow settings pane');
  assert.equal(await lunaTiers.locator('.odc-context-option').evaluateAll(options => options.every(option => option.getBoundingClientRect().height >= 32)), true, 'each tier keeps a usable target size');
  await page.locator('#root').evaluate(root => { root.style.width = ''; });
  assert.equal(await effortEditor.getAttribute('data-mode'), 'summary');
  assert.equal(await effortEditor.locator('.odc-effort-value').innerText(), '继承默认');
  const savesBeforeEffort = await page.evaluate(() => window.__saveCalls.length);
  await editEffort.click();
  let effort = luna.getByLabel('默认思考深度', { exact: true });
  await page.locator('#root').evaluate(root => { root.style.width = '320px'; });
  assert.equal(await effortEditor.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the effort editor fits a narrow settings pane');
  assert.equal(await effortEditor.locator('.odc-effort-actions').evaluate(element => [...element.children].every(button => button.getBoundingClientRect().height >= 32)), true);
  await page.locator('#root').evaluate(root => { root.style.width = ''; });
  await effort.selectOption('high');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.reasoningEffort), undefined, 'draft selection never writes configuration');
  await effort.press('Escape');
  assert.equal(await effortEditor.getAttribute('data-mode'), 'summary');
  assert.equal(await page.evaluate(() => window.__saveCalls.length), savesBeforeEffort, 'Escape cancels without a Host write');

  await editEffort.click();
  await effort.selectOption('high');
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await luna.getByRole('button', { name: '保存默认思考深度', exact: true }).click();
  assert.equal(await effort.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.reasoningEffort), undefined, 'a held save has not changed accepted configuration');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await effortEditor.getByText('设置未保存，已保留当前草稿，请重试。', { exact: true }).waitFor();
  assert.equal(await effort.inputValue(), 'high', 'rejection preserves the local draft');
  assert.equal(await effortEditor.getAttribute('data-mode'), 'editing');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.reasoningEffort), undefined, 'rejection rolls back accepted configuration');

  await page.evaluate(() => window.__setModelEffort('gpt-6-luna', 'low'));
  await effortEditor.getByText('设置未保存，已保留当前草稿，请重试。', { exact: true }).waitFor();
  await effortEditor.getByText('配置已从其他位置更新；取消可查看最新值，保存将使用当前草稿。', { exact: true }).waitFor();
  assert.equal(await effort.getAttribute('aria-describedby').then(ids => ids.split(/\s+/u).length), 2, 'the select is associated with both the conflict hint and save error');
  assert.equal(await effort.inputValue(), 'high', 'an external update does not overwrite the draft');
  await luna.getByRole('button', { name: '取消编辑默认思考深度', exact: true }).click();
  assert.equal(await effortEditor.locator('.odc-effort-value').innerText(), 'low', 'cancel reveals the latest accepted value');

  await editEffort.click();
  await effort.selectOption('high');
  await luna.getByRole('button', { name: '保存默认思考深度', exact: true }).click();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.reasoningEffort === 'high');
  assert.equal(await effortEditor.getAttribute('data-mode'), 'summary', 'only a successful Host save exits edit mode');
  await editEffort.click();
  await effort.selectOption('');
  await luna.getByRole('button', { name: '保存默认思考深度', exact: true }).click();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.reasoningEffort === undefined);
  assert.equal(await effortEditor.locator('.odc-effort-value').innerText(), '继承默认', 'inherit deletes the saved default');
  await editEffort.click();
  await effort.selectOption('high');
  await luna.getByRole('button', { name: '保存默认思考深度', exact: true }).click();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.reasoningEffort === 'high');
  await restoreImage.click();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.imageInput === undefined);
  assert.equal(await imageInput.isChecked(), true, 'restoring automatic returns to the catalog default');
  await luna.getByText('自动 · 支持图片', { exact: true }).waitFor();
  assert.equal(await restoreImage.count(), 0);
  assert.deepEqual(await modelSettings(), {
    'gpt-6-luna': { temperature: 0.7, topP: 0.9, maxTokens: 4096, reasoningEffort: 'high' },
  }, 'restore-auto removes only imageInput and preserves every other setting');
  await temperature.fill('3');
  await temperature.blur();
  await luna.locator('.odc-field-error').first().waitFor();
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.temperature), 0.7);
  await temperature.fill('0.7');
  await temperature.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.temperature === 0.7);
  await page.screenshot({ path: join(previewDir, 'models.png'), fullPage: true });
  for (const group of await page.locator('.odc-model-groups > section').all()) {
    const expand = group.getByRole('button', { name: /^显示全部/u });
    if (await expand.count()) await expand.click();
  }
  // A legacy default on an unknown model can be cleared without inventing support.
  await page.evaluate(() => window.__setModelEffort('muse-wonder', 'high'));
  const unknownModel = page.locator('.odc-model-item', { hasText: 'muse-wonder' });
  await unknownModel.locator('summary').click();
  const unknownEffortEditor = unknownModel.locator('.odc-effort');
  assert.equal(await unknownEffortEditor.locator('.odc-effort-value').innerText(), 'high（当前不可用）');
  const unknownEdit = unknownModel.getByRole('button', { name: '编辑默认思考深度', exact: true });
  assert.equal(await unknownEdit.isEnabled(), true);
  await unknownEdit.click();
  const unknownEffort = unknownModel.getByLabel('默认思考深度', { exact: true });
  assert.equal(await unknownEffort.isEnabled(), true);
  await unknownModel.getByText('当前草稿不适用于此模型或协议，请选择其他档位或继承默认。', { exact: true }).waitFor();
  assert.equal(await unknownEffort.getAttribute('aria-invalid'), 'true');
  assert.equal(await unknownEffort.locator('option[value=high]').isDisabled(), true);
  await unknownEffort.selectOption('');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['muse-wonder']?.reasoningEffort), 'high', 'clearing a stale draft still requires an explicit save');
  await unknownModel.getByRole('button', { name: '保存默认思考深度', exact: true }).click();
  await page.waitForFunction(() => window.__config.modelSettings?.['muse-wonder'] === undefined);
  assert.equal(await unknownEffortEditor.locator('.odc-effort-value').innerText(), '继承默认');
  assert.equal(await unknownEdit.isDisabled(), true);
  // Discovery success: source, timestamp and the new row become visible.
  await page.getByRole('button', { name: '刷新模型目录', exact: true }).click();
  await page.waitForFunction(() => window.__refreshModelsCalls === 1);
  await page.getByText(/来源：当前网关 · 更新于/u).waitFor();
  await page.getByText('已从当前网关刷新模型目录', { exact: false }).waitFor();
  assert.equal(await page.locator('.odc-model-item').count(), fixtureModels.length + 1);
  await page.locator('.odc-model-item', { hasText: 'gpt-6.1-sol-remote' }).waitFor();
  // Discovery failure keeps the previous catalog and must not claim success.
  await page.evaluate(() => window.__setModelsFail(true));
  await page.getByRole('button', { name: '刷新模型目录', exact: true }).click();
  await page.waitForFunction(() => window.__refreshModelsCalls === 2);
  await page.getByText('模型发现请求超过 20 秒时限', { exact: true }).waitFor();
  assert.equal(await page.getByText(/已从当前网关刷新模型目录/u).count(), 0);
  await page.evaluate(() => window.__setModelsFail(false));
  await page.getByRole('button', { name: '刷新模型目录', exact: true }).click();
  await page.waitForFunction(() => window.__refreshModelsCalls === 3);
  await page.getByText('模型发现请求超过 20 秒时限', { exact: true }).waitFor({ state: 'detached' });
  await page.getByText('已从当前网关刷新模型目录', { exact: false }).waitFor();

  // ── Conversation input quick switch ────────────────────────────────────────
  // The quick switch follows the session's own model directory, never a global model.
  const waitQuickReady = async () => {
    await page.waitForFunction(() => {
      const radio = document.querySelector('#conversation-input .odc-quick-panel input[type=radio]');
      return Boolean(radio) && !radio.disabled;
    }, null, { timeout: 5000 });
  };
  await page.evaluate(() => { window.__setQuotaRefresh(3600); });
  const quotaBefore = await page.evaluate(() => window.__refreshQuotaCalls);
  const statusBefore = await page.evaluate(() => window.__statusCalls);
  await page.evaluate(() => {
    window.__setDirectory('session-a', {
      current: { provider: 'opendesign-corouter-plan', model: 'gpt-6-luna' },
      pending: null, status: 'ready', groups: [{ id: 'co', models: [] }], routable: true,
    });
    const second = document.createElement('div');
    second.id = 'conversation-input-b';
    document.body.appendChild(second);
  });
  await page.evaluate(() => window.__mountQuick('session-a'));
  await page.waitForFunction(before => window.__statusCalls > before, statusBefore);
  assert.equal(await page.evaluate(() => window.__refreshQuotaCalls), quotaBefore, 'the quick switch reads the cached status and never refreshes the quota');
  await page.evaluate(() => window.__setQuotaRefresh(60));
  const quickA = page.locator('#conversation-input .odc-quick');
  const quickButton = quickA.getByRole('button', { name: /^CoRouter 上下文/u });
  const quickPanel = quickA.locator('.odc-quick-panel');
  await quickButton.waitFor();
  await waitQuickReady();
  assert.match(await quickButton.innerText(), /272K/u, 'the default tier is the current window');
  // A third-party model has no CoRouter window to change.
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'openai', model: 'gpt-4o' } }));
  await page.waitForFunction(() => !document.querySelector('#conversation-input .odc-quick'));
  assert.equal(await quickA.count(), 0, 'a foreign provider renders no CoRouter quick switch');
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'opendesign-corouter-plan', model: 'gpt-6-luna' } }));
  await quickButton.waitFor();
  // The popover is a dialog with the three tiers and states that the change is global.
  await quickButton.click();
  await page.getByRole('dialog', { name: '上下文窗口' }).waitFor();
  await quickPanel.waitFor();
  await waitQuickReady();
  assert.match(await quickPanel.innerText(), /修改此模型的默认值，其他会话同步。/u);
  await quickButton.click();
  await quickPanel.waitFor({ state: 'hidden' });
  await quickButton.click();
  await quickPanel.waitFor();
  await waitQuickReady();
  assert.match(await quickPanel.innerText(), /上下文档位/u);
  assert.equal(await quickPanel.getByRole('radio').count(), 3, 'the quick switch offers the three tiers');
  assert.match(await quickPanel.innerText(), /当前总窗口 272,000 tokens（含输出预留）。/u);
  // A tier choice is written as the global model default and shows up in the settings page.
  await quickPanel.getByRole('radio', { name: '扩展' }).check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'extended');
  await quickPanel.getByText('上下文档位已保存。', { exact: true }).waitFor();
  assert.match(await quickButton.innerText(), /500K/u, 'the button shows the selected tier');
  const lunaRow = page.locator('.odc-model-item').filter({ hasText: 'gpt-6-luna' });
  if (await lunaRow.locator('details').evaluate(element => !element.open)) await lunaRow.locator('summary').click();
  assert.equal(await lunaRow.locator('.odc-context-option[data-preset=extended] input').isChecked(), true, 'the settings page shows the same tier');
  // A pending tier is visible immediately and locks the quick switch until the Host answers.
  await page.evaluate(() => { window.__holdSaves = true; });
  await quickPanel.getByRole('radio', { name: '最大' }).check();
  assert.equal(await quickPanel.getByRole('radio', { name: '最大' }).isChecked(), true, 'the pending tier is visible immediately');
  assert.equal(await quickPanel.getByRole('radio', { name: '最大' }).isDisabled(), true, 'the quick switch locks while its write is pending');
  await quickPanel.getByText('正在保存模型设置…', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__heldSaves > 0);
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseHeldSave(); });
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'maximum');
  // A rejected write restores the accepted tier.
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await quickPanel.getByRole('radio', { name: '扩展' }).check();
  await page.waitForFunction(() => window.__heldSaves > 0);
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseHeldSave(); });
  await quickPanel.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier), 'maximum');
  assert.equal(await quickPanel.getByRole('radio', { name: '最大' }).isChecked(), true, 'a rejected quick save restores the accepted tier');
  // A model with a smaller reference cannot take a tier above it.
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'opendesign-corouter-plan', model: 'kimi-k2.7-code' } }));
  await page.waitForFunction(() => document.querySelector('#conversation-input .odc-quick button')?.textContent?.includes('262,144'));
  await quickButton.click();
  await quickPanel.waitFor();
  await waitQuickReady();
  assert.equal(await quickPanel.getByRole('radio', { name: '扩展' }).isDisabled(), true, 'a tier above the reference is not selectable');
  assert.equal(await quickPanel.getByRole('radio', { name: '默认' }).isEnabled(), true, 'the default tier stays selectable');
  // An explicit output that does not fit keeps the saved tier and asks for the settings page.
  await page.evaluate(() => window.__setModelSettings('gpt-6-luna', { maxTokens: 384000 }));
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'opendesign-corouter-plan', model: 'gpt-6-luna' } }));
  await quickButton.click();
  await quickPanel.waitFor();
  await waitQuickReady();
  await quickPanel.getByRole('radio', { name: '默认' }).click();
  await quickPanel.getByText('最大输出 384,000 不小于所选总窗口 272,000；请先在设置页清空或减小最大输出。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier), 'maximum', 'a conflicting tier keeps the saved value');
  // A read-only or loading configuration never writes.
  await page.evaluate(() => window.__setFormState('ready', false));
  await quickPanel.getByText('当前设置为只读。', { exact: true }).waitFor();
  assert.equal(await quickPanel.getByRole('radio', { name: '扩展' }).isDisabled(), true, 'a read-only configuration cannot change the tier');
  await page.evaluate(() => window.__setFormState('loading', false));
  await quickPanel.getByText('正在载入模型设置。', { exact: true }).waitFor();
  await page.evaluate(() => window.__setFormState('ready', true));
  await waitQuickReady();
  // An external update to another model survives the quick write.
  await page.evaluate(() => window.__setModelSettings('claude-haiku-5.5', { temperature: 0.4 }));
  await page.evaluate(() => window.__setModelSettings('gpt-6-luna', { maxTokens: 4096 }));
  await quickPanel.getByRole('radio', { name: '扩展' }).check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'extended');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['claude-haiku-5.5']?.temperature), 0.4, 'an external update to another model survives the quick write');
  // A second session keeps its own model and its own window.
  await page.evaluate(() => {
    window.__setModelSettings('claude-opus-5.5', { contextTier: 'maximum' });
    window.__setDirectory('session-b', {
      current: { provider: 'opendesign-corouter-paid', model: 'claude-opus-5.5' },
      pending: null, status: 'ready', groups: [], routable: true,
    });
    return window.__mountQuick('session-b', 'conversation-input-b');
  });
  const quickB = page.locator('#conversation-input-b .odc-quick');
  const quickButtonB = quickB.getByRole('button', { name: /^CoRouter 上下文/u });
  await quickButtonB.waitFor();
  await page.waitForFunction(() => document.querySelector('#conversation-input-b .odc-quick button')?.textContent?.includes('872K'));
  assert.match(await quickButtonB.innerText(), /872K/u, 'the second session shows its own window');
  const labelB = await quickButtonB.innerText();
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'opendesign-corouter-plan', model: 'claude-haiku-5.5' } }));
  await page.waitForFunction(() => document.querySelector('#conversation-input .odc-quick button')?.textContent?.includes('272K'));
  assert.equal(await quickButtonB.innerText(), labelB, 'the other session is unaffected by the first one');
  // Switching the model closes the popover and never writes a late result to the new model.
  await quickButton.click();
  await quickPanel.waitFor();
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'opendesign-corouter-plan', model: 'gpt-6-luna' } }));
  await quickPanel.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['claude-haiku-5.5']?.contextTier), undefined, 'a late result never reaches the new model');
  // A write that is in flight when the model changes lands on the model it started for.
  await quickButton.click();
  await quickPanel.waitFor();
  await waitQuickReady();
  await page.evaluate(() => { window.__holdSaves = true; });
  await quickPanel.getByRole('radio', { name: '最大' }).check();
  await page.waitForFunction(() => window.__heldSaves > 0);
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'opendesign-corouter-plan', model: 'claude-haiku-5.5' } }));
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseHeldSave(); });
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === 'maximum');
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['claude-haiku-5.5']?.contextTier), undefined, 'the in-flight write stays with the model it started for');
  assert.equal(await page.locator('#conversation-input .odc-quick-error').count(), 0, 'the new model shows no stale error');
  assert.equal(await page.locator('#conversation-input .odc-quick-panel').getByText('上下文档位已保存。', { exact: true }).count(), 0, 'the new model shows no stale success notice');
  // Escape and an outside click close the popover; the focus returns to the button.
  await quickButton.click();
  await quickPanel.waitFor();
  await page.keyboard.press('Escape');
  await quickPanel.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('CoRouter 上下文') ?? false), true, 'Escape returns the focus to the button');
  await quickButton.click();
  await quickPanel.waitFor();
  await page.mouse.click(8, 8);
  await quickPanel.waitFor({ state: 'hidden' });
  // The quick switch stays usable in a narrow chat pane.
  await page.locator('#conversation-input').evaluate(element => { element.style.width = '320px'; element.style.maxWidth = '320px'; });
  assert.equal(await page.locator('#conversation-input').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the quick switch fits a narrow chat pane');
  await quickButton.click();
  await quickPanel.waitFor();
  assert.equal(await quickPanel.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
  }), true, 'the popover keeps its left and right bounds in a narrow chat pane');
  await page.keyboard.press('Escape');
  await quickPanel.waitFor({ state: 'hidden' });
  await page.locator('#conversation-input').evaluate(element => { element.style.width = ''; element.style.maxWidth = ''; });
  // A 320 pixel viewport keeps the popover inside the screen.
  await page.setViewportSize({ width: 320, height: 900 });
  await quickButton.click();
  await quickPanel.waitFor();
  const quickBox = await quickPanel.boundingBox();
  assert.ok(quickBox !== null && quickBox.x >= 0 && quickBox.x + quickBox.width <= 320, 'the popover keeps its left and right bounds in a 320 pixel viewport');
  await page.keyboard.press('Escape');
  await quickPanel.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1040, height: 1000 });
  // Restore the shared model defaults the settings page expects.
  await page.evaluate(() => window.__clearModelSettings('claude-haiku-5.5'));
  await page.evaluate(() => window.__clearModelSettings('claude-opus-5.5'));
  await page.evaluate(() => window.__setModelSettings('gpt-6-luna', { maxTokens: 4096 }));
  await page.evaluate(() => window.__setDirectory('session-a', { current: { provider: 'opendesign-corouter-plan', model: 'gpt-6-luna' } }));
  await quickButton.click();
  await quickPanel.waitFor();
  await waitQuickReady();
  await quickPanel.getByRole('radio', { name: '默认' }).check();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextTier === undefined);
  await page.screenshot({ path: join(previewDir, 'context-quick.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '连接与登录', exact: true }).click();
  const startDevice = page.getByRole('button', { name: '开始设备授权', exact: true });
  // Action responses remain usable even while a separate status read is unavailable.
  await page.evaluate(() => { window.__failStatusReads = true; });
  await startDevice.click();
  const approvalLink = page.getByRole('link', { name: '官方授权页', exact: true });
  await approvalLink.waitFor();
  assert.equal(await approvalLink.getAttribute('href'), 'https://open-design.ai/cloud/cli/activate?deviceId=fixture-device&userCode=AB12-CD34');
  assert.equal(await approvalLink.getAttribute('target'), '_blank');
  assert.match(await approvalLink.getAttribute('rel'), /noopener/u);
  assert.equal(await page.getByLabel('设备授权码', { exact: true }).innerText(), 'AB12-CD34');
  assert.equal(await startDevice.isDisabled(), true);
  const copyActivation = page.getByRole('button', { name: '复制授权链接', exact: true });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedActivation = value; } } }));
  await copyActivation.click();
  await page.getByText('链接已复制，可在常用浏览器中粘贴打开。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__copiedActivation), await approvalLink.getAttribute('href'));
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('clipboard-unavailable'); } } }));
  await copyActivation.click();
  const manualCopy = page.getByLabel('请选择并复制授权链接', { exact: true });
  await manualCopy.waitFor();
  assert.equal(await manualCopy.inputValue(), await approvalLink.getAttribute('href'));
  await manualCopy.focus();
  assert.equal(await manualCopy.evaluate(input => input.selectionStart === 0 && input.selectionEnd === input.value.length), true);
  // The Host launches the temporary window; the panel reports what actually happened.
  const openWindow = page.getByRole('button', { name: '在新窗口打开授权页', exact: true });
  // Starting login must open once after the authorization code arrives, without a second click.
  await page.waitForFunction(() => window.__openActivationCalls === 1);
  await page.getByText('已在新窗口打开官方授权页；请在该窗口确认设备码。', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('.odc-settings').innerText(), /deviceSecret|controlKey|runtimeKey/);
  // Capture the working state before exercising the failure path.
  await page.screenshot({ path: join(previewDir, 'connection.png'), fullPage: true });
  // A Host that cannot offer the window says so instead of claiming success.
  await page.evaluate(() => window.__setActivationCode('unavailable'));
  await openWindow.click();
  await page.waitForFunction(() => window.__openActivationCalls === 2);
  await page.getByText('无法启动临时浏览器，请确认已安装 Chrome；也可复制链接手动打开。', { exact: true }).waitFor();
  assert.equal(await approvalLink.isVisible(), true, 'the manual link survives every failure');
  await page.evaluate(() => window.__setActivationCode('opened'));

  // Regression: the open button owns its own busy state. A cancel racing it must not
  // strand the button in "正在打开…" for the rest of the session.
  await page.evaluate(() => { window.__holdActivation = true; });
  await openWindow.click();
  await page.getByRole('button', { name: '正在打开…', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await approvalLink.waitFor({ state: 'detached' });
  await page.evaluate(() => { window.__holdActivation = false; window.__releaseActivation?.(); });
  // The stale attempt settles without leaving the button disabled when the next job arrives.
  await startDevice.click();
  await approvalLink.waitFor();
  assert.equal(await page.getByRole('button', { name: '在新窗口打开授权页', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await approvalLink.waitFor({ state: 'detached' });
  assert.equal(await startDevice.isEnabled(), true);
  await startDevice.click();
  await approvalLink.waitFor();
  await page.evaluate(() => window.__finishLogin('error'));
  await page.getByText('设备授权已过期，请重新开始', { exact: true }).waitFor();
  await approvalLink.waitFor({ state: 'detached' });
  await startDevice.click();
  await approvalLink.waitFor();
  await page.evaluate(() => {
    window.__failStatusReads = false;
    window.__holdQuota = true; window.__releaseQuota = null;
    window.__setKeySource('reference');
    window.__finishLogin('success');
  });
  await page.getByText('设备授权已完成并保存', { exact: true }).waitFor();
  await page.getByLabel('当前生效的推理凭据来源', { exact: true }).filter({ hasText: '环境或凭据引用' }).waitFor({ timeout: 3000 });
  await page.waitForFunction(() => typeof window.__releaseQuota === 'function');
  await page.evaluate(() => { window.__holdQuota = false; window.__releaseQuota(); });
  await approvalLink.waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('设备授权码', { exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator('.odc-settings').innerText(), /deviceSecret|controlKey|runtimeKey/);
  const password = page.locator('input[type=password]');
  await page.evaluate(() => { window.__setKeySource('reference'); window.__failStatusReads = true; });
  await password.fill('fixture-api-key');
  await page.getByRole('button', { name: /保存.*Key/u }).click();
  await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '');
  await page.getByText('API Key 已保存；当前仍优先使用环境或凭据引用 COROUTER_API_KEY。', { exact: true }).waitFor();
  await page.getByLabel('当前生效的推理凭据来源', { exact: true }).filter({ hasText: '环境或凭据引用' }).waitFor();
  await page.evaluate(() => { window.__failStatusReads = false; });

  // Advanced: protocol select, read-only gateway, credential reference and real timeouts.
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  const guard = page.getByRole('checkbox', { name: /启用异常结束监控/u });
  assert.equal(await guard.isChecked(), true);
  await page.getByText('已累计 2 次空响应或残留拦截。', { exact: false }).waitFor();
  // The monitor card reports each labelled recovery layer with its own counter; the protocol
  // row reads `guardedTurns` (2) and is deliberately distinct from continuations (5).
  const monitor = page.getByLabel('异常结束监控', { exact: true });
  await monitor.getByText('已续办 · 尚有待执行事项', { exact: true }).waitFor();
  assert.equal(await monitor.locator('.odc-turn-monitor-row .odc-metric-value').first().innerText(), '2');
  assert.deepEqual(await monitor.locator('.odc-turn-monitor-row .odc-metric-value').allTextContents(), ['2', '1', '4', '5'], 'protocol intercepts stay separate from the new monitor counters');
  assert.match(await monitor.locator('time').getAttribute('title'), /最近决定时间：\d{4}\//u);
  await page.evaluate(() => window.__setTurnMonitor({ available: false, checks: 0, continuations: 1, requestRetries: 0 }));
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  await monitor.getByText('仅协议保护可用；收尾核验未启用。', { exact: true }).waitFor();
  // Legacy status without the optional block keeps only the known protocol counter.
  await page.evaluate(() => window.__setTurnMonitor(undefined));
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  await monitor.getByText('仅协议拦截计数可用', { exact: true }).waitFor();
  assert.deepEqual(await monitor.locator('.odc-metric-value').allTextContents(), ['2', '—', '—', '—'], 'legacy status shows the protocol counter only, never invented zeros');
  assert.equal(await monitor.locator('.odc-turn-monitor-last dd').innerText(), '—', 'the absent decision stays unknown separately');
  await page.evaluate(() => window.__setTurnMonitor({ available: true, checks: 3, continuations: 1, requestRetries: 2, last: { at: new Date().toISOString(), decision: 'completed', reason: 'reported-complete' } }));
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  await monitor.getByText('已完成 · 已报告完成', { exact: true }).waitFor();
  // Both review limits persist through the real form write path, including rollback.
  const turnContinuations = page.getByLabel('收尾核验最大续办次数', { exact: true });
  const turnNoProgress = page.getByLabel('无进展停止上限', { exact: true });
  assert.equal(await turnContinuations.inputValue(), '3');
  assert.equal(await turnNoProgress.inputValue(), '2');
  // The completion handshake is opt-in and stays disabled by default.
  const reviewSwitch = page.getByRole('checkbox', { name: /启用结束回合核验/u });
  assert.equal(await reviewSwitch.isChecked(), false);
  assert.equal(await turnContinuations.isDisabled(), true, 'review limits stay disabled while the handshake is off');
  await reviewSwitch.check();
  await page.waitForFunction(() => window.__config.turnCompletionReview === true);
  assert.equal(await turnContinuations.isDisabled(), false);
  await turnContinuations.fill('5');
  await turnContinuations.blur();
  await page.waitForFunction(() => window.__config.turnReviewMaxContinuations === 5);
  await turnNoProgress.fill('4');
  await turnNoProgress.blur();
  await page.waitForFunction(() => window.__config.turnReviewNoProgressLimit === 4);
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await turnContinuations.fill('11');
  await turnContinuations.blur();
  await page.locator('.odc-field-error').first().waitFor();
  assert.equal(await page.evaluate(() => window.__config.turnReviewMaxContinuations), 5, 'an out-of-range value never persists');
  await turnContinuations.fill('6');
  await turnContinuations.blur();
  assert.equal(await turnContinuations.inputValue(), '6', 'the pending limit is visible while held');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#odc-turn-continuations')?.value === '5');
  await guard.uncheck();
  await page.waitForFunction(() => window.__config.emptyTurnGuard === false);
  await guard.check();
  await page.waitForFunction(() => window.__config.emptyTurnGuard === true);
  const protocol = page.getByLabel('API 协议', { exact: true });
  assert.equal(await protocol.inputValue(), 'chat-completions');
  assert.equal(await page.getByRole('option').count(), 3);
  assert.equal(await page.locator('input[type=url]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '保存 Base URL', exact: true }).count(), 0);
  await page.getByText('https://amr-link.open-design.ai/v1/chat/completions', { exact: true }).waitFor();
  // An old sampling override is valid in the existing gateway mode and must remain clearable after switching protocols.
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  const haiku = page.locator('.odc-model-item').filter({ hasText: 'claude-haiku-5.5' });
  await haiku.locator('summary').click();
  await haiku.getByLabel('温度', { exact: true }).fill('0.4');
  await haiku.getByLabel('温度', { exact: true }).blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['claude-haiku-5.5']?.temperature === 0.4);
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  await protocol.selectOption('responses');
  await page.waitForFunction(() => window.__config.apiProtocol === 'responses');
  await page.getByText('https://amr-link.open-design.ai/v1/responses', { exact: true }).waitFor();
  await protocol.selectOption('messages');
  await page.waitForFunction(() => window.__config.apiProtocol === 'messages');
  await page.getByText('https://amr-link.open-design.ai/v1/messages', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await haiku.locator('summary').click();
  const claudeTemperature = haiku.getByLabel('温度', { exact: true });
  assert.equal(await claudeTemperature.getAttribute('aria-invalid'), 'true');
  assert.equal(await claudeTemperature.isEnabled(), true, 'an incompatible old value can still be cleared');
  await claudeTemperature.fill('');
  await claudeTemperature.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['claude-haiku-5.5']?.temperature === undefined);
  await claudeTemperature.fill('0.4');
  await claudeTemperature.blur();
  await haiku.getByText(/仅接受默认温度 1/u).waitFor();
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['claude-haiku-5.5']?.temperature), undefined);
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  const reference = page.getByLabel('API Key 环境变量 / 凭据引用名', { exact: true });
  await reference.fill('COROUTER_FIXTURE_REF');
  await page.getByRole('button', { name: '保存引用名', exact: true }).click();
  await page.waitForFunction(() => window.__config.apiKeyEnv === 'COROUTER_FIXTURE_REF');
  const requestTimeout = page.getByLabel('请求总超时（毫秒）', { exact: true });
  const idleTimeout = page.getByLabel('流式空闲超时（毫秒）', { exact: true });
  const refreshSeconds = page.getByLabel('额度自动刷新间隔（秒）', { exact: true });
  const imageBudget = page.getByLabel('单次请求图片预算（MiB）', { exact: true });
  assert.equal(await imageBudget.inputValue(), '20');
  await imageBudget.fill('12');
  await imageBudget.blur();
  await page.waitForFunction(() => window.__config.maxRequestImageBytes === 12 * 1024 * 1024);
  await imageBudget.fill('0');
  await imageBudget.blur();
  await page.locator('.odc-field-error').first().waitFor();
  assert.equal(await page.evaluate(() => window.__config.maxRequestImageBytes), 12 * 1024 * 1024);
  await imageBudget.fill('12');
  await imageBudget.blur();
  await page.locator('.odc-field-error').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.__holdSaves = true; window.__rejectSave = true; });
  await imageBudget.fill('16');
  await imageBudget.blur();
  assert.equal(await imageBudget.inputValue(), '16', 'the pending image budget is visible');
  assert.equal(await imageBudget.isDisabled(), true, 'a pending image-budget save locks its field');
  await page.evaluate(() => { window.__holdSaves = false; window.__releaseSave(); });
  await page.getByText('设置未保存，已恢复原值，请重试。', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#odc-image-budget')?.value === '12');
  assert.equal(await page.evaluate(() => window.__config.maxRequestImageBytes), 12 * 1024 * 1024);
  // A rejected numeric edit remains visible as a failed action until a real retry succeeds.
  await imageBudget.fill('16');
  await imageBudget.blur();
  await page.waitForFunction(() => window.__config.maxRequestImageBytes === 16 * 1024 * 1024);
  await page.waitForFunction(() => !document.querySelector('#odc-image-budget-hint')?.classList.contains('odc-field-error'));
  await imageBudget.fill('12');
  await imageBudget.blur();
  await page.waitForFunction(() => window.__config.maxRequestImageBytes === 12 * 1024 * 1024);
  await requestTimeout.fill('900000');
  await requestTimeout.blur();
  await page.waitForFunction(() => window.__config.requestTimeoutMs === 900000);
  await idleTimeout.fill('120000');
  await idleTimeout.blur();
  await page.waitForFunction(() => window.__config.streamIdleTimeoutMs === 120000);
  await refreshSeconds.fill('30');
  await refreshSeconds.blur();
  await page.waitForFunction(() => window.__config.quotaRefreshSeconds === 30);
  await refreshSeconds.fill('4');
  await refreshSeconds.blur();
  await page.locator('.odc-field-error').first().waitFor();
  assert.equal(await page.evaluate(() => window.__config.quotaRefreshSeconds), 30);
  await refreshSeconds.fill('30');
  await refreshSeconds.blur();
  await page.locator('.odc-field-error').waitFor({ state: 'detached' });
  await page.screenshot({ path: join(previewDir, 'advanced.png'), fullPage: true });
  await page.getByRole('tab', { name: '高级', exact: true }).press('Home');
  assert.equal(await page.getByRole('tab', { name: '概览', exact: true }).getAttribute('aria-selected'), 'true');
  const reports = [];
  const switchTheme = async mode => {
    // Explicit host selection must win even when the OS requests the opposite scheme.
    await page.emulateMedia({ colorScheme: mode === 'dark' ? 'light' : 'dark', forcedColors: 'none' });
    await page.evaluate(mode => {
      document.body.toggleAttribute('data-ds-dark-theme', mode === 'dark');
    }, mode);
  };
  for (const [index, mode] of ['light', 'dark', 'light'].entries()) {
    await switchTheme(mode);
    for (const tab of ['概览', '模型', '连接与登录', '高级']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      reports.push(await auditTheme(page, `${index + 1}-${mode}-${tab}`));
      assert.equal(await page.locator('.odc-settings').evaluate(element => getComputedStyle(element).colorScheme), mode, `${mode}: native controls follow the host theme, not the OS`);
      if (tab === '概览') await page.screenshot({ path: join(previewDir, `overview-${mode}.png`), fullPage: true });
      if (tab === '高级' && mode === 'dark') await page.screenshot({ path: join(previewDir, 'advanced-dark.png'), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.getByRole('tab', { name: '模型', exact: true }).click();
    const modelDetails = page.locator('.odc-model-details').first();
    await modelDetails.locator('summary').click();
    await modelDetails.getByRole('button', { name: '编辑默认思考深度', exact: true }).click();
    assert.equal(await modelDetails.getByRole('combobox', { name: '默认思考深度' }).isEnabled(), true);
    reports.push(await auditTheme(page, `${index + 1}-${mode}-model-options`));
    // The quick switch lives outside the settings pane; the audit measures it where it is.
    const quickAuditButton = page.getByRole('button', { name: /^CoRouter 上下文/u }).first();
    if (await quickAuditButton.count()) {
      await quickAuditButton.click();
      const quickAuditPanel = page.getByRole('dialog', { name: '上下文窗口' });
      await quickAuditPanel.waitFor();
      reports.push(await auditTheme(page, `${index + 1}-${mode}-context-quick`));
      await page.keyboard.press('Escape');
      await quickAuditPanel.waitFor({ state: 'hidden' });
    }
    if (mode === 'dark') await page.screenshot({ path: join(previewDir, 'models-dark.png'), fullPage: true });
    await page.getByRole('tab', { name: '连接与登录', exact: true }).click();
    const primary = page.locator('.odc-button-primary');
    const foreground = await primary.evaluate(element => {
      const css = getComputedStyle(element);
      return { actual: css.color.replace(/\s+/g, ''), expected: css.getPropertyValue('--dsw-alias-label-primary').replace(/\s+/g, '') };
    });
    assert.equal(foreground.actual, foreground.expected, `${mode}: tinted primary action uses the host primary text token`);
    await primary.hover();
    reports.push(await auditTheme(page, `${index + 1}-${mode}-hover`));
    await page.locator('input[type=password]').focus();
    assert.equal(await page.locator('input[type=password]').evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid' && parseFloat(getComputedStyle(element).outlineWidth) >= 2), true);
    await page.screenshot({ path: join(previewDir, `theme-${mode}.png`), fullPage: true });
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await page.evaluate(() => window.__setQuotaState('error', '模拟额度读取失败，请稍后重试。'));
    await page.getByRole('button', { name: '刷新额度', exact: true }).click();
    await page.locator('.odc-notice[data-kind=error]').waitFor();
    reports.push(await auditTheme(page, `${index + 1}-${mode}-error`));
    await page.evaluate(() => window.__setQuotaState('ok'));
    await page.getByRole('button', { name: '刷新额度', exact: true }).click();
    await page.locator('.odc-notice[data-kind=error]').waitFor({ state: 'detached' });
  }
  await page.getByRole('tab', { name: '连接与登录', exact: true }).click();
  await page.emulateMedia({ forcedColors: 'active' });
  reports.push(await auditTheme(page, 'forced-colors-connection'));
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  reports.push(await auditTheme(page, 'forced-colors-protocol-options'));
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  reports.push(await auditTheme(page, 'forced-colors-compact-image-controls'));
  // The quick switch keeps its own contrast and focus ring in forced colors.
  const forcedQuickButton = page.getByRole('button', { name: /^CoRouter 上下文/u }).first();
  if (await forcedQuickButton.count()) {
    await forcedQuickButton.click();
    const forcedQuickPanel = page.getByRole('dialog', { name: '上下文窗口' });
    await forcedQuickPanel.waitFor();
    reports.push(await auditTheme(page, 'forced-colors-context-quick'));
    await page.keyboard.press('Escape');
    await forcedQuickPanel.waitFor({ state: 'hidden' });
    assert.equal(await forcedQuickButton.evaluate(element => element === document.activeElement && element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid' && parseFloat(getComputedStyle(element).outlineWidth) >= 2), true, 'Escape returns keyboard focus with a visible forced-color focus indicator');
  }
  const forcedImageInput = page.locator('.odc-image-toggle:visible input').first();
  await page.keyboard.press('Tab');
  await forcedImageInput.focus();
  assert.equal(await forcedImageInput.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid' && parseFloat(getComputedStyle(element).outlineWidth) >= 2), true, 'forced colors retain a visible keyboard focus indicator');
  const forcedEffortDetails = page.locator('.odc-model-details').first();
  await forcedEffortDetails.locator('summary').click();
  await forcedEffortDetails.getByRole('button', { name: '编辑默认思考深度', exact: true }).click();
  reports.push(await auditTheme(page, 'forced-colors-effort-editor'));
  await forcedEffortDetails.getByLabel('默认思考深度', { exact: true }).press('Escape');
  assert.equal(await forcedEffortDetails.locator('.odc-effort').getAttribute('data-mode'), 'summary');
  await switchTheme('dark');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addStyleTag({ content: 'body{padding:18px}' });
  assert.equal(await page.locator('.odc-window').evaluateAll(windows => windows.every(window => {
    const usage = window.querySelector('.odc-window-usage').getBoundingClientRect();
    const reset = window.querySelector('.odc-window-reset').getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(window.querySelector('.odc-window-usage')).lineHeight);
    return reset.top >= usage.bottom && usage.height <= lineHeight + 1 && window.scrollWidth <= window.clientWidth;
  })), true, 'narrow windows keep recovery on its own row without horizontal overflow');
  assert.equal(await page.locator('.odc-timing-row').evaluateAll(rows => rows.every(row => {
    const bounds = row.getBoundingClientRect();
    return [...row.children].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    });
  })), true, 'relative dates and their labels stay inside the timing panel');
  const narrowDetails = page.locator('.odc-window-details').first();
  await narrowDetails.locator('summary').click();
  assert.equal(await narrowDetails.getByText('窗口开始', { exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#root').evaluate(root => { root.style.width = '320px'; });
  assert.equal(await page.locator('.odc-settings').evaluate(element => element.scrollWidth <= element.clientWidth), true, '320px pane keeps the expanded window inside');
  assert.equal(await narrowDetails.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'expanded window details remain readable');
  await page.locator('#root').evaluate(root => { root.style.width = ''; });
  await narrowDetails.locator('summary').click();
  reports.push(await auditTheme(page, 'dark-mobile-overview'));
  await writeFile(join(previewDir, 'theme-contrast.json'), JSON.stringify({ scope: 'Enabled visible text and placeholders, native option colors and input/secondary-button boundaries; WCAG sRGB contrast calculation; offline official palette fixture, not a full accessibility certification.', checks: reports }, null, 2) + '\n');
  await page.screenshot({ path: join(previewDir, 'mobile-dark.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => window.__cleanup());
  assert.equal(await page.locator('style[data-opendesign-corouter]').count(), 0);
  assert.equal(await page.locator('.odc-quick').count(), 0, 'slot teardown unmounts every session quick control');
  assert.deepEqual(await page.evaluate(() => window.__activeSubscriptions()), { form: 0, directories: 0 }, 'teardown releases both form and per-session directory subscriptions');
  assert.equal(await page.evaluate(() => window.__remoteDisposed), true);
  assert.deepEqual(errors, []);
  console.log(`Offline UI smoke passed: 4 tabs, ${fixtureModels.length} models, price tiers and stale fallback, stable enablement ordering, compact keyboard-accessible image controls, model enable/edit/reset persistence, protocol selection, quota timing and auto-refresh scheduling, 10 RPCs, credential input, guard switch, keyboard navigation, disposal; ${reports.length} official light/dark/forced-color audits, minimum measured text contrast ${Math.min(...reports.map(report => report.minimum))}:1.`);
} finally { await browser.close(); }
