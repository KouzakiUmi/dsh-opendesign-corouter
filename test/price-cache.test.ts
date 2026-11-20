import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceCache, priceCacheRecord, restoredPriceCatalog, PRICE_CACHE_MAX_AGE_MS } from '../src/price-cache.js';
import type { PriceCatalog } from '../src/remote.js';

const FETCHED_AT = '2026-11-18T08:00:00.000Z';
const catalog: PriceCatalog = {
  state: 'ok', stale: false, fetchedAt: FETCHED_AT,
  models: [{ id: 'gpt-6.1-sol', tiers: [
    { label: '27.2 万 Token 及以内', currency: 'USD', unit: 'per_1m_tokens', input: 2, output: 10, cacheRead: 0.1, cacheWrite: null },
    { label: '超过 27.2 万 Token', currency: 'USD', unit: 'per_1m_tokens', input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
  ] }],
};
const record = () => ({ version: 1, fetchedAt: FETCHED_AT, state: 'ok', models: catalog.models });

test('a saved price snapshot round-trips through the persisted shape and a fresh realm', () => {
  const parsed = parsePriceCache(JSON.parse(JSON.stringify(record())));
  assert.deepEqual(parsed?.models, catalog.models);
  assert.equal(parsed?.fetchedAt, FETCHED_AT);
  // The transform is serialized as source, so it must survive a plain source re-evaluation.
  const rebuilt = (0, eval)(`(${parsePriceCache.toString()})`)(JSON.parse(JSON.stringify(record())));
  assert.deepEqual(rebuilt, parsed);
});

test('only successful non-empty snapshots with a timestamp are saved; stale is runtime-only', () => {
  assert.deepEqual(priceCacheRecord({ ...catalog, stale: true }), { version: 1, fetchedAt: FETCHED_AT, state: 'ok', models: catalog.models });
  assert.equal(priceCacheRecord({ ...catalog, state: 'partial' })?.state, 'partial');
  assert.equal(priceCacheRecord({ ...catalog, state: 'error' }), undefined);
  assert.equal(priceCacheRecord({ ...catalog, models: [] }), undefined);
  const { fetchedAt: _noTime, ...withoutTime } = catalog;
  assert.equal(priceCacheRecord(withoutTime), undefined);
});

test('a restored snapshot is marked stale, keeps its own time, and expires after seven days', () => {
  const parsed = parsePriceCache(record())!;
  const restored = restoredPriceCatalog(parsed, Date.parse(FETCHED_AT) + 60_000)!;
  assert.equal(restored.stale, true);
  assert.equal(restored.fetchedAt, FETCHED_AT);
  assert.deepEqual(restored.models, catalog.models);
  assert.equal(restoredPriceCatalog(parsed, Date.parse(FETCHED_AT) + PRICE_CACHE_MAX_AGE_MS + 1), undefined);
});

test('corrupt or out-of-bounds saved snapshots are ignored instead of trusted', () => {
  const tier = catalog.models[0]!.tiers[0]!;
  const rejected: unknown[] = [
    null, [], 'snapshot', {}, { ...record(), version: 2 },
    { ...record(), fetchedAt: 'yesterday' }, { ...record(), state: 'error' },
    { ...record(), models: [] },
    { ...record(), models: [...catalog.models, catalog.models[0]] },
    { ...record(), models: [{ id: 'x', tiers: [tier], hidden: 1 }] },
    { ...record(), models: [{ id: 'x', tiers: [{ ...tier, surprise: 1 }] }] },
    { ...record(), models: [{ id: 'x', tiers: [{ ...tier, input: -1 }] }] },
    { ...record(), models: [{ id: 'x', tiers: [{ ...tier, input: 1_000_001 }] }] },
    { ...record(), models: [{ id: 'x', tiers: [{ ...tier, label: '' }] }] },
    { ...record(), models: [{ id: 'x', tiers: [{ ...tier, currency: 'EUR' }] }] },
    { ...record(), models: [{ id: 'x', tiers: [{ ...tier, unit: 'per_1_tokens' }] }] },
    { ...record(), models: [{ id: 'x', tiers: [] }] },
    { ...record(), models: [{ id: 'x', tiers: Array.from({ length: 9 }, () => tier) }] },
    { ...record(), models: Array.from({ length: 513 }, (_, i) => ({ id: `m-${i}`, tiers: [tier] })) },
    ...['__proto__', 'constructor', 'prototype'].map(id => ({ ...record(), models: [{ id, tiers: [tier] }] })),
  ];
  for (const value of rejected) assert.equal(parsePriceCache(value), undefined, JSON.stringify(value));
});
