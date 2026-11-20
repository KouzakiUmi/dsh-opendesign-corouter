/**
 * 最近一次额度读数的持久化缓存。
 *
 * 额度读数原先只存在插件内存里。宿主每次写配置都会重建插件，于是打开设置页时状态又回到
 * “尚未读取”，必须手动刷新一次才有数据。这里把最后一次带数据的读数按身份绑定存进普通
 * 插件配置：UI 读取（`status`）直接返回它并标记为上次成功读数，上游读取仍由既有的自动刷新
 * 与手动刷新单独触发。缓存不含凭据，只含额度数字、时间与来源。
 */

import type { QuotaSnapshot } from './quota.js';

/** 超过这个年龄的读数不再展示（记录仍保留，等待被新读数覆盖）。 */
export const QUOTA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface QuotaCacheRecord {
  version: 1;
  /** 读数所属身份指纹（网关、凭据记录、桌面登录态的散列），从不含凭据原文。 */
  binding: string;
  /** 这条读数被记录的时间（ISO-8601）。 */
  readAt: string;
  /** 允许持久化的额度读数；不含失败计数与刷新计划。 */
  snapshot: QuotaSnapshot;
}

/**
 * 校验一条持久化读数。
 *
 * 这同时是 Schemastery 的 transform：函数会按源码序列化、在全新 realm 中重新执行，
 * 因此所有常量与辅助逻辑都内联，不引用模块级 helper，也不声明嵌套函数。
 * 任何越界或未知字段一律返回 undefined（忽略该字段），不让损坏的数据阻断插件加载。
 */
