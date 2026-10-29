import test from 'node:test';
import assert from 'node:assert/strict';
import { CoRouterAdapter } from '../src/adapter.js';
import { PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { EMPTY_TURN_MESSAGE } from '../src/empty-turn.js';
import { OPENDESIGN_EOT } from '../src/eot-code.js';
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
  assert.deepEqual(result.at(-1), { type: 'finish', reason: { kind: 'error', failure: { code: OPENDESIGN_EOT, message: EMPTY_TURN_MESSAGE } } });
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
test('DSv4.1 leaked REA markers become EOT failures only when its monitor and tools are enabled', async () => {
  let config = { ...base }, hits = 0;
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'fixture-key', onEmptyTurn: () => { hits++; }, fetch: async () => sse('<rea:tool_calls></rea:tool_calls>') });
  const tool = { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } };
  assert.deepEqual((await collect(adapter.stream({ ...options(), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'error', failure: { code: OPENDESIGN_EOT, message: EMPTY_TURN_MESSAGE } } });
  assert.equal(hits, 1);
  config = { ...base, emptyTurnGuard: false };
  assert.deepEqual((await collect(adapter.stream({ ...options(), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(hits, 1);
});

test('pending and completed prose remain successful responses for the Agent checkpoint across protocols', async () => {
  const tool = { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } };
  const frames = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  for (const [text] of [
    ['让我核对项目配置的完整情况。', true],
    ['端到端验证已通过。提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。', true],
    ['**端到端验证已通过。**\n提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。', true],
    ['端到端验证已通过。提交前再确认了一遍：没有二进制文件被误纳入提交，也没有真实凭据。', false],
    ['提交前请再确认一遍：没有真实凭据。', false],
  ] as const) for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
    const events = protocol === 'chat-completions' ? [
      { choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ] : protocol === 'responses' ? [
      { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ] : [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ];
    let hits = 0;
    const adapter = new CoRouterAdapter({ config: () => ({ ...base, apiProtocol: protocol }), apiKey: async () => 'fixture-key', onEmptyTurn: () => { hits++; }, fetch: async () => frames(events) });
    const result = await collect(adapter.stream({ ...options(), tools: [tool] }));
    assert.deepEqual(result.at(-1), { type: 'finish', reason: { kind: 'stop' } }, `${protocol}: ${text}`);
    assert.equal(hits, 0);
    assert.deepEqual((await collect(adapter.stream(options()))).at(-1), { type: 'finish', reason: { kind: 'stop' } }, 'no tools');
    assert.equal(hits, 0, 'prose never increments the protocol-failure counter');
    adapter.dispose();
  }
});

test('a pre-delivery response is preserved and never retried inside the adapter', async () => {
  const text = '端到端验证已通过。提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。';
  let hits = 0, calls = 0;
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'fixture-key', onEmptyTurn: () => { hits++; }, fetch: async () => {
    calls++;
    return sse(text);
  } });
  const request = { ...options(), tools: [{ name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } }] };
  try {
    const result = await collect(adapter.stream(request));
    assert.deepEqual(result.at(-1), { type: 'finish', reason: { kind: 'stop' } });
    assert.ok(result.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text === text));
    assert.equal(calls, 1);
    assert.equal(hits, 0);
  } finally { adapter.dispose(); }
});

test('premature stream termination is retryable only for the monitored call before any tool block', async () => {
  const tool = { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } };
  const frames = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
    const events = protocol === 'chat-completions' ? [{ choices: [{ delta: { content: '部分内容' } }] }]
      : protocol === 'responses' ? [{ type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: '部分内容' }]
      : [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '部分内容' } }];
    let enabled = true;
    const adapter = new CoRouterAdapter({ config: () => ({ ...base, apiProtocol: protocol, emptyTurnGuard: enabled }), apiKey: async () => 'fixture-key', fetch: async () => frames(events) });
    await assert.rejects(collect(adapter.stream({ ...options(), tools: [tool] })), { code: 'TRANSPORT' }, protocol);
    enabled = false;
    await assert.rejects(collect(adapter.stream({ ...options(), tools: [tool] })), { code: 'INVALID_RESPONSE' }, `${protocol}: disabled`);
    enabled = true;
    await assert.rejects(collect(adapter.stream(options())), { code: 'INVALID_RESPONSE' }, `${protocol}: no tools`);
    await assert.rejects(collect(adapter.stream({ ...options(PLAN_PROVIDER, 'deepseek-v4-flash'), tools: [tool] })), { code: 'INVALID_RESPONSE' }, `${protocol}: another model`);
  }
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'fixture-key', fetch: async () => frames([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fixture_tool', arguments: '{' } }] } }] },
  ]) });
  await assert.rejects(collect(adapter.stream({ ...options(), tools: [tool] })), { code: 'INVALID_RESPONSE' }, 'a started tool block is never automatically replayed');
});

