import test from 'node:test';
import assert from 'node:assert/strict';
import { CoRouterAdapter } from '../src/adapter.js';
import { PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
const base: RuntimeConfig = { apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://amr-link.open-design.ai/v1', useDesktopCredential: false, emptyTurnGuard: true, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000 };
const options = (provider = PLAN_PROVIDER, model = 'deepseek-v4.1-flash'): GenerateOptions => ({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] });
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
test('two independent Providers advertise disjoint catalogs and reject cross-group calls', async () => {
  let calls = 0;
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', fetch: async () => { calls++; return sse('ok'); } });
  assert.equal((await adapter.listModels(PLAN_PROVIDER)).length, 13);
  assert.equal((await adapter.listModels(PAID_PROVIDER)).length, 26);
  assert.throws(() => adapter.stream(options(PLAN_PROVIDER, 'gpt-6-astra')), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
});
test('verified catalog additions advertise and invoke through their evidence-backed provider', async () => {
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', fetch: async (_input, init) => {
    const wire = JSON.parse(String(init?.body));
    assert.ok(['minimax-m3.1-flash', 'gemini-4-argon', 'kimi-k3.1-pro', 'muse-spark-1.3', 'muse-wonder', 'gpt-6.1-terra'].includes(wire.model));
    return sse('ok');
  } });
  for (const id of ['minimax-m3.1-flash', 'gemini-4-argon', 'kimi-k3.1-pro', 'muse-spark-1.3', 'muse-wonder', 'gpt-6.1-terra']) {
    const provider = id === 'minimax-m3.1-flash' ? PLAN_PROVIDER : PAID_PROVIDER;
    assert.ok((await adapter.listModels(provider)).some(model => model.id === id));
    assert.equal((await collect(adapter.stream(options(provider, id)))).at(-1)?.type, 'finish');
    const wrong = provider === PLAN_PROVIDER ? PAID_PROVIDER : PLAN_PROVIDER;
    assert.throws(() => adapter.stream(options(wrong, id)), { code: 'INVALID_REQUEST' });
  }
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
  for (const id of ['deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.3-flash', 'gpt-6-luna']) {
    assert.deepEqual((await collect(adapter.stream({ ...options(PLAN_PROVIDER, id), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'stop' } });
  }
});
test('DSv4.1 leaked REA markers become EMPTY_RESPONSE only when its monitor and tools are enabled', async () => {
  let config = { ...base }, hits = 0;
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'fixture-key', onEmptyTurn: () => { hits++; }, fetch: async () => sse('<rea:tool_calls></rea:tool_calls>') });
  const tool = { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } };
  assert.deepEqual((await collect(adapter.stream({ ...options(), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'OpenDesign：模型回复只剩协议标记，未产生可用内容' } } });
  assert.equal(hits, 1);
  config = { ...base, emptyTurnGuard: false };
  assert.deepEqual((await collect(adapter.stream({ ...options(), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'stop' } });
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
test('credential routing receives the prepared gateway even after configuration changes', async () => {
  let config = { ...base, baseURL: 'https://custom.example/v1' };
  let sent = 0;
  const adapter = new CoRouterAdapter({ config: () => config,
    apiKey: async (ref, target) => {
      assert.equal(ref, base.apiKeyEnv);
      assert.equal(target, 'https://custom.example/v1');
      return target === base.baseURL ? 'device-runtime-fixture' : undefined;
    },
    fetch: async () => { sent++; return sse('must not send'); },
  });
  const call = await adapter.prepareCall(PLAN_PROVIDER, 'deepseek-v4.1-flash');
  config = { ...base };
  await assert.rejects(collect(call.stream(options())), { code: 'MISSING_CREDENTIAL' });
  assert.equal(sent, 0);
});

test('model switches hide routes and enforce rejection on direct calls', async () => {
  const configured: RuntimeConfig = { ...base, modelSettings: { 'deepseek-v4.1-flash': { enabled: false } } };
  const adapter = new CoRouterAdapter({ config: () => configured, apiKey: async () => 'test-key', fetch: async () => { assert.fail('disabled model must not fetch'); } });
  assert.equal((await adapter.listModels(PLAN_PROVIDER)).length, 12);
  assert.equal((await adapter.listModels(PAID_PROVIDER)).length, 26);
  assert.throws(() => adapter.stream(options()), { code: 'MODEL_DISABLED' });
  await assert.rejects(adapter.resolveModel(PLAN_PROVIDER, 'deepseek-v4.1-flash'), { code: 'MODEL_DISABLED' });
});

test('saved model parameters affect metadata and the actual request while per-call temperature wins', async () => {
  const configured: RuntimeConfig = { ...base, modelSettings: { 'deepseek-v4.1-flash': { temperature: 0.2, topP: 0.7, maxTokens: 512, contextWindow: 8192, reasoningEffort: 'low' } } };
  const wires: Record<string, unknown>[] = [];
  const adapter = new CoRouterAdapter({ config: () => configured, apiKey: async () => 'test-key', fetch: async (_input, init) => { wires.push(JSON.parse(String(init?.body))); return sse('ok'); } });
  const resolved = await adapter.resolveModel(PLAN_PROVIDER, 'deepseek-v4.1-flash');
  assert.equal(resolved.context?.contextWindow, 7680);
  assert.equal(resolved.defaultMaxTokens, 512);
  assert.equal(resolved.reasoning?.defaultEffort, 'low');
  await collect(adapter.stream(options()));
  assert.equal(wires[0]?.temperature, 0.2);
  assert.equal(wires[0]?.top_p, 0.7);
  assert.equal(wires[0]?.max_tokens, 512);
  assert.equal(wires[0]?.reasoning_effort, 'low');
  await collect(adapter.stream({ ...options(), temperature: 0.6 }));
  assert.equal(wires[1]?.temperature, 0.6);
});

test('an explicit output limit is not reduced to the automatic quarter-window default', async () => {
  const configured: RuntimeConfig = { ...base, modelSettings: { 'deepseek-v4.1-flash': { maxTokens: 4096, contextWindow: 8192 } } };
  const adapter = new CoRouterAdapter({ config: () => configured, apiKey: async () => 'test-key', fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 4096);
    return sse('ok');
  } });
  assert.equal((await adapter.resolveModel(PLAN_PROVIDER, 'deepseek-v4.1-flash')).defaultMaxTokens, 4096);
  await collect(adapter.stream(options()));
  configured.modelSettings = { 'deepseek-v4.1-flash': { maxTokens: 8192, contextWindow: 8192 } };
  assert.throws(() => adapter.stream(options()), { code: 'INVALID_REQUEST' });
});

test('all three selected protocols change the actual request path', async () => {
  for (const [apiProtocol, suffix] of [['chat-completions', '/chat/completions'], ['responses', '/responses'], ['messages', '/messages']] as const) {
    const adapter = new CoRouterAdapter({ config: () => ({ ...base, apiProtocol }), apiKey: async () => 'test-key', fetch: async (url, init) => {
      assert.equal(String(url), `${base.baseURL}${suffix}`);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
      return new Response('{}', { status: 401 });
    } });
    await assert.rejects(collect(adapter.stream(options())));
  }
});

test('unreadable images become named placeholders without failing the request or retrying the read', async () => {
  const image: ImageAttachmentRef = { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png', bytes: 10, width: 2, height: 2, name: 'missing-image.png' };
  let reads = 0, request = '';
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', imageDataUrl: async () => { reads++; throw new Error('PRIVATE_READ_FAILURE'); }, fetch: async (_url, init) => {
    request = String(init?.body);
    return sse('ok');
  } });
  const result = await collect(adapter.stream({ ...options(), messages: [{ role: 'user', content: [{ type: 'image', attachment: image }, { type: 'image', attachment: image }] }] }));
  assert.equal(reads, 1);
  assert.match(request, /missing-image/u);
  assert.equal(request.includes('PRIVATE_READ_FAILURE'), false);
  assert.equal(request.includes('image_url'), false);
  assert.equal(request.includes('model accepts text only'), false);
  assert.equal(result.at(-1)?.type, 'finish');
});

