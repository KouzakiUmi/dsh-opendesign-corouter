/**
 * 协议模块的合成测试：全部使用内存 SSE，不发起真实推理，不读取任何凭据。
 *
 * 覆盖面：请求投影（URL/头/体）、交错文本+推理+工具调用、usage 不相交口径、
 * 终止语义（completed/incomplete/failed/stop_reason）、以及“无内容/截断/错误不得当成功”。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReasoningEffortId, ToolCallId,
  createAssistantMessage, createMessage,
  type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { MESSAGES_DEFAULT_MAX_TOKENS, messagesURL, protocolFor } from '../src/protocols/index.js';
import type { ProtocolContext } from '../src/protocols/types.js';
import type { CatalogModel } from '../src/catalog.js';
import type { ApiProtocol } from '../src/protocol-options.js';

const model: CatalogModel = { id: 'fixture-model', name: 'Fixture', group: 'paid' };
const image: ImageAttachmentRef = { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png', bytes: 10, width: 4, height: 4, name: 'fixture.png' };
const imageURL = 'data:image/png;base64,AAAA';

const user = (text: string): GenerateOptions['messages'][number] => ({ role: 'user', content: [{ type: 'text', text }] });

function context(extra: Partial<GenerateOptions> = {}, over: Partial<ProtocolContext> = {}): ProtocolContext {
  return {
    baseURL: 'https://amr-link.open-design.ai/v1',
    apiKey: 'test-key',
    model,
    options: { provider: 'fixture', model: model.id, messages: [user('hi')], ...extra },
    images: new Map(),
    ...over,
  };
}

function bytes(raw: string, split = 5): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(raw);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < encoded.length; index += split) controller.enqueue(encoded.slice(index, index + split));
      controller.close();
    },
  });
}

function body(events: readonly unknown[], split = 5): ReadableStream<Uint8Array> {
  return bytes(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), split);
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const streamOf = (id: ApiProtocol, events: readonly unknown[], split = 5) =>
  collect(protocolFor(id).stream(body(events, split), new AbortController().signal, 1000));

/** 模拟真实消费方：收到 finish 立即停止读取。 */
async function untilFinish(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
    if (chunk.type === 'finish') break;
  }
  return out;
}

const streamOfUntilFinish = (id: ApiProtocol, events: readonly unknown[]) =>
  untilFinish(protocolFor(id).stream(body(events), new AbortController().signal, 1000));

const blocks = (chunks: readonly StreamChunk[]) =>
  chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end').map(chunk => chunk.block);

const usageOf = (chunks: readonly StreamChunk[]) => chunks.find(chunk => chunk.type === 'usage');

test('protocolFor 分派三种协议并拒绝未知 id', () => {
  assert.equal(protocolFor('chat-completions').id, 'chat-completions');
  assert.equal(protocolFor('responses').id, 'responses');
  assert.equal(protocolFor('messages').id, 'messages');
  assert.throws(() => protocolFor('bogus' as ApiProtocol), { code: 'INVALID_REQUEST' });
  for (const [id, suffix] of [['chat-completions', '/chat/completions'], ['responses', '/responses'], ['messages', '/messages']] as const) {
    assert.equal(protocolFor(id).build(context({}, { baseURL: 'https://amr-link.open-design.ai' })).url, `https://amr-link.open-design.ai/v1${suffix}`);
    assert.equal(protocolFor(id).build(context({}, { baseURL: 'https://example.invalid/proxy/v2' })).url, `https://example.invalid/proxy/v2${suffix}`);
  }
});

