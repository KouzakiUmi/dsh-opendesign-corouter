// Tests for src/catalog.ts.
// 目录事实来自公开页面（https://corouter.open-design.ai/zh/ 套餐卡 + /zh/models/<slug>/ data-model JSON，2026-10-26）。
//
// 两类能力来源分开断言：
// - 容量/输出：plan 12 款沿用 Go dsh-opendesign-go 0.1.9 的部署参考；
//   图片输入依据厂商与网关资料单独核验，见 docs/model-capabilities.md。
// - 思考档位：按各厂商官方型号文档逐型号取证（见 docs/reasoning-evidence.md）：
//   OpenAI https://developers.openai.com/api/docs/models/<model>.md 与
//   https://developers.openai.com/api/docs/guides/latest-model.md ；
//   Anthropic https://platform.claude.com/docs/en/build-with-claude/effort 。
//   档位断言写死官方取值，不从实现反推；`ultra` 无任何厂商文档支持，目录中不得出现。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODELS, findModel, modelsFor } from '../src/catalog.js';

// 官网 Core 12 款，加当前工作区 billing preflight 确认覆盖的 MiniMax。
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
  'minimax-m3.1-flash',
] as const;

// 26 项归付费通道；不承诺每个账号的具体套餐权限。
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
  'gpt-6.1-terra',
  'glm-5.2',
  'grok-4.5',
  'grok-4.6',
  'grok-4.7',
  'gemini-4-argon',
  'kimi-k3.1-pro',
  'muse-spark-1.3',
  'muse-wonder',
] as const;

/**
 * Go 0.1.9 MODEL_DEFAULTS 的容量移植值（ctx / out / modalities）。
 * 思考档位不在此表：它已改为按厂商官方文档逐型号取证，见 EFFORT_MATRIX。
 */
const GO_CAPACITY = new Map<string, {
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities?: readonly ('text' | 'image')[];
}>([
  ['claude-haiku-5.5', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] }],
  ['deepseek-v4.1-flash', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text', 'image'] }],
  ['deepseek-v4-flash', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text', 'image'] }],
  ['deepseek-v4-flash-vision-exp', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text', 'image'] }],
  ['deepseek-v4-pro', { contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  ['glm-5.3-flash', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] }],
  ['glm-5.3-flashx', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] }],
  ['gpt-6-luna', { contextWindow: 1_050_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] }],
  ['hy4-preview', { contextWindow: 1_000_000, maxOutputTokens: 64_000, inputModalities: ['text'] }],
  ['kimi-k2.7-code', { contextWindow: 262_144, maxOutputTokens: 262_144, inputModalities: ['text', 'image'] }],
  ['mimo-v2.6-flash', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] }],
  ['mimo-v2.6-pro', { contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] }],
]);

/**
 * 全 39 型号的思考档位矩阵（厂商官方文档逐型号取值）。
 * `[]` = 该型号没有可调的思考档位；`null` = 厂商档位未确认（目录中保持缺省）。
 */
