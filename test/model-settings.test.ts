// Tests for src/model-settings.ts: allowlist parsing, prototype safety and capacity overrides.
// 全部为内存合成数据；不读凭据、不联网、不触碰宿主 Profile。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { applyModelSettings, isModelEnabled, parseModelSettingsMap } from '../src/model-settings.js';
import { findModel, type CatalogModel } from '../src/catalog.js';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const;
const MAX_ENTRIES = 512;

test('a valid map is copied into fresh objects with only the supported fields', () => {
  const input = { 'deepseek-v4.1-flash': { enabled: false, imageInput: true, temperature: 0.7, topP: 0.9, maxTokens: 32000, contextWindow: 500000, reasoningEffort: 'high' } };
  const map = parseModelSettingsMap(input);
  assert.deepEqual(map, input);
  assert.notEqual(map['deepseek-v4.1-flash'], input['deepseek-v4.1-flash']);
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  // 修改副本不影响原载荷，也不共享嵌套引用。
  map['deepseek-v4.1-flash']!.temperature = 0.1;
  assert.equal(input['deepseek-v4.1-flash'].temperature, 0.7);
});

test('rejects payloads that are not plain objects, and reserved keys', () => {
  for (const value of [undefined, null, 'map', 42, true, [], ['deepseek-v4.1-flash']]) assert.throws(() => parseModelSettingsMap(value), /模型设置必须是对象/u);
  for (const key of ['__proto__', 'constructor', 'prototype']) assert.throws(() => parseModelSettingsMap(JSON.parse(`{"${key}":{"enabled":false}}`)), /保留字段名/u);
  assert.equal(({} as Record<string, unknown>).enabled, undefined);
  assert.equal(({} as Record<string, unknown>).prototype, undefined);
  // 单个条目不是对象时同样拒绝。
  assert.throws(() => parseModelSettingsMap({ 'glm-5.2': null }), /每个模型的设置必须是对象/u);
  assert.throws(() => parseModelSettingsMap({ 'glm-5.2': true }), /每个模型的设置必须是对象/u);
});

test('bounds the map at 512 entries and the model id at 128 allowed characters', () => {
  const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`model-${index}`, {}]));
  assert.equal(Object.keys(parseModelSettingsMap(entries(MAX_ENTRIES))).length, MAX_ENTRIES);
  assert.throws(() => parseModelSettingsMap(entries(MAX_ENTRIES + 1)), /最多允许 512 个模型/u);
  assert.deepEqual(parseModelSettingsMap({ ['a'.repeat(128)]: {} }), { ['a'.repeat(128)]: {} });
  assert.throws(() => parseModelSettingsMap({ ['a'.repeat(129)]: {} }), /模型 ID 必须是/u);
  assert.deepEqual(parseModelSettingsMap({ 'vendor.model:v1/route_a-b': {} }), { 'vendor.model:v1/route_a-b': {} });
  // 字符集就是边界：`.`, `:` , `/` 是合法 id 字符（id 只作映射键，从不作为文件路径）。
  assert.deepEqual(parseModelSettingsMap({ '../gpt': {} }), { '../gpt': {} });
  for (const id of ['', 'gpt 6', 'gpt+6', 'gpt#6', 'gpt@gpt', 'gpt\\6', ' ', 'é']) assert.throws(() => parseModelSettingsMap({ [id]: {} }), /模型 ID 必须是/u, id);
  // 迭代原型链上的名字不能把条目带进来。
  assert.deepEqual(parseModelSettingsMap({}), {});
});

test('unknown fields are refused so secrets cannot ride along', () => {
  assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { apiKey: 'fixture-value' } }), /不支持的字段/u);
  assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { headers: {} } }), /不支持的字段/u);
  assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { enabled: true, token: 'fixture-value' } }), /不支持的字段/u);
  assert.deepEqual(parseModelSettingsMap({ 'glm-5.2': {} }), { 'glm-5.2': {} });
});

