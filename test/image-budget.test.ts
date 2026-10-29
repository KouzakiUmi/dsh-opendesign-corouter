import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, ToolCallId, createMessage, type GenerateOptions, type ImageBlock, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { CoRouterAdapter, type AdapterOptions } from '../src/adapter.js';
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import type { CatalogModel } from '../src/catalog.js';

const row: CatalogModel = { id: 'fixture-model', name: 'Fixture', group: 'paid' };
const base: RuntimeConfig = { apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://gateway.invalid/v1', useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000 };
const image = (digit: string, bytes = 1): ImageAttachmentRef => ({ attachmentId: AttachmentId(digit.repeat(64)), mediaType: 'image/png', bytes, width: 1, height: 1 });
const first = image('a'), second = image('b'), missing = image('c');
const dataUrl = 'data:image/png;base64,aGVsbG8=';
const urlBytes = Buffer.byteLength(dataUrl, 'utf8');
const imageBlock = (attachment = first, offloaded = false): ImageBlock => ({ type: 'image', attachment, ...(offloaded ? { offloaded: true } : {}) });
const user = (...content: ImageBlock[]): GenerateOptions['messages'][number] => ({ role: 'user', content });
const tool = (...content: ImageBlock[]): GenerateOptions['messages'][number] => createMessage({ role: 'tool', source: { kind: 'tool', callId: ToolCallId('fixture') }, toolCallId: ToolCallId('fixture'), content });
const request = (messages: GenerateOptions['messages'] = [user(imageBlock())]): GenerateOptions => ({ provider: PAID_PROVIDER, model: row.id, messages });
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }

function successfulResponse(protocol: RuntimeConfig['apiProtocol']): Response {
  const values = protocol === 'messages' ? [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ] : protocol === 'responses' ? [
    { type: 'response.completed', response: { output: [{ type: 'message', id: 'm', content: [{ type: 'output_text', text: 'ok' }] }] } },
  ] : [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }];
  return new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
}

function fixture(config: RuntimeConfig = base, overrides: Partial<AdapterOptions> = {}) {
  const bodies: string[] = [], reads: string[] = [];
  const adapter = new CoRouterAdapter({
    config: () => config, models: () => [row], apiKey: async () => 'synthetic-fixture',
    imageDataUrl: async ref => { reads.push(ref.attachmentId); return dataUrl; },
    fetch: async (_url, init) => { bodies.push(String(init?.body)); return successfulResponse(config.apiProtocol); },
    ...overrides,
  });
  return { adapter, bodies, reads };
}

/** Simulate only the Host's oldest retained user/tool occurrence selection. */
function markOffloaded(options: GenerateOptions, count: number): GenerateOptions {
  return { ...options, messages: options.messages.map(message => message.role !== 'user' && message.role !== 'tool' ? message : {
    ...message, content: message.content.map(block => {
      if (block.type !== 'image' || block.offloaded || count === 0) return block;
      count--;
      return { ...block, offloaded: true };
    }),
  }) };
}

async function offloadFailure(adapter: CoRouterAdapter, options: GenerateOptions): Promise<LlmError> {
  try { await collect(adapter.stream(options)); assert.fail('request must need image offload'); }
  catch (error) { assert.ok(error instanceof LlmError); assert.equal(error.code, IMAGE_OFFLOAD_REQUIRED_CODE); return error; }
}

test('the default is a 20 MiB inline-image budget', () => {
  assert.equal(DEFAULT_MAX_REQUEST_IMAGE_BYTES, 20 * 1024 * 1024);
});

