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
    assert.deepEqual(initial.context, { contextWindow: 272_000 });
    assert.equal(initial.config.maxTokens, 4096);
    config = { ...base, modelSettings: { 'claude-opus-5.5': { contextWindow: 200_000, maxTokens: 8_192 } } };
    const next = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: 'claude-opus-5.5' });
    assert.deepEqual(next.context, { contextWindow: 200_000 });
    assert.equal(next.config.maxTokens, 8_192);
    assert.deepEqual(initial.context, { contextWindow: 272_000 });
    const deepseek = await ctx.llm.prepareCall({ provider: PLAN_PROVIDER, model: 'deepseek-v4.1-flash' });
    assert.deepEqual(deepseek.context, { contextWindow: 272_000 });
    assert.equal(deepseek.config.maxTokens, 68_000);
    const unknown = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: 'future-model' });
    assert.deepEqual(unknown.context, { contextWindow: 272_000 }, 'unknown capacity receives a local working budget, not a fabricated catalog limit');
    config = { ...base, apiProtocol: 'chat-completions' };
    const chat = await ctx.llm.prepareCall({ provider: PAID_PROVIDER, model: 'claude-opus-5.5' });
    assert.deepEqual(chat.context, { contextWindow: 272_000 });
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
  const added = MODELS.filter(row => (row.group === 'paid' && !['gpt-6.1-terra', 'claude-opus-5.5'].includes(row.id)) || row.id === 'minimax-m3.1-flash');
  assert.equal(added.length, 25);
  try {
    for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
      config = { ...base, apiProtocol: protocol };
      for (const row of added) {
        const call = await ctx.llm.prepareCall({ provider: row.group === 'plan' ? PLAN_PROVIDER : PAID_PROVIDER, model: row.id });
        assert.equal(call.context?.contextWindow, Math.min(272_000, row.contextWindow ?? 272_000), `${row.id}/${protocol} context`);
        assert.equal(call.config.maxTokens, protocol === 'messages' ? 4096 : undefined, `${row.id}/${protocol} output`);
      }
    }
  } finally {
    dispose(); adapter.dispose(); await runtime.dispose();
  }
});
