/**
 * OpenAI 兼容 `GET /models` 模型发现（与选定推理协议无关）。
 *
 * 契约：
 * - 只请求 OpenAI 兼容 API 的 `/models`；裸网关 origin 自动补 `/v1`，显式前缀保留。使用 `Bearer` 鉴权 + 应用归因头，
 *   `redirect: 'error'`，20 秒上限，响应体上限 2 MiB。
 * - 与推理协议解耦：本函数不接受 protocol 参数，也不根据协议挑选路径。
 * - 归一化只接受 `data[]` 中可用且有界的 id；已知 id 继承 catalog 的分组与能力，
 *   新 id 归 `paid`。显式上下文容量只作为保守参考，不凭名称推断能力。
 * - 媒体输出模型（图像/视频/语音，走 `/api/v1/media/*`）不进对话目录。
 * - 所有失败折叠为 `ModelDiscoveryError` 的固定分类与固定文字，不回显凭据、
 *   请求头或响应体。
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { findModel, type CatalogModel } from './catalog.js';
import { assertBaseURL } from './config.js';
import { openAiBaseURL as normalizeOpenAiBase } from './protocol-options.js';
import { combinedSignal, record, safeSecret } from './util.js';

/** 发现请求的总时限（毫秒）。 */
export const DISCOVERY_TIMEOUT_MS = 20_000;
/** 响应体上限（字节）；超出即按格式错误拒绝，不解析部分 JSON。 */
export const MAX_DISCOVERY_BODY_BYTES = 2 * 1024 * 1024;
/** 单次发现的模型条数上限。 */
const MAX_MODELS = 512;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_MODEL_NAME_LENGTH = 128;
const MAX_CONTEXT_WINDOW = 100_000_000;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
/**
 * 显式媒体输出模型的 id 前缀：官网证据里这些模型走 `/api/v1/media/*`，
 * 选中后 chat 请求必败。只按 id 前缀排除，不从名称或未知能力字段推断。
 */
const MEDIA_MODEL_ID = /^(?:gpt-image-|nano-banana-|seedream-|imagen-|veo-|doubao-seedance-|sora-)/u;

/** Failure taxonomy; `status` is the HTTP status when one was received. */
export type ModelDiscoveryErrorKind = 'url' | 'credential' | 'network' | 'timeout' | 'aborted' | 'auth' | 'permission' | 'rate-limit' | 'server' | 'response';

const MESSAGES: Record<ModelDiscoveryErrorKind, string> = {
  url: '模型发现地址无效：必须是绝对 HTTP(S) 地址，且不含凭据、查询串或片段',
  credential: '模型发现凭据缺失，或含有不可用于 HTTP 请求头的字符',
  network: '无法连接模型发现服务',
  timeout: '模型发现请求超过 20 秒时限',
  aborted: '模型发现请求已取消',
  auth: '模型发现认证失败，请检查凭据',
  permission: '模型发现凭据无权读取模型列表',
  'rate-limit': '模型发现请求被限流，请稍后重试',
  server: '模型发现服务暂时不可用',
  response: '模型发现响应不符合 OpenAI 模型列表格式',
};

/**
 * Fixed-text discovery failure. The message is one of the constants above, so callers may
 * log it verbatim: no credential, header, URL or upstream body is ever interpolated.
 */
export class ModelDiscoveryError extends Error {
  constructor(readonly kind: ModelDiscoveryErrorKind, readonly status?: number) {
    super(MESSAGES[kind]);
    this.name = 'ModelDiscoveryError';
  }
}

function statusKind(status: number): ModelDiscoveryErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate-limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  return 'response';
}

/**
 * Read at most `MAX_DISCOVERY_BODY_BYTES` and decode once; partial bodies are refused.
 * A body cut off by the caller's cancellation or the deadline is classified as such instead
 * of being reported as a format problem.
 */
