/** Exact-model reasoning contracts; in-memory request projection only, no credentials/network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningEffortId, ToolCallId, createAssistantMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { MODELS, findModel } from '../src/catalog.js';
import { protocolFor } from '../src/protocols/index.js';
import type { ApiProtocol } from '../src/protocol-options.js';
import type { ProtocolContext } from '../src/protocols/types.js';
import { defaultReasoningEffort, modelReasoningEfforts, reasoningEffortName, reasoningParameters, usesReasoningContent, vendorDefaultEffort } from '../src/reasoning.js';

const protocols: readonly ApiProtocol[] = ['chat-completions', 'responses', 'messages'];
function context(id: string, effort?: string, messages: GenerateOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]): ProtocolContext {
  const model = findModel(id) ?? { id, name: id, group: 'paid' as const };
  return {
    baseURL: 'https://gateway.invalid/v1', apiKey: 'offline-test-key', model, images: new Map(),
    options: { provider: 'fixture', model: id, messages, ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) },
  };
}
function body(id: string, protocol: ApiProtocol, effort: string): Record<string, unknown> {
  return protocolFor(protocol).build(context(id, effort)).body as Record<string, unknown>;
}
function control(wire: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['thinking', 'reasoning', 'output_config', 'reasoning_effort', 'enable_thinking', 'thinking_budget']
    .filter(key => key in wire).map(key => [key, wire[key]]));
}

test('toggle catalog declarations encode off/on, while fixed and four unknown models stay distinct', () => {
  assert.equal(MODELS.length, 46);
  for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'qwen3.7-max', 'hy4', 'hy4-flash', 'hy4-preview']) {
    const model = findModel(id)!;
    assert.equal(model.reasoningMode, 'toggle', id);
    assert.deepEqual(model.reasoningEfforts, ['none', 'high'], id);
    assert.equal(model.defaultEffort, 'high', id);
  }
  const fixed = findModel('kimi-k2.7-code')!;
  assert.equal(fixed.reasoningMode, 'fixed');
  assert.deepEqual(fixed.reasoningEfforts, []);
  for (const protocol of protocols) {
    assert.deepEqual(modelReasoningEfforts(fixed, protocol), []);
    assert.equal(defaultReasoningEffort(fixed, protocol), undefined);
  }
  for (const id of ['deepseek-v4.1-flash-eco', 'gemini-4-carbon', 'muse-ember-1.0', 'muse-wonder']) {
    const model = findModel(id)!;
    assert.equal(model.reasoningMode, undefined, id);
    assert.equal(model.reasoningEfforts, undefined, id);
    assert.equal(model.defaultEffort, undefined, id);
    for (const protocol of protocols) {
      assert.equal(modelReasoningEfforts(model, protocol), undefined, id);
      assert.equal(defaultReasoningEffort(model, protocol), undefined, id);
      assert.equal(reasoningParameters(id, protocol, 'high'), undefined, 'no neighboring-model projection');
    }
  }
});

test('literal protocol matrix separates MiMo toggles from graded/adaptive and rejects invented levels', () => {
  const matrix = [
    ['chat-completions', 'none', { thinking: { type: 'disabled' } }],
    ['chat-completions', 'high', { thinking: { type: 'enabled' } }],
    ['messages', 'none', { thinking: { type: 'disabled' } }],
    ['messages', 'high', { thinking: { type: 'enabled' } }],
    ['responses', 'none', { reasoning: { effort: 'none' } }],
    ['responses', 'high', { reasoning: { effort: 'high' } }],
  ] as const;
  for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
    for (const [protocol, effort, expected] of matrix) {
      assert.deepEqual(reasoningParameters(id, protocol, effort), expected);
      assert.deepEqual(control(body(id, protocol, effort)), expected, `${id}/${protocol}/${effort}`);
      assert.deepEqual(modelReasoningEfforts(findModel(id)!, protocol), ['none', 'high']);
      assert.equal(vendorDefaultEffort(findModel(id)!, protocol), 'high');
    }
    for (const protocol of protocols) for (const effort of ['minimal', 'low', 'medium', 'xhigh', 'max', 'ultra']) {
      assert.equal(reasoningParameters(id, protocol, effort), null);
      assert.throws(() => body(id, protocol, effort), { code: 'UNSUPPORTED_OPTION' });
    }
  }
});

test('Qwen3.7 supports a Chat boolean switch only, without inventing a budget or other-protocol mapping', () => {
  const model = findModel('qwen3.7-max')!;
  for (const [effort, enabled] of [['none', false], ['high', true]] as const) {
    assert.deepEqual(control(body(model.id, 'chat-completions', effort)), { enable_thinking: enabled });
    for (const protocol of ['responses', 'messages'] as const) {
      assert.equal(reasoningParameters(model.id, protocol, effort), null);
      assert.throws(() => body(model.id, protocol, effort), { code: 'UNSUPPORTED_OPTION' });
      assert.deepEqual(modelReasoningEfforts(model, protocol), []);
      assert.equal(vendorDefaultEffort(model, protocol), undefined);
    }
  }
  assert.deepEqual(modelReasoningEfforts(model, 'chat-completions'), ['none', 'high']);
  assert.equal(vendorDefaultEffort(model, 'chat-completions'), 'high');
  assert.throws(() => body(model.id, 'chat-completions', 'medium'), { code: 'UNSUPPORTED_OPTION' });
});

test('Hy4 uses no_think on Chat but never opens unsupported closing on another protocol', () => {
  for (const id of ['hy4', 'hy4-flash']) {
    assert.deepEqual(control(body(id, 'chat-completions', 'none')), { reasoning_effort: 'no_think' });
    assert.deepEqual(control(body(id, 'chat-completions', 'high')), { reasoning_effort: 'high' });
    for (const protocol of ['responses', 'messages'] as const) {
      assert.equal(reasoningParameters(id, protocol, 'none'), null);
      assert.throws(() => body(id, protocol, 'none'), { code: 'UNSUPPORTED_OPTION' });
      assert.deepEqual(modelReasoningEfforts(findModel(id)!, protocol), ['high']);
      assert.equal(defaultReasoningEffort(findModel(id)!, protocol, 'none'), undefined);
      assert.equal(reasoningParameters(id, protocol, 'high'), undefined, 'existing high behavior is preserved, not newly certified');
    }
    assert.deepEqual(control(body(id, 'responses', 'high')), { reasoning: { effort: 'high', summary: 'auto' } });
    assert.deepEqual(control(body(id, 'messages', 'high')), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    for (const protocol of protocols) assert.throws(() => body(id, protocol, 'low'), { code: 'UNSUPPORTED_OPTION' });
  }
});

test('only the four ordinary DeepSeek rows gain none; Kimi and GLM effort sets are not widened', () => {
  for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    const model = findModel(id)!;
    assert.deepEqual(model.reasoningEfforts, ['none', 'low', 'high', 'max']);
    assert.equal(model.defaultEffort, 'high');
    assert.equal(model.reasoningMode, undefined);
    assert.deepEqual(control(body(id, 'chat-completions', 'none')), { reasoning_effort: 'none' });
    assert.deepEqual(control(body(id, 'responses', 'none')), { reasoning: { effort: 'none', summary: 'auto' } });
    assert.deepEqual(control(body(id, 'messages', 'none')), { thinking: { type: 'disabled' } });
  }
  for (const id of ['kimi-k3', 'kimi-k3.1-pro', 'glm-5.3-flash', 'glm-5.3-flashx']) {
    assert.deepEqual(findModel(id)!.reasoningEfforts, ['low', 'high', 'max']);
  }
});

test('labels and exact-ID projection do not turn toggle high into graded depth', () => {
  assert.equal(reasoningEffortName('none', 'toggle'), '关闭');
  assert.equal(reasoningEffortName('high', 'toggle'), '开启');
  assert.deepEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'].map(value => reasoningEffortName(value)),
    ['关闭', '最低', '低', '中', '高', '较高', '极高', '最高']);
  assert.equal(reasoningEffortName('future-level'), 'future-level');
  for (const id of ['mimo-v2.6-pro-ultraspeed', 'mimo-v2.6-flash-next', 'hy4-preview', 'qwen3.7-max-preview']) {
    for (const protocol of protocols) assert.equal(reasoningParameters(id, protocol, 'none'), undefined);
  }
  assert.deepEqual(modelReasoningEfforts({ reasoningEfforts: ['none', 'high'] }, 'responses'), ['none', 'high'], 'structural callers without IDs retain compatibility');
});

test('MiMo Chat retains the reasoning_content of historical assistant tool calls, but nearby IDs do not', () => {
  const assistant = createAssistantMessage({ source: { provider: 'fixture', model: 'mimo-v2.6-pro' }, content: [
    { type: 'reasoning', text: 'retained private tool reasoning' },
    { type: 'tool-call', id: ToolCallId('call_fixture'), name: 'read', arguments: '{"path":"fixture"}' },
  ] });
  for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
    assert.equal(usesReasoningContent(id), true);
    const wire = protocolFor('chat-completions').build(context(id, 'high', [assistant])).body as { messages: Array<Record<string, unknown>> };
    assert.equal(wire.messages[0]!.reasoning_content, 'retained private tool reasoning');
    assert.ok(Array.isArray(wire.messages[0]!.tool_calls));
  }
  assert.equal(usesReasoningContent('deepseek-future'), true, 'old prefix policy is unchanged');
  assert.equal(usesReasoningContent('kimi-future'), true);
  for (const id of ['mimo-v2.6-pro-ultraspeed', 'mimo-v2.6-flash-next', 'other']) {
    assert.equal(usesReasoningContent(id), false);
    const wire = protocolFor('chat-completions').build(context(id, undefined, [assistant])).body as { messages: Array<Record<string, unknown>> };
    assert.equal(wire.messages[0]!.reasoning_content, undefined);
  }
});
