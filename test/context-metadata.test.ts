import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { CoRouterAdapter } from '../src/adapter.js';
import { MODELS, type CatalogModel } from '../src/catalog.js';
import { PAID_PROVIDER, PLAN_PROVIDER, type RuntimeConfig } from '../src/config.js';

const base: RuntimeConfig = {
  apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://gateway.invalid/v1', apiProtocol: 'messages',
  useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000,
};

test('the Host receives the whole context window separately from the output allowance', async () => {
  const ctx = new Context();
  const runtime = await ctx.plugin(LlmRuntime);
  let config = base;
  const future: CatalogModel = { id: 'future-model', name: 'Future model', group: 'paid' };
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'fixture', models: () => [...MODELS, future] });
  const dispose = ctx.llm.registerAdapter([PAID_PROVIDER, PLAN_PROVIDER], adapter);
  try {
    const initial = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: 'claude-opus-5.5' });
    assert.deepEqual(initial.context, { contextWindow: 256_000 });
    assert.equal(initial.config.maxTokens, 4096);
    config = { ...base, modelSettings: { 'claude-opus-5.5': { contextWindow: 200_000, maxTokens: 8_192 } } };
    const next = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: 'claude-opus-5.5' });
    assert.deepEqual(next.context, { contextWindow: 200_000 });
    assert.equal(next.config.maxTokens, 8_192);
    assert.deepEqual(initial.context, { contextWindow: 256_000 });
    const deepseek = await ctx.llm.prepareCall({ provider: PLAN_PROVIDER, model: 'deepseek-v4.1-flash' });
    assert.deepEqual(deepseek.context, { contextWindow: 256_000 });
    assert.equal(deepseek.config.maxTokens, 64_000);
    const unknown = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: 'future-model' });
    assert.equal(unknown.context, undefined, 'unknown capacity must not advertise a fabricated context');
    assert.equal(unknown.config.maxTokens, 4096, 'Messages retains its protocol default without inventing a model cap');
    config = { ...base, apiProtocol: 'chat-completions' };
    const chat = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: 'claude-opus-5.5' });
    assert.deepEqual(chat.context, { contextWindow: 256_000 });
    assert.equal(chat.config.maxTokens, undefined, 'the capacity reference does not add a Chat output cap');
  } finally {
    dispose(); adapter.dispose(); await runtime.dispose();
  }
});

test('new context references survive Host preparation without adding an output cap', async () => {
  const ctx = new Context();
  const runtime = await ctx.plugin(LlmRuntime);
  let config = base;
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'fixture' });
  const dispose = ctx.llm.registerAdapter([PAID_PROVIDER, PLAN_PROVIDER], adapter);
  const added = MODELS.filter(row => row.maxOutputTokens === undefined);
  const expectedWindows = new Map<number, readonly number[]>([
    [1_000_000, [256_000, 512_000, 1_000_000]],
    [1_050_000, [256_000, 512_000, 1_050_000]],
    [1_048_576, [262_144, 524_288, 1_048_576]],
    [262_144, [65_536, 131_072, 262_144]],
    [500_000, [128_000, 256_000, 500_000]],
  ]);
  assert.equal(added.length, 29, '17 exact model rows have evidenced output caps; the other 29 do not');
  try {
    for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
      for (const [index, contextTier] of (['default', 'extended', 'maximum'] as const).entries()) {
        config = { ...base, apiProtocol: protocol, modelSettings: Object.fromEntries(added.map(row => [row.id, { contextTier }])) };
        for (const row of added) {
          const expected = row.contextWindow === undefined ? undefined : expectedWindows.get(row.contextWindow);
          if (row.contextWindow !== undefined) assert.ok(expected, `explicit fixture missing reference ${row.contextWindow}`);
          const call = await ctx.llm.prepareCall({ provider: row.group === 'plan' ? PLAN_PROVIDER : PAID_PROVIDER, model: row.id });
          assert.equal(call.context?.contextWindow, expected?.[index], `${row.id}/${protocol}/${contextTier} context`);
          assert.equal(call.config.maxTokens, protocol === 'messages' ? 4096 : undefined, `${row.id}/${protocol}/${contextTier} output`);
        }
      }
    }
  } finally {
    dispose(); adapter.dispose(); await runtime.dispose();
  }
});

test('Host omits unknown context across tiers and restores a numeric custom window without capping it', async () => {
  const ctx = new Context();
  const runtime = await ctx.plugin(LlmRuntime);
  const future: CatalogModel = { id: 'future-model', name: 'Future', group: 'paid' };
  let config: RuntimeConfig = base;
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [future], apiKey: async () => 'fixture' });
  const dispose = ctx.llm.registerAdapter([PAID_PROVIDER], adapter);
  try {
    for (const apiProtocol of ['chat-completions', 'responses', 'messages'] as const) {
      for (const contextTier of ['default', 'extended', 'maximum'] as const) {
        config = { ...base, apiProtocol, modelSettings: { [future.id]: { contextTier } } };
        const call = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: future.id });
        assert.equal(call.context, undefined, `${apiProtocol}/${contextTier}`);
        assert.equal(call.config.maxTokens, apiProtocol === 'messages' ? 4096 : undefined);
      }
      config = { ...base, apiProtocol, modelSettings: { [future.id]: { contextWindow: 1_000_000 } } };
      const custom = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: future.id });
      assert.deepEqual(custom.context, { contextWindow: 1_000_000 });
      assert.equal(custom.config.maxTokens, apiProtocol === 'messages' ? 4096 : undefined);
    }
  } finally { dispose(); adapter.dispose(); await runtime.dispose(); }
});