async function boundedJson(response: Response, signal: AbortSignal | undefined, deadline: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ModelDiscoveryError('response');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DISCOVERY_BODY_BYTES) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw new ModelDiscoveryError('response');
  }
  let size = 0;
  let raw = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_DISCOVERY_BODY_BYTES) throw new ModelDiscoveryError('response');
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } catch (error) {
    if (signal?.aborted) throw new ModelDiscoveryError('aborted');
    if (deadline.aborted) throw new ModelDiscoveryError('timeout');
    if (error instanceof ModelDiscoveryError) throw error;
    throw new ModelDiscoveryError('response');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try { return JSON.parse(raw); } catch { throw new ModelDiscoveryError('response'); }
}

/**
 * Normalize an OpenAI list body. Rows without a usable id are dropped, duplicates keep
 * their first occurrence, and no capability is invented. Explicit gateway window fields
 * may lower a catalog reference, or supply a reference for a previously unknown id.
 */
function gatewayContext(value: Record<string, unknown>): number | undefined {
  const metadata = record(value.metadata) ? value.metadata : {};
  const candidates = [
    metadata.context_limit, metadata.contextWindowTokens, metadata.context_window_tokens,
    value.contextWindowTokens, value.context_window_tokens, value.contextLength, value.context_length,
    value.contextWindow, value.context_window,
  ].filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0 && item <= MAX_CONTEXT_WINDOW);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function normalize(body: unknown): readonly CatalogModel[] {
  if (!record(body) || !Array.isArray(body.data)) throw new ModelDiscoveryError('response');
  if (body.data.length > MAX_MODELS) throw new ModelDiscoveryError('response');
  const seen = new Set<string>();
  const rows: CatalogModel[] = [];
  for (const value of body.data) {
    if (!record(value) || typeof value.id !== 'string' || !MODEL_ID.test(value.id) || ['__proto__', 'constructor', 'prototype'].includes(value.id)) continue;
    if (MEDIA_MODEL_ID.test(value.id) || seen.has(value.id)) continue;
    seen.add(value.id);
    const known = findModel(value.id);
    const offeredContext = gatewayContext(value);
    if (known) {
      const contextWindow = offeredContext === undefined ? known.contextWindow
        : known.contextWindow === undefined ? offeredContext : Math.min(known.contextWindow, offeredContext);
      rows.push({ ...known, ...(contextWindow === undefined ? {} : { contextWindow }) });
      continue;
    }
    const offered = typeof value.name === 'string' ? value.name.trim() : '';
    const name = offered !== '' && offered.length <= MAX_MODEL_NAME_LENGTH ? offered : value.id;
    rows.push({ id: value.id, name, group: 'paid', ...(offeredContext === undefined ? {} : { contextWindow: offeredContext }) });
  }
  return rows;
}

/**
 * Discover the chat models an OpenAI-compatible endpoint advertises.
 *
 * @param openAiBaseURL Absolute HTTP(S) base URL without credentials/query/fragment.
 * @param key Bearer credential; trimmed once, never echoed or persisted here.
 * @param signal Caller cancellation, combined with the internal 20 s deadline.
 * @param fetcher Optional `fetch` replacement (tests, hosts with a custom transport).
 * @throws {ModelDiscoveryError} Fixed classification and fixed message for every failure.
 */
export async function fetchModelCatalog(openAiBaseURL: string, key: string, signal?: AbortSignal, fetcher?: typeof fetch): Promise<readonly CatalogModel[]> {
  let base: string;
  try { base = normalizeOpenAiBase(assertBaseURL(openAiBaseURL)); } catch { throw new ModelDiscoveryError('url'); }
  let credential: string;
  try { credential = safeSecret(key); } catch { throw new ModelDiscoveryError('credential'); }
  const request = fetcher ?? fetch;
  const deadline = combinedSignal(signal, DISCOVERY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await request(`${base}/models`, {
      method: 'GET',
      headers: { ...attributionHeaders(), authorization: `Bearer ${credential}`, accept: 'application/json' },
      signal: deadline,
      redirect: 'error',
    });
  } catch {
    if (signal?.aborted) throw new ModelDiscoveryError('aborted');
    if (deadline.aborted) throw new ModelDiscoveryError('timeout');
    throw new ModelDiscoveryError('network');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelDiscoveryError(statusKind(response.status), response.status);
  }
  return normalize(await boundedJson(response, signal, deadline));
}
