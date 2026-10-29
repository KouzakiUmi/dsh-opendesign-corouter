import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_WINDOW_PRESETS, contextWindowPreset, effectiveContextWindow } from '../src/context-budget.js';

test('context presets are fixed decimal-token combined windows', () => {
  assert.deepEqual(CONTEXT_WINDOW_PRESETS.map(({ id, tokens }) => ({ id, tokens })), [
    { id: 'default', tokens: 272_000 },
    { id: 'extended', tokens: 500_000 },
    { id: 'maximum', tokens: 872_000 },
  ]);
  assert.equal(contextWindowPreset(undefined), 'default');
  assert.equal(contextWindowPreset(undefined, 'default'), 'default');
  assert.equal(contextWindowPreset(undefined, 'extended'), 'extended');
  assert.equal(contextWindowPreset(undefined, 'maximum'), 'maximum');
});

test('default and explicit presets are limited by the known reference', () => {
  assert.equal(effectiveContextWindow(1_000_000), 272_000);
  assert.equal(effectiveContextWindow(1_000_000, undefined, 'extended'), 500_000);
  assert.equal(effectiveContextWindow(1_000_000, undefined, 'maximum'), 872_000);
  assert.equal(effectiveContextWindow(262_144), 262_144);
  assert.equal(effectiveContextWindow(262_144, undefined, 'extended'), 262_144);
  assert.equal(effectiveContextWindow(96_000, undefined, 'maximum'), 96_000);
  assert.equal(effectiveContextWindow(500_000, undefined, 'maximum'), 500_000);
});

test('unknown references still receive an explicit local working budget', () => {
  assert.equal(effectiveContextWindow(undefined), 272_000);
  assert.equal(effectiveContextWindow(undefined, undefined, 'extended'), 500_000);
  assert.equal(effectiveContextWindow(undefined, undefined, 'maximum'), 872_000);
});

test('legacy custom windows stay distinguishable and unchanged until replaced', () => {
  for (const saved of [8_192, 200_000, 272_000, 500_000, 512_000, 872_000, 1_000_000, 100_000_000]) {
    assert.equal(contextWindowPreset(saved), undefined);
    assert.equal(effectiveContextWindow(500_000, saved), saved);
    assert.equal(effectiveContextWindow(undefined, saved), saved);
  }
});