test('all protocols count full data URL bytes per user/tool occurrence at the exact boundary', async () => {
  for (const apiProtocol of ['chat-completions', 'responses', 'messages'] as const) {
    for (const purpose of [undefined, 'compaction'] as const) {
      const options = { ...request([user(imageBlock()), tool(imageBlock())]), ...(purpose ? { purpose } : {}) };
      const original = structuredClone(options);
      const fit = fixture({ ...base, apiProtocol, maxRequestImageBytes: 2 * urlBytes });
      const over = fixture({ ...base, apiProtocol, maxRequestImageBytes: 2 * urlBytes - 1 });
      try {
        assert.equal((await collect(fit.adapter.stream(options))).at(-1)?.type, 'finish');
        assert.equal(fit.reads.length, 1, 'attachment reads are deduplicated, wire occurrences are not');
        assert.equal(fit.bodies[0]?.split('aGVsbG8=').length, 3);
        const failure = await offloadFailure(over.adapter, options);
        assert.equal(failure.failure.offloadImages, 1);
        assert.equal(over.bodies.length, 0);
        await collect(over.adapter.stream(markOffloaded(options, 1)));
        assert.equal(over.bodies.length, 1, 'the Host can mark the oldest occurrence then retry');
        assert.match(over.bodies[0] ?? '', /image omitted to fit request image limits/u);
        assert.deepEqual(options, original, 'the adapter never silently changes history');
      } finally { fit.adapter.dispose(); over.adapter.dispose(); }
    }
  }
});

test('Host LLM stream preserves offload facts for compaction requests and retries', async () => {
  for (const trigger of ['budget', 'http413'] as const) {
    const ctx = new Context();
    const runtime = await ctx.plugin(LlmRuntime);
    let posts = 0;
    const { adapter } = fixture({ ...base, apiProtocol: 'messages', maxRequestImageBytes: trigger === 'budget' ? urlBytes : 2 * urlBytes }, {
      fetch: async () => {
        posts++;
        return trigger === 'http413' && posts === 1 ? new Response('{}', { status: 413 }) : successfulResponse('messages');
      },
    });
    const registration = ctx.llm.registerAdapter([PAID_PROVIDER], adapter);
    const options: GenerateOptions = { ...request([user(imageBlock(), imageBlock(second))]), purpose: 'compaction' };
    try {
      const finish = (await collect(ctx.llm.stream(options))).at(-1);
      assert.equal(finish?.type, 'finish');
      if (finish?.type !== 'finish' || finish.reason.kind !== 'error') assert.fail('expected a Host-projected error');
      assert.equal(finish.reason.failure.code, IMAGE_OFFLOAD_REQUIRED_CODE);
      assert.equal(finish.reason.failure.offloadImages, trigger === 'budget' ? 1 : 2);
      if (trigger === 'http413') assert.equal(finish.reason.failure.status, 413);
      const retried = (await collect(ctx.llm.stream(markOffloaded(options, finish.reason.failure.offloadImages!)))).at(-1);
      assert.equal(retried?.type === 'finish' && retried.reason.kind, 'stop');
      assert.equal(posts, trigger === 'budget' ? 1 : 2);
    } finally { registration(); adapter.dispose(); await runtime.dispose(); }
  }
});

test('actual data URLs, not attachment metadata sizes, determine the budget', async () => {
  const { adapter, bodies } = fixture({ ...base, maxRequestImageBytes: urlBytes - 1 });
  try {
    assert.equal((await offloadFailure(adapter, request([user(imageBlock(image('d', 0)))]))).failure.offloadImages, 1);
    assert.equal(bodies.length, 0);
  } finally { adapter.dispose(); }
});

test('unreadable and zero-byte predecessors keep the Host occurrence order; old offloads do not count', async () => {
  const { adapter, bodies, reads } = fixture({ ...base, maxRequestImageBytes: urlBytes - 1 }, {
    imageDataUrl: async ref => { reads.push(ref.attachmentId); if (ref.attachmentId === missing.attachmentId) return undefined; return dataUrl; },
  });
  const options = request([user(imageBlock(first, true), imageBlock(missing)), tool(imageBlock(second))]);
  try {
    const failure = await offloadFailure(adapter, options);
    assert.equal(failure.failure.offloadImages, 2, 'the unreadable predecessor must also be marked before the sent image');
    assert.deepEqual(reads, [missing.attachmentId, second.attachmentId]);
    await collect(adapter.stream(markOffloaded(options, 2)));
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.includes('aGVsbG8='), false);
  } finally { adapter.dispose(); }
});

