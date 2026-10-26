import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import * as plugin from '../src/index.js';
import { PLAN_PROVIDER, PAID_PROVIDER, SETTINGS_NS } from '../src/config.js';
import { REMOTE_PACKAGE } from '../src/remote.js';
import { TYPERT } from '../src/generated/typert.host.js';
const isolatedPlugin = { ...plugin, inject: ['llm', 'typert'], apply(ctx: Context, config: Parameters<typeof plugin.apply>[1]) {
  ctx.typert.register(TYPERT); // Direct compositions have no Loader; explicitly supply the generated contribution.
  plugin.apply(ctx, config);
} };

test('host model discovery always calls the OpenAI models endpoint regardless of draft protocol', async () => {
  const ctx = new Context();
  const llm = await ctx.plugin(LlmRuntime);
  const registry = await ctx.plugin(TypertRegistry);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://amr-link.open-design.ai/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer discovery-only-fixture');
    return Response.json({ data: [{ id: 'new-discovered', name: 'New discovered' }] });
  };
  let fiber: Fiber | undefined;
  try {
    fiber = await ctx.plugin(isolatedPlugin, { apiProtocol: 'messages', useDesktopCredential: false });
    const models = await ctx.llm.discoverModels(SETTINGS_NS, { baseURL: 'https://amr-link.open-design.ai/v1', api: 'anthropic-messages', apiKey: 'discovery-only-fixture' });
    assert.equal(calls, 1);
    assert.equal(models[0]?.id, 'new-discovered');
  } finally {
    await fiber?.dispose();
    globalThis.fetch = originalFetch;
    await registry.dispose();
    await llm.dispose();
  }
});

test('real Cordis scope loads both Providers and Host RPC, then fully withdraws on dispose', async () => {
  const ctx = new Context();
  const llm = await ctx.plugin(LlmRuntime);
  const registry = await ctx.plugin(TypertRegistry);
  try {
    const fiber = await ctx.plugin(isolatedPlugin, { useDesktopCredential: false });
    assert.deepEqual(ctx.llm.listProviders().map(row => row.id), [PLAN_PROVIDER, PAID_PROVIDER]);
    assert.equal((await ctx.llm.listModels(PLAN_PROVIDER)).length, 13);
    assert.equal((await ctx.llm.listModels(PAID_PROVIDER)).length, 25);
    assert.ok(ctx.typert.getPackage(REMOTE_PACKAGE, 'host'));
    assert.ok(ctx.get('openDesignCoRouter'));
    await fiber.dispose();
    assert.deepEqual(ctx.llm.listProviders(), []);
    assert.equal(ctx.typert.getPackage(REMOTE_PACKAGE, 'host'), undefined);
    assert.equal(ctx.get('openDesignCoRouter'), undefined);
    // A new generation can reclaim exactly the same provider and descriptor names.
    const replacement = await ctx.plugin(isolatedPlugin, { useDesktopCredential: false });
    assert.equal(ctx.llm.listProviders().length, 2);
    await replacement.dispose();
  } finally { await registry.dispose(); await llm.dispose(); }
});
