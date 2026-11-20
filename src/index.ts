import { randomUUID, createHash, createHmac } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { credentialKey, credentialRef, type CredentialRecord, type CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { CoRouterAdapter } from './adapter.js';
import { ReplayKeyStore } from './replay-key.js';
import { installEotRecovery } from './eot-recovery.js';
import { installTurnMonitor } from './turn-monitor.js';
import type { TurnMonitorStatus } from './turn-monitor-status.js';
import { fetchModelCatalog } from './model-discovery.js';
import { ModelDirectory } from './model-directory.js';
import { SelectorBridge } from './selector-bridge.js';
import { resolveModelAccount, type ModelAccount, type EntitlementResult, type ModelScope } from './model-entitlements.js';
import { effectiveProtocol } from './protocol-options.js';
import { fetchPricingSnapshot } from './pricing.js';
import { applyModelSettings, isModelEnabled } from './model-settings.js';
import { modelReasoningEfforts, vendorDefaultEffort } from './reasoning.js';
import type { CatalogModel } from './catalog.js';
import { Config, SETTINGS_NS, PLAN_PROVIDER, PAID_PROVIDER, apiKeyRef, readConfig, type LiveConfig } from './config.js';
import { parseModelCatalogSnapshot, type ModelCatalogSnapshot } from './model-catalog-snapshot.js';
import { parseQuotaCache, quotaCacheSnapshot, restoredQuotaSnapshot } from './quota-cache.js';
import type { QuotaCacheRecord } from './quota-cache.js';
import { priceCacheRecord, restoredPriceCatalog } from './price-cache.js';
import { resolveSession, deviceGrant, isOfficialRuntimeUrl, readDesktopCredential, COOKIE_ENV_REFS, type LoginGrant } from './auth.js';
import { ConsoleLogin, type LoginOptions } from './login.js';
import { ActivationLauncher, type ActivationLauncherOptions } from './browser-open.js';
import { readQuota, ConsoleError, type QuotaSnapshot } from './quota.js';
import { readDesktopQuota } from './desktop-quota.js';
import { record } from './util.js';
import { parseStatus, parsePriceCatalog, parseLoginState, parseStartLoginRequest as parseStartLogin, parseCancelLoginRequest as parseCancelLogin, parseSaveApiKeyRequest as parseSaveApiKey, parseActivationOpenState,
  type Status, type PriceCatalog, type LoginState, type StartLoginRequest, type CancelLoginRequest, type SaveApiKeyRequest, type ActivationOpenState } from './remote.js';

export { Config } from './config.js';
export { CoRouterAdapter } from './adapter.js';
export { MODELS } from './catalog.js';
export const name = 'llm-opendesign-corouter';
export const inject = ['llm'];
const API_KEY = credentialKey(name, 'api-key');
const SESSION = credentialKey(name, 'console');
/** The Host settings service's revision-conflict code (`SettingsConflictError.code`). */
const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT';
/** A saved reading keeps its numbers without a rewrite; refresh its timestamp at this cadence. */
const QUOTA_CACHE_WRITE_MS = 6 * 60 * 60_000;
/** Public price snapshots use the same write cadence: content change or an old timestamp. */
const PRICE_CACHE_WRITE_MS = 6 * 60 * 60_000;
/**
 * Both routes authenticate themselves: a saved API key, a profile-named reference, or an
 * OpenDesign device sign-in. Declaring that path tells the directory the plugin owns its
 * credentials instead of reading a per-route environment field.
 *
 * It is a description, not a repair: the observed Host model page acts on this declaration only
 * for its own DeepSeek and pi-ai layouts, and shows this namespace a read-only hint instead. The
 * missing-API-key warning disappears because the profile names no reference by default; a
 * reference the user does name stays authoritative for requests and stays what the page reports on.
 */
const NATIVE_AUTH = { env: [], oauth: true } as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
/** The persisted catalog and price snapshots never participate in revision or login fingerprints. */
const stableConfig = (config: ReturnType<typeof readConfig>): ReturnType<typeof readConfig> => {
  const { modelCatalog: _snapshot, priceCache: _prices, ...rest } = config;
  return rest;
};
const needLogin = (): QuotaSnapshot => ({ state: 'need-login', updatedAt: new Date().toISOString(), windows: [], balances: {}, note: '请在连接与登录页完成账号授权后读取额度。' });
const unreadQuota = (): QuotaSnapshot => ({ state: 'partial', updatedAt: new Date().toISOString(), windows: [], balances: {}, note: '额度尚未读取，请刷新额度。' });
interface CapturedState {
  apiRecord: CredentialRecord | undefined; sessionRecord: CredentialRecord | undefined;
  key: string | undefined; keySource: Status['apiKeySource']; config: ReturnType<typeof readConfig>;
}
interface LoginCapture { revision: string; sessionHash: string; configHash: string }
/** Narrow structural view of the Host settings service; only the catalog snapshot field is written. */
interface SettingsWriter {
  describe(): readonly { ns: string; revision: number }[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}
export interface HostDependencies {
  resolveSession: typeof resolveSession;
  readDesktopCredential?: typeof readDesktopCredential;
  readQuota: typeof readQuota;
  readDesktopQuota: typeof readDesktopQuota;
  fetchModels?: typeof fetchModelCatalog;
  modelAccount?: (key: string, baseURL: string, grant: LoginGrant | undefined, useDesktop: boolean) => Promise<ModelAccount | undefined>;
  readModelScope?: (account: ModelAccount, signal?: AbortSignal) => Promise<ModelScope>;
  readEntitlements?: (models: readonly CatalogModel[], options?: import('./model-entitlements.js').EntitlementOptions) => Promise<EntitlementResult>;
  fetchPrices?: typeof fetchPricingSnapshot;
  modelsChanged?: () => void;
  /** Offline fixtures may drive the directory lifetime explicitly. Production defaults on. */
  modelAutoRefresh?: boolean;
  loginOptions?: LoginOptions;
  activationOptions?: ActivationLauncherOptions;
}
function grantOf(value: CredentialRecord | undefined): LoginGrant | undefined {
  if (value?.kind !== 'grant' || !record(value.payload)) return;
  if (value.payload.kind === 'device') return deviceGrant(value.payload);
  if (typeof value.payload.cookie !== 'string') return;
  return { cookie: value.payload.cookie, ...(typeof value.payload.expiresAt === 'number' ? { expiresAt: value.payload.expiresAt } : {}) };
}
export class OpenDesignCoRouterService extends TypertRemoteService {
  private readonly _config: () => ReturnType<typeof readConfig>;
  private readonly _login: ConsoleLogin;
  private readonly _activation: ActivationLauncher;
  private readonly _lifetime = new AbortController();
  private _revision = randomUUID();
  private _fingerprint = '';
  private _quota = unreadQuota();
  private _quotaAt = 0;
  private _quotaConfig = '';
  private _quotaIdentity: string | undefined;
  private _quotaEpoch = 0;
  private _quotaPending: Promise<QuotaSnapshot> | undefined;
  private _quotaController: AbortController | undefined;
  /** Identity fingerprint of the saved reading already considered by this instance. */
  private _quotaCacheSeen: string | undefined;
  /** True while the shown reading came from the saved cache rather than a live read. */
  private _quotaRestored = false;
  /** Content key of the saved reading; a timestamp-only difference never rewrites settings. */
  private _quotaCacheKey = '';
  private _quotaCacheAt = 0;
  private _quotaWrite: Promise<void> = Promise.resolve();
  guardedTurns: number = 0;
  turnMonitorStatus: (() => TurnMonitorStatus) | undefined;
  private readonly _directory: ModelDirectory;
  private readonly _catalogKeys: ReplayKeyStore;
  private _modelsFingerprint = '';
  private _prices: PriceCatalog | undefined;
  private _pricesPending: Promise<PriceCatalog> | undefined;
  /** Content key of the saved price snapshot; a timestamp-only difference never rewrites settings. */
  private _priceCacheKey = '';
  private _priceCacheAt = 0;
  private _priceWrite: Promise<void> = Promise.resolve();
  modelCatalog(): readonly CatalogModel[] { return this._directory.models(); }
  modelWorkspace(): string | undefined { return this._directory.workspace(); }
  modelCallIdentity(): import('./model-directory.js').DirectoryCallIdentity | undefined { return this._directory.callIdentity(); }
  async currentModelCatalog(): Promise<readonly CatalogModel[]> {
    await this._state();
    // A saved, identity-bound directory answers without one preflight per model.
    if (this._directory.updatedAt() === undefined) await this._directory.ensurePublished();
    else if (this.dependencies.modelAutoRefresh !== false) this._directory.warm();
    return this._directory.models();
  }
  constructor(ctx: Context, config: () => ReturnType<typeof readConfig>, readonly dependencies: HostDependencies = { resolveSession, readQuota, readDesktopQuota }) {
    super(ctx, 'openDesignCoRouter');
    this._config = config;
    // A saved public price snapshot answers the first read after a rebuild, marked stale.
    const savedPrices = this._config().priceCache;
    if (savedPrices !== undefined) {
      const restored = restoredPriceCatalog(savedPrices);
      if (restored !== undefined) {
        this._prices = restored;
        this._priceCacheKey = JSON.stringify([savedPrices.state, savedPrices.models]);
        this._priceCacheAt = Number.isFinite(Date.parse(savedPrices.fetchedAt)) ? Date.parse(savedPrices.fetchedAt) : 0;
      }
    }
    this._catalogKeys = new ReplayKeyStore(() => ctx.get('credentials'));
    this._directory = new ModelDirectory({
      config: this._config,
      state: async () => {
        const state = await this._state();
        const account = state.key ? await (dependencies.modelAccount ?? resolveModelAccount)(state.key, state.config.baseURL, grantOf(state.sessionRecord), state.config.useDesktopCredential) : undefined;
        return { ...(state.key ? { key: state.key } : {}), ...(account ? { account } : {}) };
      },
      changed: () => dependencies.modelsChanged?.(), persist: snapshot => this._persistModels(snapshot),
      bindingSecret: signal => this._catalogKeys.get(signal),
      ...(dependencies.fetchModels ? { fetchModels: dependencies.fetchModels } : {}),
      ...(dependencies.readModelScope ? { readScope: dependencies.readModelScope } : {}),
      ...(dependencies.readEntitlements ? { readEntitlements: dependencies.readEntitlements } : {}),
    });
    this._login = new ConsoleLogin({
      capture: async expectedRevision => {
        const state = await this._state();
        this._expect(expectedRevision);
        this._credentials();
        return { revision: expectedRevision, sessionHash: hash(state.sessionRecord), configHash: hash(stableConfig(state.config)) } satisfies LoginCapture;
      },
      commit: async (tokens, captured, signal) => {
        if (!record(captured) || typeof captured.revision !== 'string' || typeof captured.sessionHash !== 'string' || typeof captured.configHash !== 'string') throw this._conflict();
        await this._state();
        this._expect(captured.revision);
        signal.throwIfAborted();
        await this._credentials().modifyRecord(SESSION, async current => {
          signal.throwIfAborted();
          if (hash(current) !== captured.sessionHash || hash(stableConfig(this._config())) !== captured.configHash) throw this._conflict();
          const grant = deviceGrant({ kind: 'device', ...tokens });
          if (!grant) throw new ConsoleError('auth');
          return { kind: 'grant', payload: { ...grant, savedAt: new Date().toISOString() } };
        });
        this._invalidateQuota();
        this._modelsFingerprint = '';
        this._invalidateModels();
      },
    }, {
      ...dependencies.loginOptions,
      // The Host owns the temporary window, so it closes it on every terminal transition —
      // including expiry, which happens on a timer even when no UI is polling.
      onSettled: () => { void this._activation.close(); },
    });
    this._activation = new ActivationLauncher(dependencies.activationOptions);
    ctx.effect(() => () => { this._lifetime.abort(); this._directory.dispose(); this._catalogKeys.dispose(); this._login.dispose(); return this._activation.dispose(); });
  }
  private _credentials(): CredentialProvider {
    const service = this.ctx.get('credentials');
    if (!service) throw new RemoteError('opendesign/credentials-unavailable', 'DSH 凭据服务不可用；可先使用启动环境变量', undefined);
    return service;
  }
  private async _key(ref: string, baseURL: string, apiRecord: CredentialRecord | undefined, sessionRecord: CredentialRecord | undefined): Promise<{ key: string; source: NonNullable<Status['apiKeySource']> } | undefined> {
    const credentials = this.ctx.get('credentials');
    const ambient = credentials ? (await credentials.resolve(credentialRef(ref)))?.value : launchEnvironmentOf(this.ctx).get(ref)?.value;
    if (ambient?.trim()) return { key: ambient, source: 'reference' };
    if (apiRecord?.kind === 'api-key' && apiRecord.key?.trim()) return { key: apiRecord.key, source: 'stored' };
    const grant = grantOf(sessionRecord);
    if (isOfficialRuntimeUrl(baseURL) && grant && 'kind' in grant && grant.kind === 'device') return { key: grant.runtimeKey, source: 'device' };
    if (isOfficialRuntimeUrl(baseURL) && this._config().useDesktopCredential) {
      const desktop = await (this.dependencies.readDesktopCredential ?? readDesktopCredential)();
      if (desktop.state === 'credential' && desktop.credential.runtimeKey) return { key: desktop.credential.runtimeKey, source: 'desktop' };
    }
  }
  async resolveApiKey(ref: string, baseURL = this._config().baseURL): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials');
    const [apiRecord, sessionRecord] = await Promise.all([credentials?.readRecord(API_KEY), credentials?.readRecord(SESSION)]);
    return (await this._key(ref, baseURL, apiRecord, sessionRecord))?.key;
  }
  /** Persist the gateway catalog snapshot; see {@link _persistField} for the write policy. */
  private async _persistModels(value: ModelCatalogSnapshot): Promise<'saved' | 'unsupported' | 'unavailable' | 'failed'> {
    return this._persistField({ modelCatalog: value });
  }
  /**
   * Persist one cache field through the Host form service.
   * `unsupported` means no settings service is composed (nothing to report);
   * `unavailable` means the service exists but exposes no writable form for this plugin.
   *
   * A settings write rewrites the whole composed profile and may rebuild the plugin tree, so
   * only a concurrent revision conflict (`SETTINGS_CONFLICT`) is worth re-reading the revision
   * and trying once more. Every other failure repeats identically and is reported immediately.
   */
  private async _persistField(patch: object): Promise<'saved' | 'unsupported' | 'unavailable' | 'failed'> {
    const settings = this.ctx.get('settings') as unknown as SettingsWriter | undefined;
    if (!settings) return 'unsupported';
    for (let attempt = 0; attempt < 2; attempt++) {
      let descriptor: { ns: string; revision: number } | undefined;
      try { descriptor = settings.describe().find(item => item.ns === SETTINGS_NS); }
      catch { return 'unavailable'; }
      if (!descriptor) return 'unavailable';
      try {
        await settings.update(SETTINGS_NS, patch, descriptor.revision);
        return 'saved';
      } catch (error) {
        if (attempt > 0 || !record(error) || error.code !== SETTINGS_CONFLICT) return 'failed';
      }
    }
    return 'failed';
  }
  private _invalidateModels(): void {
    this._directory.invalidate();
  }
  private async _state(): Promise<CapturedState> {
    const credentials = this.ctx.get('credentials'), config = this._config();
    const [apiRecord, sessionRecord] = await Promise.all([credentials?.readRecord(API_KEY), credentials?.readRecord(SESSION)]);
    const resolved = await this._key(apiKeyRef(config), config.baseURL, apiRecord, sessionRecord);
    const key = resolved?.key;
    const state = { apiRecord, sessionRecord, key, keySource: resolved?.source, config };
    const modelsFingerprint = hash({ key, baseURL: config.baseURL, session: sessionRecord, desktop: config.useDesktopCredential });
    if (modelsFingerprint !== this._modelsFingerprint) {
      this._modelsFingerprint = modelsFingerprint;
      this._invalidateModels();
    }
    const fingerprint = hash({ ...state, config: stableConfig(state.config) });
    if (fingerprint !== this._fingerprint) { this._fingerprint = fingerprint; this._revision = randomUUID(); }
    return state;
  }
  private _conflict() { return new RemoteError('opendesign/revision-conflict', '连接或凭据已改变，请刷新页面后重试', undefined); }
  private _expect(revision: string) { if (revision !== this._revision) throw this._conflict(); }
  private _invalidateQuota(): void { this._quotaAt = 0; this._quotaEpoch++; this._quota = unreadQuota(); this._quotaIdentity = undefined; this._quotaRestored = false; this._quotaController?.abort(); this._quotaPending = undefined; this._quotaCacheSeen = undefined; }
  /**
   * Publish the saved reading for this identity.
   *
   * Every settings write can rebuild this plugin, and an in-memory-only reading was gone by
   * the next UI read: the settings page opened on “not read yet” until someone refreshed by
   * hand. The saved reading answers that read; the upstream read stays a separate step.
   */
  private async _restoreQuota(state: CapturedState): Promise<void> {
    const saved = state.config.quotaCache;
    if (saved === undefined) return;
    if (this._quotaAt !== 0 || this._quotaPending !== undefined) return;
    if (this._quotaCacheSeen === saved.binding) return;
    this._quotaCacheSeen = saved.binding;
    const restored = restoredQuotaSnapshot(saved);
    if (restored === undefined) return;
    const binding = await this._quotaBinding(state);
    if (binding === undefined || saved.binding !== binding) return;
    if (this._quotaAt !== 0 || this._quotaPending !== undefined) return;
    this._quota = restored;
    this._quotaIdentity = undefined;
    this._quotaRestored = true;
    // The next read repeats these numbers; remember what is already saved so it does not
    // rewrite the profile (a settings write rebuilds this plugin) once per refresh cycle.
    this._quotaCacheKey = this._quotaContentKey(saved.snapshot);
    this._quotaCacheAt = Number.isFinite(Date.parse(saved.readAt)) ? Date.parse(saved.readAt) : 0;
  }
  /**
   * Identity the saved reading belongs to.
   *
   * The payload names the gateway, the credential records, the desktop login and the
   * environment cookie references; the keyed digest keeps those values out of ordinary
   * settings while still failing closed for another account. Undefined means the binding
   * secret is unavailable, so nothing is saved or restored.
   */
  private async _quotaBinding(state: CapturedState): Promise<string | undefined> {
    const config = this._config();
    let secret: Uint8Array;
    try { secret = await this._catalogKeys.get(this._lifetime.signal); }
    catch { return undefined; }
    try {
      const environment = launchEnvironmentOf(this.ctx);
      const envRefs = COOKIE_ENV_REFS.map(ref => environment.get(ref)?.value ?? '');
      let desktop: unknown;
      if (config.useDesktopCredential) {
        const read = await (this.dependencies.readDesktopCredential ?? readDesktopCredential)();
        desktop = read.state === 'credential' ? { profile: read.credential.profile, key: read.credential.runtimeKey ?? read.credential.controlKey } : read.state;
      }
      return createHmac('sha256', secret).update(JSON.stringify(['opendesign-quota-v1', config.baseURL, config.useDesktopCredential, desktop ?? null, state.apiRecord ?? null, state.sessionRecord ?? null, envRefs])).digest('hex');
    } finally { secret.fill(0); }
  }
  /** What a saved reading records; the refresh plan, failure counters and staleness are runtime only. */
  private _quotaContentKey(snapshot: QuotaSnapshot): string {
    return JSON.stringify([snapshot.state, snapshot.source, snapshot.tier, snapshot.eligible, snapshot.windows, snapshot.balances, snapshot.subscriptionPeriodStart, snapshot.subscriptionPeriodEnd, snapshot.note]);
  }
  /** Save the committed reading for the next instance; only readings with data are kept. */
  private _cacheQuota(result: QuotaSnapshot): void {
    if (result.state === 'need-login' || result.state === 'error') return;
    const snapshot = quotaCacheSnapshot(result);
    if (snapshot.windows.length === 0 && Object.keys(snapshot.balances).length === 0) return;
    // A read repeats its numbers every minute; only a content change (or an old timestamp) writes.
    const content = this._quotaContentKey(snapshot);
    if (content === this._quotaCacheKey && Date.now() - this._quotaCacheAt < QUOTA_CACHE_WRITE_MS) return;
    this._quotaWrite = this._quotaWrite.then(async () => {
      if (this._lifetime.signal.aborted) return;
      const state = await this._state();
      const binding = await this._quotaBinding(state);
      if (binding === undefined) return;
      const record = parseQuotaCache({ version: 1, binding, readAt: snapshot.updatedAt, snapshot });
      if (record === undefined) return;
      const saved = await this._persistQuota(record);
      if (this._lifetime.signal.aborted) return;
      if (saved === 'saved') { this._quotaCacheKey = content; this._quotaCacheAt = Date.now(); }
      else this._quotaCacheKey = '';
    }).catch(() => { this._quotaCacheKey = ''; });
  }
  /** Persist one saved reading; like the catalog snapshot, only a revision conflict is retried. */
  private async _persistQuota(value: QuotaCacheRecord): Promise<'saved' | 'unsupported' | 'unavailable' | 'failed'> {
    return this._persistField({ quotaCache: value });
  }
  /** Persist one saved public price snapshot; only a revision conflict is retried. */
  private async _persistPrices(value: NonNullable<ReturnType<typeof priceCacheRecord>>): Promise<'saved' | 'unsupported' | 'unavailable' | 'failed'> {
    return this._persistField({ priceCache: value });
  }
  /** Save the committed price snapshot for the next instance; only successful, non-empty reads are kept. */
  private _cachePrices(result: PriceCatalog): void {
    const record = priceCacheRecord(result);
    if (record === undefined) return;
    // A fetch repeats the same quotes; only a content change (or an old timestamp) writes.
    const content = JSON.stringify([record.state, record.models]);
    if (content === this._priceCacheKey && Date.now() - this._priceCacheAt < PRICE_CACHE_WRITE_MS) return;
    this._priceWrite = this._priceWrite.then(async () => {
      if (this._lifetime.signal.aborted) return;
      const saved = await this._persistPrices(record);
      if (this._lifetime.signal.aborted) return;
      if (saved === 'saved') { this._priceCacheKey = content; this._priceCacheAt = Date.now(); }
      else this._priceCacheKey = '';
    }).catch(() => { this._priceCacheKey = ''; });
  }
  @Remote('status')
  async status(): Promise<Status> {
    const state = await this._state();
    if (this.dependencies.modelAutoRefresh !== false) this._directory.warm();
    const quotaConfig = hash({ desktop: state.config.useDesktopCredential, session: state.sessionRecord, refreshSeconds: state.config.quotaRefreshSeconds });
    if (this._quotaConfig !== quotaConfig) { this._quotaConfig = quotaConfig; this._invalidateQuota(); }
    // The UI read answers from the saved reading; the upstream read stays a separate step.
    await this._restoreQuota(state);
    return parseStatus({
      revision: this._revision, apiKeyConfigured: Boolean(state.key?.trim()),
      ...(state.keySource ? { apiKeySource: state.keySource } : {}),
      ...(this._quota.source ? { sessionSource: this._quota.source } : {}),
      quota: this._quota, login: this._login.status(), config: { ...state.config, apiKeyEnv: state.config.apiKeyEnv ?? '' }, guardedTurns: this.guardedTurns,
      ...(this.turnMonitorStatus ? { turnMonitor: this.turnMonitorStatus() } : {}),
      models: this._directory.models().map(row => {
        const { id, name, group, contextWindow, maxOutputTokens, inputModalities } = row;
        const protocol = effectiveProtocol(row, state.config.apiProtocol, state.config.modelSettings?.[row.id]?.apiProtocol);
        const reasoningEfforts = modelReasoningEfforts(row, protocol);
        const defaultEffort = vendorDefaultEffort(row, protocol);
        return {
          id, name, group, enabled: isModelEnabled(id, state.config.modelSettings),
          ...(row.coverage ? { coverage: row.coverage } : {}),
          ...(row.nativeProtocol ? { nativeProtocol: row.nativeProtocol } : {}),
          effectiveProtocol: protocol,
          ...(inputModalities === undefined ? {} : { inputModalities }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          ...(row.reasoningMode === undefined ? {} : { reasoningMode: row.reasoningMode }),
          ...(row.reasoningEfforts === undefined ? {} : { catalogReasoningEfforts: row.reasoningEfforts }),
          ...(row.defaultEffort === undefined ? {} : { catalogDefaultEffort: row.defaultEffort }),
          ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        };
      }),
      modelsSource: this._directory.updatedAt() ? 'openai' : 'builtin',
      ...(this._directory.updatedAt() ? { modelsUpdatedAt: this._directory.updatedAt() } : {}),
      ...(this._directory.error() ? { modelsError: this._directory.error() } : {}),
      modelEntitlements: this._directory.entitlements(),
      ...(this._prices === undefined ? {} : { prices: this._prices }),
    });
  }
  @Remote('refreshModels')
  async refreshModels(): Promise<Status> {
    await this._state();
    await this._directory.refresh();
    return this.status();
  }
  /** Public website prices do not use gateway credentials or alter the model catalog. */
  @Remote('refreshPrices')
  async refreshPrices(): Promise<PriceCatalog> {
    if (this._pricesPending) return this._pricesPending;
    const run = (async (): Promise<PriceCatalog> => {
      try {
        const result = await (this.dependencies.fetchPrices ?? fetchPricingSnapshot)({ signal: this._lifetime.signal });
        if (this._lifetime.signal.aborted || result.status === 'failed') throw new Error('price unavailable');
        const next = parsePriceCatalog({
          state: result.status, stale: false, fetchedAt: result.fetchedAt,
          models: result.models.map(({ id, tiers }) => ({ id, tiers })),
        });
        this._prices = next;
        // Keep the UI read independent of the next website read.
        this._cachePrices(next);
        return next;
      } catch {
        return this._prices === undefined
          ? { state: 'error', stale: false, models: [] }
          : { ...this._prices, state: 'error', stale: true };
      }
    })();
    this._pricesPending = run;
    try { return await run; }
    finally { if (this._pricesPending === run) this._pricesPending = undefined; }
  }
  @Remote('refreshQuota')
  async refreshQuota(): Promise<QuotaSnapshot> { return this._refreshQuota(false); }
  @Remote('refreshQuotaNow')
  async refreshQuotaNow(): Promise<QuotaSnapshot> { return this._refreshQuota(true); }
  private async _refreshQuota(force: boolean): Promise<QuotaSnapshot> {
    const state = await this._state();
    const fingerprint = hash({ desktop: state.config.useDesktopCredential, session: state.sessionRecord, refreshSeconds: state.config.quotaRefreshSeconds });
    if (fingerprint !== this._quotaConfig) { this._quotaConfig = fingerprint; this._invalidateQuota(); }
    if (this._quotaPending) return this._quotaPending;
    if (!force) {
      if (this._quota.autoRefreshPaused) return this._quota;
      const next = this._quota.nextRefreshAt ? Date.parse(this._quota.nextRefreshAt) : this._quotaAt + 5000;
      if (Date.now() < next) return this._quota;
    }
    const epoch = this._quotaEpoch;
    const controller = new AbortController(); this._quotaController = controller;
    const signal = AbortSignal.any([controller.signal, this._lifetime.signal]);
    const failures = force ? 0 : this._quota.refreshFailures ?? 0;
    const run = this._readQuota(epoch, signal, failures);
    this._quotaPending = run;
    void run.finally(() => { if (this._quotaPending === run) this._quotaPending = undefined; }).catch(() => {});
    return run;
  }
  private async _readQuota(epoch: number, signal: AbortSignal, failures: number): Promise<QuotaSnapshot> {
    const config = this._config();
    let result: QuotaSnapshot;
    let identity: string | undefined;
    let refreshFailed = false;
    try {
      const grant = grantOf(await this.ctx.get('credentials')?.readRecord(SESSION));
      const authDeps = {
        useDesktop: config.useDesktopCredential,
        readGrant: async () => grant,
        resolveRef: async (ref: string) => {
          const credentials = this.ctx.get('credentials');
          return credentials ? (await credentials.resolve(credentialRef(ref)))?.value : launchEnvironmentOf(this.ctx).get(ref)?.value;
        },
      };
      const auth = await this.dependencies.resolveSession(authDeps);
      if (auth.state === 'ready') identity = hash(auth.session);
      if (auth.state === 'need-login') result = needLogin();
      else if (auth.session.source !== 'desktop') result = await this.dependencies.readQuota(auth.session, signal);
      else {
        try {
          result = await this.dependencies.readDesktopQuota(auth.session, signal);
          if (result.state === 'partial') {
            const fallback = await this.dependencies.resolveSession({ ...authDeps, useDesktop: false });
            if (fallback.state === 'ready') {
              try {
                const complete = await this.dependencies.readQuota(fallback.session, signal);
                if (complete.state === 'ok' && (complete.windows.length > 0 || complete.eligible === false)) {
                   result = { ...complete, note: `桌面登录态仅提供部分额度；当前显示独立登录账号的完整额度。${complete.note ? ` ${complete.note}` : ''}` };
                   identity = hash(fallback.session);
                 }
              } catch (error) {
                if (signal.aborted) throw error;
                // A failed optional fallback does not discard the usable desktop snapshot.
              }
            }
          }
        }
        catch (error) {
          // An expired desktop credential must not permanently shadow a valid console login.
          if (!(error instanceof ConsoleError) || !['auth', 'permission'].includes(error.kind)) throw error;
          const fallback = await this.dependencies.resolveSession({ ...authDeps, useDesktop: false });
          if (fallback.state !== 'ready') throw new ConsoleError('auth');
          identity = hash(fallback.session);
          result = await this.dependencies.readQuota(fallback.session, signal);
        }
      }
    } catch (error) {
      const authFailure = error instanceof ConsoleError && error.kind === 'auth';
      refreshFailed = !authFailure;
      const hasReadings = this._quota.windows.length > 0 || Object.keys(this._quota.balances).length > 0;
      // The saved reading already matched this identity; only an observed identity switch clears it.
      const sameIdentity = identity === this._quotaIdentity || (this._quotaRestored && this._quotaIdentity === undefined);
      if (!authFailure && identity !== undefined && sameIdentity && hasReadings) {
        result = { ...this._quota, state: 'partial', stale: true, note: '额度刷新失败，当前显示上次成功读数。' };
      } else {
        result = { ...needLogin(), state: authFailure ? 'need-login' : 'error', note: error instanceof ConsoleError ? error.message : '额度读取暂时失败；请检查连接或重新登录' };
      }
    }
    if (!signal.aborted && epoch === this._quotaEpoch) {
      this._quotaAt = Date.now();
      if (refreshFailed) {
        const count = failures + 1;
        const paused = count >= 6;
        const { nextRefreshAt: _previousPlan, ...previous } = result;
        result = { ...previous, refreshFailures: count, autoRefreshPaused: paused,
          ...(paused ? { note: `${result.note ?? '额度刷新失败'} 自动重试已暂停，请点击刷新额度重试。` } : { nextRefreshAt: new Date(this._quotaAt + Math.min(60_000, 5000 * 2 ** (count - 1))).toISOString() }),
        };
      } else if (result.state !== 'need-login') {
        result = { ...result, nextRefreshAt: new Date(this._quotaAt + (config.quotaRefreshSeconds ?? 60) * 1000).toISOString() };
      }
      this._quota = result;
      this._quotaIdentity = identity;
      if (!refreshFailed) this._quotaRestored = false;
      // Keep the UI read independent of the next upstream read.
      this._cacheQuota(result);
    }
    return epoch === this._quotaEpoch ? result : this._quota;
  }
  @Remote('startLogin')
  async startLogin(input: StartLoginRequest): Promise<LoginState> {
    const request = parseStartLogin(input);
    await this._state(); this._expect(request.expectedRevision); this._credentials();
    return parseLoginState(this._login.start(request));
  }
  @Remote('loginStatus')
  loginStatus(): LoginState { return parseLoginState(this._login.status()); }
  @Remote('cancelLogin')
  cancelLogin(input: CancelLoginRequest): LoginState { return parseLoginState(this._login.cancel(parseCancelLogin(input))); }
  @Remote('openActivationPage')
  async openActivationPage(): Promise<ActivationOpenState> {
    // The link is Host-owned state: the UI cannot pass a URL of its own to the launcher.
    const url = this._login.activationLink();
    if (url === undefined) return { code: 'no-link', opened: false };
    const result = await this._activation.open(url);
    return parseActivationOpenState({ code: result.code, opened: result.opened });
  }
  @Remote('saveApiKey')
  async saveApiKey(input: SaveApiKeyRequest): Promise<Status> {
    const request = parseSaveApiKey(input), state = await this._state();
    this._expect(request.expectedRevision);
    const expected = hash(state.apiRecord);
    await this._credentials().modifyRecord(API_KEY, async current => {
      if (hash(current) !== expected || hash(stableConfig(this._config())) !== hash(stableConfig(state.config))) throw this._conflict();
      return { kind: 'api-key', key: request.value };
    });
    return this.status();
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { openDesignCoRouter: OpenDesignCoRouterService }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'opendesign/credentials-unavailable': undefined;
    'opendesign/revision-conflict': undefined;
  }
}
export function apply(ctx: Context, config: LiveConfig): void {
  const current = () => readConfig(config);
  current();
  ctx.inject(['settings'], scope => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)));
  let modelsChanged = () => {};
  const service = new OpenDesignCoRouterService(ctx, current, { resolveSession, readQuota, readDesktopQuota, modelsChanged: () => modelsChanged() });
  const turnMonitor = installTurnMonitor(ctx, current);
  service.turnMonitorStatus = () => turnMonitor.status();
  installEotRecovery(ctx, () => current().emptyTurnGuard, () => turnMonitor.requestRetried());
  const replayKeys = new ReplayKeyStore(() => ctx.get('credentials'));
  const adapter = new CoRouterAdapter({
    config: current, models: () => service.modelCatalog(), readyModels: () => service.currentModelCatalog(), callIdentity: () => service.modelCallIdentity(), apiKey: (ref, baseURL) => service.resolveApiKey(ref, baseURL), onEmptyTurn: () => { service.guardedTurns++; },
    replayBindingSecret: signal => replayKeys.get(signal),
    imageDataUrl: async (ref, signal) => {
      const attachments = ctx.get('attachments');
      if (!attachments) return undefined;
      const image = await attachments.readImage(ref, signal);
      return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`;
    },
  });
  const registration = ctx.llm.registerAdapter([PLAN_PROVIDER, PAID_PROVIDER], adapter);
  // The selector bridge is the only path from plugin state to the Host model selector:
  // it diffs the advertised listModels projection, so a sampling/tier/protocol/quota write
  // or an identical directory refresh never rebuilds session directories (which used to
  // gray out and refresh the chat context control on every save).
  const bridge = new SelectorBridge({
    projection: () => {
      const config = current();
      return JSON.stringify(service.modelCatalog().map(row => {
        const effective = applyModelSettings(row, config.modelSettings?.[row.id]);
        return [row.id, row.group, row.name, isModelEnabled(row.id, config.modelSettings), effective.inputModalities ?? null];
      }));
    },
    replace: () => registration.replace([PLAN_PROVIDER, PAID_PROVIDER]),
  });
  modelsChanged = () => bridge.notify();
  ctx.on('loader/volatile-update', () => bridge.notify());
  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
    if (request.provider !== undefined && ![PLAN_PROVIDER, PAID_PROVIDER].includes(request.provider)) throw new LlmError('不是本插件的模型通道', 'INVALID_REQUEST');
    const config = current();
    const key = request.apiKey ?? await service.resolveApiKey(apiKeyRef(config), config.baseURL);
    if (!key) throw new LlmError('请先配置 CoRouter API Key', 'MISSING_CREDENTIAL');
    // Model discovery is always OpenAI-compatible, irrespective of request.api or inference protocol.
    const models = await fetchModelCatalog(config.baseURL, key, signal);
    return models.map(row => {
      const effective = applyModelSettings(row, config.modelSettings?.[row.id]);
      return { id: row.id, name: row.name, ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }), ...(row.maxOutputTokens === undefined ? {} : { maxTokens: row.maxOutputTokens }), ...(effective.inputModalities ? { inputModalities: effective.inputModalities } : {}) };
    });
  });
  ctx.llm.registerConfigurableProviders([
    { provider: PLAN_PROVIDER, displayName: 'OpenDesign CoRouter · 套餐赠送', settingsNs: SETTINGS_NS, settingsPath: [], defaultBaseURL: current().baseURL, nativeAuth: NATIVE_AUTH },
    { provider: PAID_PROVIDER, displayName: 'OpenDesign CoRouter · 付费模型', settingsNs: SETTINGS_NS, settingsPath: [], defaultBaseURL: current().baseURL, nativeAuth: NATIVE_AUTH },
  ]);
  ctx.effect(() => () => { adapter.dispose(); replayKeys.dispose(); bridge.dispose(); });
}
