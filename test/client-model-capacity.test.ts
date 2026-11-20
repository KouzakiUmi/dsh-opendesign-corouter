import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedModelRow, cachedModelRowCount, ensureModelRows, modelRowsFresh, resetModelCapacity } from '../src/client-model-capacity.js';
import type { RpcCaller } from '../src/client.js';

const row = (id: string, contextWindow?: number) => ({ id, name: id, group: 'plan' as const, ...(contextWindow === undefined ? {} : { contextWindow }) });
const status = (models: unknown[]) => ({ models });
function counting(models: unknown[] = [row('deepseek-v4.1-flash', 1_000_000)], fail = false): { caller: RpcCaller; calls: () => number } {
  let calls = 0;
  const caller = (async () => {
    calls++;
    if (fail) throw new Error('offline');
    return status(models);
  }) as unknown as RpcCaller;
  return { caller, calls: () => calls };
}

test('one shared read fills the cache and a fresh cache answers without another call', async () => {
  resetModelCapacity();
  const { caller, calls } = counting();
  assert.equal(cachedModelRow('deepseek-v4.1-flash'), undefined, 'nothing is cached before the first read');
  await Promise.all([ensureModelRows(caller), ensureModelRows(caller), ensureModelRows(caller)]);
  assert.equal(calls(), 1, 'concurrent callers share one in-flight read');
  assert.equal(cachedModelRowCount(), 1);
  assert.equal(cachedModelRow('deepseek-v4.1-flash')?.contextWindow, 1_000_000);
  assert.equal(modelRowsFresh(), true);
  await ensureModelRows(caller);
  assert.equal(calls(), 1, 'a fresh cache is not read again');
  await ensureModelRows(caller, { force: true });
  assert.equal(calls(), 2, 'an explicit retry reads again');
  resetModelCapacity();
});

test('a failed read keeps the previous rows and never rejects', async () => {
  resetModelCapacity();
  const ok = counting([row('gpt-6-luna', 1_050_000)]);
  await ensureModelRows(ok.caller);
  resetModelCapacity();
  const failing = counting([], true);
  await ensureModelRows(failing.caller);
  assert.equal(cachedModelRow('gpt-6-luna'), undefined, 'a failed first read caches nothing and does not throw');
  // A later success fills the cache.
  const retry = counting([row('gpt-6-luna', 1_050_000)]);
  await ensureModelRows(retry.caller, { force: true });
  assert.equal(cachedModelRow('gpt-6-luna')?.contextWindow, 1_050_000);
  resetModelCapacity();
});

test('the refresh window decides freshness from the read time', async () => {
  resetModelCapacity();
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  try {
    const { caller, calls } = counting();
    assert.equal(modelRowsFresh(), false, 'an empty cache is never fresh');
    await ensureModelRows(caller);
    assert.equal(modelRowsFresh(), true);
    clock += 5 * 60_000;
    assert.equal(modelRowsFresh(), false, 'the window expires after five minutes');
    await ensureModelRows(caller);
    assert.equal(calls(), 2);
  } finally { Date.now = now; resetModelCapacity(); }
});
