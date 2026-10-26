/** Shared JSON value types and allowlist parsers; no credential or opaque Host state is returned. */

import type { QuotaSnapshot, QuotaWindow, SessionSource } from './quota.js';
import { record } from './util.js';

// Type-only: browser imports must not pull in quota.ts runtime dependencies.
export type { QuotaSnapshot, QuotaWindow, SessionSource } from './quota.js';

/** npm package that owns the Remote methods; must satisfy typert's segment rules. */
export const REMOTE_PACKAGE = 'dsh-opendesign-corouter';
/** Cordis service key and wire namespace. The Client resolves `remote.<this>`. */
export const REMOTE_SERVICE = 'openDesignCoRouter';

/** Upper bounds on every accepted string, so an oversized Host value fails here. */
const MAX_REVISION = 256;
const MAX_JOB_ID = 128;
const MAX_BASE_URL = 2048;
const MAX_ENV_REF = 128;
const MAX_TEXT = 4096;
const MAX_MESSAGE = 1024;
const MAX_TIER = 256;
const MAX_MODELS = 512;
const MAX_WINDOWS = 64;
/** Printable ASCII only: what an HTTP header field can carry verbatim. */
const MAX_API_KEY = 16_384;
const HTTP_ASCII = /^[\x21-\x7e]+$/u;
const ENV_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Live switches of this plugin, mirrored for a settings page that only has this RPC. */
export interface StatusConfig {
  emptyTurnGuard: boolean;
  useDesktopCredential: boolean;
  baseURL: string;
  /** Credential reference name (an env var or a DSH credential ref), never the value. */
  apiKeyEnv: string;
}

/** One selectable model; `group` selects which of the two Providers owns it. */
export interface StatusModel {
  id: string;
  name: string;
  group: 'plan' | 'paid';
}

/** Terminal-or-in-flight phases a login job may report. */
export type LoginPhase = 'idle' | 'launching' | 'waiting' | 'verifying' | 'success' | 'cancelled' | 'error';

