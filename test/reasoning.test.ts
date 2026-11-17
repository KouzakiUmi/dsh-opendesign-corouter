import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { CoRouterAdapter } from '../src/adapter.js';
import { MODELS, type CatalogModel } from '../src/catalog.js';
import { PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { API_PROTOCOL_IDS } from '../src/protocol-options.js';
import { protocolFor } from '../src/protocols/index.js';
import { modelReasoningEfforts } from '../src/reasoning.js';

// The omitted-effort request fixture emits Chat SSE and verifies that explicit format.
const base: RuntimeConfig = { apiProtocol: 'chat-completions', apiKeyEnv: 'OFFLINE_FIXTURE', baseURL: 'https://example.invalid/v1', useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 };
const options = (provider: string, model: string): GenerateOptions => ({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] });
const sse = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> { for await (const _chunk of stream) { /* consume */ } }

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

test('the route default is the documented default, the saved choice wins, and an unstated default stays unset', async () => {
  let config: RuntimeConfig = { ...base };
  const unstated: CatalogModel = { id: 'fixture-unstated', name: 'Fixture Unstated', group: 'paid', reasoningEfforts: ['low', 'high'] };
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => undefined });
  const bare = new CoRouterAdapter({ config: () => base, models: () => [unstated], apiKey: async () => undefined });
  try {
    // The Host then offers the concrete tier instead of a provider-default entry an untrusted relay could read as "off".
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, 'gpt-6.1-sol')).reasoning?.defaultEffort, ReasoningEffortId('medium'));
    // Two vendors state no default; the route default recorded by shipped implementations covers them.
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, 'gpt-6-astra')).reasoning?.defaultEffort, ReasoningEffortId('low'));
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, 'muse-spark-1.3')).reasoning?.defaultEffort, ReasoningEffortId('high'));
    // A model whose default nobody documents keeps the provider's own answer.
    assert.equal((await bare.resolveModel(PAID_PROVIDER, unstated.id)).reasoning?.defaultEffort, undefined);
    config = { ...base, modelSettings: { 'gpt-6.1-sol': { reasoningEffort: 'high' } } };
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, 'gpt-6.1-sol')).reasoning?.defaultEffort, ReasoningEffortId('high'));
  } finally { adapter.dispose(); bare.dispose(); }
});

test('the Host materializes the documented default instead of leaving the effort open', async () => {
  const unstated: CatalogModel = { id: 'fixture-unstated', name: 'Fixture Unstated', group: 'paid', reasoningEfforts: ['low', 'high'] };
  const ctx = new Context();
  const fiber = await ctx.plugin(LlmRuntime);
  const adapter = new CoRouterAdapter({ config: () => base, models: () => [...MODELS, unstated], apiKey: async () => undefined });
  const registration = ctx.llm.registerAdapter([PLAN_PROVIDER, PAID_PROVIDER], adapter);
  try {
    // A reported default is what removes the Host's provider-default entry from the effort menu.
    assert.equal((await ctx.llm.resolveModelInfo(PAID_PROVIDER, 'gpt-6.1-sol')).reasoning?.defaultEffort, ReasoningEffortId('medium'));
    assert.equal((await ctx.llm.resolveCallConfig({ provider: PAID_PROVIDER, model: 'gpt-6.1-sol' })).reasoningEffort, ReasoningEffortId('medium'));
    // Without a documented default the route keeps the provider's own answer.
    assert.equal((await ctx.llm.resolveCallConfig({ provider: PAID_PROVIDER, model: unstated.id })).reasoningEffort, undefined);
  } finally { registration(); adapter.dispose(); await fiber.dispose(); }
});

test('auto and model protocol overrides share effort intersection in metadata and requests', async () => {
  let config: RuntimeConfig = { ...base, apiProtocol: 'auto' };
  const wires: Record<string, unknown>[] = [];
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'fixture-key', fetch: async (_url, init) => {
    wires.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 401 });
  } });
  const request = options(PAID_PROVIDER, 'muse-spark-1.3');
  try {
    assert.deepEqual((await adapter.resolveModel(PAID_PROVIDER, request.model)).reasoning?.efforts.map(item => item.id), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    await assert.rejects(drain(adapter.stream(request)), { code: 'AUTH' });
    assert.deepEqual(wires[0]?.reasoning, { effort: 'high', summary: 'auto' });
    config = { ...base, apiProtocol: 'responses', modelSettings: { [request.model]: { apiProtocol: 'messages' } } };
    assert.deepEqual((await adapter.resolveModel(PAID_PROVIDER, request.model)).reasoning?.efforts.map(item => item.id), ['low', 'medium', 'high', 'xhigh', 'max']);
    await assert.rejects(drain(adapter.stream(request)), { code: 'AUTH' });
    assert.deepEqual(wires[1]?.output_config, { effort: 'high' });
    await assert.rejects(drain(adapter.stream({ ...request, reasoningEffort: ReasoningEffortId('minimal') })), { code: 'UNSUPPORTED_OPTION' });
    assert.equal(wires.length, 2, 'invalid per-model-protocol effort fails before dispatch');
  } finally { adapter.dispose(); }
});

test('an omitted effort travels as the documented default, never as an implicit off', async () => {
  const unstated: CatalogModel = { id: 'fixture-unstated', name: 'Fixture Unstated', group: 'paid', reasoningEfforts: ['low', 'high'] };
  const wires: Record<string, unknown>[] = [];
  const adapter = new CoRouterAdapter({
    config: () => base, models: () => [...MODELS, unstated], apiKey: async () => 'fixture-key',
    fetch: async (_input, init) => { wires.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return sse(); },
  });
  try {
    await drain(adapter.stream(options(PAID_PROVIDER, 'gpt-6.1-sol')));
    assert.equal(wires[0]?.reasoning_effort, 'medium');
    // No documented default: the field stays absent rather than becoming "none".
    await drain(adapter.stream(options(PAID_PROVIDER, unstated.id)));
    assert.equal(Object.hasOwn(wires[1] ?? {}, 'reasoning_effort'), false);
  } finally { adapter.dispose(); }
});
