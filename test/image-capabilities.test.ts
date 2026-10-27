import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { CoRouterAdapter } from '../src/adapter.js';
import { PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import type { CatalogModel } from '../src/catalog.js';

const image: ImageAttachmentRef = { attachmentId: AttachmentId('c'.repeat(64)), mediaType: 'image/png', bytes: 5, width: 2, height: 2, name: 'diagram.png' };
const encoded = 'aGVsbG8=';
const url = `data:image/png;base64,${encoded}`;
const row: CatalogModel = { id: 'fixture-model', name: 'Fixture', group: 'paid' };
const base: RuntimeConfig = { apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://example.com/v1', useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000 };
const message = (source: 'user' | 'tool') => source === 'user'
  ? { role: 'user' as const, content: [{ type: 'image' as const, attachment: image }] }
  : createMessage({ role: 'tool', source: { kind: 'tool', callId: ToolCallId('call-1') }, toolCallId: ToolCallId('call-1'), content: [{ type: 'image', attachment: image }] });
const request = (source: 'user' | 'tool' = 'user'): GenerateOptions => ({ provider: PAID_PROVIDER, model: row.id, messages: [message(source)] });
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }

test('unknown and enabled image inputs reach the wire in all three protocols', async () => {
  for (const apiProtocol of ['chat-completions', 'responses', 'messages'] as const) {
    for (const imageInput of [undefined, true, false] as const) {
      for (const source of ['user', 'tool'] as const) {
        let reads = 0, body = '';
        const config: RuntimeConfig = { ...base, apiProtocol, modelSettings: imageInput === undefined ? {} : { [row.id]: { imageInput } } };
        const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => 'fixture', imageDataUrl: async () => { reads++; return url; }, fetch: async (_u, init) => { body = String(init?.body); return new Response('{}', { status: 401 }); } });
        const options = request(source), original = structuredClone(options);
        await assert.rejects(collect(adapter.stream(options)));
        assert.deepEqual(options, original, `${apiProtocol}/${imageInput}/${source}: history remains unchanged`);
        assert.equal(reads, imageInput === false ? 0 : 1, `${apiProtocol}/${imageInput}/${source}: reads`);
        assert.equal(body.includes(encoded), imageInput !== false, `${apiProtocol}/${imageInput}/${source}: image bytes`);
        if (imageInput === false) assert.match(body, /model accepts text only/u);
      }
    }
  }
});

test('the same image is loaded once while both user and tool occurrences are preserved', async () => {
  for (const apiProtocol of ['chat-completions', 'responses', 'messages'] as const) {
    let reads = 0, body = '';
    const adapter = new CoRouterAdapter({ config: () => ({ ...base, apiProtocol }), models: () => [row], apiKey: async () => 'fixture', imageDataUrl: async () => { reads++; return url; }, fetch: async (_u, init) => { body = String(init?.body); return new Response('{}', { status: 401 }); } });
    await assert.rejects(collect(adapter.stream({ ...request(), messages: [message('user'), message('tool')] })));
    assert.equal(reads, 1, apiProtocol);
    assert.equal(body.split(encoded).length - 1, 2, apiProtocol);
  }
});

test('effective image overrides reach model listings, resolved metadata and prepared requests', async () => {
  let config: RuntimeConfig = { ...base }, reads = 0, body = '';
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => 'fixture', imageDataUrl: async () => { reads++; return url; }, fetch: async (_u, init) => { body = String(init?.body); return new Response('{}', { status: 401 }); } });
  assert.equal((await adapter.listModels(PAID_PROVIDER))[0]?.inputModalities, undefined);
  assert.equal((await adapter.resolveModel(PAID_PROVIDER, row.id)).inputModalities, undefined);
  config = { ...base, modelSettings: { [row.id]: { imageInput: true } } };
  assert.deepEqual((await adapter.listModels(PAID_PROVIDER))[0]?.inputModalities, ['text', 'image']);
  assert.deepEqual((await adapter.resolveModel(PAID_PROVIDER, row.id)).inputModalities, ['text', 'image']);
  const prepared = await adapter.prepareCall(PAID_PROVIDER, row.id);
  config = { ...base, modelSettings: { [row.id]: { imageInput: false } } };
  assert.deepEqual((await adapter.listModels(PAID_PROVIDER))[0]?.inputModalities, ['text']);
  assert.deepEqual((await adapter.resolveModel(PAID_PROVIDER, row.id)).inputModalities, ['text']);
  await assert.rejects(collect(prepared.stream(request())));
  assert.equal(reads, 1);
  assert.equal(body.includes(encoded), true, 'prepared call keeps its own settings snapshot');
  await assert.rejects(collect(adapter.stream(request())));
  assert.equal(reads, 1);
  assert.equal(body.includes(encoded), false);
  config = { ...base };
  assert.equal((await adapter.listModels(PAID_PROVIDER))[0]?.inputModalities, undefined);
});

test('offloaded images use the request-limit placeholder, not a false capability claim', async () => {
  for (const apiProtocol of ['chat-completions', 'responses', 'messages'] as const) {
    let body = '', reads = 0;
    const adapter = new CoRouterAdapter({ config: () => ({ ...base, apiProtocol }), models: () => [row], apiKey: async () => 'fixture', imageDataUrl: async () => { reads++; return url; }, fetch: async (_u, init) => { body = String(init?.body); return new Response('{}', { status: 401 }); } });
    await assert.rejects(collect(adapter.stream({ ...request(), messages: [{ role: 'user', content: [{ type: 'image', attachment: image, offloaded: true }] }] })));
    assert.equal(reads, 0);
    assert.match(body, /image omitted to fit request image limits/u);
    assert.doesNotMatch(body, /model accepts text only/u);
  }
});

test('missing image reader uses an unreadable placeholder, not a false text-only claim', async () => {
  let body = '';
  const adapter = new CoRouterAdapter({ config: () => base, models: () => [row], apiKey: async () => 'fixture', fetch: async (_u, init) => { body = String(init?.body); return new Response('{}', { status: 401 }); } });
  await assert.rejects(collect(adapter.stream(request())));
  assert.match(body, /diagram\.png/u);
  assert.match(body, /could not be read/u);
  assert.doesNotMatch(body, /model accepts text only/u);
});

test('real LlmRuntime preserves unknown images and projects explicitly text-only input', async () => {
  const ctx = new Context();
  const llm = await ctx.plugin(LlmRuntime);
  let config: RuntimeConfig = { ...base }, reads = 0, body = '';
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => 'fixture', imageDataUrl: async () => { reads++; return url; }, fetch: async (_u, init) => { body = String(init?.body); return new Response('{}', { status: 401 }); } });
  const registration = await ctx.plugin({ inject: ['llm'], apply(scope: Context) { scope.llm.registerAdapter([PAID_PROVIDER], adapter); } });
  try {
    await collect(ctx.llm.stream(request()));
    assert.equal(reads, 1);
    assert.equal(body.includes(encoded), true);
    config = { ...base, modelSettings: { [row.id]: { imageInput: false } } };
    await collect(ctx.llm.stream(request()));
    assert.equal(reads, 1);
    assert.equal(body.includes(encoded), false);
    assert.match(body, /model accepts text only/u);
  } finally { await registration.dispose(); await llm.dispose(); }
});
