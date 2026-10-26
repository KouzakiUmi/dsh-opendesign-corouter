import { randomUUID, createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { credentialKey, credentialRef, type CredentialRecord, type CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-settings';
import { CoRouterAdapter } from './adapter.js';
import { Config, SETTINGS_NS, PLAN_PROVIDER, PAID_PROVIDER, readConfig, type LiveConfig } from './config.js';
import { MODELS } from './catalog.js';
import { resolveSession, cookieSession, type LoginGrant } from './auth.js';
import { ConsoleLogin } from './login.js';
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
}
function grantOf(value: CredentialRecord | undefined): LoginGrant | undefined {
  if (value?.kind !== 'grant' || !record(value.payload) || typeof value.payload.cookie !== 'string') return;
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
  private _quotaEpoch = 0;
  private _quotaPending: Promise<QuotaSnapshot> | undefined;
  private _quotaController: AbortController | undefined;
  guardedTurns: number = 0;
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
      verify: async (cookie, signal) => {
        const session = cookieSession(cookie, 'login');
        if (!session) throw new ConsoleError('auth');
        const quota = await this.dependencies.readQuota(session, signal);
        return { balanceOk: true, coverage: quota.state === 'ok' ? 'complete' : 'partial', windows: quota.windows };
      },
      commit: async (cookie, captured, signal, expiresAt) => {
        if (!record(captured) || typeof captured.revision !== 'string' || typeof captured.sessionHash !== 'string' || typeof captured.configHash !== 'string') throw this._conflict();
        await this._state();
        this._expect(captured.revision);
        signal.throwIfAborted();
        await this._credentials().modifyRecord(SESSION, async current => {
          signal.throwIfAborted();
          if (hash(current) !== captured.sessionHash || hash(this._config()) !== captured.configHash) throw this._conflict();
          return { kind: 'grant', payload: { cookie, expiresAt, savedAt: new Date().toISOString() } };
        });
        this._invalidateQuota();
      },
    });
    ctx.effect(() => () => { this._lifetime.abort(); this._login.dispose(); });
  }
  private _credentials(): CredentialProvider {
    const service = this.ctx.get('credentials');
    if (!service) throw new RemoteError('opendesign/credentials-unavailable', 'DSH 凭据服务不可用；可先使用启动环境变量', undefined);
    return service;
  }
  async resolveApiKey(ref: string): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials');
    const ambient = credentials ? (await credentials.resolve(credentialRef(ref)))?.value : launchEnvironmentOf(this.ctx).get(ref)?.value;
    if (ambient?.trim()) return ambient;
    const saved = await credentials?.readRecord(API_KEY);
    return saved?.kind === 'api-key' ? saved.key : undefined;
  }
  private async _state(): Promise<CapturedState> {
    const credentials = this.ctx.get('credentials'), config = this._config();
    const [apiRecord, sessionRecord, key] = await Promise.all([credentials?.readRecord(API_KEY), credentials?.readRecord(SESSION), this.resolveApiKey(config.apiKeyEnv)]);
    const state = { apiRecord, sessionRecord, key, config };
    const fingerprint = hash(state);
    if (fingerprint !== this._fingerprint) { this._fingerprint = fingerprint; this._revision = randomUUID(); }
    return state;
  }
  private _conflict() { return new RemoteError('opendesign/revision-conflict', '连接或凭据已改变，请刷新页面后重试', undefined); }
  private _expect(revision: string) { if (revision !== this._revision) throw this._conflict(); }
  private _invalidateQuota(): void { this._quotaAt = 0; this._quotaEpoch++; this._quota = needLogin(); this._quotaController?.abort(); this._quotaPending = undefined; }
  @Remote('status')
  async status(): Promise<Status> {
    const state = await this._state();
    const quotaConfig = hash({ desktop: state.config.useDesktopCredential, session: state.sessionRecord });
    if (this._quotaConfig !== quotaConfig) { this._quotaConfig = quotaConfig; this._invalidateQuota(); }
    return parseStatus({
      revision: this._revision, apiKeyConfigured: Boolean(state.key?.trim()), ...(this._quota.source ? { sessionSource: this._quota.source } : {}),
      quota: this._quota, login: this._login.status(), config: state.config, guardedTurns: this.guardedTurns,
      models: MODELS.map(({ id, name, group }) => ({ id, name, group })),
    });
  }
  @Remote('refreshQuota')
  async refreshQuota(): Promise<QuotaSnapshot> {
    const state = await this._state();
    const fingerprint = hash({ desktop: state.config.useDesktopCredential, session: state.sessionRecord });
    if (fingerprint !== this._quotaConfig) { this._quotaConfig = fingerprint; this._invalidateQuota(); }
    if (this._quotaPending) return this._quotaPending;
    const cacheMs = this._quota.state === 'error' || this._quota.state === 'need-login' ? 5000 : 30000;
    if (Date.now() - this._quotaAt < cacheMs) return this._quota;
    const epoch = this._quotaEpoch;
    const controller = new AbortController(); this._quotaController = controller;
    const signal = AbortSignal.any([controller.signal, this._lifetime.signal]);
    const run = this._readQuota(epoch, signal);
    this._quotaPending = run;
    void run.finally(() => { if (this._quotaPending === run) this._quotaPending = undefined; }).catch(() => {});
    return run;
  }
  private async _readQuota(epoch: number, signal: AbortSignal): Promise<QuotaSnapshot> {
    const config = this._config();
    let result: QuotaSnapshot;
    try {
      const authDeps = {
        useDesktop: config.useDesktopCredential,
        readGrant: async () => grantOf(await this.ctx.get('credentials')?.readRecord(SESSION)),
        resolveRef: async (ref: string) => {
          const credentials = this.ctx.get('credentials');
          return credentials ? (await credentials.resolve(credentialRef(ref)))?.value : launchEnvironmentOf(this.ctx).get(ref)?.value;
        },
      };
      const auth = await this.dependencies.resolveSession(authDeps);
      if (auth.state === 'need-login') result = needLogin();
      else if (auth.session.source !== 'desktop') result = await this.dependencies.readQuota(auth.session, signal);
      else {
        try { result = await this.dependencies.readDesktopQuota(auth.session, signal); }
        catch (error) {
          // An expired desktop credential must not permanently shadow a valid console login.
          if (!(error instanceof ConsoleError) || !['auth', 'permission'].includes(error.kind)) throw error;
          const fallback = await this.dependencies.resolveSession({ ...authDeps, useDesktop: false });
          if (fallback.state !== 'ready') throw new ConsoleError('auth');
          result = await this.dependencies.readQuota(fallback.session, signal);
        }
      }
    } catch (error) {
      result = { ...needLogin(), state: error instanceof ConsoleError && error.kind === 'auth' ? 'need-login' : 'error', note: error instanceof ConsoleError ? error.message : '额度读取暂时失败；请检查连接或重新登录' };
    }
    if (!signal.aborted && epoch === this._quotaEpoch) { this._quota = result; this._quotaAt = Date.now(); }
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
  const service = new OpenDesignCoRouterService(ctx, current);
  const adapter = new CoRouterAdapter({
    config: current, apiKey: ref => service.resolveApiKey(ref), onEmptyTurn: () => { service.guardedTurns++; },
    imageDataUrl: async (ref, signal) => {
      const attachments = ctx.get('attachments');
      if (!attachments) return undefined;
      const image = await attachments.readImage(ref, signal);
      return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`;
    },
  });
  ctx.llm.registerAdapter([PLAN_PROVIDER, PAID_PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([
    { provider: PLAN_PROVIDER, displayName: 'OpenDesign CoRouter · 套餐赠送', settingsNs: SETTINGS_NS, settingsPath: [], defaultBaseURL: current().baseURL },
    { provider: PAID_PROVIDER, displayName: 'OpenDesign CoRouter · 付费模型', settingsNs: SETTINGS_NS, settingsPath: [], defaultBaseURL: current().baseURL },
  ]);
  ctx.effect(() => () => adapter.dispose());
}