/** Credential-free view of the independent console login. */
export interface LoginState {
  jobId: string | null;
  state: LoginPhase;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Everything the settings/usage surface may read; no field is derived from a secret. */
export interface Status {
  /** Opaque Host revision of the credential record; passed back on every write. */
  revision: string;
  apiKeyConfigured: boolean;
  sessionSource?: SessionSource;
  quota: QuotaSnapshot;
  login: LoginState;
  config: StatusConfig;
  /** Turns the empty-turn guard actually intercepted since process start. */
  guardedTurns: number;
  models: readonly StatusModel[];
}

export interface StartLoginRequest {
  expectedRevision: string;
}

export interface CancelLoginRequest {
  jobId: string;
}

export interface SaveApiKeyRequest {
  value: string;
  expectedRevision: string;
}

const LOGIN_PHASES: readonly LoginPhase[] = ['idle', 'launching', 'waiting', 'verifying', 'success', 'cancelled', 'error'];
const QUOTA_STATES: readonly QuotaSnapshot['state'][] = ['ok', 'partial', 'need-login', 'error'];
const SESSION_SOURCES: readonly SessionSource[] = ['desktop', 'login', 'environment'];
const MODEL_GROUPS: readonly StatusModel['group'][] = ['plan', 'paid'];

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label} 必须是非空字符串（最多 ${max} 字符）`);
  return value;
}

function isoTime(value: unknown, label: string): string {
  const time = text(value, label, 64);
  if (!Number.isFinite(Date.parse(time))) throw new Error(`${label} 必须是 ISO 时间字符串`);
  return time;
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
  return value;
}

/** A finite number, optionally non-negative. */
function amount(value: unknown, label: string, negative = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (!negative && value < 0)) throw new Error(`${label} 必须是${negative ? '' : '非负'}有限数字`);
  return value;
}

function member<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const hit = allowed.find(candidate => candidate === value);
  if (hit === undefined) throw new Error(`${label} 不在允许的取值内`);
  return hit;
}

function parseQuotaWindow(value: unknown): QuotaWindow {
  if (!record(value)) throw new Error('额度窗口必须是对象');
  const durationSeconds = amount(value.durationSeconds, '额度窗口时长');
  if (durationSeconds <= 0) throw new Error('额度窗口时长必须大于 0');
  const limit = amount(value.limit, '额度上限');
  if (limit <= 0) throw new Error('额度上限必须大于 0');
  return {
    durationSeconds,
    used: amount(value.used, '已用额度'),
    limit,
    ...(value.remaining === undefined ? {} : { remaining: amount(value.remaining, '剩余额度') }),
    percent: Math.min(100, Math.max(0, amount(value.percent, '已用百分比'))),
    ...(value.resetsAt === undefined ? {} : { resetsAt: isoTime(value.resetsAt, '额度重置时间') }),
  };
}

/** Rebuild a `QuotaSnapshot` from an allowlist; unknown keys are dropped. */
export function parseQuotaSnapshot(value: unknown): QuotaSnapshot {
  if (!record(value)) throw new Error('额度快照必须是对象');
  const windows = value.windows;
  if (!Array.isArray(windows) || windows.length > MAX_WINDOWS) throw new Error(`额度窗口必须是数组（最多 ${MAX_WINDOWS} 项）`);
  const balances = value.balances === undefined ? {} : value.balances;
  if (!record(balances)) throw new Error('额度余额必须是对象');
  return {
    state: member(value.state, QUOTA_STATES, '额度状态'),
    ...(value.source === undefined ? {} : { source: member(value.source, SESSION_SOURCES, '额度来源') }),
    updatedAt: isoTime(value.updatedAt, '额度更新时间'),
    ...(value.tier === undefined ? {} : { tier: text(value.tier, '套餐名', MAX_TIER) }),
    ...(value.eligible === undefined ? {} : { eligible: flag(value.eligible, '套餐资格') }),
    windows: windows.map(parseQuotaWindow),
    balances: {
      ...(balances.subscriptionUsd === undefined ? {} : { subscriptionUsd: amount(balances.subscriptionUsd, '订阅余额') }),
      ...(balances.rechargeUsd === undefined ? {} : { rechargeUsd: amount(balances.rechargeUsd, '充值余额') }),
      ...(balances.totalUsd === undefined ? {} : { totalUsd: amount(balances.totalUsd, '可用余额', true) }),
    },
    ...(value.note === undefined ? {} : { note: text(value.note, '额度说明', MAX_TEXT) }),
  };
}

/** Rebuild a `LoginState` from an allowlist; the job's secret material never had a field here. */
export function parseLoginState(value: unknown): LoginState {
  if (!record(value)) throw new Error('登录状态必须是对象');
  const jobId = value.jobId;
  if (jobId !== null && jobId !== undefined && typeof jobId !== 'string') throw new Error('登录任务 id 必须是字符串或 null');
  return {
    jobId: typeof jobId === 'string' && jobId.length > 0 ? text(jobId, '登录任务 id', MAX_JOB_ID) : null,
    state: member(value.state, LOGIN_PHASES, '登录阶段'),
    ...(value.message === undefined ? {} : { message: text(value.message, '登录说明', MAX_MESSAGE) }),
    ...(value.startedAt === undefined ? {} : { startedAt: isoTime(value.startedAt, '登录开始时间') }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: isoTime(value.finishedAt, '登录结束时间') }),
  };
}

function parseStatusModel(value: unknown): StatusModel {
  if (!record(value)) throw new Error('模型条目必须是对象');
  const id = text(value.id, '模型 id', 128);
  if (!MODEL_ID.test(id)) throw new Error('模型 id 含不允许的字符');
  return {
    id,
    name: text(value.name, '模型名', 128),
    group: member(value.group, MODEL_GROUPS, '模型分组'),
  };
}

function parseStatusConfig(value: unknown): StatusConfig {
  if (!record(value)) throw new Error('配置视图必须是对象');
  const apiKeyEnv = text(value.apiKeyEnv, '凭据引用名', MAX_ENV_REF);
  if (!ENV_REF.test(apiKeyEnv)) throw new Error('凭据引用名必须是合法标识符');
  return {
    emptyTurnGuard: flag(value.emptyTurnGuard, '空轮保护开关'),
    useDesktopCredential: flag(value.useDesktopCredential, '桌面登录态开关'),
    baseURL: text(value.baseURL, '推理地址', MAX_BASE_URL),
    apiKeyEnv,
  };
}

/** Rebuild a `Status` from an allowlist; the credential itself has no field here. */
export function parseStatus(value: unknown): Status {
  if (!record(value)) throw new Error('状态必须是对象');
  const models = value.models;
  if (!Array.isArray(models) || models.length > MAX_MODELS) throw new Error(`模型列表必须是数组（最多 ${MAX_MODELS} 项）`);
  const ids = new Set<string>();
  const parsed = models.map(parseStatusModel);
  for (const model of parsed) {
    if (ids.has(model.id)) throw new Error(`模型列表重复了 id "${model.id}"`);
    ids.add(model.id);
  }
  return {
    revision: text(value.revision, '配置版本', MAX_REVISION),
    apiKeyConfigured: flag(value.apiKeyConfigured, '凭据是否就绪'),
    ...(value.sessionSource === undefined ? {} : { sessionSource: member(value.sessionSource, SESSION_SOURCES, '登录态来源') }),
    quota: parseQuotaSnapshot(value.quota),
    login: parseLoginState(value.login),
    config: parseStatusConfig(value.config),
    guardedTurns: count(value.guardedTurns, '已拦截空轮数'),
    models: parsed,
  };
}

/** `{ expectedRevision }`: the revision the UI saw before the user started a login. */
export function parseStartLoginRequest(value: unknown): StartLoginRequest {
  if (!record(value)) throw new Error('登录请求必须是对象');
  return { expectedRevision: text(value.expectedRevision, '配置版本', MAX_REVISION) };
}

/** `{ jobId }`: the attempt to cancel; a stale id is the Host's call to refuse. */
export function parseCancelLoginRequest(value: unknown): CancelLoginRequest {
  if (!record(value)) throw new Error('取消请求必须是对象');
  return { jobId: text(value.jobId, '登录任务 id', MAX_JOB_ID) };
}

/**
 * `{ value, expectedRevision }`: the raw key plus the revision it replaces.
 *
 * The key is trimmed exactly once, here, because every real source (settings field,
 * `.env` line, shell export) carries surrounding whitespace. Anything outside
 * printable ASCII is refused rather than handed to `fetch`, whose ByteString error
 * names a UTF-16 code point instead of the setting to fix.
 */
export function parseSaveApiKeyRequest(value: unknown): SaveApiKeyRequest {
  if (!record(value)) throw new Error('保存请求必须是对象');
  if (typeof value.value !== 'string') throw new Error('API Key 必须是字符串');
  const key = value.value.trim();
  if (!HTTP_ASCII.test(key)) throw new Error('API Key 为空或含有不可用于 HTTP 请求头的字符');
  if (key.length > MAX_API_KEY) throw new Error(`API Key 不能超过 ${MAX_API_KEY} 字符`);
  return { value: key, expectedRevision: text(value.expectedRevision, '配置版本', MAX_REVISION) };
}