test('unreadable-only, assistant and text-only images never request offload', async () => {
  for (const kind of ['unreadable', 'assistant', 'text-only'] as const) {
    const { adapter, bodies, reads } = fixture({ ...base, maxRequestImageBytes: 1, ...(kind === 'text-only' ? { modelSettings: { [row.id]: { imageInput: false } } } : {}) }, {
      ...(kind === 'unreadable' ? { imageDataUrl: async () => undefined } : {}),
    });
    const options = kind === 'assistant' ? request([createMessage({ role: 'assistant', source: { kind: 'model', provider: PAID_PROVIDER, model: row.id }, content: [imageBlock()] })]) : request();
    try { await collect(adapter.stream(options)); assert.equal(bodies.length, 1); assert.equal(reads.length, 0); }
    finally { adapter.dispose(); }
  }
});

test('a failed image read keeps its zero-byte position before the first oversized image', async () => {
  const { adapter, bodies } = fixture({ ...base, maxRequestImageBytes: urlBytes - 1 }, {
    imageDataUrl: async ref => { if (ref.attachmentId === missing.attachmentId) throw new Error('PRIVATE_READ_FAILURE'); return dataUrl; },
  });
  try {
    const failure = await offloadFailure(adapter, request([tool(imageBlock(missing)), user(imageBlock())]));
    assert.equal(failure.failure.offloadImages, 2);
    assert.equal(failure.message.includes('PRIVATE_READ_FAILURE'), false);
    assert.equal(bodies.length, 0);
  } finally { adapter.dispose(); }
});

test('a prepared call retains its image budget snapshot', async () => {
  let config: RuntimeConfig = { ...base, maxRequestImageBytes: urlBytes };
  const { adapter, bodies } = fixture(config, { config: () => config });
  try {
    const prepared = await adapter.prepareCall(PAID_PROVIDER, row.id);
    config = { ...base, maxRequestImageBytes: urlBytes - 1 };
    await collect(prepared.stream(request()));
    await offloadFailure(adapter, request());
    assert.equal(bodies.length, 1);
  } finally { adapter.dispose(); }
});

test('cancellation while reading images prevents both offload and network dispatch', async () => {
  const controller = new AbortController();
  const { adapter, bodies } = fixture({ ...base, maxRequestImageBytes: 1 }, { imageDataUrl: async () => { controller.abort(); return dataUrl; } });
  try {
    await assert.rejects(collect(adapter.stream({ ...request(), signal: controller.signal })), error => error instanceof Error && error.name === 'AbortError');
    assert.equal(bodies.length, 0);
  } finally { adapter.dispose(); }
});

test('413 recovery removes at least 4 MiB per committed Host selection and terminates without images', async () => {
  const quantum = 4 * 1024 * 1024;
  const largeUrl = 'data:image/png;base64,' + 'A'.repeat(quantum - 'data:image/png;base64,'.length);
  let posts = 0;
  const { adapter } = fixture({ ...base, apiProtocol: 'messages' }, {
    imageDataUrl: async () => largeUrl,
    fetch: async () => { posts++; return new Response('not json', { status: 413 }); },
  });
  let options: GenerateOptions = { ...request([user(...Array.from({ length: 5 }, () => imageBlock()))]), purpose: 'compaction' };
  try {
    for (let remaining = 5; remaining > 0; remaining--) {
      const failure = await offloadFailure(adapter, options);
      assert.equal(failure.failure.status, 413);
      assert.equal(failure.failure.offloadImages, 1);
      options = markOffloaded(options, failure.failure.offloadImages!);
    }
    await assert.rejects(collect(adapter.stream(options)), { code: 'REQUEST_TOO_LARGE' });
    assert.equal(posts, 6, 'five decreasing-image attempts, then one terminal no-image rejection');
  } finally { adapter.dispose(); }
});

test('413 offload includes unreadable predecessors and all remaining images below 4 MiB', async () => {
  const { adapter } = fixture({ ...base, apiProtocol: 'messages' }, {
    imageDataUrl: async ref => ref.attachmentId === missing.attachmentId ? undefined : dataUrl,
    fetch: async () => new Response('{}', { status: 413 }),
  });
  try {
    const failure = await offloadFailure(adapter, { ...request([user(imageBlock(missing), imageBlock()), tool(imageBlock())]), purpose: 'compaction' });
    assert.equal(failure.failure.offloadImages, 3);
    assert.equal(failure.failure.status, 413);
    await assert.rejects(collect(adapter.stream(markOffloaded(request([user(imageBlock())]), 1))), { code: 'REQUEST_TOO_LARGE' });
  } finally { adapter.dispose(); }
});

