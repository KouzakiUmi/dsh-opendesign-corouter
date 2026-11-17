import assert from 'node:assert/strict';
import test from 'node:test';
import { contextWindowPresets, contextWindowPreset, effectiveContextWindow } from '../src/context-budget.js';

const windows = [
  [1_000_000, [256_000, 512_000, 1_000_000]],
  [1_050_000, [256_000, 512_000, 1_050_000]],
  [1_048_576, [262_144, 524_288, 1_048_576]],
  [262_144, [65_536, 131_072, 262_144]],
  [500_000, [128_000, 256_000, 500_000]],
  [96_000, [32_000, 64_000, 96_000]],
  [4_096, [1_024, 2_048, 4_096]],
  [4_095, [1_024, 2_048, 4_095]],
  [3, [1, 2, 3]],
  [2, [1, 1, 2]],
  [1, [1, 1, 1]],
] as const;

test('context presets derive three combined windows from the exact reference', () => {
  for (const [reference, expected] of windows) {
    const presets = contextWindowPresets(reference);
    assert.deepEqual(presets.map(({ id }) => id), ['default', 'extended', 'maximum']);
    assert.deepEqual(presets.map(({ tokens }) => tokens), [...expected], String(reference));
    assert.ok(presets.every(({ label }) => typeof label === 'string' && label.length > 0));
    for (const [index, tier] of ['default', 'extended', 'maximum'].entries()) {
      assert.equal(effectiveContextWindow(reference, undefined, tier as 'default' | 'extended' | 'maximum'), expected[index], `${reference}/${tier}`);
    }
    assert.equal(effectiveContextWindow(reference), expected[0]);
  }
});

test('unknown and invalid references never fabricate a model window', () => {
  assert.deepEqual(contextWindowPresets().map(({ tokens }) => tokens), [undefined, undefined, undefined]);
  for (const reference of [undefined, 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(contextWindowPresets(reference).map(({ tokens }) => tokens), [undefined, undefined, undefined], String(reference));
    for (const tier of [undefined, 'default', 'extended', 'maximum'] as const) {
      assert.equal(effectiveContextWindow(reference, undefined, tier), undefined, `${reference}/${tier}`);
    }
  }
});

test('only explicit tier ids select a preset', () => {
  assert.equal(contextWindowPreset(undefined), 'default');
  for (const tier of ['default', 'extended', 'maximum'] as const) {
    assert.equal(contextWindowPreset(undefined, tier), tier);
  }
});

test('legacy custom windows stay distinguishable and uncapped even when equal to a tier', () => {
  for (const saved of [1, 8_192, 65_536, 128_000, 256_000, 262_144, 272_000, 500_000, 512_000, 872_000, 1_000_000, 1_050_000, 100_000_000]) {
    assert.equal(contextWindowPreset(saved), undefined);
    assert.equal(effectiveContextWindow(96_000, saved), saved);
    assert.equal(effectiveContextWindow(undefined, saved), saved);
  }
});