test('Chat Completions 请求保持既有投影与头', () => {
  const request = protocolFor('chat-completions').build(context({
    system: 'sys', temperature: 0.2, maxTokens: 1234, reasoningEffort: ReasoningEffortId('high'), stop: ['END'],
  }, { topP: 0.9 }));
  assert.equal(request.url, 'https://amr-link.open-design.ai/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.headers.accept, 'text/event-stream');
  assert.match(request.headers['user-agent'] ?? '', /^deepseek-harness\//u);
  const wire = request.body as Record<string, unknown>;
  assert.equal(wire.stream, true);
  assert.deepEqual(wire.stream_options, { include_usage: true });
  assert.equal(wire.max_tokens, 1234);
  assert.equal(wire.top_p, 0.9);
  assert.equal(wire.reasoning_effort, 'high');
  assert.deepEqual(wire.stop, ['END']);
  assert.equal((wire.messages as { role: string }[])[0]?.role, 'system');
});

test('Responses 请求无状态、整段 input，并投影工具与 instructions', () => {
  const assistant = createAssistantMessage({
    source: { provider: 'fixture', model: model.id },
    content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{"path":"a"}' }],
  });
  const result = createMessage({
    role: 'tool', source: { kind: 'tool', callId: ToolCallId('call_1') }, toolCallId: ToolCallId('call_1'),
    content: [{ type: 'text', text: 'ok' }],
  });
  const request = protocolFor('responses').build(context({
    system: 'sys', maxTokens: 2048, temperature: 0.3, reasoningEffort: ReasoningEffortId('high'),
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    messages: [user('hi'), assistant, result],
  }));
  assert.equal(request.url, 'https://amr-link.open-design.ai/v1/responses');
  const wire = request.body as Record<string, unknown>;
  assert.equal(wire.store, false);
  assert.equal(wire.stream, true);
  assert.equal(wire.max_output_tokens, 2048);
  assert.equal(wire.temperature, 0.3);
  assert.deepEqual(wire.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(wire.instructions, 'sys');
  assert.deepEqual(wire.tools, [{ type: 'function', name: 'read', description: 'read', parameters: { type: 'object' } }]);
  assert.deepEqual((wire.input as unknown[]).slice(-2), [
    { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ]);
  assert.throws(() => protocolFor('responses').build(context({ reasoningEffort: ReasoningEffortId('ultra') })), { code: 'UNSUPPORTED_OPTION' });
  assert.throws(() => protocolFor('responses').build(context({ stop: ['END'] })), { code: 'UNSUPPORTED_OPTION' });
});

test('Messages Base 根或 /v1 都补成 /v1/messages，鉴权只发 Bearer + 版本头', () => {
  assert.equal(messagesURL('https://amr-link.open-design.ai/v1'), 'https://amr-link.open-design.ai/v1/messages');
  assert.equal(messagesURL('https://amr-link.open-design.ai'), 'https://amr-link.open-design.ai/v1/messages');
  assert.equal(messagesURL('https://amr-link.open-design.ai/'), 'https://amr-link.open-design.ai/v1/messages');
  const request = protocolFor('messages').build(context({ system: 'sys' }, { baseURL: 'https://amr-link.open-design.ai' }));
  assert.equal(request.url, 'https://amr-link.open-design.ai/v1/messages');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['x-api-key'], undefined);
  const wire = request.body as Record<string, unknown>;
  assert.equal(wire.max_tokens, MESSAGES_DEFAULT_MAX_TOKENS);
  assert.equal(wire.system, 'sys');
});

test('Messages 投影 tool_use/tool_result、图片与思考档位', () => {
  const assistant = createAssistantMessage({
    source: { provider: 'fixture', model: model.id },
    content: [{ type: 'tool-call', id: ToolCallId('toolu_1'), name: 'read', arguments: '{"path":"a"}' }],
  });
  const result = createMessage({
    role: 'tool', source: { kind: 'tool', callId: ToolCallId('toolu_1') }, toolCallId: ToolCallId('toolu_1'),
    content: [{ type: 'image', attachment: image }],
  });
  const withImage = createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] });
  const request = protocolFor('messages').build(context({
    maxTokens: 8192, reasoningEffort: ReasoningEffortId('high'), temperature: 0.4, stop: ['END'],
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    messages: [user('看看这张图'), withImage, assistant, result],
  }, { images: new Map([[image.attachmentId, imageURL]]), topP: 0.5 }));
  const wire = request.body as Record<string, unknown>;
  // 现代 Messages 标准：思考用 adaptive + output_config.effort。
  assert.deepEqual(wire.thinking, { type: 'adaptive' });
  assert.deepEqual(wire.output_config, { effort: 'high' });
  // temperature/top_p 只是字段透传：这里不宣称该组合能在新版 Claude 成功，兼容性由上游判定。
  assert.equal(wire.temperature, 0.4);
  assert.equal(wire.top_p, 0.5);
  assert.deepEqual(wire.stop_sequences, ['END']);
  assert.deepEqual(wire.tools, [{ name: 'read', description: 'read', input_schema: { type: 'object' } }]);
  const messages = wire.messages as { role: string; content: Record<string, unknown>[] }[];
  const assistantWire = messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistantWire?.content[0], { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } });
  const toolResult = messages.flatMap(message => message.content).find(part => part.type === 'tool_result');
  assert.equal(toolResult?.tool_use_id, 'toolu_1');
  const base64 = messages.flatMap(message => message.content).filter(part => part.type === 'image');
  assert.ok(base64.length >= 1);
  assert.deepEqual(base64[0]?.source, { type: 'base64', media_type: 'image/png', data: 'AAAA' });
  // 现代 Messages 的 effort 取值只有 low/medium/high/xhigh/max；目录里的 minimal/ultra 没有对应值。
  assert.throws(() => protocolFor('messages').build(context({ reasoningEffort: ReasoningEffortId('ultra') })), { code: 'UNSUPPORTED_OPTION' });
  assert.throws(() => protocolFor('messages').build(context({ reasoningEffort: ReasoningEffortId('minimal') })), { code: 'UNSUPPORTED_OPTION' });
  const disabled = protocolFor('messages').build(context({ reasoningEffort: ReasoningEffortId('none') })).body as Record<string, unknown>;
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
  assert.equal(disabled.output_config, undefined, '关闭思考时不得发送 effort');
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const mapped = protocolFor('messages').build(context({ reasoningEffort: ReasoningEffortId(effort) })).body as Record<string, unknown>;
    assert.deepEqual(mapped.thinking, { type: 'adaptive' });
    assert.deepEqual(mapped.output_config, { effort });
  }
});

