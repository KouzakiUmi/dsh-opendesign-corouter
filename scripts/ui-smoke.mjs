// Entirely offline browser fixture: never opens the DSH GUI, account pages or real login.
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { auditTheme } from './theme-audit.mjs';
import assert from 'node:assert/strict';
import { MODELS } from '../lib/index.js';
const react = await build({ stdin: { contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client'; window.__React=React; window.__mount=(component,props)=>{window.__root=createRoot(document.getElementById('root'));window.__root.render(React.createElement(component,props));};`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } });
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
  await page.evaluate(models => {
    let quota = { state: 'ok', source: 'login', updatedAt: '2026-10-26T08:00:00Z', tier: 'Pro', eligible: true,
      windows: [{ durationSeconds: 18000, used: 120, limit: 500, remaining: 380, percent: 24, resetsAt: '2026-10-26T12:00:00Z' }, { durationSeconds: 604800, used: 400, limit: 2000, remaining: 1600, percent: 20, resetsAt: '2026-10-29T08:00:00Z' }],
      balances: { subscriptionUsd: 60, rechargeUsd: 20, totalUsd: 80 } };
    let login = { jobId: null, state: 'idle' };
    let config = { emptyTurnGuard: true, useDesktopCredential: true, baseURL: 'https://amr-link.open-design.ai/v1', apiKeyEnv: 'COROUTER_API_KEY' };
    let snapshot = { status: 'ready', writable: true, value: config };
    const listeners = new Set(), disposers = [];
    window.__setQuotaState = (state, note) => { quota = { ...quota, state, note }; };
    const status = () => ({ revision: 'fixture-revision', apiKeyConfigured: true, sessionSource: 'login', quota, login, config, guardedTurns: 2, models });
    const api = {
      status: async (...args) => { if (args.length) throw new Error('status requires zero arguments'); return { ok: true, value: status() }; }, refreshQuota: async (...args) => { if (args.length) throw new Error('refreshQuota requires zero arguments'); return { ok: true, value: quota }; },
      startLogin: async () => { login = { jobId: 'fixture-job', state: 'waiting', message: '模拟登录等待，不会打开浏览器' }; return { ok: true, value: login }; },
      loginStatus: async (...args) => { if (args.length) throw new Error('loginStatus requires zero arguments'); return { ok: true, value: login }; }, cancelLogin: async () => { login = { jobId: 'fixture-job', state: 'cancelled' }; return { ok: true, value: login }; },
      saveApiKey: async request => { if (request.value !== 'fixture-api-key') throw new Error('Unexpected fixture key'); return { ok: true, value: status() }; },
    };
    const form = { getSnapshot: () => snapshot, subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
      set: async (field, value) => { config = { ...config, [field]: value }; snapshot = { ...snapshot, value: config }; for (const cb of listeners) cb(); return true; } };
    const ctx = {
      remote: { openDesignCoRouter: api, $mount: async () => () => { window.__remoteDisposed = true; } },
      get: key => key === 'remote.openDesignCoRouter' ? api : undefined,
      effect: fn => { const result = fn(); if (result?.then) { void result.then(disposer => { if (disposer) disposers.push(disposer); }); } else if (typeof result === 'function') disposers.push(result); },
      inject: (_services, fn) => fn(ctx), configForms: { get: () => form },
      slots: { inject: (_name, fn) => fn(), register: (descriptor, component) => { window.__mount(component, descriptor.inject()); return () => {}; } },
    };
    window.__cleanup = async () => { window.__root.unmount(); for (const off of disposers.reverse()) await off(); };
    window.__plugin.apply(ctx);
  }, MODELS.map(({ id, name, group }) => ({ id, name, group })));
  await page.getByRole('heading', { name: '额度概览', exact: true }).waitFor();
  await page.getByText('US$80.00', { exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 4);
  await mkdir('docs/previews', { recursive: true });
  await page.screenshot({ path: 'docs/previews/overview.png', fullPage: true });
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  assert.equal(await page.locator('.odc-model-item').count(), 33);
  await page.getByRole('tab', { name: '连接与登录', exact: true }).click();
  await page.screenshot({ path: 'docs/previews/connection.png', fullPage: true });
  const password = page.locator('input[type=password]');
  await password.fill('fixture-api-key');
  await page.getByRole('button', { name: /保存.*Key/u }).click();
  await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '');
  await page.getByRole('tab', { name: '高级', exact: true }).click();
  const guard = page.getByRole('checkbox', { name: /启用空轮监控/u });
  assert.equal(await guard.isChecked(), true);
  await guard.uncheck();
  assert.equal(await guard.isChecked(), false);
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
    await page.evaluate(() => window.__setQuotaState('ok', undefined));
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
  console.log(`Offline UI smoke passed: 4 tabs, 33 models, credential input, guard switch, keyboard navigation, disposal; ${reports.length} official light/dark/forced-color audits, minimum measured text contrast ${Math.min(...reports.map(report => report.minimum))}:1.`);
} finally { await browser.close(); }
