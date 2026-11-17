import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextQuickSwitch, isCoRouterProvider, quickWindowLabel } from '../src/client-context-quick.js';

const h = React.createElement;

type QuickProps = Parameters<typeof ContextQuickSwitch>[0];

/** A minimal directory store: the component only reads the snapshot and subscribes to it. */
function directory(snapshot: unknown): QuickProps['directory'] {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as QuickProps['directory'];
}

const form = {
  getSnapshot: () => ({ status: 'ready', writable: true, value: { modelSettings: {} } }),
  subscribe: () => () => {},
  set: async () => true,
} as unknown as QuickProps['form'];

const caller = (async () => {
  throw new Error('Server rendering must not call RPC');
}) as unknown as QuickProps['caller'];

const ownDirectory = directory({
  current: { provider: 'opendesign-corouter-plan', model: 'gpt-6-luna' },
  pending: null,
  status: 'ready',
  groups: [{ id: 'co', models: [] }],
  routable: true,
});

test('only the plugin\'s own channels count as a CoRouter model', () => {
  assert.equal(isCoRouterProvider('opendesign-corouter-plan'), true);
  assert.equal(isCoRouterProvider('opendesign-corouter-paid'), true);
  assert.equal(isCoRouterProvider('openai'), false);
  assert.equal(isCoRouterProvider('anthropic'), false);
  assert.equal(isCoRouterProvider(''), false);
  assert.equal(isCoRouterProvider('opendesign-corouter'), false, 'a partial id is not a channel');
});

test('the quick window label stays short and readable', () => {
  assert.equal(quickWindowLabel(256_000), '256K');
  assert.equal(quickWindowLabel(512_000), '512K');
  assert.equal(quickWindowLabel(1_000_000), '1M');
  assert.equal(quickWindowLabel(1_050_000), '1.05M');
  assert.equal(quickWindowLabel(200_000), '200K');
  assert.equal(quickWindowLabel(262_144), '256K', 'binary references use compact binary subdivisions');
  assert.equal(quickWindowLabel(65_536), '64K');
  assert.equal(quickWindowLabel(131_072), '128K');
  assert.equal(quickWindowLabel(1_048_576), '1M');
  assert.equal(quickWindowLabel(undefined), '容量未知');
});

test('a foreign provider has no CoRouter context to change', () => {
  const foreign = renderToStaticMarkup(h(ContextQuickSwitch, {
    directory: directory({
      current: { provider: 'openai', model: 'gpt-4o' },
      pending: null,
      status: 'ready',
      groups: [],
      routable: true,
    }),
    form,
    caller,
  }));
  assert.equal(foreign, '', 'a third-party model renders no CoRouter quick switch');
});

test('the inline group names the channel and waits for the catalog reference without fake tiers', () => {
  const html = renderToStaticMarkup(h(ContextQuickSwitch, { directory: ownDirectory, form, caller }));
  assert.match(html, /class="odc-quick"/u);
  assert.match(html, /aria-label="CoRouter 上下文[^"]*"/u);
  // Without a catalog row the window is unknown; the control says so instead of guessing.
  assert.match(html, /容量未知/u);
  assert.match(html, /正在读取模型参考容量…/u);
  assert.doesNotMatch(html, /data-preset=|<input/u, 'unknown capacity does not render invented tier buttons');
  assert.doesNotMatch(html, /上下文预算（tokens）/u, 'the quick switch is not a numeric field');
});

test('the quick control uses the shared inline group without a dialog or trigger', () => {
  const html = renderToStaticMarkup(h(ContextQuickSwitch, { directory: ownDirectory, form, caller }));
  assert.match(html, /class="odc-context odc-context-control" role="group"/u);
  assert.doesNotMatch(html, /odc-quick-panel|role="dialog"|popover|aria-haspopup/u);
  assert.match(html, /上下文窗口/u);
  assert.match(html, /使用此模型的其他会话同步/u);
  assert.match(html, /CoRouter 上下文 · gpt-6-luna/u);
});

test('a pending model selection cannot be written through the quick switch', () => {
  const pending = renderToStaticMarkup(h(ContextQuickSwitch, {
    directory: directory({
      current: { provider: 'opendesign-corouter-plan', model: 'gpt-6-luna' },
      pending: { provider: 'opendesign-corouter-plan', model: 'claude-haiku-5.5' },
      status: 'selecting',
      groups: [],
      routable: true,
    }),
    form,
    caller,
  }));
  assert.match(pending, /正在切换模型，请稍候。/u);
  assert.doesNotMatch(pending, /data-preset=/u);
});
