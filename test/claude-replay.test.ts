import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, {
  AssistantStreamAccumulator, BlockAssembler, LlmAdapter, LlmError, ToolCallId,
  assembleAssistantStream, createAssistantMessage, createToolResultMessage, expandAssistantStream,
  type AssistantMessage, type ContentBlock, type GenerateOptions, type ReplayEnvelope, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { CoRouterAdapter } from '../src/adapter.js';
import type { CatalogModel } from '../src/catalog.js';
import { PAID_PROVIDER, PLAN_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { buildMessagesRequest, streamMessages } from '../src/protocols/messages.js';
import type { ProtocolContext, ProtocolStreamContext } from '../src/protocols/types.js';

const row: CatalogModel = { id: 'claude-opus-4.8', name: 'Fixture', group: 'paid' };
const identity: ProtocolStreamContext = { provider: PAID_PROVIDER, model: row.id, baseURL: 'https://gateway.invalid/v1', credentialIdentity: 'a'.repeat(64) };
const config: RuntimeConfig = { ...identity, apiProtocol: 'messages', apiKeyEnv: 'OFFLINE', useDesktopCredential: false,
  emptyTurnGuard: false, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000 };
const request = (messages: GenerateOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]): GenerateOptions =>
  ({ provider: identity.provider, model: identity.model, messages });
const context = (options: GenerateOptions): ProtocolContext => ({ baseURL: identity.baseURL, apiKey: 'fixture-key', model: row, options, images: new Map(), credentialIdentity: identity.credentialIdentity! });
const start = (index: number, content_block: Record<string, unknown>) => ({ type: 'content_block_start', index, content_block });
const delta = (index: number, value: Record<string, unknown>) => ({ type: 'content_block_delta', index, delta: value });
const stop = (index: number) => ({ type: 'content_block_stop', index });
const finish = (stop_reason = 'tool_use') => [{ type: 'message_delta', delta: { stop_reason } }, { type: 'message_stop' }];
function body(events: readonly unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  } });
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
function assemble(chunks: readonly StreamChunk[]): BlockAssembler {
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  return assembler;
}
function message(assembler: BlockAssembler): AssistantMessage {
  return createAssistantMessage({ content: assembler.blocks(), source: { provider: identity.provider, model: identity.model,
    ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }) } });
}
function wire(options: GenerateOptions, baseURL = identity.baseURL): { role: string; content: Record<string, unknown>[] }[] {
  const result = buildMessagesRequest({ ...context(options), baseURL }).body as { messages: { role: string; content: Record<string, unknown>[] }[] };
  return result.messages;
}
const native = [
  { type: 'thinking', thinking: '先想\n再想', signature: 'sig-one-two' },
  { type: 'text', text: '先说明' },
  { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'a', exact: 'α\nβ' } },
  { type: 'thinking', thinking: '', signature: 'empty-signature' },
  { type: 'redacted_thinking', data: 'opaque-encrypted-fixture' },
  { type: 'text', text: '后说明' },
  { type: 'tool_use', id: 'tool-2', name: 'list', input: { path: 'b' } },
];
const events = [
  { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 1 } } },
  start(0, { type: 'thinking', thinking: '先想\n', signature: 'sig-' }),
  delta(0, { type: 'thinking_delta', thinking: '再想' }),
  delta(0, { type: 'signature_delta', signature: 'one-' }), delta(0, { type: 'signature_delta', signature: 'two' }), stop(0),
  start(1, native[1]!), stop(1),
  start(2, { type: 'tool_use', id: 'tool-1', name: 'read', input: {} }),
  delta(2, { type: 'input_json_delta', partial_json: '{"path":"a",' }),
  delta(2, { type: 'input_json_delta', partial_json: '"exact":"α\\nβ"}' }), stop(2),
  start(3, { type: 'thinking', thinking: '' }), delta(3, { type: 'signature_delta', signature: 'empty-signature' }), stop(3),
  start(4, native[4]!), stop(4), start(5, native[5]!), stop(5), start(6, native[6]!), stop(6), ...finish(),
];
const parse = (input: readonly unknown[] = events) => collect(streamMessages(body(input), new AbortController().signal, 1000, identity));