test('temperature stays in 0..2 and topP in 0..1', () => {
  for (const temperature of [0, 0.5, 2]) assert.deepEqual(parseModelSettingsMap({ 'glm-5.2': { temperature } }), { 'glm-5.2': { temperature } });
  for (const topP of [0, 0.5, 1]) assert.deepEqual(parseModelSettingsMap({ 'glm-5.2': { topP } }), { 'glm-5.2': { topP } });
  for (const temperature of [-0.01, 2.01, Number.NaN, Number.POSITIVE_INFINITY, '0.7', null, true]) assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { temperature } }), /temperature 必须是 0 到 2/u);
  for (const topP of [-0.01, 1.01, Number.NaN, '0.5', null]) assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { topP } }), /topP 必须是 0 到 1/u);
  assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { enabled: 'true' } }), /enabled 必须是布尔值/u);
});

test('image input override is an explicit boolean and never invents a default', () => {
  for (const imageInput of [true, false]) assert.deepEqual(parseModelSettingsMap({ model: { imageInput } }), { model: { imageInput } });
  for (const imageInput of ['true', 1, null, [], {}]) assert.throws(() => parseModelSettingsMap({ model: { imageInput } }), /imageInput 必须是布尔值/u);
  const image = findModel('gpt-6.1-terra')!;
  const text = findModel('glm-5.2')!;
  const unknown = findModel('muse-wonder')!;
  assert.deepEqual(applyModelSettings(image, { imageInput: false }).inputModalities, ['text']);
  assert.deepEqual(applyModelSettings(text, { imageInput: true }).inputModalities, ['text', 'image']);
  assert.deepEqual(applyModelSettings(unknown, { imageInput: true }).inputModalities, ['text', 'image']);
  assert.deepEqual(applyModelSettings(unknown, { imageInput: false }).inputModalities, ['text']);
  assert.equal(applyModelSettings(unknown).inputModalities, undefined);
  assert.deepEqual(image.inputModalities, ['text', 'image']);
  assert.deepEqual(text.inputModalities, ['text']);
  assert.equal(unknown.inputModalities, undefined);
});

test('capacity fields are positive integers within their ceilings', () => {
  for (const maxTokens of [1, 128000, 10_000_000]) assert.deepEqual(parseModelSettingsMap({ 'glm-5.2': { maxTokens } }), { 'glm-5.2': { maxTokens } });
  for (const contextWindow of [1, 1_000_000, 100_000_000]) assert.deepEqual(parseModelSettingsMap({ 'glm-5.2': { contextWindow } }), { 'glm-5.2': { contextWindow } });
  for (const maxTokens of [0, -1, 1.5, 10_000_001, Number.NaN, '8000']) assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { maxTokens } }), /maxTokens 必须是 1 到 10000000 之间的整数/u);
  for (const contextWindow of [0, -1, 0.5, 100_000_001, Number.NaN, '8000']) assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { contextWindow } }), /contextWindow 必须是 1 到 100000000 之间的整数/u);
});

test('reasoningEffort accepts only the catalog vocabulary', () => {
  for (const reasoningEffort of EFFORTS) assert.deepEqual(parseModelSettingsMap({ 'glm-5.2': { reasoningEffort } }), { 'glm-5.2': { reasoningEffort } });
  for (const reasoningEffort of ['HIGH', 'maximal', 'ultra-high', '', ' ', 1, null]) assert.throws(() => parseModelSettingsMap({ 'glm-5.2': { reasoningEffort } }), /reasoningEffort 不在允许的取值内/u);
});

test('explicit output capacity must be smaller than explicit context capacity', () => {
  for (const maxTokens of [8192, 8193]) {
    assert.throws(() => parseModelSettingsMap({ 'fixture-secret': { maxTokens, contextWindow: 8192 } }), error => {
      assert.match(String(error), /maxTokens 必须小于 contextWindow/u);
      assert.doesNotMatch(String(error), /fixture-secret/u);
      return true;
    });
  }
  assert.deepEqual(parseModelSettingsMap({ model: { maxTokens: 8191, contextWindow: 8192 } }), { model: { maxTokens: 8191, contextWindow: 8192 } });
  // A single explicit capacity inherits its counterpart from the catalog at invocation.
  assert.deepEqual(parseModelSettingsMap({ model: { maxTokens: 8192 } }), { model: { maxTokens: 8192 } });
  assert.deepEqual(parseModelSettingsMap({ model: { contextWindow: 8192 } }), { model: { contextWindow: 8192 } });
  const row = findModel('glm-5.2');
  assert.ok(row);
  // Applying a row preserves the adapter's existing INVALID_REQUEST error boundary.
  assert.deepEqual(applyModelSettings(row, { maxTokens: 8192, contextWindow: 8192 }), { ...row, maxOutputTokens: 8192, contextWindow: 8192 });
});