test('Messages 连续并行工具结果合成一条 user 消息，图片只在该组之后提升', () => {
  const assistant = createAssistantMessage({
    source: { provider: 'fixture', model: model.id },
    content: [
      { type: 'tool-call', id: ToolCallId('toolu_1'), name: 'read', arguments: '{"path":"a"}' },
      { type: 'tool-call', id: ToolCallId('toolu_2'), name: 'read', arguments: '{"path":"b"}' },
    ],
  });
  const first = createMessage({
    role: 'tool', source: { kind: 'tool', callId: ToolCallId('toolu_1') }, toolCallId: ToolCallId('toolu_1'),
    content: [{ type: 'image', attachment: image }],
  });
  const second = createMessage({
    role: 'tool', source: { kind: 'tool', callId: ToolCallId('toolu_2') }, toolCallId: ToolCallId('toolu_2'),
    content: [{ type: 'text', text: 'plain' }],
  });
  const wire = protocolFor('messages').build(context({ messages: [user('go'), assistant, first, second] }, { images: new Map([[image.attachmentId, imageURL]]) })).body as Record<string, unknown>;
  const messages = wire.messages as { role: string; content: Record<string, unknown>[] }[];
  const resultGroups = messages.filter(message => message.content.some(part => part.type === 'tool_result'));
  assert.equal(resultGroups.length, 1, '并行工具结果必须落在同一条 user 消息里');
  assert.deepEqual(resultGroups[0]?.content.map(part => part.tool_use_id), ['toolu_1', 'toolu_2']);
  const imageIndex = messages.findIndex(message => message.content.some(part => part.type === 'image'));
  const resultIndex = messages.indexOf(resultGroups[0]!);
  assert.ok(imageIndex > resultIndex, '提升的图片必须排在整组工具结果之后');
  assert.equal(messages.filter(message => message.content.some(part => part.type === 'image')).length, 1);
});

test('Messages 不伪造历史工具参数：空参数按 {} 处理，非法/非对象显式拒绝', () => {
  const assistant = (argumentsText: string) => createAssistantMessage({
    source: { provider: 'fixture', model: model.id },
    content: [{ type: 'tool-call', id: ToolCallId('toolu_9'), name: 'read', arguments: argumentsText }],
  });
  const inputOf = (argumentsText: string) => {
    const wire = protocolFor('messages').build(context({ messages: [assistant(argumentsText)] })).body as Record<string, unknown>;
    const messages = wire.messages as { role: string; content: Record<string, unknown>[] }[];
    return messages.find(message => message.role === 'assistant')?.content[0]?.input;
  };
  assert.deepEqual(inputOf(''), {});
  assert.deepEqual(inputOf(' {"path":"a"} '), { path: 'a' });
  assert.throws(() => inputOf('{not json'), { code: 'INVALID_REQUEST' });
  assert.throws(() => inputOf('[1,2]'), { code: 'INVALID_REQUEST' });
});

