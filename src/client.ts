import * as React from 'react';
import openDesignCoRouterRemote, { type CoRouterRemote } from './generated/typert.remote-client.js';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import {
  type LoginState,
  type Status,
  type StatusModel,
} from './remote.js';
import type { QuotaSnapshot } from './quota.js';

const h = React.createElement;
const SETTINGS_NS = 'llm-opendesign-corouter';
const OFFICIAL_SITE = 'https://corouter.open-design.ai/zh/';
const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'models', label: '模型' },
  { id: 'connection', label: '连接与登录' },
  { id: 'advanced', label: '高级' },
] as const;
type TabId = typeof TABS[number]['id'];

export type RpcCaller = <T>(method: keyof CoRouterRemote, request?: unknown) => Promise<T>;

interface FormValues {
  emptyTurnGuard?: boolean;
  useDesktopCredential?: boolean;
  baseURL?: string;
  apiKeyEnv?: string;
}
interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: FormValues | undefined;
  writable: boolean;
}
interface ConfigForm {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
}
interface ConfigForms {
  get(namespace: string): ConfigForm;
}
interface SlotDescriptor<P> {
  name: 'settings.section';
  id: string;
  order: number;
  label: () => string;
  inject: () => P;
}
interface Slots {
  inject(name: 'settings.section', register: () => void | (() => void)): void | (() => void);
  register<P>(descriptor: SlotDescriptor<P>, component: React.ComponentType<P>): void | (() => void);
}
interface ClientContext {
  remote: TypertClientRemote & { $mount(contribution: typeof openDesignCoRouterRemote): Promise<() => void> };
  effect(effect: () => void | (() => void) | Promise<void | (() => void)>, label?: string): void;
  inject(services: ['configForms'], apply: (ctx: ConfigScope) => void): void;
  inject(services: ['remote.openDesignCoRouter'], apply: (ctx: RemoteScope) => void): void;
}
interface RemoteScope {
  remote: TypertClientRemote;
  effect(effect: () => void | (() => void), label?: string): void;
}
interface ConfigScope {
  configForms: ConfigForms;
  slots: Slots;
  effect(effect: () => void | (() => void), label?: string): void;
}
export interface SettingsProps {
  caller: RpcCaller;
  form: ConfigForm;
}
interface Notice {
  kind: 'status' | 'error';
  text: string;
}

const GENERIC_ERROR = '操作未完成，请稍后重试。';
const LOGIN_LABELS: Record<LoginState['state'], string> = {
  idle: '尚未开始独立登录',
  launching: '正在打开官方登录页面…',
  waiting: '等待你在官方页面完成登录…',
  verifying: '正在验证并保存会话…',
  success: '登录成功，会话已保存。',
  cancelled: '已取消本次登录。',
  error: '登录未完成，请重试。',
};
const QUOTA_LABELS: Record<QuotaSnapshot['state'], string> = {
  ok: '额度信息已更新',
  partial: '部分额度暂不可用，其余数据仍可参考',
  'need-login': '需要登录后读取额度',
  error: '暂时无法读取额度',
};

