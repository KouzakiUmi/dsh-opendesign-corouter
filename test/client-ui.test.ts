import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatUsd, QuotaView, SettingsPage, tabAfter, type RpcCaller, type SettingsProps } from '../src/client.js';
import type { Status } from '../src/remote.js';

const h = React.createElement;

const status: Status = {
  revision: 'revision-for-test',
  apiKeyConfigured: false,
  quota: {
    state: 'partial',
    source: 'desktop',
    updatedAt: '2026-10-26T08:00:00.000Z',
    windows: [],
    balances: {},
    note: '桌面权限不足时，可关闭桌面优先后使用已保存的独立会话。',
  },
  login: { jobId: null, state: 'idle' },
  config: {
    emptyTurnGuard: true,
    useDesktopCredential: true,
    baseURL: 'https://example.invalid/v1',
    apiKeyEnv: 'COROUTER_API_KEY',
  },
  guardedTurns: 0,
  models: [],
};

const caller: RpcCaller = async <T>(): Promise<T> => {
  throw new Error('Server rendering must not call RPC');
};
let snapshot: ReturnType<SettingsProps['form']['getSnapshot']> = {
  status: 'ready',
  writable: true,
  value: status.config,
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

test('settings renders four accessible tabs and one associated tabpanel', () => {
  const html = renderOverview();
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 1);
  assert.match(html, /aria-label="CoRouter 设置分类"/);
  assert.match(html, /aria-selected="true"/);
  for (const label of ['概览', '模型', '连接与登录', '高级']) assert.match(html, new RegExp(`>${label}<`));
});

test('unknown quota stays unknown and safe partial guidance is visible', () => {
  const html = renderToStaticMarkup(h(QuotaView, { quota: status.quota }));
  assert.match(html, /套餐余额/);
  assert.match(html, /充值 \/ 赠送金额/);
  assert.match(html, /总额度/);
  assert.ok((html.match(/>—</g) ?? []).length >= 4);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /桌面权限不足时/);
});

test('zero is a real amount rather than an unknown value', () => {
  assert.notEqual(formatUsd(0), '—');
  assert.match(formatUsd(0), /0\.00/);
  assert.equal(formatUsd(undefined), '—');
  assert.equal(formatUsd(Number.NaN), '—');
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
