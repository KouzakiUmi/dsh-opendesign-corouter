/**
 * 逐模型设置：用户在目录行之上显式覆盖的发送参数与容量。
 *
 * 独立于模型发现与推理协议：这里只做形状校验与副本合成，不读凭据、不联网、
 * 也不判断某个推理协议是否支持这些字段（兼容性由适配器在组装请求时决定）。
 *
 * 安全约定：
 * - 采用字段白名单，任何未知字段一律拒绝，避免 `apiKey`/`headers` 之类秘密或
 *   不可序列化值借道设置对象进入持久化。
 * - 拒绝 `__proto__` / `constructor` / `prototype` 作为模型 ID，防原型污染。
 * - 只返回新对象：不把外部引用（数组、嵌套对象、目录行）交给调用方，也不改入参。
 * - 错误文字固定，不回显设置值或模型 ID。
 */

import type { CatalogModel } from './catalog.js';

/** One model's optional overrides; every field absent means "inherit the catalog row". */
export interface ModelSettings {
  /** 是否出现在模型选择器；缺省视为启用。 */
  enabled?: boolean;
  /** 采样温度，0–2。 */
  temperature?: number;
  /** 核采样，0–1。 */
  topP?: number;
  /** 单次输出上限；覆盖目录行的 maxOutputTokens。 */
  maxTokens?: number;
  /** 上下文窗口；覆盖目录行的 contextWindow。 */
  contextWindow?: number;
  /** 思考深度；只允许目录同一套档位。 */
  reasoningEffort?: string;
}

/** Model id → settings. Keys are model ids, never provider-scoped. */
export type ModelSettingsMap = Record<string, ModelSettings>;

/** Never accepted as a model id: they would reach `Object.prototype` through a plain copy. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate an untrusted settings payload into a fresh, allowlisted map.
 * This is also a Schemastery transform: all runtime dependencies must live inside
 * the function so JSON serialization and fresh-realm rehydration preserve validation.
 */
export function parseModelSettingsMap(value: unknown): ModelSettingsMap {
  // Match the Host record check without importing a closure dependency.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型设置必须是对象');
  const keys = Object.keys(value);
  if (keys.length > 512) throw new Error('模型设置最多允许 512 个模型');
  const fields = new Set(['enabled', 'temperature', 'topP', 'maxTokens', 'contextWindow', 'reasoningEffort']);
  const efforts: readonly unknown[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'];
  const out: ModelSettingsMap = {};
  for (const id of keys) {
    if (['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('模型设置不允许保留字段名');
    if (!/^[A-Za-z0-9._:/-]{1,128}$/u.test(id)) throw new Error('模型 ID 必须是 1–128 位字母、数字或 . _ : / -');
    const entry: unknown = (value as Record<string, unknown>)[id];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('每个模型的设置必须是对象');
    const settings = entry as Record<string, unknown>;
    for (const field of Object.keys(settings)) {
      if (!fields.has(field)) throw new Error('模型设置含有不支持的字段');
    }
    const parsed: ModelSettings = {};
    if (settings.enabled !== undefined) {
      if (typeof settings.enabled !== 'boolean') throw new Error('模型设置的 enabled 必须是布尔值');
      parsed.enabled = settings.enabled;
    }
    for (const [field, max] of [['temperature', 2], ['topP', 1]] as const) {
      const item = settings[field];
      if (item === undefined) continue;
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > max) throw new Error(`模型设置的 ${field} 必须是 0 到 ${max} 之间的有限数字`);
      parsed[field] = item;
    }
    for (const [field, max] of [['maxTokens', 10_000_000], ['contextWindow', 100_000_000]] as const) {
      const item = settings[field];
      if (item === undefined) continue;
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > max) throw new Error(`模型设置的 ${field} 必须是 1 到 ${max} 之间的整数`);
      parsed[field] = item;
    }
    if (settings.reasoningEffort !== undefined) {
      if (typeof settings.reasoningEffort !== 'string' || !efforts.includes(settings.reasoningEffort)) throw new Error('模型设置的 reasoningEffort 不在允许的取值内');
      parsed.reasoningEffort = settings.reasoningEffort;
    }
    if (parsed.maxTokens !== undefined && parsed.contextWindow !== undefined && parsed.maxTokens >= parsed.contextWindow) throw new Error('模型设置的 maxTokens 必须小于 contextWindow');
    out[id] = parsed;
  }
  return out;
}

/**
 * Copy a catalog row and apply the user's explicit capacity overrides. The input row and
 * its arrays are never mutated; other overrides (sampling, effort) belong to the request,
 * not to the catalog row, so they are not folded in here.
 */
export function applyModelSettings(row: CatalogModel, settings?: ModelSettings): CatalogModel {
  const { contextWindow, maxTokens } = settings ?? {};
  if (contextWindow === undefined && maxTokens === undefined) return { ...row };
  // Validate each override independently; the adapter owns effective-capacity errors
  // (including inherited catalog values) and reports them through its LlmError contract.
  if (contextWindow !== undefined) parseModelSettingsMap({ model: { contextWindow } });
  if (maxTokens !== undefined) parseModelSettingsMap({ model: { maxTokens } });
  return {
    ...row,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
  };
}

/** A model is selectable unless the map explicitly disables it; unknown ids and an absent map stay enabled. */
export function isModelEnabled(id: string, settings: ModelSettingsMap = {}): boolean {
  if (RESERVED_KEYS.has(id) || !Object.hasOwn(settings, id)) return true;
  return settings[id]?.enabled !== false;
}
