import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials';
import LlmRuntime, { BlockAssembler, LlmError, ToolCallId, createAssistantMessage, createToolResultMessage,
  type AssistantMessage, type GenerateOptions, type ReplayEnvelope, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ReplayKeyStore, REPLAY_BINDING_KEY } from '../src/replay-key.js';
import { CoRouterAdapter } from '../src/adapter.js';
import { PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { buildMessagesRequest } from '../src/protocols/messages.js';
import type { CatalogModel } from '../src/catalog.js';

const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class MemoryCredentials {
  value: CredentialRecord | undefined;
  writes = 0; reads = 0; modifications = 0;
  #tail: Promise<void> = Promise.resolve();
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    assert.equal(key, REPLAY_BINDING_KEY); this.reads++;
    return structuredClone(this.value);
  }
  modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    assert.equal(key, REPLAY_BINDING_KEY); this.modifications++;
    const operation = this.#tail.then(async () => {
      const next = await mutate(structuredClone(this.value));
      if (next !== undefined) { this.value = structuredClone(next); this.writes++; }
      return structuredClone(this.value);
    });
    this.#tail = operation.then(() => {}, () => {});
    return operation;
  }
}

test('binding records are lazy, atomic across Host instances and reusable after restart', async () => {
  const credentials = new MemoryCredentials();
  const stores = [new ReplayKeyStore(() => credentials), new ReplayKeyStore(() => credentials)];
  assert.equal(credentials.reads, 0); assert.equal(credentials.writes, 0);
  const values = await Promise.all(Array.from({ length: 24 }, (_, index) => stores[index % 2]!.get(signal())));
  assert.equal(credentials.writes, 1);
  assert.ok(values.every(value => Buffer.from(value).equals(Buffer.from(values[0]!))));
  assert.equal(values[0]!.length, 32);
  const original = Buffer.from(values[0]!); values[0]!.fill(0);
  const again = await stores[0]!.get(signal()); assert.deepEqual(Buffer.from(again), original);
  assert.equal(credentials.writes, 1);
  stores.forEach(store => store.dispose());
  await assert.rejects(stores[0]!.get(signal()), { code: 'ABORTED' });
  const restarted = new ReplayKeyStore(() => credentials);
  assert.deepEqual(Buffer.from(await restarted.get(signal())), original);
  const stored = credentials.value;
  assert.ok(stored?.kind === 'grant');
  assert.deepEqual(Object.keys(stored.payload as object).sort(), ['format', 'secret', 'version']);
  restarted.dispose(); values.forEach(value => value.fill(0)); again.fill(0); original.fill(0);
});

test('malformed existing binding records are never replaced; provider failures are fixed safe errors', async () => {
  for (const value of [
    { kind: 'api-key', key: 'unrelated-record-fixture' },
    { kind: 'grant', payload: { format: 'other', secret: 'private-provider-detail' } },
    { kind: 'grant', payload: { format: 'opendesign-claude-replay-key', version: 1, secret: 'short' } },
    { kind: 'grant', payload: { format: 'opendesign-claude-replay-key', version: 1, secret: Buffer.alloc(32, 3).toString('base64'), extra: true } },
  ] satisfies CredentialRecord[]) {
    const credentials = new MemoryCredentials(); credentials.value = value;
    const store = new ReplayKeyStore(() => credentials);
    await assert.rejects(store.get(signal()), error => error instanceof LlmError && error.code === 'INVALID_REQUEST'
      && !/unrelated-record|private-provider-detail|short/u.test(error.message));
    assert.deepEqual(credentials.value, value); assert.equal(credentials.writes, 0); assert.equal(credentials.modifications, 0);
    store.dispose();
  }
  for (const failure of ['read', 'write'] as const) {
    let writes = 0;
    const store = new ReplayKeyStore(() => ({
      readRecord: async () => { if (failure === 'read') throw new Error('sensitive-provider-error'); return undefined; },
      modifyRecord: async () => { writes++; throw new Error('sensitive-provider-error'); },
    }));
    await assert.rejects(store.get(signal()), error => error instanceof LlmError && error.code === 'INVALID_REQUEST'
      && !JSON.stringify(error).includes('sensitive-provider-error') && !error.message.includes('sensitive-provider-error'));
    assert.equal(writes, failure === 'read' ? 0 : 1); store.dispose();
  }
});