test('context tiers are allowlisted separately from legacy numeric windows', () => {
  const row = findModel('deepseek-v4.1-flash')!;
  for (const [contextTier, window] of [['default', 256_000], ['extended', 512_000], ['maximum', 1_000_000]] as const) {
    const settings = { model: { contextTier } };
    assert.deepEqual(parseModelSettingsMap(settings), settings);
    assert.equal(applyModelSettings(row, { contextTier }).contextWindow, window);
  }
  for (const contextTier of ['', 'large', '272000', 272000, null, true]) {
    assert.throws(() => parseModelSettingsMap({ model: { contextTier } }), /contextTier/u);
  }
  assert.throws(() => parseModelSettingsMap({ model: { contextWindow: 500_000, contextTier: 'extended' } }), /不能同时设置/u);
  assert.throws(() => applyModelSettings(row, { contextWindow: 500_000, contextTier: 'extended' }), /不能同时设置/u);
  assert.deepEqual(parseModelSettingsMap({ model: { contextTier: 'extended', maxTokens: 500_000 } }), { model: { contextTier: 'extended', maxTokens: 500_000 } });
  const small = { ...row, contextWindow: 96_000 };
  assert.equal(applyModelSettings(small).contextWindow, 32_000);
  assert.equal(applyModelSettings(small, { contextTier: 'maximum' }).contextWindow, 96_000);
  assert.equal(applyModelSettings(small, { contextWindow: 500_000 }).contextWindow, 500_000, 'legacy overrides are not reinterpreted as tiers');
});

test('schema accepts tier and output independently without a model reference, including after fresh-realm reconstruction', () => {
  // The browser reconstructs this callback without access to module bindings.
  const rebuilt = runInNewContext(`(${parseModelSettingsMap.toString()})`) as typeof parseModelSettingsMap;
  for (const parse of [parseModelSettingsMap, rebuilt]) {
    for (const contextTier of ['default', 'extended', 'maximum'] as const) {
      for (const maxTokens of [32_000, 256_000, 272_000, 500_000, 512_000, 872_000, 1_000_000, 10_000_000]) {
        const settings = { model: { contextTier, maxTokens } };
        assert.deepEqual(JSON.parse(JSON.stringify(parse(settings))), settings, `${contextTier}/${maxTokens}`);
      }
    }
    assert.throws(() => parse({ model: { contextWindow: 512_000, maxTokens: 512_000 } }), /maxTokens 必须小于 contextWindow/u);
    assert.throws(() => parse({ model: { contextWindow: 512_000, contextTier: 'extended' } }), /不能同时设置/u);
    assert.throws(() => parse({ model: { contextTier: 'invalid' } }), /contextTier/u);
    assert.throws(() => parse({ model: { contextTier: 'maximum', maxTokens: 10_000_001 } }), /maxTokens/u);
  }
});

test('model reference selects its own tiers while unknown rows and legacy numbers retain their meaning', () => {
  const row = findModel('deepseek-v4.1-flash')!;
  for (const [reference, expected] of [
    [1_050_000, [256_000, 512_000, 1_050_000]],
    [1_048_576, [262_144, 524_288, 1_048_576]],
    [262_144, [65_536, 131_072, 262_144]],
    [500_000, [128_000, 256_000, 500_000]],
    [96_000, [32_000, 64_000, 96_000]],
  ] as const) {
    const referenceRow = { ...row, contextWindow: reference };
    for (const [index, contextTier] of (['default', 'extended', 'maximum'] as const).entries()) {
      assert.equal(applyModelSettings(referenceRow, { contextTier }).contextWindow, expected[index]);
    }
    assert.equal(referenceRow.contextWindow, reference);
  }
  const unknown: CatalogModel = { id: 'unknown-model', name: 'Unknown', group: 'paid' };
  for (const contextTier of [undefined, 'default', 'extended', 'maximum'] as const) {
    assert.equal(applyModelSettings(unknown, contextTier === undefined ? {} : { contextTier }).contextWindow, undefined);
  }
  for (const contextWindow of [65_536, 256_000, 512_000, 1_000_000, 100_000_000]) {
    assert.equal(applyModelSettings({ ...row, contextWindow: 96_000 }, { contextWindow }).contextWindow, contextWindow);
    assert.equal(applyModelSettings(unknown, { contextWindow }).contextWindow, contextWindow);
  }
});