function installStyles(): () => void {
  const style = document.createElement('style');
  style.dataset.opendesignCorouter = '';
  style.textContent = `
.odc-settings{color:var(--dsw-alias-label-primary,inherit);max-width:860px;padding:6px 2px 24px;font-size:13px;line-height:1.5}
.odc-settings *{box-sizing:border-box}.odc-settings h2{margin:0;font-size:21px;line-height:1.35;font-weight:650;letter-spacing:-.02em}.odc-settings h3{margin:0;font-size:14px;font-weight:650}.odc-settings p{margin:0}
.odc-intro{margin:6px 0 18px!important;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}.odc-tabs{display:flex;gap:4px;overflow-x:auto;margin:0 0 16px;padding:0 0 8px;border-bottom:1px solid var(--dsw-alias-border-l4,transparent)}
.odc-tab{flex:none;border:1px solid transparent;border-radius:8px;padding:7px 13px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;cursor:pointer}.odc-tab:hover{background:var(--dsw-alias-bg-layer-1,transparent)}.odc-tab[aria-selected=true]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-border-l3,transparent);background:var(--dsw-alias-bg-layer-1,transparent)}
.odc-panel{display:grid;gap:14px}.odc-card{min-width:0;padding:15px;border:1px solid var(--dsw-alias-border-l4,transparent);border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}.odc-card>p{margin-top:6px}.odc-card-head,.odc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.odc-card-head{margin-bottom:12px}
.odc-quota-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.odc-metric{display:grid;align-content:start;gap:5px;min-height:96px}.odc-metric-value{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.odc-label,.odc-hint,.odc-meta{color:var(--dsw-alias-label-secondary,inherit);font-size:11px;line-height:1.6}.odc-meta{margin-top:10px!important}.odc-window{display:grid;gap:7px;margin-top:10px}.odc-window progress{width:100%;height:7px;accent-color:var(--dsw-alias-brand-primary,Highlight)}
.odc-button{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l3,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;cursor:pointer}.odc-button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,Highlight)}.odc-button-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,Highlight));color:var(--dsw-alias-label-primary-foreground,HighlightText);border-color:transparent}.odc-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,Highlight))}.odc-button:disabled{opacity:.55;cursor:not-allowed}.odc-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.odc-notice{padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);font-size:12px;line-height:1.6}.odc-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary,inherit);color:color-mix(in srgb,var(--dsw-alias-state-error-primary,CanvasText) 85%,var(--dsw-alias-label-primary,CanvasText))}
.odc-model-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.odc-model-list{display:grid;gap:6px;margin:10px 0 0;padding:0;list-style:none}.odc-model-item{padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);min-width:0}.odc-model-item strong,.odc-model-item code{display:block;overflow-wrap:anywhere}.odc-model-item code{margin-top:2px;color:var(--dsw-alias-label-secondary,inherit);font-size:11px}.odc-model-count{color:var(--dsw-alias-label-secondary,inherit);font-size:11px;font-weight:400}
.odc-field{display:grid;gap:6px;margin-top:14px}.odc-field label,.odc-switch-text{font-size:12px;font-weight:550}.odc-input{width:100%;min-width:0;min-height:34px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l3,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px}.odc-input::placeholder{color:var(--dsw-alias-label-secondary,inherit);opacity:1}.odc-input:disabled{opacity:.55}
.odc-switch{display:flex;align-items:flex-start;gap:10px;cursor:pointer}.odc-switch input{width:16px;height:16px;flex:none;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,Highlight)}.odc-switch>span{display:grid;gap:4px}.odc-switch:has(input:disabled){cursor:not-allowed;opacity:.6}.odc-divider{height:1px;border:0;background:var(--dsw-alias-border-l4,transparent);margin:2px 0}.odc-link{color:var(--dsw-alias-brand-primary,inherit);text-underline-offset:3px}
.odc-settings :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:3px}@media(max-width:680px){.odc-quota-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.odc-model-groups{grid-template-columns:1fr}}@media(max-width:380px){.odc-quota-grid{grid-template-columns:1fr}.odc-card{padding:12px}}
`;
  document.head.append(style);
  return () => style.remove();
}

async function withTimeout<T>(operation: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation = () => {};
  const cancelled = () => rejectCancellation();
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectCancellation = () => reject(new Error('RPC cancelled'));
    if (signal.aborted) {
      rejectCancellation();
      return;
    }
    timer = setTimeout(() => reject(new Error('RPC timeout')), ms);
    signal.addEventListener('abort', cancelled, { once: true });
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', cancelled);
  }
}