export function parseQuotaCache(value: unknown): QuotaCacheRecord | undefined {
  const STATES = ['ok', 'partial'];
  const SOURCES = ['desktop', 'login', 'environment'];
  const RESET_MODES_MAX = 128;
  const MAX_WINDOWS = 64;
  const SNAPSHOT_KEYS = ['state', 'source', 'updatedAt', 'tier', 'eligible', 'windows', 'balances', 'subscriptionPeriodStart', 'subscriptionPeriodEnd', 'note'];
  const WINDOW_KEYS = ['durationSeconds', 'used', 'limit', 'remaining', 'percent', 'resetsAt', 'windowStart', 'resetMode'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  const binding = record.binding;
  if (typeof binding !== 'string' || !/^[a-f0-9]{64}$/u.test(binding)) return undefined;
  const readAt = record.readAt;
  if (typeof readAt !== 'string' || readAt.length === 0 || readAt.length > 64 || !Number.isFinite(Date.parse(readAt))) return undefined;
  const raw = record.snapshot;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const snapshot = raw as Record<string, unknown>;
  for (const key of Object.keys(snapshot)) if (!SNAPSHOT_KEYS.includes(key)) return undefined;
  // Only a reading that carries data is cacheable; never persist a login prompt or an error.
  if (typeof snapshot.state !== 'string' || !STATES.includes(snapshot.state)) return undefined;
  if (snapshot.source !== undefined && (typeof snapshot.source !== 'string' || !SOURCES.includes(snapshot.source))) return undefined;
  const updatedAt = snapshot.updatedAt;
  if (typeof updatedAt !== 'string' || updatedAt.length === 0 || updatedAt.length > 64 || !Number.isFinite(Date.parse(updatedAt))) return undefined;
  if (snapshot.tier !== undefined && (typeof snapshot.tier !== 'string' || snapshot.tier.length === 0 || snapshot.tier.length > 256)) return undefined;
  if (snapshot.eligible !== undefined && typeof snapshot.eligible !== 'boolean') return undefined;
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length > MAX_WINDOWS) return undefined;
  const windows: QuotaSnapshot['windows'] = [];
  for (const entry of snapshot.windows) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const window = entry as Record<string, unknown>;
    for (const key of Object.keys(window)) if (!WINDOW_KEYS.includes(key)) return undefined;
    const duration = window.durationSeconds, limit = window.limit, used = window.used, percent = window.percent;
    const remaining = window.remaining, resetsAt = window.resetsAt, windowStart = window.windowStart;
    for (const amount of [duration, limit, used, percent]) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12) return undefined;
    }
    if (duration === 0 || limit === 0 || (percent as number) > 100) return undefined;
    if (remaining !== undefined && (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 1e12)) return undefined;
    for (const time of [resetsAt, windowStart]) {
      if (time === undefined) continue;
      if (typeof time !== 'string' || time.length === 0 || time.length > 64 || !Number.isFinite(Date.parse(time))) return undefined;
    }
    if (window.resetMode !== undefined && (typeof window.resetMode !== 'string' || window.resetMode.length === 0 || window.resetMode.length > RESET_MODES_MAX)) return undefined;
    windows.push({
      durationSeconds: duration as number,
      used: used as number,
      limit: limit as number,
      ...(remaining === undefined ? {} : { remaining: remaining as number }),
      percent: percent as number,
      ...(resetsAt === undefined ? {} : { resetsAt: resetsAt as string }),
      ...(windowStart === undefined ? {} : { windowStart: windowStart as string }),
      ...(window.resetMode === undefined ? {} : { resetMode: window.resetMode as string }),
    });
  }
  const rawBalances = snapshot.balances;
  if (rawBalances !== undefined && (typeof rawBalances !== 'object' || rawBalances === null || Array.isArray(rawBalances))) return undefined;
  const balances = (rawBalances ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(balances)) if (!['subscriptionUsd', 'rechargeUsd', 'totalUsd'].includes(key)) return undefined;
  for (const key of Object.keys(balances)) {
    const amount = balances[key];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e12) return undefined;
  }
  for (const boundary of [snapshot.subscriptionPeriodStart, snapshot.subscriptionPeriodEnd]) {
    if (boundary === undefined) continue;
    if (typeof boundary !== 'string' || boundary.length === 0 || boundary.length > 64 || !Number.isFinite(Date.parse(boundary))) return undefined;
  }
  if (snapshot.note !== undefined && (typeof snapshot.note !== 'string' || snapshot.note.length > 4096)) return undefined;
  const parsed: QuotaSnapshot = {
    state: snapshot.state as QuotaSnapshot['state'],
    ...(snapshot.source === undefined ? {} : { source: snapshot.source as NonNullable<QuotaSnapshot['source']> }),
    updatedAt,
    ...(snapshot.tier === undefined ? {} : { tier: snapshot.tier as string }),
    ...(snapshot.eligible === undefined ? {} : { eligible: snapshot.eligible as boolean }),
    windows,
    balances: {
      ...(balances.subscriptionUsd === undefined ? {} : { subscriptionUsd: balances.subscriptionUsd as number }),
      ...(balances.rechargeUsd === undefined ? {} : { rechargeUsd: balances.rechargeUsd as number }),
      ...(balances.totalUsd === undefined ? {} : { totalUsd: balances.totalUsd as number }),
    },
    ...(snapshot.subscriptionPeriodStart === undefined ? {} : { subscriptionPeriodStart: snapshot.subscriptionPeriodStart as string }),
    ...(snapshot.subscriptionPeriodEnd === undefined ? {} : { subscriptionPeriodEnd: snapshot.subscriptionPeriodEnd as string }),
    ...(snapshot.note === undefined ? {} : { note: snapshot.note as string }),
  };
  // A reading with neither windows nor balances explains nothing about the account.
  if (parsed.windows.length === 0 && Object.keys(parsed.balances).length === 0) return undefined;
  return { version: 1, binding, readAt, snapshot: parsed };
}

/** The values a persisted reading may carry; runtime bookkeeping stays in memory. */
export function quotaCacheSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  const { nextRefreshAt: _plan, stale: _stale, refreshFailures: _failures, autoRefreshPaused: _paused, ...rest } = snapshot;
  return rest;
}

/**
 * The view a restored reading shows: the last committed numbers, marked stale, with its own
 * update time. An expired record is not shown at all.
 */
export function restoredQuotaSnapshot(record: QuotaCacheRecord, now = Date.now()): QuotaSnapshot | undefined {
  const readAt = Date.parse(record.readAt);
  if (!Number.isFinite(readAt) || now - readAt > QUOTA_CACHE_MAX_AGE_MS) return undefined;
  return { ...record.snapshot, stale: true };
}
