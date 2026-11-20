import test from 'node:test';
import assert from 'node:assert/strict';
import { quickControlState, type QuickControlInputs } from '../src/client-control-state.js';
import type { StatusModel } from '../src/remote.js';

const row: StatusModel = { id: 'm', name: 'M', group: 'plan', contextWindow: 1_000_000 };
const base = (): QuickControlInputs => ({
  directory: { current: { provider: 'opendesign-corouter-plan', model: 'm' }, pending: null, status: 'ready', groups: [], routable: true },
  form: { status: 'ready', writable: true, value: { modelSettings: {} } },
  values: { modelSettings: {} },
  pendingFields: [],
  modelId: 'm',
  row,
  awaiting: false,
});

test('a background directory refresh never blocks the control', () => {
  for (const status of ['loading', 'idle', 'selecting'] as const) {
    const state = quickControlState({ ...base(), directory: { ...base().directory, status } });
    assert.equal(state.reason, undefined, status);
    assert.equal(state.pending, false);
  }
});

test('only real unavailability blocks, each with its own reason', () => {
  const cases: Array<[Partial<QuickControlInputs>, string]> = [
    [{ directory: { ...base().directory, status: 'error' } }, '会话模型目录读取失败'],
    [{ directory: { ...base().directory, pending: { provider: 'opendesign-corouter-plan', model: 'other' } } }, '正在切换模型'],
    [{ form: { status: 'unavailable', writable: true, value: undefined } }, '模型设置暂不可用'],
    [{ form: { status: 'loading', writable: false, value: undefined } }, '正在载入模型设置'],
    [{ form: { status: 'ready', writable: false, value: { modelSettings: {} } } }, '当前设置为只读'],
    [{ pendingFields: ['modelSettings'] }, '正在保存模型设置'],
    [{ row: undefined, awaiting: true }, '正在读取模型参考容量'],
    [{ row: undefined, awaiting: false }, '当前模型不在 CoRouter 目录中'],
  ];
  for (const [patch, expected] of cases) {
    const state = quickControlState({ ...base(), ...patch });
    assert.ok(state.reason?.includes(expected), `${expected}: got ${state.reason}`);
  }
});

test('the pending save overlay supplies the settings the control renders', () => {
  const state = quickControlState({
    ...base(),
    values: { modelSettings: { m: { contextTier: 'extended' }, other: { temperature: 0.4 } } },
    pendingFields: ['modelSettings'],
  });
  assert.deepEqual(state.settings, { contextTier: 'extended' });
  assert.deepEqual(state.settingsMap.other, { temperature: 0.4 });
  assert.equal(state.pending, true);
  assert.match(state.reason ?? '', /正在保存模型设置/u);
});
