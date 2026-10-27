import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { CoRouterAdapter } from '../src/adapter.js';
import { MODELS, type CatalogModel } from '../src/catalog.js';
import { PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { API_PROTOCOL_IDS } from '../src/protocol-options.js';
import { protocolFor } from '../src/protocols/index.js';
import { modelReasoningEfforts } from '../src/reasoning.js';

const base: RuntimeConfig = { apiKeyEnv: 'OFFLINE_FIXTURE', baseURL: 'https://example.invalid/v1', useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 };
const options = (provider: string, model: string): GenerateOptions => ({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] });

test('every advertised model effort is accepted by the active request builder', async () => {
  let config = { ...base };
  const ctx = new Context();
  const fiber = await ctx.plugin(LlmRuntime);
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => { assert.fail('metadata must not read credentials'); } });
  const registration = ctx.llm.registerAdapter([PLAN_PROVIDER, PAID_PROVIDER], adapter);
  try {
    for (const apiProtocol of API_PROTOCOL_IDS) {
      config = { ...base, apiProtocol };
      for (const row of MODELS) {
        const provider = row.group === 'plan' ? PLAN_PROVIDER : PAID_PROVIDER;
        const model = await ctx.llm.resolveModelInfo(provider, row.id);
        for (const effort of model.reasoning?.efforts ?? []) {
          assert.doesNotThrow(() => protocolFor(apiProtocol).build({ baseURL: base.baseURL, apiKey: 'fixture-key', model: row, images: new Map(), options: { ...options(provider, row.id), reasoningEffort: effort.id } }), `${apiProtocol}/${row.id}/${effort.id}`);
        }
      }
    }
  } finally { registration(); adapter.dispose(); await fiber.dispose(); }
});

test('protocol intersection excludes unsupported choices without changing their meaning', () => {
  const row = { reasoningEfforts: ['none', 'minimal', 'low', 'ultra', 'max'] };
  assert.deepEqual(modelReasoningEfforts(row, 'responses'), ['none', 'minimal', 'low', 'max']);
  assert.deepEqual(modelReasoningEfforts(row, 'messages'), ['none', 'low', 'max']);
  assert.deepEqual(modelReasoningEfforts({ reasoningEfforts: [] }, 'messages'), []);
  assert.equal(modelReasoningEfforts({}, 'chat-completions'), undefined);
});

test('a stale default does not corrupt Core metadata and is rejected before credential or network I/O', async () => {
  const config: RuntimeConfig = { ...base, modelSettings: { 'glm-5.3-flash': { reasoningEffort: 'ultra' } } };
  let credentialReads = 0, fetches = 0;
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => { credentialReads++; return 'fixture-key'; }, fetch: async () => { fetches++; assert.fail('unsupported effort must not fetch'); } });
  const ctx = new Context(); const fiber = await ctx.plugin(LlmRuntime);
  const registration = ctx.llm.registerAdapter([PLAN_PROVIDER, PAID_PROVIDER], adapter);
  try {
    const model = await ctx.llm.resolveModelInfo(PLAN_PROVIDER, 'glm-5.3-flash');
    assert.deepEqual(model.reasoning?.efforts.map(row => row.id), ['low', 'high', 'max']);
    assert.equal(model.reasoning?.defaultEffort, undefined);
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options(PLAN_PROVIDER, 'glm-5.3-flash'))) { /* consume */ } }, { code: 'UNSUPPORTED_OPTION' });
    assert.equal(credentialReads, 0); assert.equal(fetches, 0);
  } finally { registration(); adapter.dispose(); await fiber.dispose(); }
});

test('unknown model capabilities are not synthesized from a saved effort', async () => {
  const row: CatalogModel = { id: 'fixture-unknown', name: 'Fixture', group: 'paid' };
  const adapter = new CoRouterAdapter({ config: () => ({ ...base, modelSettings: { [row.id]: { reasoningEffort: 'high' } } }), models: () => [row], apiKey: async () => { assert.fail('unsupported effort must not read credentials'); } });
  try {
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, row.id)).reasoning, undefined);
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options(PAID_PROVIDER, row.id))) { /* consume */ } }, { code: 'UNSUPPORTED_OPTION' });
  } finally { adapter.dispose(); }
});

test('only valid explicit defaults are materialized; vendor defaults remain upstream-owned', async () => {
  let config: RuntimeConfig = { ...base };
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => undefined });
  try {
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, 'gpt-6.1-sol')).reasoning?.defaultEffort, undefined);
    config = { ...base, modelSettings: { 'gpt-6.1-sol': { reasoningEffort: 'high' } } };
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, 'gpt-6.1-sol')).reasoning?.defaultEffort, ReasoningEffortId('high'));
  } finally { adapter.dispose(); }
});
