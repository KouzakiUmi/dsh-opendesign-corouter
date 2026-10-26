import { randomUUID, createHash } from 'node:crypto';
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
import { fetchModelCatalog, ModelDiscoveryError } from './model-discovery.js';
import { isModelEnabled } from './model-settings.js';
import type { CatalogModel } from './catalog.js';
import { Config, SETTINGS_NS, PLAN_PROVIDER, PAID_PROVIDER, readConfig, type LiveConfig } from './config.js';
import { MODELS } from './catalog.js';
import { resolveSession, deviceGrant, isOfficialRuntimeUrl, type LoginGrant } from './auth.js';
import { ConsoleLogin, type LoginOptions } from './login.js';
import { readQuota, ConsoleError, type QuotaSnapshot } from './quota.js';
import { readDesktopQuota } from './desktop-quota.js';
import { record } from './util.js';
import { parseStatus, parseLoginState, parseStartLoginRequest as parseStartLogin, parseCancelLoginRequest as parseCancelLogin, parseSaveApiKeyRequest as parseSaveApiKey,
  type Status, type LoginState, type StartLoginRequest, type CancelLoginRequest, type SaveApiKeyRequest } from './remote.js';

export { Config } from './config.js';
export { CoRouterAdapter } from './adapter.js';
export { MODELS } from './catalog.js';
export const name = 'llm-opendesign-corouter';
export const inject = ['llm'];
const API_KEY = credentialKey(name, 'api-key');
const SESSION = credentialKey(name, 'console');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
const needLogin = (): QuotaSnapshot => ({ state: 'need-login', updatedAt: new Date().toISOString(), windows: [], balances: {}, note: '尚未读取额度；可使用桌面登录态或在连接页登录' });
interface CapturedState {
  apiRecord: CredentialRecord | undefined; sessionRecord: CredentialRecord | undefined;
  key: string | undefined; config: ReturnType<typeof readConfig>;
}
interface LoginCapture { revision: string; sessionHash: string; configHash: string }
export interface HostDependencies {
  resolveSession: typeof resolveSession;
  readQuota: typeof readQuota;
  readDesktopQuota: typeof readDesktopQuota;
  fetchModels?: typeof fetchModelCatalog;
  modelsChanged?: () => void;
  loginOptions?: LoginOptions;
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
  private readonly _lifetime = new AbortController();
  private _revision = randomUUID();
  private _fingerprint = '';
  private _quota = needLogin();
  private _quotaAt = 0;
  private _quotaConfig = '';
  private _quotaIdentity: string | undefined;
  private _quotaEpoch = 0;
  private _quotaPending: Promise<QuotaSnapshot> | undefined;
  private _quotaController: AbortController | undefined;
  guardedTurns: number = 0;
  private _models: readonly CatalogModel[] = MODELS;
  private _modelsUpdatedAt: string | undefined;
  private _modelsError: string | undefined;
  private _modelsFingerprint = '';
  private _modelsEpoch = 0;
  private _modelsPending: Promise<Status> | undefined;
  private _modelsController: AbortController | undefined;
  modelCatalog(): readonly CatalogModel[] { return this._models; }
  constructor(ctx: Context, config: () => ReturnType<typeof readConfig>, readonly dependencies: HostDependencies = { resolveSession, readQuota, readDesktopQuota }) {
    super(ctx, 'openDesignCoRouter');
    this._config = config;
    this._login = new ConsoleLogin({
      capture: async expectedRevision => {
        const state = await this._state();
        this._expect(expectedRevision);
        this._credentials();
        return { revision: expectedRevision, sessionHash: hash(state.sessionRecord), configHash: hash(state.config) } satisfies LoginCapture;
      },
      commit: async (tokens, captured, signal) => {
        if (!record(captured) || typeof captured.revision !== 'string' || typeof captured.sessionHash !== 'string' || typeof captured.configHash !== 'string') throw this._conflict();
        await this._state();
        this._expect(captured.revision);
        signal.throwIfAborted();
        await this._credentials().modifyRecord(SESSION, async current => {
          signal.throwIfAborted();
          if (hash(current) !== captured.sessionHash || hash(this._config()) !== captured.configHash) throw this._conflict();
          const grant = deviceGrant({ kind: 'device', ...tokens });
          if (!grant) throw new ConsoleError('auth');
          return { kind: 'grant', payload: { ...grant, savedAt: new Date().toISOString() } };
        });
        this._invalidateQuota();
        this._modelsFingerprint = '';
        this._invalidateModels();
      },
    }, dependencies.loginOptions);
    ctx.effect(() => () => { this._lifetime.abort(); this._login.dispose(); });
  }
  private _credentials(): CredentialProvider {
    const service = this.ctx.get('credentials');
    if (!service) throw new RemoteError('opendesign/credentials-unavailable', 'DSH 凭据服务不可用；可先使用启动环境变量', undefined);
    return service;
  }
  private async _key(ref: string, baseURL: string, apiRecord: CredentialRecord | undefined, sessionRecord: CredentialRecord | undefined): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials');
    const ambient = credentials ? (await credentials.resolve(credentialRef(ref)))?.value : launchEnvironmentOf(this.ctx).get(ref)?.value;
    if (ambient?.trim()) return ambient;
    if (apiRecord?.kind === 'api-key' && apiRecord.key?.trim()) return apiRecord.key;
    const grant = grantOf(sessionRecord);
    return isOfficialRuntimeUrl(baseURL) && grant && 'kind' in grant && grant.kind === 'device' ? grant.runtimeKey : undefined;
  }
  async resolveApiKey(ref: string, baseURL = this._config().baseURL): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials');
    const [apiRecord, sessionRecord] = await Promise.all([credentials?.readRecord(API_KEY), credentials?.readRecord(SESSION)]);
    return this._key(ref, baseURL, apiRecord, sessionRecord);
  }
  private _invalidateModels(): void {
    const changed = this._modelsUpdatedAt !== undefined;
    this._modelsEpoch++;
    this._modelsController?.abort();
    this._modelsPending = undefined;
    this._models = MODELS;
    this._modelsUpdatedAt = undefined;
    this._modelsError = undefined;
    if (changed) {
      try { this.dependencies.modelsChanged?.(); }
      catch { /* A notification failure cannot undo an accepted credential write or cache invalidation. */ }
    }
  }
  private async _state(): Promise<CapturedState> {
    const credentials = this.ctx.get('credentials'), config = this._config();
    const [apiRecord, sessionRecord] = await Promise.all([credentials?.readRecord(API_KEY), credentials?.readRecord(SESSION)]);
    const key = await this._key(config.apiKeyEnv, config.baseURL, apiRecord, sessionRecord);
    const state = { apiRecord, sessionRecord, key, config };
    const modelsFingerprint = hash({ key, baseURL: config.baseURL });
    if (modelsFingerprint !== this._modelsFingerprint) {
      this._modelsFingerprint = modelsFingerprint;
      this._invalidateModels();
    }
    const fingerprint = hash(state);
    if (fingerprint !== this._fingerprint) { this._fingerprint = fingerprint; this._revision = randomUUID(); }
    return state;
  }
  private _conflict() { return new RemoteError('opendesign/revision-conflict', '连接或凭据已改变，请刷新页面后重试', undefined); }
  private _expect(revision: string) { if (revision !== this._revision) throw this._conflict(); }
  private _invalidateQuota(): void { this._quotaAt = 0; this._quotaEpoch++; this._quota = needLogin(); this._quotaIdentity = undefined; this._quotaController?.abort(); this._quotaPending = undefined; }
  @Remote('status')
  async status(): Promise<Status> {
    const state = await this._state();
    const quotaConfig = hash({ desktop: state.config.useDesktopCredential, session: state.sessionRecord, refreshSeconds: state.config.quotaRefreshSeconds });
    if (this._quotaConfig !== quotaConfig) { this._quotaConfig = quotaConfig; this._invalidateQuota(); }
    return parseStatus({
      revision: this._revision, apiKeyConfigured: Boolean(state.key?.trim()), ...(this._quota.source ? { sessionSource: this._quota.source } : {}),
      quota: this._quota, login: this._login.status(), config: state.config, guardedTurns: this.guardedTurns,
      models: this._models.map(({ id, name, group, contextWindow, maxOutputTokens, reasoningEfforts }) => ({
        id, name, group, enabled: isModelEnabled(id, state.config.modelSettings),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      })),
      modelsSource: this._modelsUpdatedAt ? 'openai' : 'builtin',
      ...(this._modelsUpdatedAt ? { modelsUpdatedAt: this._modelsUpdatedAt } : {}),
      ...(this._modelsError ? { modelsError: this._modelsError } : {}),
    });
  }
  @Remote('refreshModels')
  async refreshModels(): Promise<Status> {
    const state = await this._state();
    if (this._modelsPending) return this._modelsPending;
    const key = state.key;
    if (!key?.trim()) {
      this._modelsError = '请先配置 API Key，再从 OpenAI 端口拉取模型。';
      return this.status();
    }
    const epoch = this._modelsEpoch;
    const controller = new AbortController();
    this._modelsController = controller;
    const signal = AbortSignal.any([controller.signal, this._lifetime.signal]);
    const run = (async () => {
      try {
        const models = await (this.dependencies.fetchModels ?? fetchModelCatalog)(state.config.baseURL, key, signal);
        await this._state();
        if (signal.aborted || epoch !== this._modelsEpoch) return this.status();
        this._models = models;
        this._modelsUpdatedAt = new Date().toISOString();
        this._modelsError = undefined;
        this.dependencies.modelsChanged?.();
      } catch (error) {
        if (!signal.aborted && epoch === this._modelsEpoch) this._modelsError = error instanceof ModelDiscoveryError ? error.message : '模型列表更新失败，请稍后重试。';
      }
      return this.status();
    })();
    this._modelsPending = run;
    try { return await run; }
    finally { if (this._modelsPending === run) this._modelsPending = undefined; }
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
      if (!authFailure && identity !== undefined && identity === this._quotaIdentity && hasReadings) {
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
  @Remote('saveApiKey')
  async saveApiKey(input: SaveApiKeyRequest): Promise<Status> {
    const request = parseSaveApiKey(input), state = await this._state();
    this._expect(request.expectedRevision);
    const expected = hash(state.apiRecord);
    await this._credentials().modifyRecord(API_KEY, async current => {
      if (hash(current) !== expected || hash(this._config()) !== hash(state.config)) throw this._conflict();
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
  const adapter = new CoRouterAdapter({
    config: current, models: () => service.modelCatalog(), apiKey: (ref, baseURL) => service.resolveApiKey(ref, baseURL), onEmptyTurn: () => { service.guardedTurns++; },
    imageDataUrl: async (ref, signal) => {
      const attachments = ctx.get('attachments');
      if (!attachments) return undefined;
      const image = await attachments.readImage(ref, signal);
      return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`;
    },
  });
  const registration = ctx.llm.registerAdapter([PLAN_PROVIDER, PAID_PROVIDER], adapter);
  modelsChanged = () => registration.replace([PLAN_PROVIDER, PAID_PROVIDER]);
  let configFingerprint = hash(current());
  ctx.on('loader/volatile-update', () => {
    const next = hash(current());
    if (next === configFingerprint) return;
    configFingerprint = next;
    modelsChanged();
  });
  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
    if (request.provider !== undefined && ![PLAN_PROVIDER, PAID_PROVIDER].includes(request.provider)) throw new LlmError('不是本插件的模型通道', 'INVALID_REQUEST');
    const config = current();
    const key = request.apiKey ?? await service.resolveApiKey(config.apiKeyEnv, config.baseURL);
    if (!key) throw new LlmError('请先配置 CoRouter API Key', 'MISSING_CREDENTIAL');
    // Model discovery is always OpenAI-compatible, irrespective of request.api or inference protocol.
    const models = await fetchModelCatalog(config.baseURL, key, signal);
    return models.map(row => ({ id: row.id, name: row.name, ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }), ...(row.maxOutputTokens === undefined ? {} : { maxTokens: row.maxOutputTokens }), ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}) }));
  });
  ctx.llm.registerConfigurableProviders([
    { provider: PLAN_PROVIDER, displayName: 'OpenDesign CoRouter · 套餐赠送', settingsNs: SETTINGS_NS, settingsPath: [], defaultBaseURL: current().baseURL },
    { provider: PAID_PROVIDER, displayName: 'OpenDesign CoRouter · 付费模型', settingsNs: SETTINGS_NS, settingsPath: [], defaultBaseURL: current().baseURL },
  ]);
  ctx.effect(() => () => adapter.dispose());
}
