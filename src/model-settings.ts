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
import { record } from './util.js';

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

/** 上限与目录、远程设置视图保持同一量级。 */
const MAX_ENTRIES = 512;
const MAX_MODEL_ID_LENGTH = 128;
/** 允许字母、数字与 `.` `_` `:` `/` `-`；不含空白、引号与路径穿越符。 */
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
const MAX_TEMPERATURE = 2;
const MAX_TOP_P = 1;
const MAX_TOKENS = 10_000_000;
const MAX_CONTEXT_WINDOW = 100_000_000;
/** 与 catalog.ts 的 EFFORTS_* 同一档位集合。 */
const REASONING_EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'];
/** Never accepted as a model id: they would reach `Object.prototype` through a plain copy. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
/** The only fields a settings object may carry; anything else is a smuggling attempt. */
const SETTINGS_FIELDS: ReadonlySet<string> = new Set(['enabled', 'temperature', 'topP', 'maxTokens', 'contextWindow', 'reasoningEffort']);

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('模型设置的 enabled 必须是布尔值');
  return value;
}

function bounded(value: unknown, max: number, label: 'temperature' | 'topP'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`模型设置的 ${label} 必须是 0 到 ${max} 之间的有限数字`);
  return value;
}

function capacity(value: unknown, max: number, label: 'maxTokens' | 'contextWindow'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`模型设置的 ${label} 必须是 1 到 ${max} 之间的整数`);
  return value;
}

function effort(value: unknown): string {
  const hit = REASONING_EFFORTS.find(candidate => candidate === value);
  if (hit === undefined) throw new Error('模型设置的 reasoningEffort 不在允许的取值内');
  return hit;
}

/** Rebuild one entry from the allowlist; unknown fields and secrets never survive. */
function settingsOf(value: unknown): ModelSettings {
  if (!record(value)) throw new Error('每个模型的设置必须是对象');
  for (const field of Object.keys(value)) {
    if (!SETTINGS_FIELDS.has(field)) throw new Error('模型设置含有不支持的字段');
  }
  const out: ModelSettings = {};
  if (value.enabled !== undefined) out.enabled = flag(value.enabled);
  if (value.temperature !== undefined) out.temperature = bounded(value.temperature, MAX_TEMPERATURE, 'temperature');
  if (value.topP !== undefined) out.topP = bounded(value.topP, MAX_TOP_P, 'topP');
  if (value.maxTokens !== undefined) out.maxTokens = capacity(value.maxTokens, MAX_TOKENS, 'maxTokens');
  if (value.contextWindow !== undefined) out.contextWindow = capacity(value.contextWindow, MAX_CONTEXT_WINDOW, 'contextWindow');
  if (value.reasoningEffort !== undefined) out.reasoningEffort = effort(value.reasoningEffort);
  return out;
}

/**
 * Validate an untrusted settings payload (settings store, credential-free Host state)
 * into a fresh map. Rejects non-objects, oversized maps, reserved/unsafe ids, unknown
 * fields and out-of-range values; never returns the input's objects or arrays.
 */
export function parseModelSettingsMap(value: unknown): ModelSettingsMap {
  if (!record(value)) throw new Error('模型设置必须是对象');
  const keys = Object.keys(value);
  if (keys.length > MAX_ENTRIES) throw new Error(`模型设置最多允许 ${MAX_ENTRIES} 个模型`);
  const out: ModelSettingsMap = {};
  for (const id of keys) {
    if (RESERVED_KEYS.has(id)) throw new Error('模型设置不允许保留字段名');
    if (!MODEL_ID.test(id)) throw new Error(`模型 ID 必须是 1–${MAX_MODEL_ID_LENGTH} 位字母、数字或 . _ : / -`);
    out[id] = settingsOf(value[id]);
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
  return {
    ...row,
    ...(contextWindow === undefined ? {} : { contextWindow: capacity(contextWindow, MAX_CONTEXT_WINDOW, 'contextWindow') }),
    ...(maxTokens === undefined ? {} : { maxOutputTokens: capacity(maxTokens, MAX_TOKENS, 'maxTokens') }),
  };
}

/** A model is selectable unless the map explicitly disables it; unknown ids and an absent map stay enabled. */
export function isModelEnabled(id: string, settings: ModelSettingsMap = {}): boolean {
  if (RESERVED_KEYS.has(id) || !Object.hasOwn(settings, id)) return true;
  return settings[id]?.enabled !== false;
}
