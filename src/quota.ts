// OpenDesign normalization and independent-pool degradation adapted from dsh-subusage 0.16.2 (MIT).
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { record, combinedSignal } from './util.js';

export const API_BASE = 'https://amr-api.open-design.ai/api/v1';
export const CURRENT_URL = `${API_BASE}/workspaces/current`;
export const SUMMARY_URL = `${API_BASE}/billing/summary`;
export const usageUrl = (workspace: string) => `${API_BASE}/workspaces/${encodeURIComponent(workspace)}/billing/coding-plan-usage`;
export const preflightUrl = (workspace: string) => `${API_BASE}/workspaces/${encodeURIComponent(workspace)}/billing/preflight`;
export type SessionSource = 'desktop' | 'login' | 'environment';
export interface Session { headers: Record<string, string>; source: SessionSource; credentialType?: 'device' }
export interface QuotaWindow {
  durationSeconds: number; used: number; limit: number; remaining?: number; percent: number; resetsAt?: string;
  /** Window start as reported by coding-plan-usage (ISO-8601); never derived from the reset time. */
  windowStart?: string;
  /** Service-side window policy (`activity_triggered`, `anchored_recurring`, ...), when reported. */
  resetMode?: string;
}
export interface QuotaSnapshot {
  state: 'ok' | 'partial' | 'need-login' | 'error';
  source?: SessionSource;
  updatedAt: string;
  tier?: string;
  eligible?: boolean;
  windows: QuotaWindow[];
  balances: { subscriptionUsd?: number; rechargeUsd?: number; totalUsd?: number };
  /**
   * Billing-period boundaries of the subscription pool (ISO-8601), from
   * `billing/summary`'s `subscriptionCurrentPeriodStart/End`. `End` is when the
   * plan model credits refresh — distinct from a rolling window's `resetsAt`.
   */
  subscriptionPeriodStart?: string;
  subscriptionPeriodEnd?: string;
  /** Next client-side read, owned by the host cache policy; this module never invents it. */
  nextRefreshAt?: string;
  /** A failed non-auth refresh retained the previous successful readings. */
  stale?: boolean;
  /** Consecutive failed automatic reads; manual refresh starts a new bounded sequence. */
  refreshFailures?: number;
  autoRefreshPaused?: boolean;
  note?: string;
}
export class ConsoleError extends Error {
  constructor(readonly kind: 'auth' | 'permission' | 'network' | 'response' | 'rate-limit', readonly status?: number) {
    super(kind === 'auth' ? 'OpenDesign 登录已失效，请重新登录' : kind === 'permission' ? 'OpenDesign 当前登录态无权读取该额度层' : kind === 'rate-limit' ? 'OpenDesign 额度接口限流，请稍后刷新' : kind === 'response' ? 'OpenDesign 额度接口返回格式发生变化' : 'OpenDesign 额度暂时无法读取');
  }
}
export async function consoleJson(url: string, session: Session, signal?: AbortSignal, fetcher = fetch): Promise<unknown> {
  signal?.throwIfAborted();
  if (session.credentialType === 'device') {
    let target: URL;
    try { target = new URL(url); } catch { throw new ConsoleError('response'); }
    if (target.origin !== 'https://amr-api.open-design.ai' || target.username || target.password) throw new ConsoleError('response');
  }
  const requestSignal = combinedSignal(signal, 20_000);
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new ConsoleError('network'));
  requestSignal.addEventListener('abort', onAbort, { once: true });
  const read = async (): Promise<unknown> => {
    const response = await fetcher(url, { headers: { ...attributionHeaders(), accept: 'application/json', ...session.headers }, signal: requestSignal, redirect: 'error', credentials: 'omit' });
    const cancelBody = () => { void response.body?.cancel().catch(() => undefined); };
    if (requestSignal.aborted) { cancelBody(); throw new ConsoleError('network'); }
    if (response.redirected || (response.url && response.url !== url)) { cancelBody(); throw new ConsoleError('response'); }
    if (response.status === 401 || response.status === 403) { cancelBody(); throw new ConsoleError(response.status === 401 ? 'auth' : 'permission', response.status); }
    if (!response.ok) { cancelBody(); throw new ConsoleError(response.status === 429 ? 'rate-limit' : 'network', response.status); }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 2 * 1024 * 1024)) { cancelBody(); throw new ConsoleError('response'); }
    // Bound both fetch and body reads even when an injected transport ignores AbortSignal.
    const reader = response.body?.getReader();
    if (!reader) throw new ConsoleError('response');
    const cancelReader = () => { void reader.cancel().catch(() => undefined); };
    requestSignal.addEventListener('abort', cancelReader, { once: true });
    let size = 0, raw = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (requestSignal.aborted) throw new ConsoleError('network');
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new ConsoleError('response');
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { requestSignal.removeEventListener('abort', cancelReader); cancelReader(); reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new ConsoleError('response'); }
    if (record(body) && (body.code === 401 || body.code === '401')) throw new ConsoleError('auth', 401);
    if (record(body) && (body.code === 403 || body.code === '403')) throw new ConsoleError('permission', 403);
    return body;
  };
  try { return await Promise.race([read(), aborted]); }
  catch (error) { signal?.throwIfAborted(); throw error instanceof ConsoleError ? error : new ConsoleError('network'); }
  finally { requestSignal.removeEventListener('abort', onAbort); }
}
function number(value: unknown, negative = false): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/u.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && (negative || n >= 0) ? n : undefined;
}
/** Normalize a reported timestamp to ISO-8601; anything unparsable stays unknown. */
function iso(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
export function normalizeQuota(body: unknown, summary?: unknown): Pick<QuotaSnapshot, 'windows' | 'balances' | 'tier' | 'eligible' | 'subscriptionPeriodStart' | 'subscriptionPeriodEnd'> {
  if (!record(body) || !(typeof body.eligible === 'boolean' || typeof body.tier === 'string' || body.tier === null || Array.isArray(body.windows))) throw new ConsoleError('response');
  const windows: QuotaWindow[] = [];
  for (const row of Array.isArray(body.windows) ? body.windows : []) {
    if (!record(row)) continue;
    const seconds = number(row.durationSeconds), used = number(row.usedCredits), limit = number(row.limitCredits), remaining = number(row.remainingCredits);
    if (seconds === undefined || seconds <= 0 || used === undefined || limit === undefined || limit <= 0) continue;
    const resetsAt = iso(row.resetsAt), windowStart = iso(row.windowStart);
    const resetMode = typeof row.resetMode === 'string' && row.resetMode.trim() ? row.resetMode.trim() : undefined;
    windows.push({ durationSeconds: seconds, used, limit, percent: Math.min(100, used / limit * 100), ...(remaining === undefined ? {} : { remaining }), ...(resetsAt === undefined ? {} : { resetsAt }), ...(windowStart === undefined ? {} : { windowStart }), ...(resetMode === undefined ? {} : { resetMode }) });
  }
  const membershipTier = record(summary) && typeof summary.membershipTier === 'string' ? summary.membershipTier.trim() : '';
  const tier = typeof body.tier === 'string' ? body.tier.trim() : body.tier === undefined && body.eligible !== false ? membershipTier : '';
  const eligible = typeof body.eligible === 'boolean' ? body.eligible : body.tier === null ? false : undefined;
  return { windows, balances: normalizeBalances(summary), ...normalizeSubscription(summary), ...(tier ? { tier } : {}), ...(eligible === undefined ? {} : { eligible }) };
}
/** Billing period of the subscription pool; absent fields stay unknown, never derived. */
export function normalizeSubscription(summary: unknown): Pick<QuotaSnapshot, 'subscriptionPeriodStart' | 'subscriptionPeriodEnd'> {
  if (!record(summary)) return {};
  const start = iso(summary.subscriptionCurrentPeriodStart), end = iso(summary.subscriptionCurrentPeriodEnd);
  return { ...(start === undefined ? {} : { subscriptionPeriodStart: start }), ...(end === undefined ? {} : { subscriptionPeriodEnd: end }) };
}
export function normalizeBalances(summary: unknown): QuotaSnapshot['balances'] {
  if (!record(summary)) return {};
  const perUsd = number(summary.creditsPerUsd), balances = record(summary.balances) ? summary.balances : {};
  const subscription = number(balances.subscriptionCredits), recharge = number(balances.rechargeCredits), total = number(balances.totalAvailableCredits, true);
  const divisor = perUsd !== undefined && perUsd > 0 ? perUsd : undefined;
  const totalUsd = number(summary.balanceUsd, true) ?? number(summary.totalAvailableCreditsUsd, true) ?? (divisor !== undefined && total !== undefined ? total / divisor : undefined);
  return { ...(divisor !== undefined && subscription !== undefined ? { subscriptionUsd: subscription / divisor } : {}), ...(divisor !== undefined && recharge !== undefined ? { rechargeUsd: recharge / divisor } : {}), ...(totalUsd !== undefined ? { totalUsd } : {}) };
}
/** Device contract: opencode-opendesign-auth 0.1.4, workspace preflight + personal summary.
 * Unlike desktop reads, this path never invokes vela or borrows desktop account data.
 */
export async function readDeviceQuota(session: Session, signal?: AbortSignal, fetcher = fetch): Promise<QuotaSnapshot> {
  const common = { source: session.source, updatedAt: new Date().toISOString() };
  let current: unknown;
  try { current = await consoleJson(CURRENT_URL, session, signal, fetcher); }
  catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ConsoleError && error.kind === 'permission') return { ...common, state: 'partial', windows: [], balances: {}, note: '当前设备授权无权读取工作区；额度暂不可确认' };
    throw error;
  }
  if (!record(current)) throw new ConsoleError('response');
  const workspaceId = typeof current.activeWorkspaceId === 'string' && current.activeWorkspaceId.trim() ? current.activeWorkspaceId : current.workspaceId;
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(workspaceId)) throw new ConsoleError('response');
  // Absence of a type (or a membership tier) is not evidence that this is a personal workspace.
  const personal = current.workspaceType === 'personal';
  const [preflight, billing] = await Promise.allSettled([
    consoleJson(preflightUrl(workspaceId), session, signal, fetcher),
    personal ? consoleJson(SUMMARY_URL, session, signal, fetcher) : Promise.resolve(undefined),
  ]);
  signal?.throwIfAborted();
  for (const item of [preflight, billing]) if (item.status === 'rejected' && item.reason instanceof ConsoleError && item.reason.kind === 'auth') throw item.reason;
  const summary = billing.status === 'fulfilled' ? billing.value : undefined;
  const flight = preflight.status === 'fulfilled' && record(preflight.value) ? preflight.value : undefined;
  let normalized: ReturnType<typeof normalizeQuota> | undefined;
  try { normalized = normalizeQuota(flight?.codingPlan, personal ? summary : undefined); }
  catch (error) { if (!(error instanceof ConsoleError)) throw error; }
  const balances = personal ? normalizeBalances(summary) : {};
  const total = personal ? number(flight?.balanceUsd, true) : undefined;
  if (total !== undefined) balances.totalUsd = total;
  const permission = [preflight, billing].some(item => item.status === 'rejected' && item.reason instanceof ConsoleError && item.reason.kind === 'permission');
  if (!normalized && !Object.keys(balances).length && !permission) {
    if (preflight.status === 'rejected') throw preflight.reason;
    throw new ConsoleError('response');
  }
  const windows = normalized?.windows ?? [];
  const missingWindows = normalized?.eligible !== false && !windows.length;
  const missingBalances = personal && Object.keys(balances).length < 3;
  const partial = missingWindows || missingBalances || !personal || permission;
  const note = !personal ? '团队或未知工作区：账号钱包口径未核实，暂不显示'
    : missingWindows ? '套餐额度窗口暂不可确认'
    : missingBalances ? '部分钱包余额暂不可确认'
    : permission ? '部分额度层无权读取'
    : normalized?.eligible === false ? '该账号没有 Design Plan 订阅；钱包余额照常显示' : undefined;
  return { ...common, ...normalized, ...normalizeSubscription(personal ? summary : undefined), windows, balances, state: partial ? 'partial' : 'ok', ...(note ? { note } : {}) };
}

