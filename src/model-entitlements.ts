/** Account-bound, advisory Coding Plan coverage. Never borrows a different runtime identity. */
import type { CatalogModel } from './catalog.js';
import { desktopSession, deviceSession, isOfficialRuntimeUrl, readDesktopCredential, type AuthSession, type LoginGrant } from './auth.js';
import { consoleJson, CURRENT_URL, preflightUrl } from './quota.js';
import { combinedSignal, record } from './util.js';

export type ModelCoverage = 'included' | 'not-included' | 'unknown';
export interface ModelAccount {
  session: AuthSession;
  source: 'device' | 'desktop';
}
export interface ModelScope {
  workspaceId: string;
  memberId: string;
  /** Non-secret identity scope. Only its keyed binding may be persisted. */
  source: ModelAccount['source'];
}
export interface ModelEntitlements {
  state: 'verified' | 'partial' | 'unavailable';
  source?: ModelAccount['source'];
  tier?: string;
  updatedAt?: string;
}
export interface EntitlementResult {
  models: readonly CatalogModel[];
  summary: ModelEntitlements;
  scope?: ModelScope;
}
export interface EntitlementOptions {
  account?: ModelAccount;
  scope?: ModelScope;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const ENTITLEMENT_TIMEOUT_MS = 60_000;

/** Exact equality with an issued pair is required, not a matching tier/name/email. */
export async function resolveModelAccount(key: string, baseURL: string, grant: LoginGrant | undefined, useDesktop: boolean): Promise<ModelAccount | undefined> {
  if (!isOfficialRuntimeUrl(baseURL)) return;
  if (grant && 'kind' in grant && grant.kind === 'device' && grant.runtimeKey === key) {
    return { session: deviceSession(grant), source: 'device' };
  }
  if (!useDesktop) return;
  const desktop = await readDesktopCredential();
  if (desktop.state === 'credential' && desktop.credential.runtimeKey === key) {
    return { session: desktopSession(desktop.credential), source: 'desktop' };
  }
}

/** Current workspace and member are resolved together from the paired control credential. */
export async function readModelScope(account: ModelAccount, signal?: AbortSignal, fetcher = fetch): Promise<ModelScope> {
  const body = await consoleJson(CURRENT_URL, account.session, signal, fetcher);
  if (!record(body)) throw new Error('模型权益工作区不可确认');
  const workspaceId = body.activeWorkspaceId ?? body.workspaceId;
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId) || typeof body.workspaceMemberId !== 'string' || !ID.test(body.workspaceMemberId)
    || (body.workspaceId !== undefined && body.workspaceId !== workspaceId)
    || (body.memberStatus !== undefined && body.memberStatus !== 'active')) throw new Error('模型权益工作区不可确认');
  return { workspaceId, memberId: body.workspaceMemberId, source: account.source };
}

/** A missing preflight is unknown; exhausted quota does not change coverage. */
export function parseModelCoverage(value: unknown, scope: ModelScope, modelId: string): { coverage: ModelCoverage; tier?: string } | undefined {
  if (!record(value) || value.schemaVersion !== 1 || value.workspaceId !== scope.workspaceId || value.workspaceMemberId !== scope.memberId
    || value.modelId !== modelId || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || !record(value.codingPlan) || value.codingPlan.workspaceId !== scope.workspaceId || typeof value.codingPlan.eligible !== 'boolean'
    || typeof value.modelCovered !== 'boolean' || !['coding_plan', 'wallet', 'gateway'].includes(String(value.funding))) return;
  const tier = typeof value.codingPlan.tier === 'string' && ['go', 'plus', 'pro', 'max'].includes(value.codingPlan.tier) ? value.codingPlan.tier : undefined;
  const included = value.codingPlan.eligible && value.modelCovered;
  if (value.funding === 'coding_plan' && !included) return;
  return { coverage: included ? 'included' : 'not-included', ...(tier === undefined ? {} : { tier }) };
}

export function unverifiedModels(models: readonly CatalogModel[]): readonly CatalogModel[] {
  return models.map(model => ({ ...model, group: 'paid', coverage: 'unknown' }));
}

/** At most three bounded control-plane reads are active; no inference or quota reservation. */
export async function readModelEntitlements(models: readonly CatalogModel[], options: EntitlementOptions = {}): Promise<EntitlementResult> {
  const rows = unverifiedModels(models).map(model => ({ ...model }));
  if (!options.account || !options.scope) return { models: rows, summary: { state: 'unavailable' } };
  const { account, scope } = options;
  const deadline = combinedSignal(options.signal, ENTITLEMENT_TIMEOUT_MS);
  let next = 0, verified = 0;
  const tiers = new Set<string>();
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
    while (next < rows.length && !deadline.aborted) {
      const index = next++, row = rows[index]!;
      try {
        const value = await consoleJson(`${preflightUrl(scope.workspaceId)}?modelId=${encodeURIComponent(row.id)}`, account.session, deadline, options.fetcher ?? fetch);
        const evidence = parseModelCoverage(value, scope, row.id);
        if (!evidence) continue;
        rows[index] = { ...row, group: evidence.coverage === 'included' ? 'plan' : 'paid', coverage: evidence.coverage };
        if (evidence.tier) tiers.add(evidence.tier);
        verified++;
      } catch { if (options.signal?.aborted) options.signal.throwIfAborted(); }
    }
  }));
  options.signal?.throwIfAborted();
  // Conflicting subscription snapshots can straddle an upgrade/downgrade: do not publish a mixed classification.
  if (tiers.size > 1) return { models: unverifiedModels(models), summary: { state: 'unavailable', source: account.source }, scope };
  return { models: rows, scope, summary: {
    state: verified === rows.length && verified > 0 ? 'verified' : verified > 0 ? 'partial' : 'unavailable', source: account.source,
    ...(tiers.size === 1 ? { tier: [...tiers][0] } : {}), updatedAt: new Date().toISOString(),
  } };
}
