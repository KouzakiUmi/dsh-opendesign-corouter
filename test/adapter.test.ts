import test from 'node:test';
import assert from 'node:assert/strict';
import { CoRouterAdapter } from '../src/adapter.js';
import { PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
const base: RuntimeConfig = { apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://amr-link.open-design.ai/v1', useDesktopCredential: false, emptyTurnGuard: true, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000 };
const options = (provider = PLAN_PROVIDER, model = 'deepseek-v4.1-flash'): GenerateOptions => ({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] });
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
test('two independent Providers advertise disjoint catalogs and reject cross-group calls', async () => {
  let calls = 0;
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', fetch: async () => { calls++; return sse('ok'); } });
  assert.equal((await adapter.listModels(PLAN_PROVIDER)).length, 12);
  assert.equal((await adapter.listModels(PAID_PROVIDER)).length, 21);
  assert.throws(() => adapter.stream(options(PLAN_PROVIDER, 'gpt-6-astra')), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
});
test('wire uses documented API-key endpoint, attribution and safe budget/reasoning projection', async () => {
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', fetch: async (input, init) => {
    assert.equal(String(input), 'https://amr-link.open-design.ai/v1/chat/completions');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-key');
    assert.match(headers.get('user-agent') ?? '', /^deepseek-harness\//u);
    assert.equal(init?.redirect, 'error');
    const wire = JSON.parse(String(init?.body));
    assert.equal(wire.reasoning_effort, 'high');
    assert.equal(wire.max_tokens, 384000); // explicit cap may exceed the default reserve while the request still fits
    assert.equal(wire.messages[0].role, 'system');
    return sse('answer');
  } });
  const chunks = await collect(adapter.stream({ ...options(), system: 'system', reasoningEffort: ReasoningEffortId('high'), maxTokens: 384000 }));
  assert.equal(chunks.at(-1)?.type, 'finish');
});
test('empty-turn monitor only changes gift chat tool-enabled steps; switch is independent', async () => {
  let hits = 0, config = { ...base };
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'test-key', onEmptyTurn: () => { hits++; }, fetch: async () => sse('<thinking></thinking>') });
  const tool = { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } };
  const result = await collect(adapter.stream({ ...options(), tools: [tool] }));
  assert.deepEqual(result.at(-1), { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'OpenDesign：模型回复只剩协议标记，未产生可用内容' } } });
  config = { ...base, emptyTurnGuard: false };
  assert.deepEqual((await collect(adapter.stream({ ...options(), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'stop' } });
  config = { ...base };
  assert.deepEqual((await collect(adapter.stream({ ...options(PAID_PROVIDER, 'gpt-6-astra'), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.deepEqual((await collect(adapter.stream(options()))).at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(hits, 1);
});
test('prepareCall binds metadata and dispatch to a single settings generation', async () => {
  let config = { ...base };
  const called: string[] = [];
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'test-key', fetch: async input => { called.push(String(input)); return sse('ok'); } });
  const call = await adapter.prepareCall(PLAN_PROVIDER, 'deepseek-v4.1-flash');
  config = { ...config, baseURL: 'https://example.com/new' };
  await collect(call.stream(options()));
  assert.equal(called[0], `${base.baseURL}/chat/completions`);
  assert.equal(call.model.context?.contextWindow, 750000);
});
test('HTTP errors never echo credential or untrusted body; missing key does not fetch', async () => {
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', fetch: async () => Response.json({ error: { message: 'test-key PRIVATE_BODY', code: 'invalid_api_key' } }, { status: 401 }) });
  await assert.rejects(collect(adapter.stream(options())), (error: Error) => !error.message.includes('test-key') && !error.message.includes('PRIVATE_BODY'));
  const missing = new CoRouterAdapter({ config: () => base, apiKey: async () => undefined, fetch: async () => { assert.fail('must not fetch'); } });
  await assert.rejects(collect(missing.stream(options())), { code: 'MISSING_CREDENTIAL' });
});
