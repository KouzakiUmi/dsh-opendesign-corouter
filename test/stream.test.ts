import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeSse, tokenUsage, gatewayError } from '../src/stream.js';
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function bytes(raw: string, split = 7) {
  const encoded = new TextEncoder().encode(raw);
  return new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < encoded.length; i += split) controller.enqueue(encoded.slice(i, i + split)); controller.close(); } });
}
async function all<T>(stream: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const item of stream) out.push(item); return out; }
const collect = (raw: string) => all(consumeSse(bytes(raw), new AbortController().signal, 1000));
test('SSE preserves split UTF8, CRLF, reasoning, and disjoint cache usage', async () => {
  const raw = ': keepalive\r\n\r\n' + event({ choices: [{ delta: { reasoning_content: '思考' } }] }) + event({ choices: [{ delta: { content: '你好' } }] }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + event({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } } }) + 'data: [DONE]\r\n\r\n';
  const chunks = await collect(raw);
  assert.deepEqual(chunks.filter(x => x.type === 'block-end').map(x => x.block), [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '你好' }]);
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 70, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, reasoningTokens: 5 } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});
test('parallel tool calls and delayed ids retain all argument fragments', async () => {
  const raw = event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }, { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] } }] }) + event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '}' } }] } }] }) + event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  const chunks = await collect(raw);
  const ends = chunks.filter(x => x.type === 'block-end').map(x => x.block);
  assert.deepEqual(ends, [{ type: 'tool-call', id: 'a', name: 'first', arguments: '{}' }, { type: 'tool-call', id: 'b', name: 'second', arguments: '{}' }]);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});
test('truncated, empty, malformed, or in-band errors never become successful responses', async () => {
  await assert.rejects(collect(event({ choices: [{ delta: { content: 'partial' } }] })), { code: 'INVALID_RESPONSE' });
  await assert.rejects(collect(event({ choices: [{ delta: {}, finish_reason: 'stop' }] })), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(collect('data: invalid\n\n'), { code: 'INVALID_RESPONSE' });
  await assert.rejects(collect(event({ error: { code: 'invalid_api_key', message: 'DO_NOT_ECHO_SECRET' } })), (e: Error) => !e.message.includes('DO_NOT_ECHO_SECRET'));
});
test('repeated complete tool names do not corrupt the target, and missing tool blocks fail closed', async () => {
  const raw = event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{' } }] } }] }) + event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '}' } }] } }] }) + event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  const chunks = await collect(raw);
  assert.ok(chunks.some(x => x.type === 'block-end' && x.block.type === 'tool-call' && x.block.name === 'read' && x.block.arguments === '{}'));
  await assert.rejects(collect(event({ choices: [{ delta: { content: '<thinking></thinking>' }, finish_reason: 'tool_calls' }] })), { code: 'INVALID_RESPONSE' });
});
test('idle and abort close the upstream reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(all(consumeSse(stream, new AbortController().signal, 5)), { code: 'TIMEOUT' });
  assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(all(consumeSse(bytes(''), controller.signal, 100)), /cancelled/u);
});
test('token accounting omits invalid cache counts; failure taxonomy is stable', () => {
  assert.deepEqual(tokenUsage({ prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 9 }), { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  assert.equal(gatewayError(429, {}).code, 'RATE_LIMIT');
  // Permission denial does not prove an invalid key; wallet depletion is distinct from a plan quota.
  assert.equal(gatewayError(403, {}).code, 'PERMISSION');
  assert.equal(gatewayError(402, { error: { message: 'insufficient balance' } }).code, 'QUOTA');
});