test('leaked tool markup is rejected, but a real tool call is never replaced', async () => {
  const tool = { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } };
  let hits = 0;
  let response = sse('<rea:tool_calls><rea:tool name="fixture_tool"><rea:parameter name="path">fixture.txt</rea:parameter></rea:tool></rea:tool_calls>');
  const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'fixture-key', onEmptyTurn: () => { hits++; }, fetch: async () => response });
  assert.deepEqual((await collect(adapter.stream({ ...options(), tools: [tool] }))).at(-1), { type: 'finish', reason: { kind: 'error', failure: { code: OPENDESIGN_EOT, message: EMPTY_TURN_MESSAGE } } });
  response = new Response([
    { choices: [{ delta: { content: '先检查配置。' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fixture_tool', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const result = await collect(adapter.stream({ ...options(), tools: [tool] }));
  assert.deepEqual(result.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(hits, 1);
});

test('zero-content responses get EOT recovery only for the monitored tool call', async () => {
  const tool = { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } };
  const emptyFrame = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  for (const fetch of [async () => new Response(null), async () => emptyFrame()]) {
    let hits = 0;
    const adapter = new CoRouterAdapter({ config: () => base, apiKey: async () => 'fixture-key', fetch, onEmptyTurn: () => { hits++; } });
    await assert.rejects(collect(adapter.stream({ ...options(), tools: [tool] })), { code: OPENDESIGN_EOT });
    await assert.rejects(collect(adapter.stream(options())), { code: 'EMPTY_RESPONSE' });
    await assert.rejects(collect(adapter.stream({ ...options(PLAN_PROVIDER, 'deepseek-v4-flash'), tools: [tool] })), { code: 'EMPTY_RESPONSE' });
    assert.equal(hits, 1, 'the monitored failure is counted exactly once');
  }
});

test('prepareCall binds metadata and dispatch to a single settings generation', async () => {
  let config = { ...base };
  const called: string[] = [];
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => 'test-key', fetch: async input => { called.push(String(input)); return sse('ok'); } });
  const call = await adapter.prepareCall(PLAN_PROVIDER, 'deepseek-v4.1-flash');
  config = { ...config, baseURL: 'https://example.com/new' };
  await collect(call.stream(options()));
  assert.equal(called[0], `${base.baseURL}/chat/completions`);
  assert.equal(call.model.context?.contextWindow, 1_000_000);
  assert.equal(call.model.defaultMaxTokens, 250_000);
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
  assert.equal(resolved.context?.contextWindow, 8192);
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

test('Opus context reports the full reference window, honours overrides, and keeps the Messages output default', async () => {
  let configured: RuntimeConfig = { ...base, apiProtocol: 'messages' };
  const adapter = new CoRouterAdapter({ config: () => configured, apiKey: async () => 'test-key' });
  const initial = await adapter.prepareCall(PAID_PROVIDER, 'claude-opus-5.5');
  assert.deepEqual(initial.model.context, { contextWindow: 1_000_000 });
  assert.equal(initial.model.defaultMaxTokens, 4096);
  configured = { ...configured, modelSettings: { 'claude-opus-5.5': { contextWindow: 200_000, maxTokens: 8_192 } } };
  const overridden = await adapter.resolveModel(PAID_PROVIDER, 'claude-opus-5.5');
  assert.deepEqual(overridden.context, { contextWindow: 200_000 });
  assert.equal(overridden.defaultMaxTokens, 8_192);
  assert.deepEqual(initial.model.context, { contextWindow: 1_000_000 }, 'prepared calls keep their captured metadata');
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