test('Responses 交错文本/推理/工具调用与不相交 usage', async () => {
  const chunks = await streamOf('responses', [
    { type: 'response.created' },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"a"}' },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: '完成' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 2, summary_index: 0, delta: '思考' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'response.completed', response: {
      status: 'completed',
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 },
    } },
  ], 1);
  assert.deepEqual(blocks(chunks), [
    { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
    { type: 'text', text: '完成' },
    { type: 'reasoning', text: '思考' },
  ]);
  assert.deepEqual(usageOf(chunks), { type: 'usage', usage: { inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 5 } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

test('Messages 交错 thinking/文本/工具参数分片与不相交 usage', async () => {
  const chunks = await streamOf('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ], 1);
  assert.deepEqual(blocks(chunks), [
    { type: 'reasoning', text: '想' },
    { type: 'text', text: '你好' },
    { type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"path":"a"}' },
  ]);
  assert.deepEqual(usageOf(chunks), { type: 'usage', usage: { inputTokens: 10, outputTokens: 12, totalTokens: 27, cacheReadTokens: 3, cacheWriteTokens: 2 } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

test('截断按不完整处理：Responses incomplete → max-tokens，两种协议缺终态都失败', async () => {
  const incomplete = await streamOf('responses', [
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '半截' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_tokens' } } },
  ]);
  assert.deepEqual(incomplete.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } });
  assert.deepEqual(blocks(incomplete), [{ type: 'text', text: '半截' }]);
  await assert.rejects(streamOf('responses', [{ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '半截' }]), { code: 'INVALID_RESPONSE' });
  await assert.rejects(streamOf('messages', [{ type: 'message_start', message: { usage: {} } }]), { code: 'INVALID_RESPONSE' });
});

test('无内容、拒绝、过滤与失败事件都不是成功响应', async () => {
  await assert.rejects(streamOf('responses', [{ type: 'response.completed', response: { status: 'completed', output: [] } }]), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(streamOf('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(streamOf('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]), { code: 'INVALID_RESPONSE' });
  await assert.rejects(streamOf('responses', [{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }]), { code: 'INVALID_RESPONSE' });
  await assert.rejects(streamOf('responses', [{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'DO_NOT_ECHO_SECRET' } } }]), (error: Error & { code?: string }) => error.code === 'SERVER' && !error.message.includes('DO_NOT_ECHO_SECRET'));
  await assert.rejects(streamOf('messages', [{ type: 'error', error: { type: 'rate_limit_error', message: 'DO_NOT_ECHO_SECRET' } }]), (error: Error & { code?: string }) => error.code === 'RATE_LIMIT' && !error.message.includes('DO_NOT_ECHO_SECRET'));
});

test('终态才给内容的网关也能还原块，工具块缺失仍失败', async () => {
  const hydrated = await streamOf('responses', [
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '只有终态' }] }] } },
  ]);
  assert.deepEqual(blocks(hydrated), [{ type: 'text', text: '只有终态' }]);
  assert.deepEqual(hydrated.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  await assert.rejects(streamOf('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]), { code: 'INVALID_RESPONSE' });
});

test('消费者在 finish 处提前退出时，合法性校验仍已发生', async () => {
  await assert.rejects(streamOfUntilFinish('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(streamOfUntilFinish('responses', [{ type: 'response.completed', response: { status: 'completed', output: [] } }]), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(streamOfUntilFinish('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]), { code: 'INVALID_RESPONSE' });
  const ok = await streamOfUntilFinish('responses', [
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]);
  assert.deepEqual(ok.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.deepEqual(blocks(ok), [{ type: 'text', text: 'ok' }]);
});

test('content_block_start 自带首段内容时按内容开块，不误判为空响应', async () => {
  const chunks = await streamOf('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '先给' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '内置推理' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
  assert.deepEqual(blocks(chunks), [{ type: 'text', text: '先给' }, { type: 'reasoning', text: '内置推理' }]);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('空闲与取消沿用旧的失败分类并释放上游', async () => {
  const stalled = new ReadableStream<Uint8Array>({ pull() { /* 永不产出 */ } });
  await assert.rejects(collect(protocolFor('messages').stream(stalled, new AbortController().signal, 5)), { code: 'TIMEOUT' });
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(collect(protocolFor('responses').stream(bytes(''), controller.signal, 100)), /cancelled/u);
});
