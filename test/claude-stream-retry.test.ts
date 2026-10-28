import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { BlockAssembler, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { CoRouterAdapter } from '../src/adapter.js';
import type { CatalogModel } from '../src/catalog.js';
import { PAID_PROVIDER, PLAN_PROVIDER, type RuntimeConfig } from '../src/config.js';

const base: RuntimeConfig = {
  apiKeyEnv: 'OFFLINE_FIXTURE', baseURL: 'https://gateway.invalid/v1', apiProtocol: 'messages',
  useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000,
};
const start = (index: number, content_block: Record<string, unknown>) => ({ type: 'content_block_start', index, content_block });
const delta = (index: number, value: Record<string, unknown>) => ({ type: 'content_block_delta', index, delta: value });
const stop = (index: number) => ({ type: 'content_block_stop', index });
const thinking = [start(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: 'partial thought' })];
const signedThinking = [...thinking, delta(0, { type: 'signature_delta', signature: 'opaque-fixture-signature' }), stop(0)];
function response(events: readonly unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface FixtureOptions {
  config?: Partial<RuntimeConfig>;
  model?: string;
  group?: CatalogModel['group'];
  signal?: AbortSignal;
  tools?: GenerateOptions['tools'];
  onChunk?(chunk: StreamChunk): void;
}
async function run(makeResponse: () => Response, options: FixtureOptions = {}) {
  const ctx = new Context();
  const runtime = await ctx.plugin(LlmRuntime);
  const row: CatalogModel = { id: options.model ?? 'claude-opus-5.5', name: 'Fixture', group: options.group ?? 'paid' };
  const provider = row.group === 'paid' ? PAID_PROVIDER : PLAN_PROVIDER;
  let fetches = 0;
  const adapter = new CoRouterAdapter({
    config: () => ({ ...base, ...options.config }), models: () => [row], apiKey: async () => 'offline-fixture-key',
    fetch: async () => { fetches++; return makeResponse(); },
  });
  const registration = ctx.llm.registerAdapter([provider], adapter);
  try {
    const prepared = await ctx.llm.prepareCall({ provider, model: row.id });
    const chunks: StreamChunk[] = [];
    const assembler = new BlockAssembler();
    for await (const chunk of prepared.stream({
      ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    })) {
      chunks.push(chunk);
      assembler.push(chunk);
      options.onChunk?.(chunk);
    }
    return { chunks, assembler, fetches, policy: prepared.retryPolicy };
  } finally {
    registration();
    adapter.dispose();
    await runtime.dispose();
  }
}
function failure(result: Awaited<ReturnType<typeof run>>, code: string, kind: 'error' | 'aborted' = 'error'): void {
  assert.equal(result.fetches, 1, 'the adapter dispatches once; retry scheduling belongs to the Agent');
  const terminals = result.chunks.filter(chunk => chunk.type === 'finish');
  assert.equal(terminals.length, 1);
  const terminal = terminals[0];
  assert.ok(terminal?.type === 'finish');
  assert.ok(terminal.reason.kind === 'error' || terminal.reason.kind === 'aborted');
  assert.equal(terminal.reason.kind, kind);
  assert.equal(terminal.reason.failure.code, code);
  assert.equal(terminal.replayState, undefined);
  assert.equal(result.assembler.finish.kind, kind);
  assert.equal(result.assembler.replayState, undefined);
  assert.doesNotMatch(JSON.stringify(result.chunks), /opaque-fixture-signature/u);
}

test('paid Opus 5.5 Messages EOF before tools is a transport failure, never a completed replay', async () => {
  const cases: readonly (readonly unknown[])[] = [
    [], thinking,
    [...signedThinking, start(1, { type: 'text', text: '' })],
    [...signedThinking, start(1, { type: 'text', text: '' }), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    [start(0, { type: 'text', text: 'partial visible answer' }), stop(0)],
  ];
  for (const events of cases) for (const emptyTurnGuard of [false, true]) {
    for (const tools of [undefined, [{ name: 'read', description: 'fixture', parameters: { type: 'object' } }]]) {
      failure(await run(() => response(events), { config: { emptyTurnGuard }, tools }), 'TRANSPORT');
    }
  }
  const result = await run(() => response(thinking));
  assert.deepEqual(result.assembler.blocks(), [{ type: 'reasoning', text: 'partial thought' }]);
});

test('Opus EOF transport failures use the existing bounded provider policy without adapter retries', async () => {
  const result = await run(() => response(thinking));
  failure(result, 'TRANSPORT');
  assert.equal(result.policy.mode, 'normal');
  assert.ok(result.policy.mode === 'normal');
  assert.equal(result.policy.maxRetries, 5);
  assert.ok(result.policy.retryableCodes.includes('TRANSPORT'));
  assert.equal(result.policy.retryableCodes.includes('INVALID_RESPONSE'), false);
});

test('the first tool block start protects Opus EOF even before its id or arguments arrive', async () => {
  const tool = start(1, { type: 'tool_use', id: 'tool-1', name: 'read', input: {} });
  const cases = [
    [start(1, { type: 'tool_use' })],
    [tool],
    [tool, delta(1, { type: 'input_json_delta', partial_json: '{"path":' })],
    [tool, delta(1, { type: 'input_json_delta', partial_json: '{"path":"a"}' }), stop(1)],
  ];
  for (const events of cases) {
    const result = await run(() => response([...signedThinking, ...events]));
    failure(result, 'INVALID_RESPONSE');
    assert.ok(result.chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call'));
  }
});

test('malformed JSON, block structure and refusal are not reclassified as Opus transport errors', async () => {
  const cases: (() => Response)[] = [
    () => new Response('data: {\n\n'),
    () => response([start(0, { type: 'text', text: 'a' }), start(0, { type: 'text', text: 'duplicate' })]),
    () => response([start(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'text_delta', text: 'wrong block' })]),
    () => response([delta(9, { type: 'thinking_delta', thinking: 'missing block' })]),
    () => response([...signedThinking, { type: 'message_delta', delta: { stop_reason: 'refusal' } }, { type: 'message_stop' }]),
  ];
  for (const makeResponse of cases) failure(await run(makeResponse), 'INVALID_RESPONSE');
});

test('a valid empty completion remains EMPTY_RESPONSE rather than a missing-terminal transport failure', async () => {
  failure(await run(() => response([
    start(0, { type: 'text', text: '' }),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ])), 'EMPTY_RESPONSE');
});

test('other Claude models and non-Claude Messages keep their existing EOF classification', async () => {
  for (const model of ['claude-fable-5.1', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4.8',
    'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-haiku-5.5', 'fixture-model']) {
    failure(await run(() => response(signedThinking), { model }), 'INVALID_RESPONSE');
  }
  failure(await run(() => response(thinking), { group: 'plan' }), 'INVALID_RESPONSE');
});

test('Opus Chat Completions and Responses do not inherit the Messages EOF policy', async () => {
  failure(await run(() => response([{ choices: [{ delta: { content: 'partial' } }] }]), {
    config: { apiProtocol: 'chat-completions' },
  }), 'INVALID_RESPONSE');
  failure(await run(() => response([{ type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'partial' }]), {
    config: { apiProtocol: 'responses' },
  }), 'INVALID_RESPONSE');
});

test('user cancellation during Opus thinking stays aborted and carries no successful replay', async () => {
  const controller = new AbortController();
  const result = await run(() => response([...signedThinking, start(1, { type: 'text', text: '' })]), {
    signal: controller.signal,
    onChunk: chunk => { if (chunk.type === 'reasoning-delta') controller.abort(new LlmError('fixture cancelled', 'ABORTED')); },
  });
  failure(result, 'ABORTED', 'aborted');
});

test('idle and total timeouts during Opus thinking remain TIMEOUT and release the stream', async () => {
  for (const config of [{ requestTimeoutMs: 10000, streamIdleTimeoutMs: 10 }, { requestTimeoutMs: 10, streamIdleTimeoutMs: 1000 }]) {
    let cancelled = false;
    const result = await run(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(start(0, { type: 'thinking', thinking: 'partial' }))}\n\n`));
      },
      cancel() { cancelled = true; },
    })), { config });
    failure(result, 'TIMEOUT');
    assert.equal(cancelled, true);
  }
});
