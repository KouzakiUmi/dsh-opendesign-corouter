// Entirely offline browser fixture: never opens the DSH GUI, account pages or real login.
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { auditTheme } from './theme-audit.mjs';
import assert from 'node:assert/strict';
import { MODELS, Config } from '../lib/index.js';
const react = await build({ stdin: { contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client'; import Schema from '@deepseek-ai/schemastery'; window.__Schema=Schema; window.__React=React; window.__mount=(component,props)=>{window.__root=createRoot(document.getElementById('root'));window.__root.render(React.createElement(component,props));};`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } });
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
  body{margin:0;background:var(--dsw-alias-bg-base);font-family:system-ui,'Microsoft YaHei',sans-serif;padding:38px;color:var(--dsw-alias-label-primary)} #root{max-width:900px;margin:auto} .fixture-note{max-width:900px;margin:0 auto 20px;color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.03em}
  </style></head><body><div class="fixture-note">离线界面预览 · 模拟数据，非真实账号</div><main id="root"></main></body></html>`);
  await page.addStyleTag({ content: theme });
  await page.addScriptTag({ content: react.outputFiles[0].text });
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(bundle) { window.__plugin = bundle.factory(name => { if (name === 'react') return window.__React; throw new Error('Unexpected external: ' + name); }); } };
  });
  await page.addScriptTag({ content: client });
const fixtureModels = MODELS.map(({ id, name, group, contextWindow, maxOutputTokens, reasoningEfforts }) => ({
  id, name, group,
  ...(contextWindow === undefined ? {} : { contextWindow }),
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
}));
  await page.evaluate(({ rawModels, wireSchema }) => {
    // Rehydrate the shipped schema in the browser, without the Host module's closures.
    for (const node of Object.values(wireSchema.refs)) {
      if (node.meta) delete node.meta.volatile;
    }
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
    let config = {
      emptyTurnGuard: true, useDesktopCredential: true, baseURL: 'https://amr-link.open-design.ai/v1', apiKeyEnv: 'COROUTER_API_KEY',
      apiProtocol: 'chat-completions', modelSettings: {}, quotaRefreshSeconds: 60, requestTimeoutMs: 1800000, streamIdleTimeoutMs: 300000,
    };
    validateConfig(config);
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
    window.__refreshModelsCalls = 0;
    window.__modelsFail = false;
    window.__autoRefreshBump = false;
    window.__config = config;
    const syncConfig = () => { window.__config = config; };
    const status = () => {
      const value = {
        revision: 'fixture-revision', apiKeyConfigured: true, sessionSource: 'login', quota, login, config, guardedTurns: 2,
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
    const api = {
      status: async (...args) => { if (args.length) throw new Error('status requires zero arguments'); return { ok: true, value: status() }; },
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
        login = { jobId: 'fixture-job', state: 'waiting', message: '请在授权窗口确认设备授权',
          activationUrl: 'https://open-design.ai/cloud/cli/activate?code=AB12-CD34', userCode: 'AB12-CD34',
          expiresAt: new Date(Date.now() + 300_000).toISOString() };
        return { ok: true, value: login };
      },
      loginStatus: async (...args) => { if (args.length) throw new Error('loginStatus requires zero arguments'); return { ok: true, value: login }; },
      cancelLogin: async () => { login = { jobId: 'fixture-job', state: 'cancelled' }; return { ok: true, value: login }; },
      openActivationPage: async (...args) => {
        if (args.length) throw new Error('openActivationPage requires zero arguments');
        window.__openActivationCalls += 1;
        if (window.__holdActivation) await new Promise(resolve => { window.__releaseActivation = resolve; });
        const code = window.__activationCode ?? 'opened';
        return { ok: true, value: { code, opened: code === 'opened' } };
      },
      saveApiKey: async request => { if (request.value !== 'fixture-api-key') throw new Error('Unexpected fixture key'); return { ok: true, value: status() }; },
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
    window.__setModelsFail = value => { window.__modelsFail = value; };
    window.__openActivationCalls = 0;
    window.__setActivationCode = code => { window.__activationCode = code; };
    window.__setFormState = (state, writable) => {
      snapshot = { ...snapshot, status: state, writable, value: state === 'ready' ? config : undefined };
      for (const cb of listeners) cb();
    };
    window.__saveCalls = [];
    const form = {
      getSnapshot: () => snapshot,
      subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
      set: async (field, value) => {
        window.__saveCalls.push(field);
        if (window.__holdSaves) await new Promise(resolve => { window.__releaseSave = resolve; });
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
    const ctx = {
      remote: { openDesignCoRouter: api, $mount: async () => () => { window.__remoteDisposed = true; } },
      get: key => key === 'remote.openDesignCoRouter' ? api : undefined,
      effect: fn => { const result = fn(); if (result?.then) { void result.then(disposer => { if (disposer) disposers.push(disposer); }); } else if (typeof result === 'function') disposers.push(result); },
      inject: (_services, fn) => fn(ctx), configForms: { get: () => form },
      slots: { inject: (_name, fn) => fn(), register: (descriptor, component) => { window.__mount(component, descriptor.inject()); return () => {}; } },
    };
    window.__cleanup = async () => { window.__root.unmount(); for (const off of disposers.reverse()) await off(); };
    window.__plugin.apply(ctx);
  }, { rawModels: fixtureModels, wireSchema: JSON.parse(JSON.stringify(Config.toJSON())) });
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
  const pendingGuard = page.getByRole('checkbox', { name: /启用空轮监控/u });
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
  for (const label of ['订阅账期结束', '下次额度恢复', '下次自动刷新']) {
    const metric = page.locator('.odc-metric', { hasText: label });
    assert.match(await metric.locator('.odc-metric-text').innerText(), /\d{4}\//, `${label} must show a concrete timestamp`);
  }
  await page.getByText('套餐赠送窗口', { exact: true }).waitFor();
  await mkdir('docs/previews', { recursive: true });
  await page.screenshot({ path: 'docs/previews/overview.png', fullPage: true });

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
  await page.getByLabel('搜索付费 Provider', { exact: true }).fill('qwen');
  await page.locator('.odc-model-item', { hasText: 'qwen3.7-max' }).waitFor();
  await page.getByLabel('搜索付费 Provider', { exact: true }).fill('');
  for (const group of await page.locator('.odc-model-groups > section').all()) {
    const expand = group.getByRole('button', { name: /^显示全部/u });
    if (await expand.count()) await expand.click();
  }
  assert.equal(await page.locator('.odc-model-item').count(), fixtureModels.length);
  const luna = page.locator('.odc-model-item', { hasText: 'gpt-6-luna' });
  const lunaSwitch = luna.locator('input[type=checkbox]');
  assert.equal(await lunaSwitch.isChecked(), true);
  await lunaSwitch.uncheck();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.enabled === false);
  await luna.getByText('已禁用', { exact: true }).waitFor();
  // Force a Host status refresh while disabled, so Status.models still claims `enabled: false`.
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__lastStatus.models.find(model => model.id === 'gpt-6-luna').enabled), false);
  // Reset deletes the whole map entry; the ready form must win over the now-stale catalog flag.
  await luna.getByRole('button', { name: '重置', exact: true }).click();
  await page.waitForFunction(() => !('gpt-6-luna' in (window.__config.modelSettings ?? {})));
  assert.equal(await lunaSwitch.isChecked(), true);
  assert.equal(await luna.getByText('已禁用', { exact: true }).count(), 0);
  // Expand and edit every parameter; blanks inherit, invalid input never persists.
  await luna.locator('summary').click();
  assert.equal(await luna.locator('details').evaluate(element => element.open), true);
  const temperature = luna.getByLabel('温度', { exact: true });
  const topP = luna.getByLabel('Top P', { exact: true });
  const maxTokens = luna.getByLabel('最大输出（tokens）', { exact: true });
  const contextWindow = luna.getByLabel('上下文预算（tokens）', { exact: true });
  const effort = luna.getByLabel('默认思考深度', { exact: true });
  await temperature.fill('0.7');
  await temperature.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.temperature === 0.7);
  await topP.fill('0.9');
  await topP.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.topP === 0.9);
  await maxTokens.fill('4096');
  await maxTokens.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.maxTokens === 4096);
  await contextWindow.fill('200000');
  await contextWindow.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.contextWindow === 200000);
  await contextWindow.fill('4096');
  await contextWindow.blur();
  await luna.getByText('最大输出必须小于上下文预算；请先增大上下文预算或减小最大输出。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__config.modelSettings['gpt-6-luna'].contextWindow), 200000);
  await contextWindow.fill('200000');
  await contextWindow.blur();
  await effort.selectOption('high');
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.reasoningEffort === 'high');
  assert.deepEqual(await modelSettings(), {
    'gpt-6-luna': { temperature: 0.7, topP: 0.9, maxTokens: 4096, contextWindow: 200000, reasoningEffort: 'high' },
  });
  await temperature.fill('3');
  await temperature.blur();
  await luna.locator('.odc-field-error').first().waitFor();
  assert.equal(await page.evaluate(() => window.__config.modelSettings?.['gpt-6-luna']?.temperature), 0.7);
  await temperature.fill('0.7');
  await temperature.blur();
  await page.waitForFunction(() => window.__config.modelSettings?.['gpt-6-luna']?.temperature === 0.7);
  await page.screenshot({ path: 'docs/previews/models.png', fullPage: true });
  for (const group of await page.locator('.odc-model-groups > section').all()) {
    const expand = group.getByRole('button', { name: /^显示全部/u });
    if (await expand.count()) await expand.click();
  }
  // Discovery success: source, timestamp and the new row become visible.
  await page.getByRole('button', { name: '从 OpenAI 刷新模型', exact: true }).click();
  await page.waitForFunction(() => window.__refreshModelsCalls === 1);
  await page.getByText(/来源：OpenAI \/models 发现 · 更新于/u).waitFor();
  await page.getByText('已从 OpenAI 刷新模型列表', { exact: false }).waitFor();
  assert.equal(await page.locator('.odc-model-item').count(), fixtureModels.length + 1);
  await page.locator('.odc-model-item', { hasText: 'gpt-6.1-sol-remote' }).waitFor();
  // Discovery failure keeps the previous catalog and must not claim success.
  await page.evaluate(() => window.__setModelsFail(true));
  await page.getByRole('button', { name: '从 OpenAI 刷新模型', exact: true }).click();
  await page.waitForFunction(() => window.__refreshModelsCalls === 2);
  await page.getByText('模型发现请求超过 20 秒时限', { exact: true }).waitFor();
  assert.equal(await page.getByText(/已从 OpenAI 刷新模型列表/u).count(), 0);
  await page.evaluate(() => window.__setModelsFail(false));

  await page.getByRole('tab', { name: '连接与登录', exact: true }).click();
  const startDevice = page.getByRole('button', { name: '开始设备授权', exact: true });
  await startDevice.click();
  const approvalLink = page.getByRole('link', { name: '复制链接手动打开', exact: true });
  await approvalLink.waitFor();
  assert.equal(await approvalLink.getAttribute('href'), 'https://open-design.ai/cloud/cli/activate?code=AB12-CD34');
  assert.equal(await approvalLink.getAttribute('target'), '_blank');
  assert.match(await approvalLink.getAttribute('rel'), /noopener/u);
  assert.equal(await page.getByLabel('设备授权码', { exact: true }).innerText(), 'AB12-CD34');
  assert.equal(await startDevice.isDisabled(), true);
  // The Host launches the temporary window; the panel reports what actually happened.
  const openWindow = page.getByRole('button', { name: '在新窗口打开授权页', exact: true });
  await openWindow.click();
  await page.waitForFunction(() => window.__openActivationCalls === 1);
  await page.getByText('已在新窗口打开官方授权页；请在该窗口确认设备码。', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('.odc-settings').innerText(), /deviceSecret|controlKey|runtimeKey/);
  // Capture the working state before exercising the failure path.
  await page.screenshot({ path: 'docs/previews/connection.png', fullPage: true });
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
  await page.evaluate(() => window.__finishLogin('success'));
  await page.getByText('设备授权已完成并保存', { exact: true }).waitFor();
  await approvalLink.waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('设备授权码', { exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator('.odc-settings').innerText(), /deviceSecret|controlKey|runtimeKey/);
  const password = page.locator('input[type=password]');
  await password.fill('fixture-api-key');
  await page.getByRole('button', { name: /保存.*Key/u }).click();
  await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '');

  // Advanced: protocol select, read-only gateway, credential reference and real timeouts.
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  const guard = page.getByRole('checkbox', { name: /启用空轮监控/u });
  assert.equal(await guard.isChecked(), true);
  await page.getByText('本次运行已拦截 2 轮。', { exact: false }).waitFor();
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
  await protocol.selectOption('responses');
  await page.waitForFunction(() => window.__config.apiProtocol === 'responses');
  await page.getByText('https://amr-link.open-design.ai/v1/responses', { exact: true }).waitFor();
  await protocol.selectOption('messages');
  await page.waitForFunction(() => window.__config.apiProtocol === 'messages');
  await page.getByText('https://amr-link.open-design.ai/v1/messages', { exact: true }).waitFor();
  const reference = page.getByLabel('API Key 环境变量 / 凭据引用名', { exact: true });
  await reference.fill('COROUTER_FIXTURE_REF');
  await page.getByRole('button', { name: '保存引用名', exact: true }).click();
  await page.waitForFunction(() => window.__config.apiKeyEnv === 'COROUTER_FIXTURE_REF');
  const requestTimeout = page.getByLabel('请求总超时（毫秒）', { exact: true });
  const idleTimeout = page.getByLabel('流式空闲超时（毫秒）', { exact: true });
  const refreshSeconds = page.getByLabel('额度自动刷新间隔（秒）', { exact: true });
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
  await page.screenshot({ path: 'docs/previews/advanced.png', fullPage: true });
  await page.getByRole('tab', { name: '高级', exact: true }).press('Home');
  assert.equal(await page.getByRole('tab', { name: '概览', exact: true }).getAttribute('aria-selected'), 'true');
  const reports = [];
  const switchTheme = async mode => {
    // Explicit host selection must win even when the OS requests the opposite scheme.
    await page.emulateMedia({ colorScheme: mode === 'dark' ? 'light' : 'dark', forcedColors: 'none' });
    await page.evaluate(mode => {
      document.body.toggleAttribute('data-ds-dark-theme', mode === 'dark');
      document.documentElement.style.colorScheme = mode;
    }, mode);
  };
  for (const [index, mode] of ['light', 'dark', 'light'].entries()) {
    await switchTheme(mode);
    for (const tab of ['概览', '模型', '连接与登录', '高级']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      reports.push(await auditTheme(page, `${index + 1}-${mode}-${tab}`));
      if (tab === '概览') await page.screenshot({ path: `docs/previews/overview-${mode}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.getByRole('tab', { name: '连接与登录', exact: true }).click();
    const primary = page.locator('.odc-button-primary');
    const foreground = await primary.evaluate(element => {
      const css = getComputedStyle(element);
      return { actual: css.color.replace(/\s+/g, ''), expected: css.getPropertyValue('--dsw-alias-label-primary-foreground').replace(/\s+/g, '') };
    });
    assert.equal(foreground.actual, foreground.expected, `${mode}: primary label uses the actual host foreground token`);
    await primary.hover();
    reports.push(await auditTheme(page, `${index + 1}-${mode}-hover`));
    await page.locator('input[type=password]').focus();
    assert.equal(await page.locator('input[type=password]').evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid' && parseFloat(getComputedStyle(element).outlineWidth) >= 2), true);
    await page.screenshot({ path: `docs/previews/theme-${mode}.png`, fullPage: true });
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
  await switchTheme('dark');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addStyleTag({ content: 'body{padding:18px}' });
  reports.push(await auditTheme(page, 'dark-mobile-overview'));
  await writeFile('docs/previews/theme-contrast.json', JSON.stringify({ scope: 'Enabled visible text and placeholders; WCAG sRGB contrast calculation; offline official palette fixture, not a full accessibility certification.', checks: reports }, null, 2) + '\n');
  await page.screenshot({ path: 'docs/previews/mobile-dark.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => window.__cleanup());
  assert.equal(await page.locator('style[data-opendesign-corouter]').count(), 0);
  assert.equal(await page.evaluate(() => window.__remoteDisposed), true);
  assert.deepEqual(errors, []);
  console.log(`Offline UI smoke passed: 4 tabs, ${fixtureModels.length} models, model enable/edit/reset persistence, protocol selection, quota timing and auto-refresh scheduling, 9 RPCs, credential input, guard switch, keyboard navigation, disposal; ${reports.length} official light/dark/forced-color audits, minimum measured text contrast ${Math.min(...reports.map(report => report.minimum))}:1.`);
} finally { await browser.close(); }
