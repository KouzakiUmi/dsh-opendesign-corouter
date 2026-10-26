// Tests for src/catalog.ts.
// 目录事实来自公开页面（https://corouter.open-design.ai/zh/ 套餐卡 + /zh/models/<slug>/ data-model JSON，2026-10-26）；
// plan 12 款的能力字段来自 Go dsh-opendesign-go 0.1.9 的 MODEL_DEFAULTS（同 amr-link endpoint 部署资料），
// 由父会话移植、未经官网独立复核。未使用任何凭据或真实鉴权请求。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODELS, findModel, modelsFor } from '../src/catalog.js';

// Design Plan 名单（官网四档一致），12 款。
const PLAN_IDS = [
  'claude-haiku-5.5',
  'gpt-6-luna',
  'deepseek-v4.1-flash',
  'glm-5.3-flashx',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'hy4-preview',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro',
  'glm-5.3-flash',
  'kimi-k2.7-code',
] as const;

// 其余 21 款官网在售公开对话模型：付费通道（不等于“套餐可抵扣名单”）。
const PAID_IDS = [
  'qwen3.7-max',
  'claude-fable-5',
  'claude-fable-5.1',
  'claude-opus-4.8',
  'claude-opus-5',
  'claude-opus-5.5',
  'claude-sonnet-5',
  'claude-sonnet-5.5',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'kimi-k3',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'glm-5.2',
  'grok-4.5',
  'grok-4.6',
  'grok-4.7',
] as const;

const EFFORTS_FULL = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const;
const EFFORTS_STD = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORTS_LOW_HIGH = ['low', 'high', 'max'] as const;

// Go 0.1.9 MODEL_DEFAULTS 移植值：ctx / out / modalities / efforts。
const GO_DEFAULTS = new Map<string, {
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: readonly ('text' | 'image')[];
  reasoningEfforts: readonly string[];
}>([
  ['claude-haiku-5.5', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_STD] }],
  ['deepseek-v4.1-flash', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_FULL] }],
  ['deepseek-v4-flash', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_FULL] }],
  ['deepseek-v4-flash-vision-exp', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_FULL] }],
  ['deepseek-v4-pro', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text'], reasoningEfforts: [...EFFORTS_FULL] }],
  ['glm-5.3-flash', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_LOW_HIGH] }],
  ['glm-5.3-flashx', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_LOW_HIGH] }],
  ['gpt-6-luna', { contextWindow: 1_050_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_FULL] }],
  ['hy4-preview', { contextWindow: 1_000_000, maxOutputTokens: 64_000, inputModalities: ['text'], reasoningEfforts: [...EFFORTS_STD] }],
  ['kimi-k2.7-code', { contextWindow: 262_144, maxOutputTokens: 262_144, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_STD] }],
  ['mimo-v2.6-flash', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_STD] }],
  ['mimo-v2.6-pro', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'], reasoningEfforts: [...EFFORTS_STD] }],
]);

test('catalog 收录官网全部 33 款公开 chat 模型：plan 12 + paid 21', () => {
  assert.equal(MODELS.length, 33);
  assert.equal(modelsFor('plan').length, 12);
  assert.equal(modelsFor('paid').length, 21);
  assert.deepEqual([...modelsFor('plan').map(model => model.id)].sort(), [...PLAN_IDS].sort());
  assert.deepEqual([...modelsFor('paid').map(model => model.id)].sort(), [...PAID_IDS].sort());
});

test('模型 ID 与显示名非空且全局唯一，两个分组不重叠', () => {
  const ids = MODELS.map(model => model.id);
  assert.equal(new Set(ids).size, ids.length);
  const plan = new Set(modelsFor('plan').map(model => model.id));
  const paid = new Set(modelsFor('paid').map(model => model.id));
  for (const id of plan) assert.equal(paid.has(id), false, `${id} 不应同时属于两个分组`);
  for (const model of MODELS) {
    assert.match(model.id, /^[a-z0-9][a-z0-9.-]*$/u);
    assert.ok(model.name.trim().length > 0, `${model.id} 缺少显示名`);
    assert.ok(model.group === 'plan' || model.group === 'paid');
  }
});

test('媒体模型与 ID 未公开的套餐模型不进对话目录', () => {
  for (const model of MODELS) {
    assert.doesNotMatch(model.id, /^(gpt-image-|nano-banana-|seedream-|imagen-|veo-|doubao-seedance-|sora-)/u);
  }
  for (const id of ['muse-spark-1.3', 'gemini-4-argon', 'gpt-image-2', 'nano-banana-2', 'seedream-5.0']) {
    assert.equal(findModel(id), undefined, `${id} 不应出现在目录中`);
  }
});

test('plan 12 款能力与 Go 0.1.9 MODEL_DEFAULTS 逐项一致', () => {
  assert.equal(GO_DEFAULTS.size, PLAN_IDS.length);
  for (const model of modelsFor('plan')) {
    const expected = GO_DEFAULTS.get(model.id);
    assert.ok(expected, `${model.id} 缺少 Go defaults 期望值`);
    assert.equal(model.contextWindow, expected.contextWindow, `${model.id} contextWindow`);
    assert.equal(model.maxOutputTokens, expected.maxOutputTokens, `${model.id} maxOutputTokens`);
    assert.deepEqual(model.inputModalities, expected.inputModalities, `${model.id} inputModalities`);
    assert.deepEqual(model.reasoningEfforts, expected.reasoningEfforts, `${model.id} reasoningEfforts`);
  }
});

test('paid 21 款不编造能力：上下文 / 输出 / 模态 / 思考档位全部缺省', () => {
  for (const model of modelsFor('paid')) {
    assert.equal(model.contextWindow, undefined, `${model.id} 不应携带 contextWindow`);
    assert.equal(model.maxOutputTokens, undefined, `${model.id} 不应携带 maxOutputTokens`);
    assert.equal(model.inputModalities, undefined, `${model.id} 不应推断 inputModalities`);
    assert.equal(model.reasoningEfforts, undefined, `${model.id} 不应携带 reasoningEfforts`);
  }
});

test('findModel 精确匹配，已收录 ID 命中对应分组', () => {
  assert.equal(findModel('deepseek-v4.1-flash')?.group, 'plan');
  assert.equal(findModel('claude-opus-5.5')?.group, 'paid');
  assert.equal(findModel('qwen3.7-max')?.group, 'paid');
  assert.equal(findModel('hy4-preview')?.group, 'plan');
  assert.equal(findModel('DeepSeek-V4.1-Flash'), undefined);
  assert.equal(findModel(''), undefined);
});

test('modelsFor 返回顺序与 MODELS 中的相对顺序一致，且覆盖全部模型', () => {
  for (const group of ['plan', 'paid'] as const) {
    assert.deepEqual(modelsFor(group), MODELS.filter(model => model.group === group));
  }
  assert.equal(modelsFor('plan').length + modelsFor('paid').length, MODELS.length);
});