test('real runtime and assembler preserve signed, empty and redacted thinking through parallel tool continuation', async () => {
  const ctx = new Context(); const runtime = await ctx.plugin(LlmRuntime);
  const captured: unknown[] = [];
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => 'fixture-key', fetch: async (_url, init) => {
    captured.push(JSON.parse(String(init?.body)));
    return new Response(body(captured.length === 1 ? events : [start(0, { type: 'text', text: 'done' }), stop(0), ...finish('end_turn')]));
  } });
  const registration = ctx.llm.registerAdapter([PAID_PROVIDER], adapter);
  try {
    const chunks = await collect(ctx.llm.stream(request()));
    const assembler = assemble(chunks);
    assert.deepEqual(assembler.blocks().map(block => block.type), ['reasoning', 'text', 'tool-call', 'reasoning', 'reasoning', 'text', 'tool-call']);
    assert.deepEqual(assembler.blocks().filter(block => block.type === 'reasoning').map(block => block.text), ['先想\n再想', '', '']);
    assert.doesNotMatch(JSON.stringify(assembler.blocks()), /signature|opaque-encrypted/u);
    assert.equal(assembler.replayState?.blocks?.length, 7);
    const saved = message(assembler);
    const results = ['tool-1', 'tool-2'].map(call => createToolResultMessage({ callId: ToolCallId(call), content: [{ type: 'text', text: 'result' }], isError: false }));
    const next = await collect(ctx.llm.stream(request([saved, ...results])));
    assert.equal(next.at(-1)?.type, 'finish');
    const second = captured[1] as { messages: { role: string; content: unknown[] }[] };
    assert.deepEqual(second.messages[0], { role: 'assistant', content: native });
    assert.equal(second.messages[1]?.role, 'user');
    assert.deepEqual(second.messages[1]?.content.map(value => (value as { tool_use_id: string }).tool_use_id), ['tool-1', 'tool-2']);
  } finally { registration(); adapter.dispose(); await runtime.dispose(); }
});

test('cancellation between terminal usage and finish never commits replay metadata', async () => {
  const controller = new AbortController();
  const chunks: StreamChunk[] = [];
  await assert.rejects(async () => {
    for await (const chunk of streamMessages(body(events), controller.signal, 1000, identity)) {
      chunks.push(chunk);
      if (chunk.type === 'usage') controller.abort();
    }
  }, { name: 'AbortError' });
  assert.equal(chunks.some(chunk => chunk.type === 'finish'), false);

  const ctx = new Context(); const runtime = await ctx.plugin(LlmRuntime);
  const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => 'fixture-key', fetch: async () => new Response(body(events)) });
  const registration = ctx.llm.registerAdapter([PAID_PROVIDER], adapter);
  const signal = new AbortController(), hostChunks: StreamChunk[] = [];
  try {
    for await (const chunk of ctx.llm.stream({ ...request(), signal: signal.signal })) {
      hostChunks.push(chunk);
      if (chunk.type === 'usage') signal.abort();
    }
    const terminal = hostChunks.find(chunk => chunk.type === 'finish');
    assert.ok(terminal?.type === 'finish');
    assert.equal(terminal.reason.kind, 'aborted');
    assert.equal(terminal.replayState, undefined);
  } finally { registration(); adapter.dispose(); await runtime.dispose(); }
});

test('compact stream JSON reload and frozen message source retain exact replay alignment', async () => {
  const chunks = await parse(); const accumulator = new AssistantStreamAccumulator();
  chunks.forEach((chunk, time) => accumulator.push({ chunk, time }));
  const compact = JSON.parse(JSON.stringify(accumulator.snapshot()));
  assert.deepEqual(expandAssistantStream(compact).map(value => value.chunk), chunks);
  const restored = assembleAssistantStream(compact);
  assert.deepEqual(restored.blocks(), assemble(chunks).blocks());
  assert.deepEqual(restored.replayState, assemble(chunks).replayState);
  assert.deepEqual(wire(request([message(restored)]))[0]?.content, native);
  assert.equal(restored.message({ provider: identity.provider, model: identity.model }).source.replayState, undefined);
});

