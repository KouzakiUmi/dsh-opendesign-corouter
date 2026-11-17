/** One owner for account-scoped discovery, atomic selector publication and saved snapshots. */
import { createHmac } from 'node:crypto';
import { findModel, MODELS, type CatalogModel } from './catalog.js';
import { fetchModelCatalog, ModelDiscoveryError } from './model-discovery.js';
import { readModelScope, readModelEntitlements, unverifiedModels, type ModelAccount, type ModelScope, type ModelEntitlements } from './model-entitlements.js';
import type { RuntimeConfig } from './config.js';
import type { ModelCatalogSnapshot } from './model-catalog-snapshot.js';
import { combinedSignal } from './util.js';

export const MODEL_DIRECTORY_REFRESH_MS = 10 * 60_000;
interface DirectoryState { key?: string; account?: ModelAccount }
export interface DirectoryCallIdentity { key: string; workspace?: string }
export interface ModelDirectoryOptions {
  config(): RuntimeConfig;
  state(): Promise<DirectoryState>;
  changed(): void;
  persist(snapshot: ModelCatalogSnapshot): Promise<'saved' | 'unsupported' | 'unavailable' | 'failed'>;
  bindingSecret(signal: AbortSignal): Promise<Uint8Array>;
  fetchModels?: typeof fetchModelCatalog;
  readEntitlements?: typeof readModelEntitlements;
  readScope?: typeof readModelScope;
}
export class ModelDirectory {
  private readonly lifetime = new AbortController();
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private epoch = 0;
  private lastAttempt = 0;
  private write: Promise<void> = Promise.resolve();
  private writeSerial = 0;
  private _models: readonly CatalogModel[];
  private _updatedAt: string | undefined;
  private _error: string | undefined;
  private _entitlements: ModelEntitlements = { state: 'unavailable' };
  private _scope: ModelScope | undefined;
  private _runtimeKey: string | undefined;
  private _callBlocked = false;
  constructor(readonly options: ModelDirectoryOptions) {
    this._models = this.seed();
  }
  private seed(): readonly CatalogModel[] {
    const config = this.options.config();
    const rows = MODELS;
    // Persisted coverage is never authoritative before current identity + workspace validation.
    return unverifiedModels(rows.map(row => {
      const known = findModel(row.id);
      if (!known) return row;
      return { ...known, ...(row.contextWindow === undefined ? {} : { contextWindow: known.contextWindow === undefined ? row.contextWindow : Math.min(known.contextWindow, row.contextWindow) }) };
    }));
  }
  models(): readonly CatalogModel[] { return this._models; }
  updatedAt(): string | undefined { return this._updatedAt; }
  error(): string | undefined { return this._error; }
  entitlements(): ModelEntitlements { return this._entitlements; }
  workspace(): string | undefined { return this._scope?.workspaceId; }
  callIdentity(): DirectoryCallIdentity | undefined {
    if (this._callBlocked) throw new Error('当前工作区身份已变化或不可确认，请先刷新模型目录');
    return this._runtimeKey ? { key: this._runtimeKey, ...(this._scope ? { workspace: this._scope.workspaceId } : {}) } : undefined;
  }
  dispose(): void { this.lifetime.abort(); this.controller?.abort(); this._runtimeKey = undefined; }
  invalidate(): void {
    const changed = this._updatedAt !== undefined || this._scope !== undefined;
    this.epoch++;
    this.controller?.abort(); this.pending = undefined; this.lastAttempt = 0;
    this._models = this.seed(); this._updatedAt = undefined; this._error = undefined; this._entitlements = { state: 'unavailable' }; this._scope = undefined; this._runtimeKey = undefined;
    this._callBlocked = false;
    if (changed) try { this.options.changed(); } catch { /* Identity invalidation must not roll back an accepted credential change. */ }
  }
  /** Status/list reads start at most one background refresh per ten minutes. */
  warm(): void {
    if (this.pending || Date.now() - this.lastAttempt < MODEL_DIRECTORY_REFRESH_MS || this.lifetime.signal.aborted) return;
    void this.refresh().catch(() => undefined);
  }
  async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const controller = new AbortController(); this.controller = controller;
    const signal = combinedSignal(AbortSignal.any([controller.signal, this.lifetime.signal]), 90_000);
    this.lastAttempt = Date.now();
    const run = this.read(epoch, signal);
    this.pending = run;
    try { await run; } finally { if (this.pending === run) this.pending = undefined; }
  }
  private async binding(key: string, scope: ModelScope | undefined, signal: AbortSignal): Promise<string> {
    const secret = await this.options.bindingSecret(signal);
    try {
      return createHmac('sha256', secret).update(JSON.stringify(['opendesign-model-directory-v2', this.options.config().baseURL, key, scope?.workspaceId ?? '', scope?.memberId ?? ''])).digest('hex');
    } finally { secret.fill(0); }
  }
  private async read(epoch: number, signal: AbortSignal): Promise<void> {
    try {
      const state = await this.options.state();
      const key = state.key;
      if (!key?.trim()) { this._error = '请先登录或配置 API Key，再从当前网关读取模型目录。'; return; }
      const config = this.options.config();
      let scope: ModelScope | undefined;
      if (state.account) {
        try { scope = await (this.options.readScope ?? readModelScope)(state.account, signal); }
        catch { this.dropCoverage(true); signal.throwIfAborted(); }
      }
      if (this._scope && (!scope || scope.workspaceId !== this._scope.workspaceId || scope.memberId !== this._scope.memberId)) this.dropCoverage(true);
      const binding = await this.binding(key, scope, signal);
      const snapshot = config.modelCatalog;
      if (this._updatedAt === undefined && snapshot?.baseURL === config.baseURL && snapshot.binding === binding) {
        this._models = unverifiedModels(snapshot.models.map(row => {
          const known = findModel(row.id);
          return known ? { ...known, ...(row.contextWindow === undefined ? {} : { contextWindow: known.contextWindow === undefined ? row.contextWindow : Math.min(known.contextWindow, row.contextWindow) }) } : row;
        }));
        this._updatedAt = snapshot.updatedAt;
        this._runtimeKey = key;
        this._scope = scope;
        try { this.options.changed(); } catch { this._models = this.seed(); this._updatedAt = undefined; }
      }
      const models = await (this.options.fetchModels ?? fetchModelCatalog)(config.baseURL, key, signal, undefined, scope?.workspaceId);
      if (models.length === 0) throw new ModelDiscoveryError('response');
      const result = await (this.options.readEntitlements ?? readModelEntitlements)(models, { ...(state.account ? { account: state.account } : {}), ...(scope ? { scope } : {}), signal });
      if (scope && state.account) {
        // Reject a workspace/member switch during a batch instead of persisting mixed account evidence.
        let after: ModelScope;
        try { after = await (this.options.readScope ?? readModelScope)(state.account, signal); }
        catch { this.dropCoverage(true); throw new ModelDiscoveryError('response'); }
        if (after.workspaceId !== scope.workspaceId || after.memberId !== scope.memberId) { this.dropCoverage(true); throw new ModelDiscoveryError('response'); }
      }
      const latest = await this.options.state();
      if (signal.aborted || epoch !== this.epoch || latest.key !== key || this.options.config().baseURL !== config.baseURL) return;
      const previous = { models: this._models, updatedAt: this._updatedAt, entitlements: this._entitlements, scope: this._scope, key: this._runtimeKey, blocked: this._callBlocked };
      this._models = result.models; this._updatedAt = new Date().toISOString(); this._entitlements = result.summary; this._scope = scope; this._runtimeKey = key; this._error = undefined;
      this._callBlocked = state.account !== undefined && scope === undefined;
      try { this.options.changed(); }
      catch {
        this._models = previous.models; this._updatedAt = previous.updatedAt; this._entitlements = previous.entitlements; this._scope = previous.scope; this._runtimeKey = previous.key;
        this._callBlocked = previous.blocked;
        this._error = '模型目录已读取，但模型选择器更新失败，请重试。'; return;
      }
      // A settings write can rebuild the tree. Timestamp-only saves would create a reload loop.
      if (snapshot?.binding !== binding || JSON.stringify(snapshot.models) !== JSON.stringify(this._models)) {
        this.queueWrite({ baseURL: config.baseURL, updatedAt: this._updatedAt, models: this._models, binding }, epoch);
      }
    } catch (error) {
      if (!signal.aborted && epoch === this.epoch) this._error = error instanceof ModelDiscoveryError ? error.message : '模型目录或账号权益暂时无法读取，请稍后刷新。';
    }
  }
  private dropCoverage(blockCalls: boolean): void {
    this._models = unverifiedModels(this._models); this._entitlements = { state: 'unavailable' };
    this._scope = undefined; this._runtimeKey = undefined; this._callBlocked = blockCalls;
    try { this.options.changed(); } catch { /* Never restore stale authorization after a failed notification. */ }
  }
  private queueWrite(snapshot: ModelCatalogSnapshot, epoch: number): void {
    const serial = ++this.writeSerial;
    this.write = this.write.then(async () => {
      if (this.lifetime.signal.aborted || epoch !== this.epoch) return;
      const result = await this.options.persist(snapshot);
      if (serial !== this.writeSerial || epoch !== this.epoch) return;
      if (result === 'unavailable') this._error = '模型目录已更新，但当前配置服务不可写；重启后需要重新刷新。';
      else if (result === 'failed') this._error = '模型目录已更新，但保存失败；重启后需要重新刷新。';
    }).catch(() => { if (epoch === this.epoch) this._error = '模型目录已更新，但保存失败；重启后需要重新刷新。'; });
  }
}
