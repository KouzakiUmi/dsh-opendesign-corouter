// Tests for src/catalog.ts.
// 目录事实：2026-11-17 scoped service catalog；公开套餐卡仅作 seed，不当账号权益。
// 新容量证据：Claude Fable 5.2 型号页、腾讯 TokenHub 78934/80637、百炼 qwen4-max。
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
import { effectiveProtocol, type ApiProtocol } from '../src/protocol-options.js';

// Public seed only: actual Host grouping requires fresh scoped entitlement evidence.
const PLAN_IDS = [
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-eco',
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

// Seed paid/other rows; this list is not an account entitlement assertion.
const PAID_IDS = [
  'claude-haiku-5.5', 'gpt-6-luna', 'glm-5.3-flashx',
  'claude-fable-5.2', 'gemini-4-carbon', 'hy4', 'hy4-flash', 'muse-ember-1.0', 'qwen4-max',
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
 * 全 46 型号的思考档位矩阵（厂商官方文档逐型号取值）。
 * `[]` = 该型号没有可调的思考档位；`null` = 厂商档位未确认（目录中保持缺省）。
 */
const EFFORT_MATRIX = new Map<string, readonly string[] | null>([
  ['claude-fable-5.2', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['deepseek-v4.1-flash-eco', null], ['gemini-4-carbon', null], ['muse-ember-1.0', null],
  // 2026-11-18 official audit: Hy4 Chat no_think is a switch, not another depth level.
  ['hy4', ['none', 'high']], ['hy4-flash', ['none', 'high']], ['qwen4-max', ['low', 'high', 'xhigh']],
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
  ['deepseek-v4.1-flash', ['none', 'low', 'high', 'max']],
  ['deepseek-v4-pro', ['none', 'low', 'high', 'max']],
  ['deepseek-v4-flash', ['none', 'low', 'high', 'max']],
  ['deepseek-v4-flash-vision-exp', ['none', 'low', 'high', 'max']],
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
  ['mimo-v2.6-pro', ['none', 'high']],
  ['mimo-v2.6-flash', ['none', 'high']],
  ['hy4-preview', ['none', 'high']],
  ['qwen3.7-max', ['none', 'high']],
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
  'claude-fable-5.2',
  'claude-fable-5.1',
  'claude-fable-5',
  'claude-opus-5.5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-sonnet-5.5',
  'claude-sonnet-5',
  'claude-haiku-5.5',
] as const;

test('catalog seed 收录 46 个目录项：公开分组 11 + 35，不等于账号权益', () => {
  assert.equal(MODELS.length, 46);
  assert.equal(modelsFor('plan').length, 11);
  assert.equal(modelsFor('paid').length, 35);
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
  for (const id of ['gpt-image-2', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'wan-2.7', 'nano-banana-2', 'seedream-5.0']) {
    assert.equal(findModel(id), undefined, `${id} 不应出现在目录中`);
  }
});

test('原 12 款容量/输出参考不因套餐分组变化而丢失', () => {
  assert.equal(GO_CAPACITY.size, 12);
  for (const [id, expected] of GO_CAPACITY) {
    const model = findModel(id)!;
    assert.ok(model, `${id} must remain in catalog`);
    assert.equal(model.contextWindow, expected.contextWindow, `${model.id} contextWindow`);
    assert.equal(model.maxOutputTokens, expected.maxOutputTokens, `${model.id} maxOutputTokens`);
    assert.deepEqual(model.inputModalities, expected.inputModalities, `${model.id} inputModalities`);
  }
});

test('46 个模型容量按完整证据矩阵固定，未知不借用相邻型号', () => {
  const windows = new Map<string, number | undefined>([
    ['claude-fable-5.2', 1_000_000], ['deepseek-v4.1-flash-eco', undefined],
    ['gemini-4-carbon', undefined], ['muse-ember-1.0', undefined],
    ['hy4', 1_000_000], ['hy4-flash', 1_000_000], ['qwen4-max', 1_000_000],
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
  assert.equal(windows.size, 46);
  assert.deepEqual([...windows.keys()].sort(), MODELS.map(row => row.id).sort());
  for (const row of MODELS) assert.equal(row.contextWindow, windows.get(row.id), row.id);
  const outputCaps = new Map([...GO_CAPACITY].map(([id, value]) => [id, value.maxOutputTokens] as const));
  outputCaps.set('gpt-6.1-terra', 128_000);
  outputCaps.set('claude-fable-5.2', 128_000);
  outputCaps.set('hy4', 64_000); outputCaps.set('hy4-flash', 64_000);
  outputCaps.set('qwen4-max', 131_072); // Conservative cap shared by both documented modes.
  for (const row of MODELS) assert.equal(row.maxOutputTokens, outputCaps.get(row.id), `${row.id} output cap`);
});

test('图片输入能力采用逐型号证据，未确认模型保持未知', () => {
  const image = [
    'claude-fable-5.2', 'hy4', 'hy4-flash', 'qwen4-max',
    'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
    'claude-fable-5.1', 'claude-fable-5', 'claude-opus-5.5', 'claude-opus-5', 'claude-opus-4.8', 'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-haiku-5.5',
    'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'glm-5.3-flashx', 'glm-5.3-flash',
    'kimi-k2.7-code', 'kimi-k3', 'kimi-k3.1-pro', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash',
    'grok-4.7', 'grok-4.6', 'grok-4.5', 'mimo-v2.6-pro', 'mimo-v2.6-flash', 'minimax-m3.1-flash', 'muse-spark-1.3',
  ];
  const text = ['glm-5.2', 'qwen3.7-max', 'hy4-preview'];
  const unknown = ['deepseek-v4-pro', 'muse-wonder', 'deepseek-v4.1-flash-eco', 'gemini-4-carbon', 'muse-ember-1.0'];
  assert.deepEqual([...image, ...text, ...unknown].sort(), MODELS.map(model => model.id).sort());
  for (const id of image) assert.deepEqual(findModel(id)?.inputModalities, ['text', 'image'], id);
  for (const id of text) assert.deepEqual(findModel(id)?.inputModalities, ['text'], id);
  for (const id of unknown) assert.equal(findModel(id)?.inputModalities, undefined, id);
});

test('全 46 型号的思考档位矩阵按厂商官方文档逐型号固定', () => {
  assert.equal(EFFORT_MATRIX.size, 46);
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

/**
 * 目录采用的默认档位。绝大多数取 docs/reasoning-evidence.md 的“官方默认”列；
 * gpt-6-astra 与 muse-spark-1.3 的厂商未声明默认，取已发布实现记录的路由默认
 * （Codex CLI 注册表 Astra=low、Meta 合作客户端 Muse Spark 1.3=high）。
 * 未列出的型号表示没有任何有出处的默认：目录必须保持缺省，不猜一个档位。
 */
const DEFAULT_EFFORT_MATRIX = new Map<string, string>([
  ['claude-fable-5.2', 'high'], ['hy4', 'high'], ['hy4-flash', 'high'], ['qwen4-max', 'high'],
  ['gpt-6.1-sol', 'medium'], ['gpt-6.1-terra', 'medium'], ['gpt-6-luna', 'medium'],
  ['gpt-6-sol', 'medium'], ['gpt-5.6-luna', 'medium'], ['gpt-5.6-sol', 'medium'], ['gpt-5.6-terra', 'medium'],
  ['gpt-6-astra', 'low'],
  ['claude-fable-5.1', 'high'], ['claude-fable-5', 'high'], ['claude-opus-5.5', 'medium'],
  ['claude-opus-5', 'high'], ['claude-opus-4.8', 'high'], ['claude-sonnet-5.5', 'high'],
  ['claude-sonnet-5', 'high'], ['claude-haiku-5.5', 'medium'],
  ['deepseek-v4.1-flash', 'high'], ['deepseek-v4-pro', 'high'],
  ['deepseek-v4-flash', 'high'], ['deepseek-v4-flash-vision-exp', 'high'],
  ['glm-5.3-flashx', 'max'], ['glm-5.3-flash', 'max'], ['glm-5.2', 'max'],
  ['kimi-k3', 'max'], ['kimi-k3.1-pro', 'max'],
  ['gemini-4-argon', 'medium'], ['gemini-3.8-flash', 'medium'], ['gemini-3.7-flash', 'medium'],
  ['grok-4.7', 'high'], ['grok-4.6', 'high'], ['grok-4.5', 'high'],
  ['hy4-preview', 'high'], ['minimax-m3.1-flash', 'max'], ['muse-spark-1.3', 'high'],
  // MiMo and Qwen3.7 default enabled; high is internal on, never a claimed intensity.
  ['mimo-v2.6-pro', 'high'], ['mimo-v2.6-flash', 'high'], ['qwen3.7-max', 'high'],
]);

test('每个可调档位的型号都带一个有出处的默认档位，未知型号保持缺省', () => {
  for (const model of MODELS) {
    const expected = DEFAULT_EFFORT_MATRIX.get(model.id);
    if (expected === undefined) {
      // Fixed Kimi and all four unknown rows have no adjustable default.
      assert.equal(model.defaultEffort, undefined, `${model.id} 没有有出处的默认档位时不应携带 defaultEffort`);
      continue;
    }
    assert.equal(model.defaultEffort, expected, `${model.id} defaultEffort`);
    assert.ok((model.reasoningEfforts ?? []).includes(expected), `${model.id} 的默认档位必须属于该型号的档位集合`);
  }
  // 每个带档位集合的型号都必须有默认值，否则模型选择器会退回 provider-default 项。
  for (const model of MODELS.filter(row => (row.reasoningEfforts ?? []).length > 0)) {
    assert.ok(model.defaultEffort !== undefined, `${model.id} 带档位集合却没有默认档位`);
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

test('fixed与toggle按完整精确矩阵区分，未知型号不伪造控制', () => {
  const modes = new Map<string, 'toggle' | 'fixed'>([
    ['kimi-k2.7-code', 'fixed'], ['mimo-v2.6-pro', 'toggle'], ['mimo-v2.6-flash', 'toggle'],
    ['qwen3.7-max', 'toggle'], ['hy4', 'toggle'], ['hy4-flash', 'toggle'], ['hy4-preview', 'toggle'],
  ]);
  for (const model of MODELS) assert.equal(model.reasoningMode, modes.get(model.id), model.id);
  for (const id of ['kimi-k2.7-code']) {
    const model = findModel(id);
    assert.ok(model);
    assert.deepEqual(model.reasoningEfforts, [], `${id} 应为空档位集合`);
  }
  for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'qwen3.7-max', 'hy4', 'hy4-flash']) {
    assert.deepEqual(findModel(id)!.reasoningEfforts, ['none', 'high'], `${id} internal off/on only`);
    assert.equal(findModel(id)!.defaultEffort, 'high', `${id} defaults enabled`);
  }
  for (const id of ['muse-wonder', 'deepseek-v4.1-flash-eco', 'gemini-4-carbon', 'muse-ember-1.0']) {
    const unknown = findModel(id);
    assert.ok(unknown);
    assert.equal(unknown.reasoningEfforts, undefined, `${id} 档位未确认，应保持缺省`);
    assert.equal(unknown.reasoningMode, undefined);
    assert.equal(unknown.defaultEffort, undefined);
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

test('首选协议采用精确 ID 证据，未确认路由只按产品策略默认 Responses', () => {
  const preferred = new Map<string, ApiProtocol>([
    ...['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
      'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].map(id => [id, 'responses'] as const),
    ...['claude-fable-5.2', 'claude-fable-5.1', 'claude-fable-5', 'claude-opus-5.5', 'claude-opus-5', 'claude-opus-4.8',
      'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-haiku-5.5'].map(id => [id, 'messages'] as const),
    ...['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2',
      'mimo-v2.6-pro', 'mimo-v2.6-flash', 'qwen3.7-max', 'hy4-preview'].map(id => [id, 'chat-completions'] as const),
  ]);
  for (const model of MODELS) {
    assert.equal(model.nativeProtocol, preferred.get(model.id), `${model.id} native evidence`);
    assert.equal(effectiveProtocol(model), preferred.get(model.id) ?? 'responses', `${model.id} auto selection`);
  }
  for (const id of ['deepseek-v4.1-flash-eco', 'gemini-4-carbon', 'muse-ember-1.0']) {
    const row = findModel(id)!;
    assert.equal(row.contextWindow, undefined, `${id} context unknown`);
    assert.equal(row.maxOutputTokens, undefined, `${id} output unknown`);
    assert.equal(row.inputModalities, undefined, `${id} input unknown`);
    assert.equal(row.reasoningEfforts, undefined, `${id} effort unknown`);
    assert.equal(row.defaultEffort, undefined, `${id} default unknown`);
    assert.equal(row.nativeProtocol, undefined, `${id} native route unknown`);
  }
});

test('modelsFor 返回顺序与 MODELS 中的相对顺序一致，且覆盖全部模型', () => {
  for (const group of ['plan', 'paid'] as const) {
    assert.deepEqual(modelsFor(group), MODELS.filter(model => model.group === group));
  }
  assert.equal(modelsFor('plan').length + modelsFor('paid').length, MODELS.length);
});