test('applyModelSettings overrides capacity on a copy and never mutates the catalog row', () => {
  const row = findModel('deepseek-v4.1-flash');
  assert.ok(row);
  const copy = applyModelSettings(row, { contextWindow: 500_000, maxTokens: 64_000 });
  assert.notEqual(copy, row);
  assert.equal(copy.contextWindow, 500_000);
  assert.equal(copy.maxOutputTokens, 64_000);
  assert.equal(copy.id, row.id);
  assert.equal(copy.name, row.name);
  assert.equal(copy.group, row.group);
  assert.deepEqual(copy.inputModalities, row.inputModalities);
  // 原始目录行保持官网/Go defaults 取证值。
  assert.equal(row.contextWindow, 1_000_000);
  assert.equal(row.maxOutputTokens, 384_000);
  // 缺省使用工作总窗口，目录参考本身不变；采样参数仍属于请求。
  const defaultRow = { ...row, contextWindow: 256_000 };
  assert.deepEqual(applyModelSettings(row), defaultRow);
  assert.deepEqual(applyModelSettings(row, {}), defaultRow);
  assert.deepEqual(applyModelSettings(row, { temperature: 0.3, topP: 0.8, reasoningEffort: 'low' }), defaultRow);
  assert.equal(applyModelSettings(row, { contextWindow: 200_000 }).maxOutputTokens, row.maxOutputTokens);
  assert.equal(applyModelSettings(row, { maxTokens: 8_000 }).contextWindow, 256_000);
  // 动态发现且无容量的模型可由用户显式补上，仍然不推断其它能力。
  const paid: CatalogModel = { id: 'future-model', name: 'Future model', group: 'paid' };
  const tuned = applyModelSettings(paid, { contextWindow: 300_000, maxTokens: 16_000 });
  assert.deepEqual(tuned, { ...paid, contextWindow: 300_000, maxOutputTokens: 16_000 });
  assert.equal(paid.contextWindow, undefined);
});

test('applyModelSettings refuses programmatic capacities outside the parser bounds', () => {
  const row = findModel('glm-5.2');
  assert.ok(row);
  for (const contextWindow of [0, -1, 1.5, 100_000_001, Number.NaN]) assert.throws(() => applyModelSettings(row, { contextWindow }), /contextWindow 必须是 1 到 100000000 之间的整数/u);
  for (const maxTokens of [0, -1, 10_000_001, Number.NaN]) assert.throws(() => applyModelSettings(row, { maxTokens }), /maxTokens 必须是 1 到 10000000 之间的整数/u);
});

test('isModelEnabled defaults to enabled and never reads the prototype chain', () => {
  const map = parseModelSettingsMap({ 'claude-opus-5': { enabled: false }, 'glm-5.2': { enabled: true }, 'deepseek-v4-pro': { temperature: 0.2 } });
  assert.equal(isModelEnabled('claude-opus-5', map), false);
  assert.equal(isModelEnabled('glm-5.2', map), true);
  assert.equal(isModelEnabled('deepseek-v4-pro', map), true);
  assert.equal(isModelEnabled('never-mentioned', map), true);
  assert.equal(isModelEnabled('claude-opus-5'), true);
  assert.equal(isModelEnabled('', map), true);
  assert.equal(isModelEnabled('constructor', {}), true);
  assert.equal(isModelEnabled('toString', {}), true);
  assert.equal(isModelEnabled('__proto__', {}), true);
});