const EFFORT_MATRIX = new Map<string, readonly string[] | null>([
  // OpenAI：`reasoning.effort` 支持集合；GPT-6.1 Sol 与 GPT-6 Astra 官方明文不支持 `none`。
  ['gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-6.1-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
  // Anthropic：`output_config.effort` 只有 low/medium/high/xhigh/max，无 none/minimal。
  ['claude-fable-5.1', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4.8', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-sonnet-5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-haiku-5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  // DeepSeek / Z.ai / Moonshot / Google / xAI / Xiaomi / Tencent / Alibaba。
  ['deepseek-v4.1-flash', ['low', 'high', 'max']],
  ['deepseek-v4-pro', ['low', 'high', 'max']],
  ['deepseek-v4-flash', ['low', 'high', 'max']],
  ['deepseek-v4-flash-vision-exp', ['low', 'high', 'max']],
  ['glm-5.3-flashx', ['low', 'high', 'max']],
  ['glm-5.3-flash', ['low', 'high', 'max']],
  ['glm-5.2', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['kimi-k2.7-code', []],
  ['kimi-k3', ['low', 'high', 'max']],
  ['kimi-k3.1-pro', ['low', 'high', 'max']],
  ['gemini-4-argon', ['low', 'medium', 'high']],
  ['gemini-3.8-flash', ['low', 'medium', 'high']],
  ['gemini-3.7-flash', ['low', 'medium', 'high']],
  ['grok-4.7', ['low', 'medium', 'high', 'xhigh']],
  ['grok-4.6', ['low', 'medium', 'high', 'xhigh']],
  ['grok-4.5', ['low', 'medium', 'high']],
  ['mimo-v2.6-pro', []],
  ['mimo-v2.6-flash', []],
  ['hy4-preview', ['none', 'high']],
  ['qwen3.7-max', []],
  // 官方 API 新增项。
  ['minimax-m3.1-flash', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['muse-spark-1.3', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  // Muse Wonder 的精确别名尚未确认，档位保持未知。
  ['muse-wonder', null],
]);

/** 厂商文档化过的全部思考档位取值；`ultra` 不在其中。 */
const KNOWN_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** 官方明文支持 `none` 的 OpenAI 型号。 */
const OPENAI_NONE_MODELS = new Set(['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
/** Anthropic 型号：effort 只有 low/medium/high/xhigh/max。 */
const ANTHROPIC_MODELS = [
  'claude-fable-5.1',
  'claude-fable-5',
  'claude-opus-5.5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-sonnet-5.5',
  'claude-sonnet-5',
  'claude-haiku-5.5',
] as const;

test('catalog 收录 39 个目录项：Core 附赠通道 13 + 付费通道 26', () => {
  assert.equal(MODELS.length, 39);
  assert.equal(modelsFor('plan').length, 13);
  assert.equal(modelsFor('paid').length, 26);
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

test('媒体专用模型不进对话目录', () => {
  for (const model of MODELS) {
    assert.doesNotMatch(model.id, /^(gpt-image-|nano-banana-|seedream-|imagen-|veo-|doubao-seedance-|sora-)/u);
  }
  for (const id of ['gpt-image-2', 'nano-banana-2', 'seedream-5.0']) {
    assert.equal(findModel(id), undefined, `${id} 不应出现在目录中`);
  }
});

test('plan 12 款的容量/输出保留 Go 参考，模态采用当前证据', () => {
  assert.equal(GO_CAPACITY.size, PLAN_IDS.length - 1);
  for (const model of modelsFor('plan').filter(model => model.id !== 'minimax-m3.1-flash')) {
    const expected = GO_CAPACITY.get(model.id);
    assert.ok(expected, `${model.id} 缺少 Go capacity 期望值`);
    assert.equal(model.contextWindow, expected.contextWindow, `${model.id} contextWindow`);
    assert.equal(model.maxOutputTokens, expected.maxOutputTokens, `${model.id} maxOutputTokens`);
    assert.deepEqual(model.inputModalities, expected.inputModalities, `${model.id} inputModalities`);
  }
});

test('39 个模型的上下文参考值按来源逐项记录，不改变既有输出默认值', () => {
  const windows = new Map<string, number>([
    ['gpt-6.1-sol', 1_050_000], ['gpt-6.1-terra', 1_050_000], ['gpt-6-astra', 1_050_000],
    ['gpt-6-luna', 1_050_000], ['gpt-6-sol', 1_050_000], ['gpt-5.6-luna', 1_050_000],
    ['gpt-5.6-sol', 1_050_000], ['gpt-5.6-terra', 1_050_000],
    ['claude-fable-5.1', 1_000_000], ['claude-fable-5', 1_000_000], ['claude-opus-5.5', 1_000_000],
    ['claude-opus-5', 1_000_000], ['claude-opus-4.8', 1_000_000], ['claude-sonnet-5.5', 1_000_000],
    ['claude-sonnet-5', 1_000_000], ['claude-haiku-5.5', 1_000_000],
    ['deepseek-v4.1-flash', 1_000_000], ['deepseek-v4-pro', 1_000_000], ['deepseek-v4-flash', 1_000_000],
    ['deepseek-v4-flash-vision-exp', 1_000_000], ['glm-5.3-flashx', 1_000_000], ['glm-5.3-flash', 1_000_000], ['glm-5.2', 1_000_000],
    ['kimi-k2.7-code', 262_144], ['kimi-k3', 1_048_576], ['kimi-k3.1-pro', 1_048_576],
    ['gemini-4-argon', 1_048_576], ['gemini-3.8-flash', 1_048_576], ['gemini-3.7-flash', 1_048_576],
    ['grok-4.7', 500_000], ['grok-4.6', 500_000], ['grok-4.5', 500_000],
    ['mimo-v2.6-pro', 1_000_000], ['mimo-v2.6-flash', 1_000_000], ['hy4-preview', 1_000_000],
    ['qwen3.7-max', 1_000_000], ['minimax-m3.1-flash', 1_000_000],
    ['muse-spark-1.3', 1_048_576], ['muse-wonder', 1_048_576],
  ]);
  assert.equal(windows.size, 39);
  assert.deepEqual([...windows.keys()].sort(), MODELS.map(row => row.id).sort());
  for (const row of MODELS) assert.equal(row.contextWindow, windows.get(row.id), row.id);
  for (const row of modelsFor('paid').filter(model => model.id !== 'gpt-6.1-terra')) assert.equal(row.maxOutputTokens, undefined, row.id);
  assert.equal(findModel('gpt-6.1-terra')?.maxOutputTokens, 128_000);
  assert.equal(findModel('minimax-m3.1-flash')?.maxOutputTokens, undefined);
});

test('图片输入能力采用逐型号证据，未确认模型保持未知', () => {
  const image = [
    'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
    'claude-fable-5.1', 'claude-fable-5', 'claude-opus-5.5', 'claude-opus-5', 'claude-opus-4.8', 'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-haiku-5.5',
    'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'glm-5.3-flashx', 'glm-5.3-flash',
    'kimi-k2.7-code', 'kimi-k3', 'kimi-k3.1-pro', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash',
    'grok-4.7', 'grok-4.6', 'grok-4.5', 'mimo-v2.6-pro', 'mimo-v2.6-flash', 'minimax-m3.1-flash', 'muse-spark-1.3',
  ];
  const text = ['glm-5.2', 'qwen3.7-max', 'hy4-preview'];
  const unknown = ['deepseek-v4-pro', 'muse-wonder'];
  assert.deepEqual([...image, ...text, ...unknown].sort(), MODELS.map(model => model.id).sort());
  for (const id of image) assert.deepEqual(findModel(id)?.inputModalities, ['text', 'image'], id);
  for (const id of text) assert.deepEqual(findModel(id)?.inputModalities, ['text'], id);
  for (const id of unknown) assert.equal(findModel(id)?.inputModalities, undefined, id);
});

test('全 39 型号的思考档位矩阵按厂商官方文档逐型号固定', () => {
  assert.equal(EFFORT_MATRIX.size, 39);
  assert.deepEqual([...EFFORT_MATRIX.keys()].sort(), MODELS.map(model => model.id).sort());
  for (const model of MODELS) {
    const expected = EFFORT_MATRIX.get(model.id);
    assert.ok(expected !== undefined, `${model.id} 缺少思考档位期望值`);
    if (expected === null) {
      // 厂商档位未确认：保持缺省，而不是猜测一个默认集合。
      assert.equal(model.reasoningEfforts, undefined, `${model.id} 档位未确认时不应携带 reasoningEfforts`);
      continue;
    }
    assert.deepEqual(model.reasoningEfforts, expected, `${model.id} reasoningEfforts`);
  }
});

test('思考档位只取厂商文档化的取值，且 none 只出现在官方确认支持的型号上', () => {
  for (const model of MODELS) {
    for (const effort of model.reasoningEfforts ?? []) {
      assert.ok(KNOWN_EFFORTS.has(effort), `${model.id} 含未文档化档位 ${effort}`);
      assert.notEqual(effort, 'ultra', `${model.id} 不应含无厂商支持的 ultra`);
    }
  }
  for (const model of MODELS) {
    const supportsNone = (model.reasoningEfforts ?? []).includes('none');
    if (model.id.startsWith('claude-')) {
      assert.equal(supportsNone, false, `${model.id} 的 Anthropic effort 不含 none`);
    }
    if (model.id === 'gpt-6.1-sol' || model.id === 'gpt-6-astra') {
      assert.equal(supportsNone, false, `${model.id} 官方明文不支持 none`);
    }
    if (model.id.startsWith('gpt-')) {
      assert.equal(supportsNone, OPENAI_NONE_MODELS.has(model.id), `${model.id} 的 none 支持与官方文档不一致`);
    }
  }
  for (const id of ANTHROPIC_MODELS) {
    const model = findModel(id);
    assert.ok(model);
    assert.deepEqual(model.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max'], `${id} 的 Anthropic 档位集合`);
    assert.equal((model.reasoningEfforts ?? []).includes('minimal'), false, `${id} 不含 minimal`);
  }
});

test('没有可调档位的型号用空集合，档位未确认的型号保持缺省', () => {
  for (const id of ['kimi-k2.7-code', 'mimo-v2.6-pro', 'mimo-v2.6-flash', 'qwen3.7-max']) {
    const model = findModel(id);
    assert.ok(model);
    assert.deepEqual(model.reasoningEfforts, [], `${id} 应为空档位集合`);
  }
  const unknown = findModel('muse-wonder');
  assert.ok(unknown);
  assert.equal(unknown.reasoningEfforts, undefined, 'muse-wonder 档位未确认，应保持缺省');
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