test('cancellation during image loading is never turned into a placeholder request', async () => {
  const controller = new AbortController();
  const image: ImageAttachmentRef = { attachmentId: AttachmentId('b'.repeat(64)), mediaType: 'image/png', bytes: 10, width: 2, height: 2, name: 'cancelled.png' };
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', imageDataUrl: async () => {
    controller.abort(new DOMException('cancelled', 'AbortError'));
    throw new Error('read cancelled');
  }, fetch: async () => { assert.fail('cancelled request must not be sent'); } });
  await assert.rejects(collect(adapter.stream({ ...options(), signal: controller.signal, messages: [{ role: 'user', content: [{ type: 'image', attachment: image }] }] })), { name: 'AbortError' });
});

test('retryable model failures are delegated to the host rather than repeated inside the adapter', async () => {
  let calls = 0;
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', fetch: async () => { calls++; return new Response('{}', { status: 503 }); } });
  await assert.rejects(collect(adapter.stream(options())), { code: 'SERVER' });
  assert.equal(calls, 1);
});

test('HTTP errors never echo credential or untrusted body; missing key does not fetch', async () => {
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'test-key', fetch: async () => Response.json({ error: { message: 'test-key PRIVATE_BODY', code: 'invalid_api_key' } }, { status: 401 }) });
  await assert.rejects(collect(adapter.stream(options())), (error: Error) => !error.message.includes('test-key') && !error.message.includes('PRIVATE_BODY'));
  const missing = new CoRouterAdapter({ config: () => base, apiKey: async () => undefined, fetch: async () => { assert.fail('must not fetch'); } });
  await assert.rejects(collect(missing.stream(options())), { code: 'MISSING_CREDENTIAL' });
});