test('413 recovery selects enough mixed-size oldest occurrences rather than a single small image', async () => {
  const sizes = new Map([[first.attachmentId, 2 * 1024 * 1024], [second.attachmentId, 3 * 1024 * 1024]]);
  const { adapter } = fixture(base, {
    imageDataUrl: async ref => 'data:image/png;base64,' + 'A'.repeat(sizes.get(ref.attachmentId)! - 'data:image/png;base64,'.length),
    fetch: async () => new Response('{}', { status: 413 }),
  });
  try {
    const failure = await offloadFailure(adapter, request([user(imageBlock()), tool(imageBlock(second), imageBlock())]));
    assert.equal(failure.failure.offloadImages, 2, '2 MiB + 3 MiB is the shortest prefix removing at least 4 MiB');
  } finally { adapter.dispose(); }
});

test('one large image offloads once, then a still-oversized text request terminates', async () => {
  let posts = 0;
  const { adapter } = fixture(base, {
    imageDataUrl: async () => 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024),
    fetch: async () => { posts++; return new Response('{}', { status: 413 }); },
  });
  try {
    const failure = await offloadFailure(adapter, request());
    assert.equal(failure.failure.offloadImages, 1);
    await assert.rejects(collect(adapter.stream(markOffloaded(request(), 1))), { code: 'REQUEST_TOO_LARGE' });
    assert.equal(posts, 2);
  } finally { adapter.dispose(); }
});

test('413 without sent images never requests offload; more specific errors keep their classification', async () => {
  for (const kind of ['text', 'unreadable', 'text-only', 'context', 'credential', 'quota', 'server'] as const) {
    const code = ({ context: 'context_length_exceeded', credential: 'invalid_api_key', quota: 'insufficient_quota', server: 'server_error' } as const)[kind as 'context' | 'credential' | 'quota' | 'server'];
    const expected = ({ context: 'CONTEXT_WINDOW_EXCEEDED', credential: 'INVALID_CREDENTIAL', quota: 'ACCOUNT_QUOTA', server: 'SERVER' } as const)[kind as 'context' | 'credential' | 'quota' | 'server'] ?? 'REQUEST_TOO_LARGE';
    const { adapter } = fixture({ ...base, ...(kind === 'text-only' ? { modelSettings: { [row.id]: { imageInput: false } } } : {}) }, {
      ...(kind === 'unreadable' ? { imageDataUrl: async () => undefined } : {}),
      fetch: async () => Response.json({ error: { code, message: 'PRIVATE_SERVER_BODY' } }, { status: 413 }),
    });
    try {
      await assert.rejects(collect(adapter.stream(kind === 'text' ? request([user()]) : request())), error => {
        assert.ok(error instanceof LlmError); assert.equal(error.code, expected); assert.equal(error.failure.status, 413); assert.equal(error.message.includes('PRIVATE_SERVER_BODY'), false); return true;
      });
    } finally { adapter.dispose(); }
  }
});

test('without a Host executor, offload is one failure rather than a local retry loop', async () => {
  let posts = 0;
  const { adapter } = fixture(base, { fetch: async () => { posts++; return new Response('{}', { status: 413 }); } });
  const options = request(), original = structuredClone(options);
  try { await offloadFailure(adapter, options); assert.equal(posts, 1); assert.deepEqual(options, original); }
  finally { adapter.dispose(); }
});

test('cancellation while reading a 413 response stays authoritative over offload', async () => {
  const controller = new AbortController();
  const { adapter } = fixture(base, { fetch: async () => { controller.abort(); return new Response('{}', { status: 413 }); } });
  try { await assert.rejects(collect(adapter.stream({ ...request(), signal: controller.signal })), error => error instanceof Error && error.name === 'AbortError'); }
  finally { adapter.dispose(); }
});
