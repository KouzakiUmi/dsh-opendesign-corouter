import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import * as plugin from '../src/index.js';
import { PLAN_PROVIDER, PAID_PROVIDER } from '../src/config.js';
import { REMOTE_PACKAGE } from '../src/remote.js';
import { TYPERT } from '../src/generated/typert.host.js';
const isolatedPlugin = { ...plugin, inject: ['llm', 'typert'], apply(ctx: Context, config: Parameters<typeof plugin.apply>[1]) {
  ctx.typert.register(TYPERT); // Direct compositions have no Loader; explicitly supply the generated contribution.
  plugin.apply(ctx, config);
} };

test('real Cordis scope loads both Providers and Host RPC, then fully withdraws on dispose', async () => {
  const ctx = new Context();
  const llm = await ctx.plugin(LlmRuntime);
  const registry = await ctx.plugin(TypertRegistry);
  try {
    const fiber = await ctx.plugin(isolatedPlugin, { useDesktopCredential: false });
    assert.deepEqual(ctx.llm.listProviders().map(row => row.id), [PLAN_PROVIDER, PAID_PROVIDER]);
    assert.equal((await ctx.llm.listModels(PLAN_PROVIDER)).length, 12);
    assert.equal((await ctx.llm.listModels(PAID_PROVIDER)).length, 21);
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