test('no credential service uses an isolated memory binding and never pretends to be durable', async () => {
  const first = new ReplayKeyStore(() => undefined); const second = new ReplayKeyStore(() => undefined);
  const a = await first.get(signal()); const a2 = await first.get(signal()); const b = await second.get(signal());
  assert.deepEqual(a, a2); assert.notDeepEqual(a, b);
  first.dispose(); second.dispose(); a.fill(0); a2.fill(0); b.fill(0);
});

test('cancelled reads and deferred mutations cannot initiate a late credential write', async () => {
  const read = deferred<CredentialRecord | undefined>(); let modifications = 0;
  const first = new ReplayKeyStore(() => ({ readRecord: () => read.promise,
    modifyRecord: async () => { modifications++; return undefined; } }));
  const controller = new AbortController(); const pending = first.get(controller.signal); controller.abort(new Error('private-cancel-reason'));
  await assert.rejects(pending, error => error instanceof LlmError && error.code === 'ABORTED' && !error.message.includes('private-cancel-reason'));
  read.resolve(undefined); await Promise.resolve(); assert.equal(modifications, 0); first.dispose();

  type Mutate = (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>;
  const mutation = deferred<Mutate>();
  const later = new ReplayKeyStore(() => ({ readRecord: async () => undefined,
    modifyRecord: async (_key, mutate) => { mutation.resolve(mutate); return new Promise(() => {}); } }));
  const operation = later.get(signal()); const mutate = await mutation.promise; later.dispose();
  await assert.rejects(operation, { code: 'ABORTED' });
  await assert.rejects(mutate(undefined), { code: 'ABORTED' });
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(later.get(alreadyAborted.signal), { code: 'ABORTED' });
});

test('cancellation after atomic commit leaves one reusable record but does not produce request output', async () => {
  const committed = deferred<void>(); const release = deferred<void>();
  let value: CredentialRecord | undefined;
  const provider = { readRecord: async () => value,
    modifyRecord: async (_key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      value = await mutate(value); committed.resolve(); await release.promise; return value;
    } };
  const first = new ReplayKeyStore(() => provider); const controller = new AbortController();
  const operation = first.get(controller.signal); await committed.promise; controller.abort();
  await assert.rejects(operation, { code: 'ABORTED' }); assert.ok(value);
  release.resolve(); const restarted = new ReplayKeyStore(() => provider);
  assert.equal((await restarted.get(signal())).length, 32); first.dispose(); restarted.dispose();
});

const row: CatalogModel = { id: 'claude-opus-4.8', name: 'Fixture', group: 'paid' };
const base: RuntimeConfig = { apiProtocol: 'messages', apiKeyEnv: 'OFFLINE_FIXTURE', baseURL: 'https://gateway.invalid/v1',
  useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 };
const request = (messages: GenerateOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]): GenerateOptions => ({ provider: PAID_PROVIDER, model: row.id, messages });
const events = [
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'private-signature-fixture' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'private-opaque-fixture' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-fixture', name: 'read', input: { path: 'a' } } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
];
const response = () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> { const values: StreamChunk[] = []; for await (const value of stream) values.push(value); return values; }
function save(chunks: readonly StreamChunk[]): AssistantMessage {
  const assembler = new BlockAssembler(); chunks.forEach(chunk => assembler.push(chunk));
  return createAssistantMessage({ content: assembler.blocks(), source: { provider: PAID_PROVIDER, model: row.id,
    ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }) } });
}
const binding = (saved: AssistantMessage) => ((saved.source.replayState as ReplayEnvelope).response as { credentialIdentity: string }).credentialIdentity;

