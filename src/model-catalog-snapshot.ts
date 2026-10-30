/**
 * 最近一次成功的网关模型目录快照。
 *
 * 快照保存在普通插件配置里，这样宿主重启后不会静默退回内置目录。它按不可信输入校验：
 * 未知字段、越界数值与重复 id 一律拒绝；无效快照返回 `undefined`（忽略该字段），
 * 不让损坏的持久化数据阻断插件加载。`baseURL` 绑定读取时的网关，换网关后旧快照不生效。
 */

import type { CatalogModel } from './catalog.js';

export interface ModelCatalogSnapshot {
  /** 读取目录时的规范化网关地址。 */
  baseURL: string;
  /** 成功读取时间的 ISO-8601 字符串。 */
  updatedAt: string;
  models: readonly CatalogModel[];
}

/**
 * Validate a persisted snapshot into a fresh, allowlisted value.
 * This is also a Schemastery transform: every constant and helper lives inline because the
 * function is serialized as source and re-executed in a fresh realm. Avoid nested function
 * declarations here — bundlers wrap them with helpers the fresh realm does not define.
 */
export function parseModelCatalogSnapshot(value: unknown): ModelCatalogSnapshot | undefined {
  const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
  const GROUPS = ['plan', 'paid'];
  const KEYS = ['id', 'name', 'group', 'contextWindow', 'maxOutputTokens', 'inputModalities', 'reasoningEfforts'];
  /** Same reserved keys the per-model settings reject; they must not reach a plain copy. */
  const RESERVED = ['__proto__', 'constructor', 'prototype'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.baseURL !== 'string' || snapshot.baseURL.length === 0 || snapshot.baseURL.length > 2048) return undefined;
  // Normalize exactly like the runtime base URL so values written by older versions still match.
  let base: URL;
  try { base = new URL(snapshot.baseURL); } catch { return undefined; }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return undefined;
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) return undefined;
  const baseURL = base.href.replace(/\/+$/u, '');
  if (baseURL.length === 0 || baseURL.length > 2048) return undefined;
  if (typeof snapshot.updatedAt !== 'string' || snapshot.updatedAt.length === 0 || snapshot.updatedAt.length > 64 || !Number.isFinite(Date.parse(snapshot.updatedAt))) return undefined;
  if (!Array.isArray(snapshot.models) || snapshot.models.length === 0 || snapshot.models.length > 512) return undefined;
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const entry of snapshot.models) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item)) if (!KEYS.includes(key)) return undefined;
    const id = item.id, name = item.name, group = item.group;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || !MODEL_ID.test(id) || seen.has(id) || RESERVED.includes(id)) return undefined;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 128) return undefined;
    if (typeof group !== 'string' || !GROUPS.includes(group)) return undefined;
    const model: CatalogModel = { id, name, group: group as 'plan' | 'paid' };
    if (item.contextWindow !== undefined) {
      if (!Number.isSafeInteger(item.contextWindow) || (item.contextWindow as number) <= 0 || (item.contextWindow as number) > 100_000_000) return undefined;
      model.contextWindow = item.contextWindow as number;
    }
    if (item.maxOutputTokens !== undefined) {
      if (!Number.isSafeInteger(item.maxOutputTokens) || (item.maxOutputTokens as number) <= 0 || (item.maxOutputTokens as number) > 10_000_000) return undefined;
      model.maxOutputTokens = item.maxOutputTokens as number;
    }
    if (item.inputModalities !== undefined) {
      if (!Array.isArray(item.inputModalities) || item.inputModalities.length < 1 || item.inputModalities.length > 2) return undefined;
      const modalities: ('text' | 'image')[] = [];
      for (const modality of item.inputModalities) {
        if (modality !== 'text' && modality !== 'image') return undefined;
        modalities.push(modality);
      }
      // The status transport requires `text` and rejects duplicates; a snapshot must not pass here and fail there.
      if (!modalities.includes('text') || new Set(modalities).size !== modalities.length) return undefined;
      model.inputModalities = modalities;
    }
    if (item.reasoningEfforts !== undefined) {
      if (!Array.isArray(item.reasoningEfforts) || item.reasoningEfforts.length > 16) return undefined;
      const efforts: string[] = [];
      for (const effort of item.reasoningEfforts) {
        if (typeof effort !== 'string' || effort.length === 0 || effort.length > 32) return undefined;
        efforts.push(effort);
      }
      model.reasoningEfforts = efforts;
    }
    seen.add(id);
    models.push(model);
  }
  return { baseURL, updatedAt: snapshot.updatedAt, models };
}