test('max-token assembler prunes incomplete tool and its entry without resurrecting it', async () => {
  const chunks = await parse([start(0, { type: 'thinking', thinking: 'kept', signature: 'signed' }), stop(0),
    start(1, { type: 'tool_use', id: 'truncated', name: 'read', input: {} }),
    delta(1, { type: 'input_json_delta', partial_json: '{"path":' }), ...finish('max_tokens')]);
  const assembler = assemble(chunks);
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: 'kept' }]);
  assert.equal(assembler.replayState?.blocks?.length, 1);
  assert.deepEqual(wire(request([message(assembler)]))[0]?.content, [{ type: 'thinking', thinking: 'kept', signature: 'signed' }]);
  const unsigned = assemble(await parse([start(0, { type: 'thinking', thinking: 'partial' }), ...finish('max_tokens')]));
  assert.deepEqual(wire(request([message(unsigned)])), []);
});

test('foreign provider/model/origin, wrong protocol/version and malformed envelopes never replay private blocks', async () => {
  const saved = message(assemble(await parse()));
  const original = saved.source.replayState as ReplayEnvelope;
  const response = original.response as Record<string, unknown>;
  const variants: AssistantMessage[] = [
    createAssistantMessage({ content: saved.content, source: { provider: PLAN_PROVIDER, model: saved.source.model, replayState: saved.source.replayState } }),
    createAssistantMessage({ content: saved.content, source: { provider: saved.source.provider, model: 'claude-other', replayState: saved.source.replayState } }),
    ...[{ protocol: 'responses' }, { version: 2 }, { provider: PLAN_PROVIDER }, { model: 'other' }].map(change =>
      createAssistantMessage({ content: saved.content, source: { provider: identity.provider, model: identity.model,
        replayState: { ...original, response: { ...response, ...change } } } })),
    ...[null, {}, { response }, { ...original, blocks: [] }].map(replayState =>
      createAssistantMessage({ content: saved.content, source: { provider: identity.provider, model: identity.model, replayState } })),
  ];
  for (const value of variants) assert.doesNotMatch(JSON.stringify(wire(request([value]))), /signature|redacted_thinking|opaque-encrypted/u);
  assert.throws(() => wire(request([saved]), 'https://other.invalid/v1'), { code: 'INVALID_REQUEST' });
  // Origin, not an arbitrary gateway path spelling, is the identity boundary.
  assert.deepEqual(wire(request([saved]), 'https://gateway.invalid/another-path')[0]?.content, native);
});

test('content edits, reordering and unaligned compaction invalidate the whole envelope; aligned pruning stays local', async () => {
  const saved = message(assemble(await parse()));
  const changes: ContentBlock[][] = [
    saved.content.slice(1), [...saved.content].reverse(),
    saved.content.map(block => block.type === 'text' ? { ...block, text: 'edited' } : block),
    saved.content.map(block => block.type === 'reasoning' && block.text !== '' ? { ...block, text: 'edited' } : block),
    saved.content.map(block => block.type === 'tool-call' ? { ...block, arguments: '{"path":"edited"}' } : block),
    saved.content.map(block => block.type === 'tool-call' ? { ...block, id: ToolCallId('different') } : block),
    saved.content.map(block => block.type === 'tool-call' ? { ...block, name: 'different' } : block),
  ];
  for (const content of changes) {
    const changed = createAssistantMessage({ content, source: { provider: saved.source.provider, model: saved.source.model, replayState: saved.source.replayState } });
    assert.doesNotMatch(JSON.stringify(wire(request([changed]))), /signature|redacted_thinking/u);
  }
  const envelope = saved.source.replayState as ReplayEnvelope;
  const kept = [1, 4, 5];
  const compacted = createAssistantMessage({ content: saved.content.filter((_, index) => kept.includes(index)),
    source: { provider: identity.provider, model: identity.model, replayState: { response: envelope.response,
      blocks: envelope.blocks!.filter((_, index) => kept.includes(index)) } } });
  assert.deepEqual(wire(request([compacted]))[0]?.content, kept.map(index => native[index]));
});

