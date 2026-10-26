// OpenDesign normalization and independent-pool degradation adapted from dsh-subusage 0.16.2 (MIT).
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { record, combinedSignal } from './util.js';

export const API_BASE = 'https://amr-api.open-design.ai/api/v1';
export const CURRENT_URL = `${API_BASE}/workspaces/current`;
export const SUMMARY_URL = `${API_BASE}/billing/summary`;
export const usageUrl = (workspace: string) => `${API_BASE}/workspaces/${encodeURIComponent(workspace)}/billing/coding-plan-usage`;
export type SessionSource = 'desktop' | 'login' | 'environment';
export interface Session { headers: Record<string, string>; source: SessionSource }
export interface QuotaWindow {
  durationSeconds: number; used: number; limit: number; remaining?: number; percent: number; resetsAt?: string;
}
export interface QuotaSnapshot {
  state: 'ok' | 'partial' | 'need-login' | 'error';
  source?: SessionSource;
  updatedAt: string;
  tier?: string;
  eligible?: boolean;
  windows: QuotaWindow[];
  balances: { subscriptionUsd?: number; rechargeUsd?: number; totalUsd?: number };
  note?: string;
}
export class ConsoleError extends Error {
  constructor(readonly kind: 'auth' | 'permission' | 'network' | 'response' | 'rate-limit', readonly status?: number) {
    super(kind === 'auth' ? 'OpenDesign 登录已失效，请重新登录' : kind === 'permission' ? 'OpenDesign 当前登录态无权读取该额度层' : kind === 'rate-limit' ? 'OpenDesign 额度接口限流，请稍后刷新' : kind === 'response' ? 'OpenDesign 额度接口返回格式发生变化' : 'OpenDesign 额度暂时无法读取');
  }
}
export async function consoleJson(url: string, session: Session, signal?: AbortSignal, fetcher = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { ...attributionHeaders(), accept: 'application/json', ...session.headers }, signal: combinedSignal(signal, 20000), redirect: 'error' });
  } catch { throw new ConsoleError('network'); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ConsoleError(response.status === 401 ? 'auth' : 'permission', response.status); }
  if (!response.ok) { await response.body?.cancel(); throw new ConsoleError(response.status === 429 ? 'rate-limit' : 'network', response.status); }
  // Console responses are small; reject unexpected HTML/downloads without echoing it.
  const reader = response.body?.getReader();
  if (!reader) throw new ConsoleError('response');
  let size = 0, raw = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new ConsoleError('response');
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try { return JSON.parse(raw); } catch { throw new ConsoleError('response'); }
}
function number(value: unknown, negative = false): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/u.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && (negative || n >= 0) ? n : undefined;
}
export function normalizeQuota(body: unknown, summary?: unknown): Pick<QuotaSnapshot, 'windows' | 'balances' | 'tier' | 'eligible'> {
  if (!record(body) || !(typeof body.eligible === 'boolean' || typeof body.tier === 'string' || body.tier === null || Array.isArray(body.windows))) throw new ConsoleError('response');
  const windows: QuotaWindow[] = [];
  for (const row of Array.isArray(body.windows) ? body.windows : []) {
    if (!record(row)) continue;
    const seconds = number(row.durationSeconds), used = number(row.usedCredits), limit = number(row.limitCredits), remaining = number(row.remainingCredits);
    if (seconds === undefined || seconds <= 0 || used === undefined || limit === undefined || limit <= 0) continue;
    windows.push({ durationSeconds: seconds, used, limit, percent: Math.min(100, used / limit * 100), ...(remaining === undefined ? {} : { remaining }), ...(typeof row.resetsAt === 'string' && Number.isFinite(Date.parse(row.resetsAt)) ? { resetsAt: row.resetsAt } : {}) });
  }
  return { windows, balances: normalizeBalances(summary), ...(typeof body.tier === 'string' && body.tier ? { tier: body.tier } : {}), ...(typeof body.eligible === 'boolean' ? { eligible: body.eligible } : {}) };
}
export function normalizeBalances(summary: unknown): QuotaSnapshot['balances'] {
  if (!record(summary)) return {};
  const perUsd = number(summary.creditsPerUsd), balances = record(summary.balances) ? summary.balances : {};
  const subscription = number(balances.subscriptionCredits), recharge = number(balances.rechargeCredits), total = number(balances.totalAvailableCredits, true);
  const divisor = perUsd !== undefined && perUsd > 0 ? perUsd : undefined;
  const totalUsd = number(summary.balanceUsd, true) ?? number(summary.totalAvailableCreditsUsd, true) ?? (divisor !== undefined && total !== undefined ? total / divisor : undefined);
  return { ...(divisor !== undefined && subscription !== undefined ? { subscriptionUsd: subscription / divisor } : {}), ...(divisor !== undefined && recharge !== undefined ? { rechargeUsd: recharge / divisor } : {}), ...(totalUsd !== undefined ? { totalUsd } : {}) };
}
export async function readQuota(session: Session, signal?: AbortSignal, fetcher = fetch): Promise<QuotaSnapshot> {
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
    return { ...common, state: 'partial', windows: [], balances, note: '钱包已读取；套餐赠送额度暂不可确认' };
  }
  const missingWindows = normalized.eligible === true && !normalized.windows.length;
  const missingBalances = personal && Object.keys(normalized.balances).length < 3;
  const partial = missingWindows || missingBalances || !personal;
  return { ...common, ...normalized, state: partial ? 'partial' : 'ok', ...(partial ? { note: !personal ? '团队或未知工作区：账号钱包口径未核实，暂不显示' : missingWindows ? '套餐存在，但额度窗口暂不可确认' : '部分钱包余额暂不可确认' } : {}) };
}