function createCaller(ctx: ClientContext): RpcCaller {
  const controller = new AbortController();
  let service: TypertClientRemote | undefined;
  let available: Promise<void> | undefined;
  let markAvailable: (() => void) | undefined;
  ctx.effect(() => () => controller.abort(), 'opendesign-corouter: cancel RPC waits');
  ctx.inject(['remote.openDesignCoRouter'], scope => {
    const current = scope.remote;
    service = current;
    markAvailable?.();
    scope.effect(() => () => {
      if (service === current) service = undefined;
      available = undefined;
      markAvailable = undefined;
    }, 'opendesign-corouter: remote availability');
  });
  const waitForService = async (): Promise<TypertClientRemote> => {
    if (service !== undefined) return service;
    if (available === undefined) {
      available = new Promise(resolve => { markAvailable = resolve; });
    }
    await withTimeout(available, 4_000, controller.signal);
    if (service === undefined) throw new Error('RPC unavailable');
    return service;
  };
  return async <T>(method: keyof CoRouterRemote, request?: unknown): Promise<T> => {
    const remote = await waitForService();
    const operation = openDesignCoRouterRemote.methods[`openDesignCoRouter/${method}`];
    if (!operation) throw new Error('Unknown generated Remote method');
    const parameter = operation.parameters[0];
    const input = operation.input({ strict: true }).create().parse(parameter ? { [parameter.wire]: request } : {});
    const response = await withTimeout(Promise.resolve(operation.invoke(remote, input)), 25_000, controller.signal);
    if (!('ok' in response) || !response.ok) throw new Error('RPC failed');
    return response.value as T;
  };
}

function useMounted(): React.MutableRefObject<boolean> {
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

function useFormSnapshot(form: ConfigForm): FormSnapshot {
  return React.useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
    () => form.getSnapshot(),
  );
}

function NoticeView({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return h('p', {
    className: 'odc-notice',
    'data-kind': notice.kind,
    role: notice.kind === 'error' ? 'alert' : 'status',
  }, notice.text);
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value);
}

function formatTime(value: string | undefined): string {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
}