test('unsigned history and malformed private fields are not forged or projected into readable text', async () => {
  const saved = message(assemble(await parse())); const envelope = saved.source.replayState as ReplayEnvelope;
  for (const broken of [{ type: 'thinking', thinking: '先想\n再想', signature: '' }, { type: 'thinking', thinking: 'wrong', signature: 'sig' },
    { type: 'redacted_thinking', data: 12 }, null]) {
    const entries = [...envelope.blocks!]; entries[0] = broken;
    const changed = createAssistantMessage({ content: saved.content, source: { provider: identity.provider, model: identity.model,
      replayState: { response: envelope.response, blocks: entries } } });
    assert.doesNotMatch(JSON.stringify(wire(request([changed]))), /signature|redacted_thinking/u);
  }
  const unsigned = createAssistantMessage({ content: [{ type: 'reasoning', text: 'private unsigned text' }, { type: 'text', text: 'visible' }],
    source: { provider: identity.provider, model: identity.model } });
  assert.deepEqual(wire(request([unsigned]))[0]?.content, [{ type: 'text', text: 'visible' }]);
});

test('runtime errors, cancellation and premature EOF settle without successful replay state', async () => {
  for (const mode of ['error', 'cancel', 'eof'] as const) {
    const controller = new AbortController();
    const ctx = new Context(); const runtime = await ctx.plugin(LlmRuntime);
    const adapter = new CoRouterAdapter({ config: () => config, models: () => [row], apiKey: async () => 'fixture-key', fetch: async () => {
      if (mode === 'cancel') return new Response(new ReadableStream({ start(output) {
        output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(start(0, { type: 'thinking', thinking: 'partial', signature: 'hidden' }))}\n\n`));
      } }));
      return new Response(body([start(0, { type: 'thinking', thinking: 'partial', signature: 'hidden' }), stop(0),
        ...(mode === 'error' ? [{ type: 'error', error: { type: 'overloaded_error', message: 'fixture' } }] : [])]));
    } });
    const registration = ctx.llm.registerAdapter([PAID_PROVIDER], adapter);
    try {
      const chunks: StreamChunk[] = [];
      for await (const chunk of ctx.llm.stream({ ...request(), signal: controller.signal })) {
        chunks.push(chunk);
        if (mode === 'cancel' && chunk.type === 'reasoning-delta') controller.abort(new LlmError('cancelled', 'ABORTED'));
      }
      const terminal = chunks.at(-1);
      assert.equal(terminal?.type, 'finish');
      assert.ok(terminal?.type === 'finish' && ['error', 'aborted'].includes(terminal.reason.kind));
      assert.ok(terminal?.type === 'finish' && terminal.replayState === undefined);
      assert.equal(assemble(chunks).replayState, undefined);
      assert.doesNotMatch(JSON.stringify(assemble(chunks).blocks()), /hidden/u);
    } finally { registration(); adapter.dispose(); await runtime.dispose(); }
  }
});

test('runtime adapter-instance boundary strips replay from a foreign historical provider', async () => {
  const saved = message(assemble(await parse()));
  class Receiver extends LlmAdapter {
    seen: GenerateOptions | undefined;
    override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      this.seen = options; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const receiver = new Receiver(); const ctx = new Context(); const runtime = await ctx.plugin(LlmRuntime);
  const registration = ctx.llm.registerAdapter(['foreign'], receiver);
  try {
    await collect(ctx.llm.stream({ ...request([saved]), provider: 'foreign' }));
    const historical = receiver.seen?.messages[0];
    assert.ok(historical?.role === 'assistant' && historical.source.replayState === undefined);
  } finally { registration(); await runtime.dispose(); }
});

test('malformed stream order, block kinds and successful tool JSON fail before replay finish', async () => {
  const bad = [
    [start(0, { type: 'thinking', thinking: '' }), start(0, { type: 'text', text: 'duplicate' })],
    [start(0, { type: 'text', text: '' }), delta(0, { type: 'signature_delta', signature: 'secret' })],
    [start(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'text_delta', text: 'wrong' })],
    [start(0, { type: 'thinking', thinking: 'a' }), stop(0), delta(0, { type: 'thinking_delta', thinking: 'late' })],
    [start(0, { type: 'redacted_thinking', data: '' })],
    [start(0, { type: 'tool_use', id: 't', name: 'read', input: {} }), delta(0, { type: 'input_json_delta', partial_json: '{' }), stop(0)],
  ];
  for (const input of bad) await assert.rejects(parse([...input, ...finish()]), error => error instanceof LlmError && ['INVALID_RESPONSE', 'INVALID_REQUEST'].includes(error.code));
});

test('empty signed thinking and redacted-only successful responses remain real aligned blocks', async () => {
  for (const block of [native[3]!, native[4]!]) {
    const saved = message(assemble(await parse([start(7, block), stop(7), ...finish('end_turn')])));
    assert.deepEqual(saved.content, [{ type: 'reasoning', text: '' }]);
    assert.deepEqual(wire(request([saved]))[0]?.content, [block]);
  }
  await assert.rejects(parse([start(0, { type: 'text', text: '' }), ...finish('end_turn')]), { code: 'EMPTY_RESPONSE' });
});

test('overlapping native blocks preserve start order even when close events are reversed', async () => {
  const saved = message(assemble(await parse([
    start(9, { type: 'thinking', thinking: '', signature: 'a' }),
    start(2, { type: 'text', text: 'later' }), stop(2), delta(9, { type: 'thinking_delta', thinking: 'first' }), stop(9), ...finish('end_turn'),
  ])));
  assert.deepEqual(wire(request([saved]))[0]?.content, [{ type: 'thinking', thinking: 'first', signature: 'a' }, { type: 'text', text: 'later' }]);
});

test('post-stream guard discards signed replay for residue but preserves prose for Agent review', async () => {
  const monitored: CatalogModel = { id: 'deepseek-v4.1-flash', name: 'Fixture', group: 'plan' };
  for (const [text, rejected] of [['<rea:tool_calls></rea:tool_calls>', true], ['让我核对项目配置的完整情况。', false]] as const) {
  const adapter = new CoRouterAdapter({ config: () => ({ ...config, emptyTurnGuard: true }), models: () => [monitored],
    apiKey: async () => 'fixture-key', fetch: async () => new Response(body([
      start(0, { type: 'thinking', thinking: 'read next', signature: 'fixture-signature' }), stop(0),
      start(1, { type: 'text', text }), stop(1), ...finish('end_turn'),
    ])) });
  try {
    const chunks = await collect(adapter.stream({ ...request(), provider: PLAN_PROVIDER, model: monitored.id,
      tools: [{ name: 'read', description: 'fixture', parameters: { type: 'object' } }] }));
    const terminal = chunks.at(-1);
    assert.ok(terminal?.type === 'finish');
    assert.equal(terminal.reason.kind, rejected ? 'error' : 'stop');
    if (rejected) {
      assert.equal(terminal.replayState, undefined);
      assert.equal(assemble(chunks).replayState, undefined);
    } else {
      assert.ok(terminal.replayState);
      assert.ok(assemble(chunks).replayState);
    }
  } finally { adapter.dispose(); }
  }
});

test('aggregate private replay size and native block count have bounded failure paths', async () => {
  const big = 'x'.repeat(1024 * 1024);
  await assert.rejects(parse([start(0, { type: 'thinking', thinking: '' }),
    ...Array.from({ length: 9 }, () => delta(0, { type: 'signature_delta', signature: big })), ...finish('end_turn')]), { code: 'INVALID_RESPONSE' });
  await assert.rejects(parse(Array.from({ length: 4097 }, (_, index) => start(index, { type: 'thinking', thinking: '' }))), { code: 'INVALID_RESPONSE' });
});