test('persistent binding survives Host restart, isolates key/origin changes and never sends identity labels upstream', async () => {
  const credentials = new MemoryCredentials(); let key = 'inference-alpha-fixture'; let config = base;
  const sent: string[] = [];
  const make = () => {
    const store = new ReplayKeyStore(() => credentials);
    const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => key,
      replayBindingSecret: signal => store.get(signal), fetch: async (_url, init) => { sent.push(String(init?.body)); return response(); } });
    return { adapter, store };
  };
  const ctx = new Context(); const runtime = await ctx.plugin(LlmRuntime);
  let host = make(); let registration = ctx.llm.registerAdapter([PAID_PROVIDER], host.adapter);
  try {
    const saved = save(await collect(ctx.llm.stream(request()))); const alpha = binding(saved);
    assert.match(alpha, /^[a-f0-9]{64}$/u); assert.equal(credentials.writes, 1);
    const results = createToolResultMessage({ callId: ToolCallId('tool-fixture'), content: [{ type: 'text', text: 'result' }], isError: false });
    const history = JSON.parse(JSON.stringify([saved, results])) as GenerateOptions['messages'];
    for (const hidden of [key, alpha]) assert.equal(JSON.stringify(credentials.value).includes(hidden), false);
    key = 'inference-beta-fixture';
    const reject = await collect(ctx.llm.stream(request(history))); const terminal = reject.at(-1);
    assert.ok(terminal?.type === 'finish' && terminal.reason.kind === 'error' && terminal.reason.failure.code === 'INVALID_REQUEST');
    assert.equal(sent.length, 1);
    for (const hidden of [key, 'inference-alpha-fixture', alpha, 'private-signature-fixture', 'private-opaque-fixture']) assert.equal(JSON.stringify(reject).includes(hidden), false);
    const beta = save(await collect(ctx.llm.stream(request()))); assert.notEqual(binding(beta), alpha);
    key = '  inference-alpha-fixture  ';
    assert.equal(binding(save(await collect(ctx.llm.stream(request(history))))), alpha);
    config = { ...base, baseURL: 'https://other.invalid/v1' };
    const beforeOrigin = sent.length;
    const foreign = await collect(ctx.llm.stream(request(history)));
    assert.ok(foreign.at(-1)?.type === 'finish'); assert.equal(sent.length, beforeOrigin);
    config = { ...base, baseURL: 'https://GATEWAY.invalid:443/another-path' };
    assert.equal(binding(save(await collect(ctx.llm.stream(request(history))))), alpha);
    registration(); host.adapter.dispose(); host.store.dispose();
    host = make(); registration = ctx.llm.registerAdapter([PAID_PROVIDER], host.adapter);
    assert.equal(binding(save(await collect(ctx.llm.stream(request(history))))), alpha);
    assert.equal(credentials.writes, 1);
    for (const body of sent) { assert.equal(body.includes(alpha), false); assert.equal(body.includes('credentialIdentity'), false); }
  } finally { registration(); host.adapter.dispose(); host.store.dispose(); await runtime.dispose(); }
});

test('legacy/missing identities fail explicitly; absent service fails across new instances but ordinary calls remain possible', async () => {
  const make = () => new CoRouterAdapter({ config: () => base, models: () => [row], apiKey: async () => 'fixture-key', fetch: async () => response() });
  const first = make(); const second = make();
  try {
    const saved = save(await collect(first.stream(request())));
    await collect(first.stream(request([saved])));
    await assert.rejects(collect(second.stream(request([saved]))), { code: 'INVALID_REQUEST' });
    await collect(second.stream(request()));
    const envelope = saved.source.replayState as ReplayEnvelope;
    const { credentialIdentity: _old, ...legacy } = envelope.response as Record<string, unknown>;
    const old = createAssistantMessage({ content: saved.content, source: { provider: PAID_PROVIDER, model: row.id, replayState: { response: legacy, blocks: envelope.blocks } } });
    await assert.rejects(collect(first.stream(request([old]))), error => error instanceof LlmError && error.code === 'INVALID_REQUEST' && /新建会话|压缩/u.test(error.message));
    assert.throws(() => buildMessagesRequest({ baseURL: base.baseURL, apiKey: 'fixture', model: row, options: request([saved]), images: new Map() }), { code: 'INVALID_REQUEST' });
  } finally { first.dispose(); second.dispose(); }
});

test('binding reads are only requested for the eight documented Claude Messages models', async () => {
  let reads = 0;
  const other: CatalogModel = { id: 'other-vendor', name: 'Fixture', group: 'paid' };
  let config = base;
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [row, other], apiKey: async () => 'fixture',
    replayBindingSecret: async () => { reads++; return Buffer.alloc(32, 5); }, fetch: async () => response() });
  try {
    await collect(adapter.stream({ ...request(), model: other.id })); assert.equal(reads, 0);
    await collect(adapter.stream(request())); assert.equal(reads, 1);
    config = { ...base, apiProtocol: 'chat-completions' };
    await assert.rejects(collect(adapter.stream(request()))); assert.equal(reads, 1);
  } finally { adapter.dispose(); }
});