function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天赠送窗口`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时赠送窗口`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟赠送窗口`;
  return `${seconds} 秒赠送窗口`;
}

export function QuotaView({ quota }: { quota: QuotaSnapshot | undefined }) {
  if (quota === undefined) return h('p', { className: 'odc-hint', role: 'status' }, '正在读取额度…');
  const metrics = [
    { label: '套餐余额', value: formatUsd(quota.balances.subscriptionUsd), hint: '订阅剩余可用金额' },
    { label: '充值 / 赠送金额', value: formatUsd(quota.balances.rechargeUsd), hint: '充值与赠送的可用金额' },
    { label: '总额度', value: formatUsd(quota.balances.totalUsd), hint: '钱包当前可用总额' },
  ];
  return h(React.Fragment, null,
    h('div', { className: 'odc-card' },
      h('div', { className: 'odc-card-head' },
        h('div', null, h('h3', null, '套餐赠送窗口'), quota.tier !== undefined ? h('p', { className: 'odc-hint' }, `当前套餐：${quota.tier}`) : null),
        h('span', { className: 'odc-label' }, QUOTA_LABELS[quota.state])),
      quota.windows.length === 0 ? h('p', { className: 'odc-metric-value' }, '—') : quota.windows.map((window, index) =>
        h('div', { className: 'odc-window', key: `${window.durationSeconds}-${index}` },
          h('div', { className: 'odc-row' },
            h('span', null, windowLabel(window.durationSeconds)),
            h('span', { className: 'odc-label' }, `已用 ${window.percent.toFixed(1)}% · 剩余 ${window.remaining ?? '—'}`)),
          h('progress', { max: 100, value: window.percent, 'aria-label': `${windowLabel(window.durationSeconds)}已用额度` }),
          h('span', { className: 'odc-meta' }, `已用 ${window.used} / 上限 ${window.limit} · 重置 ${formatTime(window.resetsAt)}`)))),
    h('div', { className: 'odc-quota-grid' }, metrics.map(metric =>
      h('div', { className: 'odc-card odc-metric', key: metric.label },
        h('span', { className: 'odc-label' }, metric.label),
        h('strong', { className: 'odc-metric-value' }, metric.value),
        h('span', { className: 'odc-hint' }, metric.hint)))),
    h('p', { className: 'odc-meta' }, `更新于 ${formatTime(quota.updatedAt)}${quota.source !== undefined ? ` · 来源：${{ desktop: '桌面登录态', login: '独立登录', environment: '环境凭据' }[quota.source]}` : ''}`),
    quota.note !== undefined ? h('p', { className: 'odc-notice', 'data-kind': quota.state === 'error' ? 'error' : 'status', role: quota.state === 'error' ? 'alert' : 'status' }, quota.note) : null);
}

function Overview({ status, busy, onRefresh }: { status: Status | undefined; busy: boolean; onRefresh: () => void }) {
  return h(React.Fragment, null,
    h('div', { className: 'odc-card-head' },
      h('div', null, h('h3', null, '额度概览'), h('p', { className: 'odc-hint' }, '套餐窗口与钱包余额分开计量；未知数据不做推算。')),
      h('button', { className: 'odc-button', type: 'button', disabled: busy, onClick: onRefresh }, busy ? '刷新中…' : '刷新额度')),
    h(QuotaView, { quota: status?.quota }));
}

function ModelGroup({ title, group, models }: { title: string; group: StatusModel['group']; models: readonly StatusModel[] }) {
  const [query, setQuery] = React.useState('');
  const id = React.useId();
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = models.filter(model => model.group === group
    && (normalized === '' || `${model.name} ${model.id}`.toLocaleLowerCase().includes(normalized)));
  return h('section', { className: 'odc-card', 'aria-labelledby': `${id}-title` },
    h('div', { className: 'odc-card-head' },
      h('h3', { id: `${id}-title` }, title),
      h('span', { className: 'odc-model-count' }, `${filtered.length} / ${models.filter(model => model.group === group).length}`)),
    h('label', { className: 'odc-label', htmlFor: `${id}-search` }, `搜索${title}`),
    h('input', {
      id: `${id}-search`, className: 'odc-input', type: 'search', value: query,
      placeholder: '输入模型名称或 ID', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
    }),
    filtered.length === 0 ? h('p', { className: 'odc-hint', role: 'status' }, '没有匹配的模型。') :
      h('ul', { className: 'odc-model-list' }, filtered.map(model =>
        h('li', { className: 'odc-model-item', key: model.id },
          h('strong', null, model.name),
          h('code', null, model.id),
          h('span', { className: 'odc-label' }, `归属：${title}`)))));
}

function Models({ models }: { models: readonly StatusModel[] | undefined }) {
  return h(React.Fragment, null,
    h('div', null, h('h3', null, '可用模型'), h('p', { className: 'odc-hint' }, '两个 Provider 独立筛选。这里仅展示目录，不修改 API 或当前会话模型。')),
    h('div', { className: 'odc-model-groups' },
      h(ModelGroup, { title: '套餐赠送 Provider', group: 'plan', models: models ?? [] }),
      h(ModelGroup, { title: '付费 Provider', group: 'paid', models: models ?? [] })));
}

function Switch({ checked, disabled, label, hint, onChange }: {
  checked: boolean; disabled: boolean; label: string; hint: string; onChange: (checked: boolean) => void;
}) {
  return h('label', { className: 'odc-switch' },
    h('input', { type: 'checkbox', checked, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked) }),
    h('span', null, h('span', { className: 'odc-switch-text' }, label), h('small', { className: 'odc-hint' }, hint)));
}

function loginInFlight(state: LoginState['state']): boolean {
  return state === 'launching' || state === 'waiting' || state === 'verifying';
}

function Connection({ status, formSnapshot, setFormField, pendingField, caller, loadStatus, refreshAfterLogin }: {
  status: Status | undefined;
  formSnapshot: FormSnapshot;
  setFormField: (field: string, value: unknown) => Promise<boolean>;
  pendingField: string | null;
  caller: RpcCaller;
  loadStatus: () => Promise<void>;
  refreshAfterLogin: () => Promise<void>;
}) {
  const mounted = useMounted();
  const actionVersion = React.useRef(0);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [apiKey, setApiKey] = React.useState('');
  const [keyBusy, setKeyBusy] = React.useState(false);
  React.useEffect(() => () => { actionVersion.current += 1; }, []);
  const login = status?.login;
  const state = login?.state ?? 'idle';
  const inFlight = loginInFlight(state);

  const startLogin = async () => {
    if (status === undefined || busy) return;
    const version = ++actionVersion.current;
    setBusy(true);
    setNotice({ kind: 'status', text: '正在启动官方登录…' });
    try {
      const next = await caller<LoginState>('startLogin', { expectedRevision: status.revision });
      if (!mounted.current || version !== actionVersion.current) return;
      setNotice({ kind: 'status', text: '请在打开的官方页面中亲自完成登录。' });
      await (next.state === 'success' ? refreshAfterLogin() : loadStatus());
    } catch {
      if (mounted.current && version === actionVersion.current) setNotice({ kind: 'error', text: '无法启动登录，请稍后重试。' });
    } finally {
      if (mounted.current && version === actionVersion.current) setBusy(false);
    }
  };
  const cancelLogin = async () => {
    if (login?.jobId == null || busy) return;
    const version = ++actionVersion.current;
    setBusy(true);
    try {
      await caller<LoginState>('cancelLogin', { jobId: login.jobId });
      if (!mounted.current || version !== actionVersion.current) return;
      await loadStatus();
      if (mounted.current) setNotice({ kind: 'status', text: '已请求取消登录。' });
    } catch {
      if (mounted.current && version === actionVersion.current) setNotice({ kind: 'error', text: '取消未完成，请稍后重试。' });
    } finally {
      if (mounted.current && version === actionVersion.current) setBusy(false);
    }
  };
  const saveKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (status === undefined || keyBusy || apiKey.trim() === '') {
      if (apiKey.trim() === '') setNotice({ kind: 'error', text: '请输入 API Key 后再保存。' });
      return;
    }
    const version = ++actionVersion.current;
    setKeyBusy(true);
    setNotice(null);
    try {
      await caller<Status>('saveApiKey', { value: apiKey, expectedRevision: status.revision });
      if (!mounted.current || version !== actionVersion.current) return;
      setApiKey('');
      await loadStatus();
      if (mounted.current) setNotice({ kind: 'status', text: 'API Key 已安全保存。' });
    } catch {
      if (!mounted.current || version !== actionVersion.current) return;
      setApiKey('');
      setNotice({ kind: 'error', text: 'API Key 未保存，请检查后重试。' });
    } finally {
      if (mounted.current && version === actionVersion.current) setKeyBusy(false);
    }
  };

  const desktopChecked = formSnapshot.value?.useDesktopCredential ?? status?.config.useDesktopCredential ?? true;
  return h(React.Fragment, null,
    h('section', { className: 'odc-card' },
      h('h3', null, '连接方式'),
      h('p', { className: 'odc-hint' }, '优先复用 OpenDesign 桌面端已有登录态，无需复制桌面凭据。关闭后使用独立登录或环境凭据。'),
      h('div', { style: { marginTop: 14 } },
        h(Switch, {
          checked: desktopChecked,
          disabled: !formSnapshot.writable || pendingField === 'useDesktopCredential',
          label: '优先使用桌面登录态',
          hint: '仅控制读取优先级，不会修改或写回桌面端登录文件。',
          onChange: checked => { void setFormField('useDesktopCredential', checked); },
        })),
      h('p', { className: 'odc-meta' }, `当前会话来源：${status?.sessionSource === undefined ? '—' : { desktop: '桌面登录态', login: '独立登录', environment: '环境凭据' }[status.sessionSource]}`)),
    h('section', { className: 'odc-card' },
      h('h3', null, '独立登录'),
      h('p', { className: 'odc-hint' }, '登录需由你在官方页面亲自完成；插件不会代填账号或密码。验证通过后才保存会话。'),
      h('div', { className: 'odc-actions', style: { marginTop: 14 } },
        h('button', { className: 'odc-button odc-button-primary', type: 'button', disabled: status === undefined || busy || inFlight, onClick: () => { void startLogin(); } }, '登录并保存会话'),
        inFlight ? h('button', { className: 'odc-button', type: 'button', disabled: busy || login?.jobId == null, onClick: () => { void cancelLogin(); } }, '取消登录') : null,
        h('a', { className: 'odc-link', href: OFFICIAL_SITE, target: '_blank', rel: 'noreferrer noopener' }, '打开 CoRouter 官网')),
      h('p', { className: 'odc-meta', role: state === 'error' ? 'alert' : 'status' }, LOGIN_LABELS[state]),
      h(NoticeView, { notice })),
    h('section', { className: 'odc-card' },
      h('h3', null, 'API Key'),
      h('p', { className: 'odc-hint' }, status?.apiKeyConfigured === true ? '已配置 API Key。保存仅替换本插件保存的 Key；环境变量或已有凭据引用仍优先。' : '尚未配置 API Key；推理需要 CoRouter Key，额度登录不能代替。'),
      h('form', { onSubmit: (event: React.FormEvent) => { void saveKey(event); } },
        h('div', { className: 'odc-field' },
          h('label', { htmlFor: 'odc-api-key' }, '新的 API Key'),
          h('input', {
            id: 'odc-api-key', className: 'odc-input', type: 'password', value: apiKey,
            autoComplete: 'new-password', autoCapitalize: 'off', spellCheck: false,
            disabled: status === undefined || keyBusy, placeholder: '仅用于本次保存，不会回填',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value),
          }),
          h('small', { className: 'odc-hint' }, 'Key 保存后清空，不写入网页存储。额度属于当前登录账号，未验证与此 Key 的工作空间一致。')),
        h('div', { className: 'odc-actions', style: { marginTop: 12 } },
          h('button', { className: 'odc-button', type: 'submit', disabled: status === undefined || keyBusy || apiKey.trim() === '' }, keyBusy ? '保存中…' : '保存 API Key')))));
}

function Advanced({ status, formSnapshot, setFormField, pendingField }: {
  status: Status | undefined;
  formSnapshot: FormSnapshot;
  setFormField: (field: string, value: unknown) => Promise<boolean>;
  pendingField: string | null;
}) {
  const [baseURL, setBaseURL] = React.useState(status?.config.baseURL ?? '');
  const [apiKeyEnv, setApiKeyEnv] = React.useState(status?.config.apiKeyEnv ?? '');
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const mounted = useMounted();
  React.useEffect(() => { setBaseURL(formSnapshot.value?.baseURL ?? status?.config.baseURL ?? ''); }, [formSnapshot.value?.baseURL, status?.config.baseURL]);
  React.useEffect(() => { setApiKeyEnv(formSnapshot.value?.apiKeyEnv ?? status?.config.apiKeyEnv ?? ''); }, [formSnapshot.value?.apiKeyEnv, status?.config.apiKeyEnv]);
  const saveText = async (field: 'baseURL' | 'apiKeyEnv') => {
    const value = field === 'baseURL' ? baseURL.trim() : apiKeyEnv.trim();
    if (value === '') {
      setNotice({ kind: 'error', text: '配置值不能为空。' });
      return;
    }
    setNotice(null);
    try {
      const accepted = await setFormField(field, value);
      if (mounted.current) setNotice(accepted ? { kind: 'status', text: '配置已保存。' } : { kind: 'error', text: '配置未保存，请刷新后重试。' });
    } catch {
      if (mounted.current) setNotice({ kind: 'error', text: GENERIC_ERROR });
    }
  };
  const disabled = !formSnapshot.writable;
  return h(React.Fragment, null,
    h('section', { className: 'odc-card' },
      h('h3', null, '空轮监控'),
      h('p', { className: 'odc-hint' }, '独立监控套餐赠送模型的空轮或协议残渣；不影响付费 Provider 的开关。'),
      h('div', { style: { marginTop: 14 } }, h(Switch, {
        checked: formSnapshot.value?.emptyTurnGuard ?? status?.config.emptyTurnGuard ?? true,
        disabled: disabled || pendingField === 'emptyTurnGuard', label: '启用空轮监控',
        hint: `本次运行已拦截 ${status?.guardedTurns ?? '—'} 轮。检测后由宿主重试策略处理，宿主重试会额外消耗额度。`,
        onChange: checked => { void setFormField('emptyTurnGuard', checked); },
      }))),
    h('section', { className: 'odc-card' },
      h('h3', null, '推理连接'),
      h('p', { className: 'odc-hint' }, formSnapshot.status === 'unavailable' ? '宿主未开放此配置表单。' : '字段由宿主配置表单校验并持久化；无需额外的保存接口。'),
      h('div', { className: 'odc-field' },
        h('label', { htmlFor: 'odc-base-url' }, 'Base URL'),
        h('input', { id: 'odc-base-url', className: 'odc-input', type: 'url', value: baseURL, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setBaseURL(event.target.value) }),
        h('small', { className: 'odc-hint' }, '仅用于 OpenAI 兼容推理，不用于控制台登录或额度查询。')),
      h('div', { className: 'odc-actions', style: { marginTop: 10 } }, h('button', { className: 'odc-button', type: 'button', disabled: disabled || pendingField === 'baseURL', onClick: () => { void saveText('baseURL'); } }, '保存 Base URL')),
      h('div', { className: 'odc-field' },
        h('label', { htmlFor: 'odc-api-key-env' }, 'API Key 环境变量 / 凭据引用名'),
        h('input', { id: 'odc-api-key-env', className: 'odc-input', type: 'text', value: apiKeyEnv, disabled, autoCapitalize: 'off', spellCheck: false, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setApiKeyEnv(event.target.value) }),
        h('small', { className: 'odc-hint' }, '这里只保存引用名称，不填写 Key 本身。')),
      h('div', { className: 'odc-actions', style: { marginTop: 10 } }, h('button', { className: 'odc-button', type: 'button', disabled: disabled || pendingField === 'apiKeyEnv', onClick: () => { void saveText('apiKeyEnv'); } }, '保存引用名')),
      h(NoticeView, { notice })));
}

export function tabAfter(current: TabId, key: string): TabId | undefined {
  const index = TABS.findIndex(tab => tab.id === current);
  if (key === 'Home') return TABS[0]!.id;
  if (key === 'End') return TABS[TABS.length - 1]!.id;
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (delta === 0) return undefined;
  return TABS[(index + delta + TABS.length) % TABS.length]!.id;
}

export function SettingsPage({ caller, form }: SettingsProps) {
  const mounted = useMounted();
  const [tab, setTab] = React.useState<TabId>('overview');
  const [status, setStatus] = React.useState<Status>();
  const [error, setError] = React.useState<string>();
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [pendingField, setPendingField] = React.useState<string | null>(null);
  const [formNotice, setFormNotice] = React.useState<Notice | null>(null);
  const statusVersion = React.useRef(0);
  const quotaVersion = React.useRef(0);
  const loginVersion = React.useRef(0);
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = React.useId();
  const formSnapshot = useFormSnapshot(form);

  const loadStatus = React.useCallback(async () => {
    const version = ++statusVersion.current;
    try {
      const next = await caller<Status>('status');
      if (!mounted.current || version !== statusVersion.current) return;
      setStatus(next);
      setError(undefined);
    } catch {
      if (mounted.current && version === statusVersion.current) setError('暂时无法连接 CoRouter 服务，请稍后重试。');
    } finally {
      if (mounted.current && version === statusVersion.current) setLoading(false);
    }
  }, [caller, mounted]);
  const refreshBusy = React.useRef(false);
  const refresh = React.useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    const version = ++quotaVersion.current;
    setRefreshing(true);
    setError(undefined);
    try {
      const quota = await caller<QuotaSnapshot>('refreshQuota');
      if (!mounted.current || version !== quotaVersion.current) return;
      setStatus(previous => previous === undefined ? previous : { ...previous, quota });
      // status() is a safe cache read: refresh first, then obtain source and revision.
      await loadStatus();
    } catch {
      if (mounted.current && version === quotaVersion.current) setError('额度刷新未完成，请稍后重试。');
    } finally {
      if (mounted.current && version === quotaVersion.current) {
        refreshBusy.current = false;
        setRefreshing(false);
      }
    }
  }, [caller, loadStatus, mounted]);
  React.useEffect(() => {
    void refresh();
    return () => {
      statusVersion.current += 1;
      quotaVersion.current += 1;
      loginVersion.current += 1;
      refreshBusy.current = false;
    };
  }, [refresh]);

  const setFormField = React.useCallback(async (field: string, value: unknown): Promise<boolean> => {
    setPendingField(field);
    setFormNotice(null);
    try {
      const accepted = await form.set(field, value);
      if (mounted.current) setFormNotice(accepted ? { kind: 'status', text: '设置已保存。' } : { kind: 'error', text: '设置未保存，请重试。' });
      return accepted;
    } catch {
      if (mounted.current) setFormNotice({ kind: 'error', text: GENERIC_ERROR });
      return false;
    } finally {
      if (mounted.current) setPendingField(null);
    }
  }, [form, mounted]);

  const loginState = status?.login.state;
  const loginActive = loginState !== undefined && loginInFlight(loginState);
  React.useEffect(() => {
    if (!loginActive) return;
    let stopped = false;
    const poll = async () => {
      const version = ++loginVersion.current;
      try {
        const login = await caller<LoginState>('loginStatus');
        if (stopped || !mounted.current || version !== loginVersion.current) return;
        setStatus(previous => previous === undefined ? previous : { ...previous, login });
        if (!loginInFlight(login.state)) {
          if (login.state === 'success') void refresh();
          else void loadStatus();
        }
      } catch {
        // Keep the last good state; the next bounded poll can recover transient failures.
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1_200);
    return () => { stopped = true; clearInterval(timer); loginVersion.current += 1; };
  }, [caller, loadStatus, loginActive, mounted, refresh]);

  const selectTab = (next: TabId) => {
    setTab(next);
    if (next === 'overview' && tab !== 'overview') void refresh();
  };

  let content: React.ReactNode;
  if (tab === 'overview') content = h(Overview, { status, busy: refreshing, onRefresh: () => { void refresh(); } });
  else if (tab === 'models') content = h(Models, { models: status?.models });
  else if (tab === 'connection') content = h(Connection, { status, formSnapshot, setFormField, pendingField, caller, loadStatus, refreshAfterLogin: refresh });
  else content = h(Advanced, { status, formSnapshot, setFormField, pendingField });

  return h('div', { className: 'odc-settings' },
    h('h2', null, 'OpenDesign CoRouter'),
    h('p', { className: 'odc-intro' }, '在一个简洁面板中管理额度、双 Provider 模型、登录与运行保护。'),
    h('div', { className: 'odc-tabs', role: 'tablist', 'aria-label': 'CoRouter 设置分类' }, TABS.map((item, index) =>
      h('button', {
        key: item.id, ref: (node: HTMLButtonElement | null): void => { tabRefs.current[index] = node; },
        className: 'odc-tab', type: 'button', role: 'tab', id: `${baseId}-tab-${item.id}`,
        'aria-controls': `${baseId}-panel`, 'aria-selected': tab === item.id, tabIndex: tab === item.id ? 0 : -1,
        onClick: () => selectTab(item.id),
        onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
          const next = tabAfter(item.id, event.key);
          if (next === undefined) return;
          event.preventDefault();
          selectTab(next);
          tabRefs.current[TABS.findIndex(candidate => candidate.id === next)]?.focus();
        },
      }, item.label))),
    h('div', {
      className: 'odc-panel', role: 'tabpanel', id: `${baseId}-panel`, tabIndex: 0,
      'aria-labelledby': `${baseId}-tab-${tab}`,
    }, content),
    loading ? h('p', { className: 'odc-meta', role: 'status' }, '正在连接服务…') : null,
    error !== undefined ? h(NoticeView, { notice: { kind: 'error', text: error } }) : null,
    h(NoticeView, { notice: formNotice }));
}

export const name = 'dsh-opendesign-corouter';
export const inject = ['slots', 'remote'];

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'opendesign-corouter: settings styles');
  ctx.effect(() => ctx.remote.$mount(openDesignCoRouterRemote), 'opendesign-corouter: mount remote');
  const caller = createCaller(ctx);
  ctx.inject(['configForms'], scope => {
    const form = scope.configForms.get(SETTINGS_NS);
    scope.effect(() => scope.slots.inject('settings.section', () => scope.slots.register<SettingsProps>({
      name: 'settings.section', id: 'opendesign-corouter', order: 65,
      label: () => 'OpenDesign CoRouter', inject: () => ({ caller, form }),
    }, SettingsPage)), 'opendesign-corouter: settings section');
  });
}
