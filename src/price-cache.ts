/**
 * 最近一次官网公开价格快照的持久化缓存。
 *
 * 价格原先只存在插件内存里：宿主每次写配置都可能重建插件，打开模型页又要等一次官网
 * 抓取才有数字。这里把最后一次成功快照存进普通插件配置，`status` 读取直接返回它并标记
 * 为上次快照；官网抓取仍由客户端的首次打开（无新鲜快照时）与手动“更新价格”单独触发。
 *
 * 价格是公开、无凭据数据，不按账号身份绑定；只按年龄过期。缓存不含任何凭据。
 * 校验函数同时是 Schemastery transform：按源码序列化、在全新 realm 重新执行，因此所有
 * 常量与逻辑内联，不引用模块级 helper，不声明嵌套函数。
 */

import type { PriceCatalog, PriceTier } from './remote.js';

/** 超过这个年龄的快照不再展示（记录仍保留，等待被新快照覆盖）。 */
export const PRICE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface PriceCacheRecord {
  version: 1;
  /** 快照采集时间（ISO-8601）。 */
  fetchedAt: string;
  /** 只保存成功或部分成功；error 不保存。 */
  state: 'ok' | 'partial';
  models: PriceCatalog['models'];
}

/**
 * 校验一条持久化价格快照；字段上限与 `parsePriceCatalog` 保持一致。
 * 任何越界或未知字段一律返回 undefined（忽略该字段），不让损坏数据阻断插件加载。
 */
export function parsePriceCache(value: unknown): PriceCacheRecord | undefined {
  const STATES = ['ok', 'partial'];
  const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
  const RESERVED = ['__proto__', 'constructor', 'prototype'];
  const CURRENCIES = ['USD'];
  const UNITS = ['per_1m_tokens', 'per_1k_tokens'];
  const MODEL_KEYS = ['id', 'tiers'];
  const TIER_KEYS = ['label', 'currency', 'unit', 'input', 'output', 'cacheRead', 'cacheWrite'];
  const MAX_MODELS = 512;
  const MAX_TIERS = 8;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  const fetchedAt = record.fetchedAt;
  if (typeof fetchedAt !== 'string' || fetchedAt.length === 0 || fetchedAt.length > 64 || !Number.isFinite(Date.parse(fetchedAt))) return undefined;
  if (typeof record.state !== 'string' || !STATES.includes(record.state)) return undefined;
  if (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > MAX_MODELS) return undefined;
  const seen = new Set<string>();
  const models: { id: string; tiers: PriceTier[] }[] = [];
  for (const entry of record.models) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const model = entry as Record<string, unknown>;
    for (const key of Object.keys(model)) if (!MODEL_KEYS.includes(key)) return undefined;
    const id = model.id;
    if (typeof id !== 'string' || !MODEL_ID.test(id) || seen.has(id) || RESERVED.includes(id)) return undefined;
    seen.add(id);
    if (!Array.isArray(model.tiers) || model.tiers.length === 0 || model.tiers.length > MAX_TIERS) return undefined;
    const tiers: PriceTier[] = [];
    for (const rawTier of model.tiers) {
      if (typeof rawTier !== 'object' || rawTier === null || Array.isArray(rawTier)) return undefined;
      const tier = rawTier as Record<string, unknown>;
      for (const key of Object.keys(tier)) if (!TIER_KEYS.includes(key)) return undefined;
      const label = tier.label;
      if (typeof label !== 'string' || label.length === 0 || label.length > 128) return undefined;
      const currency = tier.currency === null ? null : typeof tier.currency === 'string' && CURRENCIES.includes(tier.currency) ? tier.currency : undefined;
      if (currency === undefined) return undefined;
      const unit = tier.unit === null ? null : typeof tier.unit === 'string' && UNITS.includes(tier.unit) ? tier.unit : undefined;
      if (unit === undefined) return undefined;
      const amounts: (number | null)[] = [];
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const amount = tier[key];
        if (amount === null) { amounts.push(null); continue; }
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return undefined;
        amounts.push(amount);
      }
      tiers.push({
        label,
        currency: currency as 'USD' | null,
        unit: unit as 'per_1m_tokens' | 'per_1k_tokens' | null,
        input: amounts[0] as number | null,
        output: amounts[1] as number | null,
        cacheRead: amounts[2] as number | null,
        cacheWrite: amounts[3] as number | null,
      });
    }
    models.push({ id, tiers });
  }
  return { version: 1, fetchedAt, state: record.state as 'ok' | 'partial', models };
}

/** 把一次成功抓取投影成可持久化记录；error、空目录或缺时间戳不保存。 */
export function priceCacheRecord(catalog: PriceCatalog): PriceCacheRecord | undefined {
  if (catalog.state === 'error' || catalog.models.length === 0) return undefined;
  if (catalog.fetchedAt === undefined || !Number.isFinite(Date.parse(catalog.fetchedAt))) return undefined;
  return parsePriceCache({ version: 1, fetchedAt: catalog.fetchedAt, state: catalog.state, models: catalog.models });
}

/** 恢复视图：上次成功快照，标记 stale 并保留原采集时间；过期记录不展示。 */
export function restoredPriceCatalog(record: PriceCacheRecord, now = Date.now()): PriceCatalog | undefined {
  const fetchedAt = Date.parse(record.fetchedAt);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > PRICE_CACHE_MAX_AGE_MS) return undefined;
  return { state: record.state, stale: true, fetchedAt: record.fetchedAt, models: record.models };
}