test('an uncooperative binding reader is cancelled, times out and clears late bytes before any fetch', async () => {
  for (const mode of ['cancel', 'dispose', 'timeout'] as const) {
    const started = deferred<void>(); const release = deferred<Uint8Array>(); const controller = new AbortController(); let calls = 0;
    const adapter = new CoRouterAdapter({ config: () => ({ ...base, requestTimeoutMs: mode === 'timeout' ? 5 : 1000 }), models: () => [row], apiKey: async () => 'fixture',
      replayBindingSecret: () => { started.resolve(); return release.promise; }, fetch: async () => { calls++; return response(); } });
    const pending = collect(adapter.stream({ ...request(), signal: controller.signal }));
    await started.promise;
    if (mode === 'cancel') controller.abort(new Error('private-abort-detail'));
    if (mode === 'dispose') adapter.dispose();
    await assert.rejects(pending, error => error instanceof LlmError && error.code === (mode === 'timeout' ? 'TIMEOUT' : 'ABORTED') && !error.message.includes('private-abort-detail'));
    const late = Buffer.alloc(32, 9); release.resolve(late); await Promise.resolve(); await Promise.resolve();
    assert.ok(late.every(value => value === 0)); assert.equal(calls, 0); adapter.dispose();
  }
});

test('Claude output limits reject overrides and saved defaults before credential or binding reads', async () => {
  let reads = 0; let binds = 0; let calls = 0;
  let config: RuntimeConfig = { ...base, modelSettings: { [row.id]: { maxTokens: 128001 } } };
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => { reads++; return 'fixture'; },
    replayBindingSecret: async () => { binds++; return Buffer.alloc(32, 8); }, fetch: async () => { calls++; return response(); } });
  const direct = (maxTokens?: number) => buildMessagesRequest({ baseURL: base.baseURL, apiKey: 'fixture', model: row,
    options: { ...request(), ...(maxTokens === undefined ? {} : { maxTokens }) }, images: new Map() });
  try {
    assert.throws(() => direct(128001), { code: 'UNSUPPORTED_OPTION' });
    await assert.rejects(collect(adapter.stream(request())), { code: 'UNSUPPORTED_OPTION' });
    config = base;
    await assert.rejects(collect(adapter.stream({ ...request(), maxTokens: 128001 })), { code: 'UNSUPPORTED_OPTION' });
    assert.equal(reads, 0); assert.equal(binds, 0); assert.equal(calls, 0);
    assert.doesNotThrow(() => direct(128000));
    await collect(adapter.stream({ ...request(), maxTokens: 128000 }));
    assert.equal(reads, 1); assert.equal(calls, 1);
    assert.equal((direct().body as { max_tokens: number }).max_tokens, 4096);
  } finally { adapter.dispose(); }
});

test('invalid historical Claude output defaults stay saved but do not contaminate Host metadata', async () => {
  const configured: CatalogModel = { ...row, contextWindow: 1_000_000, maxOutputTokens: 128000 };
  let config: RuntimeConfig = { ...base, modelSettings: { [row.id]: { maxTokens: 128001 } } };
  let reads = 0;
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [configured],
    apiKey: async () => { reads++; return 'fixture'; } });
  try {
    const invalid = await adapter.resolveModel(PAID_PROVIDER, row.id);
    assert.equal(invalid.defaultMaxTokens, undefined);
    assert.equal(invalid.context?.contextWindow, configured.contextWindow);
    assert.equal(config.modelSettings?.[row.id]?.maxTokens, 128001);
    await assert.rejects(collect(adapter.stream(request())), { code: 'UNSUPPORTED_OPTION' });
    assert.equal(reads, 0);
    config = { ...base, modelSettings: { [row.id]: { maxTokens: 128000 } } };
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, row.id)).defaultMaxTokens, 128000);
    config = { ...config, apiProtocol: 'chat-completions', modelSettings: { [row.id]: { maxTokens: 128001 } } };
    assert.equal((await adapter.resolveModel(PAID_PROVIDER, row.id)).defaultMaxTokens, 128001);
  } finally { adapter.dispose(); }
});
