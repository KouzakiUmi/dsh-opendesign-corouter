import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotaCache, quotaCacheSnapshot, restoredQuotaSnapshot, QUOTA_CACHE_MAX_AGE_MS } from '../src/quota-cache.js';
import type { QuotaSnapshot } from '../src/quota.js';

const reading: QuotaSnapshot = {
  state: 'ok', source: 'login', updatedAt: '2026-11-18T08:00:00.000Z', tier: 'go', eligible: true,
  windows: [{ durationSeconds: 18_000, used: 120, limit: 500, remaining: 380, percent: 24, resetsAt: '2026-11-18T13:00:00.000Z', windowStart: '2026-11-18T08:00:00.000Z', resetMode: 'activity_triggered' }],
  balances: { subscriptionUsd: 12.5, rechargeUsd: 3, totalUsd: 15.5 },
  subscriptionPeriodStart: '2026-11-01T00:00:00.000Z', subscriptionPeriodEnd: '2026-12-01T00:00:00.000Z',
  note: '桌面登录态仅提供部分额度。',
};
const record = () => ({ version: 1, binding: 'a'.repeat(64), readAt: reading.updatedAt, snapshot: reading });

test('a saved reading round-trips through the persisted shape', () => {
  const parsed = parseQuotaCache(JSON.parse(JSON.stringify(record())));
  assert.deepEqual(parsed?.snapshot, reading);
  assert.equal(parsed?.binding, 'a'.repeat(64));
  // The transform is serialized as source, so it must survive a plain source re-evaluation.
  const rebuilt = (0, eval)(`(${parseQuotaCache.toString()})`)(JSON.parse(JSON.stringify(record())));
  assert.deepEqual(rebuilt, parsed);
});

test('runtime bookkeeping never enters the saved reading', () => {
  const live: QuotaSnapshot = { ...reading, stale: true, refreshFailures: 3, autoRefreshPaused: true, nextRefreshAt: '2026-11-18T09:00:00.000Z' };
  const snapshot = quotaCacheSnapshot(live);
  assert.deepEqual(snapshot, reading);
});

test('a restored reading is marked stale and keeps its own update time', () => {
  const parsed = parseQuotaCache(record())!;
  const restored = restoredQuotaSnapshot(parsed, Date.parse(reading.updatedAt) + 60_000)!;
  assert.equal(restored.stale, true);
  assert.equal(restored.updatedAt, reading.updatedAt);
  assert.deepEqual(restored.windows, reading.windows);
  assert.equal(restored.nextRefreshAt, undefined);
  assert.equal(restored.autoRefreshPaused, undefined);
  assert.equal(restoredQuotaSnapshot(parsed, Date.parse(reading.updatedAt) + QUOTA_CACHE_MAX_AGE_MS + 1), undefined, 'an expired reading is not shown');
});

test('corrupt, foreign or empty saved readings are ignored instead of trusted', () => {
  const rejected: unknown[] = [
    null, [], 'reading', {}, { ...record(), version: 2 }, { ...record(), binding: 'not-a-hash' },
    { ...record(), readAt: 'yesterday' }, { ...record(), snapshot: { ...reading, unknownField: 1 } },
    { ...record(), snapshot: { ...reading, state: 'need-login' } },
    { ...record(), snapshot: { ...reading, state: 'error' } },
    { ...record(), snapshot: { ...reading, windows: [{ ...reading.windows[0]!, percent: 140 }] } },
    { ...record(), snapshot: { ...reading, windows: [{ ...reading.windows[0]!, used: -1 }] } },
    { ...record(), snapshot: { ...reading, windows: [{ ...reading.windows[0]!, surprise: 1 }] } },
    { ...record(), snapshot: { ...reading, balances: { walletUsd: 1 } } },
    { ...record(), snapshot: { ...reading, balances: { totalUsd: 'a lot' } } },
    { ...record(), snapshot: { ...reading, windows: [], balances: {} } },
    { ...record(), snapshot: { ...reading, windows: new Array(65).fill(reading.windows[0]) } },
  ];
  for (const value of rejected) assert.equal(parseQuotaCache(value), undefined, JSON.stringify(value));
});

test('a reading with data but no windows is still saved for the wallet view', () => {
  const walletOnly: QuotaSnapshot = { ...reading, windows: [] };
  assert.deepEqual(parseQuotaCache({ ...record(), snapshot: walletOnly })?.snapshot, walletOnly);
});