export async function readQuota(session: Session, signal?: AbortSignal, fetcher = fetch): Promise<QuotaSnapshot> {
  if (session.credentialType === 'device') return readDeviceQuota(session, signal, fetcher);
  const current = await consoleJson(CURRENT_URL, session, signal, fetcher);
  if (!record(current) || typeof current.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(current.workspaceId)) throw new ConsoleError('response');
  const personal = current.workspaceType === 'personal';
  const [usage, billing] = await Promise.allSettled([
    consoleJson(usageUrl(current.workspaceId), session, signal, fetcher),
    personal ? consoleJson(SUMMARY_URL, session, signal, fetcher) : Promise.resolve(undefined),
  ]);
  // Never hide an authentication failure behind success from the other pool.
  for (const item of [usage, billing]) if (item.status === 'rejected' && item.reason instanceof ConsoleError && item.reason.kind === 'auth') throw item.reason;
  const summary = billing.status === 'fulfilled' ? billing.value : undefined;
  const common = { source: session.source, updatedAt: new Date().toISOString() };
  let normalized: ReturnType<typeof normalizeQuota>;
  try {
    if (usage.status === 'rejected') throw usage.reason;
    normalized = normalizeQuota(usage.value, summary);
  } catch (error) {
    const balances = normalizeBalances(summary);
    if (!Object.keys(balances).length) throw error;
    return { ...common, state: 'partial', windows: [], balances, ...normalizeSubscription(summary), note: '钱包已读取；套餐赠送额度暂不可确认' };
  }
  const missingWindows = normalized.eligible !== false && !normalized.windows.length;
  const noSubscription = normalized.eligible === false && !normalized.windows.length;
  const missingBalances = personal && Object.keys(normalized.balances).length < 3;
  const partial = missingWindows || missingBalances || !personal;
  const note = !personal ? '团队或未知工作区：账号钱包口径未核实，暂不显示'
    : missingWindows ? '套餐额度窗口暂不可确认'
    : noSubscription ? '该账号没有 Design Plan 订阅；钱包余额照常显示'
    : missingBalances ? '部分钱包余额暂不可确认' : undefined;
  return { ...common, ...normalized, state: partial ? 'partial' : 'ok', ...(note === undefined ? {} : { note }) };
}
