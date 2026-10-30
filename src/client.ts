import * as React from 'react';
import openDesignCoRouterRemote, { type CoRouterRemote } from './generated/typert.remote-client.js';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import {
  type ActivationOpenState,
  type LoginState,
  type Status,
  type StatusModel,
  type PriceCatalog,
  type PriceTier,
} from './remote.js';
import type { QuotaSnapshot, QuotaWindow } from './quota.js';
import { inferenceEndpoint, API_PROTOCOL_OPTIONS, type ApiProtocol } from './protocol-options.js';
import type { ModelSettings, ModelSettingsMap } from './model-settings.js';
import { CONTEXT_WINDOW_PRESETS, contextWindowPreset, effectiveContextWindow, type ContextWindowPresetId } from './context-budget.js';
import { validateActivationUrl } from './device-auth.js';
import { modelReasoningEfforts } from './reasoning.js';
import { CLAUDE_MESSAGES_MAX_OUTPUT, claudeOutputError, claudeSamplingError, hasRestrictedClaudeSampling } from './claude-capabilities.js';
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, MAX_REQUEST_IMAGE_BYTES, MIN_REQUEST_IMAGE_BYTES } from './image-budget.js';
import { configWritesFor } from './client-config-writes.js';
import { ContextQuickSwitch, QUICK_CONTEXT_CSS, type ContextQuickProps, type ModelDirectoryService } from './client-context-quick.js';
import type { ReviewDecision, ReviewReason } from './turn-monitor-status.js';

const h = React.createElement;
const SETTINGS_NS = 'llm-opendesign-corouter';
/** Must match `DEFAULT_API_KEY_REF` in src/config.ts; the browser bundle keeps its own copy. */
export const DEFAULT_KEY_REF = 'COROUTER_API_KEY';
const OFFICIAL_SITE = 'https://corouter.open-design.ai/zh/';
const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'models', label: '模型' },
  { id: 'connection', label: '连接与登录' },
  { id: 'advanced', label: '高级' },
] as const;
type TabId = typeof TABS[number]['id'];

/** 自动刷新间隔与请求时限的界面边界；与 Host 配置校验保持同一量级。 */
const DEFAULT_QUOTA_REFRESH_SECONDS = 60;
const MIN_QUOTA_REFRESH_SECONDS = 5;
const MAX_QUOTA_REFRESH_SECONDS = 3600;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_800_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 3_600_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const MIN_STREAM_IDLE_TIMEOUT_MS = 1_000;
const MAX_STREAM_IDLE_TIMEOUT_MS = 1_800_000;
/** 与 Host 配置校验保持一致的收尾核验续办边界。 */
const DEFAULT_TURN_REVIEW_MAX_CONTINUATIONS = 3;
const MIN_TURN_REVIEW_MAX_CONTINUATIONS = 1;
const MAX_TURN_REVIEW_MAX_CONTINUATIONS = 10;
const DEFAULT_TURN_REVIEW_NO_PROGRESS_LIMIT = 2;
const MIN_TURN_REVIEW_NO_PROGRESS_LIMIT = 1;
const MAX_TURN_REVIEW_NO_PROGRESS_LIMIT = 5;
/** Client wait per RPC. The Host's slowest operation (one activation open) budgets less. */
const RPC_TIMEOUT_MS = 30_000;
/** 与 model-settings.ts 的容量上限保持一致，避免界面先接受再被 Host 拒绝。 */
const MAX_OUTPUT_TOKENS = 10_000_000;

export type RpcCaller = <T>(method: keyof CoRouterRemote, request?: unknown) => Promise<T>;

export interface FormValues {
  emptyTurnGuard?: boolean;
  turnCompletionReview?: boolean;
  useDesktopCredential?: boolean;
  baseURL?: string;
  apiKeyEnv?: string;
  apiProtocol?: ApiProtocol;
  modelSettings?: ModelSettingsMap;
  quotaRefreshSeconds?: number;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRequestImageBytes?: number;
  turnReviewMaxContinuations?: number;
  turnReviewNoProgressLimit?: number;
}
export interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: FormValues | undefined;
  writable: boolean;
}
export interface ConfigForm {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  /** Drop one field back to unnamed; absent on a Host that only writes values. */
  unset?(field: string): Promise<boolean>;
}
export interface ConfigForms {
  get(namespace: string): ConfigForm;
}
export interface SlotDescriptor<P> {
  name: 'settings.section' | 'conversation.input.right';
  id: string;
  order: number;
  label?: () => string;
  inject: (sessionId: string) => P;
}
export interface Slots {
  inject(name: 'settings.section' | 'conversation.input.right', register: () => void | (() => void)): void | (() => void);
  register<P>(descriptor: SlotDescriptor<P>, component: React.ComponentType<P>): void | (() => void);
}
export interface ClientContext {
  remote: TypertClientRemote & { $mount(contribution: typeof openDesignCoRouterRemote): Promise<() => void> };
  effect(effect: () => void | (() => void) | Promise<void | (() => void)>, label?: string): void;
  inject(services: ['configForms'], apply: (ctx: ConfigScope) => void): void;
  inject(services: ['remote.openDesignCoRouter'], apply: (ctx: RemoteScope) => void): void;
}
export interface RemoteScope {
  remote: TypertClientRemote;
  effect(effect: () => void | (() => void), label?: string): void;
}
export interface ConfigScope {
  configForms: ConfigForms;
  slots: Slots;
  effect(effect: () => void | (() => void), label?: string): void;
  inject(services: ['modelDirectories'], apply: (ctx: ModelDirectoryScope) => void): void;
}
export interface ModelDirectoryScope { slots: Slots; modelDirectories: ModelDirectoryService; effect(effect: () => void | (() => void), label?: string): void }
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
  launching: '正在申请设备授权码…',
  waiting: '请在授权窗口或常用浏览器中确认本次登录。',
  verifying: '正在保存设备授权…',
  success: '登录成功，设备授权已保存。',
  cancelled: '已取消本次登录。',
  error: '登录未完成，请重试。',
};
const QUOTA_LABELS: Record<QuotaSnapshot['state'], string> = {
  ok: '额度信息已更新',
  partial: '额度数据暂未完整',
  'need-login': '需要登录后读取额度',
  error: '暂时无法读取额度',
};

/** 结束核验决定与原因的固定中文映射；模型原文不进入界面。 */
const REVIEW_DECISION_LABELS: Record<ReviewDecision, string> = {
  continued: '已续办',
  completed: '已完成',
  'waiting-user': '等待用户',
  'waiting-work': '等待执行',
  blocked: '受阻',
  limited: '达到上限',
  skipped: '未核验',
  unverified: '无法确认',
};
const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  'missing-outcome': '尚未报告收尾状态',
  'pending-action': '尚有待执行事项',
  'reported-complete': '已报告完成',
  'needs-user': '需要用户补充',
  'work-running': '任务仍在进行',
  'reported-blocked': '已报告阻塞',
  'continuation-limit': '达到续办上限',
  'no-progress': '无进展',
  'goal-owned': '由现有目标状态控制',
  'service-unavailable': '服务暂不可用',
  cancelled: '已取消',
  truncated: '回答被截断',
  'request-failed': '请求失败',
  disabled: '监控未启用',
  superseded: '被新任务取代',
  'invalid-evidence': '证据不可用',
  'tool-concluded': '工具已结束本轮',
};

function installStyles(): () => void {
  const style = document.createElement('style');
  style.dataset.opendesignCorouter = '';
  style.textContent = `
.odc-settings{color:var(--dsw-alias-label-primary,inherit);max-width:860px;padding:6px 2px 24px;font-size:13px;line-height:1.5}
.odc-settings{color-scheme:light;container-type:inline-size}body[data-ds-dark-theme] .odc-settings{color-scheme:dark}
.odc-settings *{box-sizing:border-box}.odc-settings h2{margin:0;font-size:21px;line-height:1.35;font-weight:650;letter-spacing:-.02em}.odc-settings h3{margin:0;font-size:14px;font-weight:650}.odc-settings p{margin:0}
.odc-intro{margin:6px 0 18px!important;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}.odc-tabs{display:flex;gap:4px;overflow-x:auto;margin:0 0 16px;padding:0 0 8px;border-bottom:1px solid var(--dsw-alias-border-l4,transparent)}
.odc-tab{flex:none;border:1px solid transparent;border-radius:8px;padding:7px 13px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;cursor:pointer}.odc-tab:hover{background:var(--dsw-alias-bg-layer-1,transparent)}.odc-tab[aria-selected=true]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-border-l3,transparent);background:var(--dsw-alias-bg-layer-1,transparent)}
.odc-panel{display:grid;gap:14px}.odc-card{min-width:0;padding:15px;border:1px solid var(--dsw-alias-border-l4,transparent);border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}.odc-card>p{margin-top:6px}.odc-card-head,.odc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.odc-card-head{margin-bottom:12px}
.odc-quota-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.odc-metric{display:grid;align-content:start;gap:5px;min-height:96px}.odc-metric-value{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.odc-metric-value.odc-metric-text{font-size:13px;font-weight:600;line-height:1.55}.odc-quota-grid+.odc-quota-grid{margin-top:10px}
.odc-label,.odc-hint,.odc-meta{color:var(--dsw-alias-label-secondary,inherit);font-size:11px;line-height:1.6}.odc-meta{margin-top:10px!important}
.odc-window{display:grid;gap:10px;margin-top:12px;padding:14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,transparent);min-width:0}.odc-window-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.odc-window h4{margin:0;font-size:13px;font-weight:600}.odc-window-remaining{display:flex;align-items:baseline;gap:6px;font-variant-numeric:tabular-nums;white-space:nowrap}.odc-window-remaining strong{font-size:22px;line-height:1.2}.odc-window progress{display:block;width:100%;height:8px;accent-color:var(--dsw-alias-brand-primary,Highlight)}
.odc-window-usage{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0}.odc-window-usage>div{display:grid;gap:3px;min-width:0}.odc-window dt,.odc-quota-footer dt{color:var(--dsw-alias-label-secondary,inherit);font-size:11px}.odc-window dd,.odc-quota-footer dd{margin:0;min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.odc-window-reset{display:grid;gap:3px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l4,transparent)}.odc-window-reset time{font-size:12px}.odc-window-details>summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,inherit);min-height:32px;padding:6px 0}.odc-window-details dl{display:grid;gap:8px;margin:6px 0 0}.odc-window-details dl>div{display:grid;gap:3px}.odc-quota-footer{display:grid;gap:8px;margin:0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l4,transparent)}.odc-quota-footer>div{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px}.odc-quota-footer dd{font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}
.odc-button{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l3,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;cursor:pointer}.odc-button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,Highlight)}.odc-button-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,Highlight));color:var(--dsw-alias-label-primary-foreground,HighlightText);border-color:transparent}.odc-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,Highlight))}.odc-button:disabled{opacity:.55;cursor:not-allowed}.odc-button-small{min-height:26px;padding:3px 9px;font-size:11px}.odc-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.odc-notice{padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);font-size:12px;line-height:1.6}.odc-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary,inherit);color:color-mix(in srgb,var(--dsw-alias-state-error-primary,CanvasText) 85%,var(--dsw-alias-label-primary,CanvasText))}
.odc-model-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.odc-model-list{display:grid;gap:6px;margin:10px 0 0;padding:0;list-style:none}.odc-model-item{padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);min-width:0}.odc-model-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}.odc-model-switch{min-width:0;flex:1 1 190px}.odc-model-item strong,.odc-model-item code{display:block;overflow-wrap:anywhere}.odc-model-item strong{font-size:12px;font-weight:600}.odc-model-item code{margin-top:2px;color:var(--dsw-alias-label-secondary,inherit);font-size:11px}.odc-model-meta{margin-top:6px!important;color:var(--dsw-alias-label-secondary,inherit);font-size:11px;overflow-wrap:anywhere}.odc-model-count{color:var(--dsw-alias-label-secondary,inherit);font-size:11px;font-weight:400}.odc-chip{display:inline-flex;align-items:center;padding:1px 7px;border:1px solid var(--dsw-alias-border-l3,transparent);border-radius:999px;color:var(--dsw-alias-label-secondary,inherit);font-size:10px;line-height:1.6}
.odc-model-details{margin-top:8px}.odc-model-details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary,inherit);font-size:11px;line-height:1.7}.odc-model-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 10px;margin-top:8px}
.odc-context{grid-column:1/-1;min-width:0;margin:0 0 4px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l4,transparent);border-radius:10px}.odc-context-legend{padding:0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}.odc-context-options{display:grid;gap:6px;margin-top:2px}.odc-context-option{display:flex;align-items:flex-start;gap:8px;min-width:0;min-height:32px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,transparent);border-radius:8px;cursor:pointer}.odc-context-option:hover:not(:has(input:disabled)){border-color:color-mix(in srgb,var(--odc-accent) 55%,transparent)}.odc-context-option:has(input:checked){border-color:color-mix(in srgb,var(--odc-accent) 65%,transparent);background:color-mix(in srgb,var(--odc-accent) 8%,transparent)}.odc-context-option:has(input:disabled){cursor:not-allowed;opacity:.6}.odc-context-option input{appearance:auto;width:16px;height:16px;flex:none;margin:2px 0 0;cursor:inherit;accent-color:var(--dsw-alias-brand-primary,Highlight)}.odc-context-copy{display:grid;gap:1px;min-width:0}.odc-context-copy strong{font-size:12px;font-weight:600}.odc-context-legacy{margin-top:6px!important;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.odc-model-image{display:flex;align-items:center;gap:2px 8px;flex-wrap:wrap;margin-top:3px;min-width:0}.odc-image-toggle{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:28px;padding:2px 2px 2px 0;color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-weight:550;cursor:pointer}.odc-image-toggle input{appearance:auto;width:16px;height:16px;flex:none;margin:0;cursor:inherit;accent-color:var(--dsw-alias-brand-primary,Highlight)}.odc-image-toggle:has(input:disabled){cursor:not-allowed;opacity:.6}.odc-image-state{min-width:0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:1.5;overflow-wrap:anywhere}.odc-image-reset{min-height:28px;padding:2px 7px;border:1px solid var(--dsw-alias-border-l3,CanvasText);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;cursor:pointer}.odc-image-reset:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,Highlight);color:var(--dsw-alias-label-primary,inherit)}.odc-image-reset:disabled{opacity:.55;cursor:not-allowed}
.odc-field{display:grid;gap:6px;margin-top:14px}.odc-field-compact{margin-top:8px}.odc-field label,.odc-switch-text{font-size:12px;font-weight:550}.odc-input{width:100%;min-width:0;min-height:34px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l3,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px}.odc-field-compact .odc-input{min-height:30px;padding:5px 8px;font-size:11px}.odc-input::placeholder{color:var(--dsw-alias-label-secondary,inherit);opacity:1}.odc-input:disabled{opacity:.55}
.odc-effort{min-width:0}.odc-effort-head{display:flex;align-items:center;justify-content:space-between;gap:6px 10px;flex-wrap:wrap}.odc-effort-label{font-size:12px;font-weight:550}.odc-effort-value{min-width:0;margin:0;font-size:12px;overflow-wrap:anywhere}.odc-effort-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.odc-input option{background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
.odc-input,.odc-button:not(.odc-button-primary),.odc-tab[aria-selected=true]{border-color:var(--dsw-alias-border-l3,CanvasText);border-color:color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 55%,var(--dsw-alias-bg-layer-2,Canvas))}
.odc-switch{display:flex;align-items:center;gap:12px;min-height:44px;padding:6px 2px;cursor:pointer}.odc-switch input{appearance:auto;width:20px;height:20px;flex:none;margin:0;cursor:inherit;accent-color:var(--dsw-alias-brand-primary,Highlight)}.odc-switch>span{display:grid;gap:4px;min-width:0}.odc-switch:has(input:disabled){cursor:not-allowed;opacity:.6}.odc-divider{height:1px;border:0;background:var(--dsw-alias-border-l4,transparent);margin:2px 0}.odc-link{color:var(--dsw-alias-brand-primary,inherit);text-underline-offset:3px}
.odc-readonly{display:grid;gap:10px;margin-top:14px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,transparent)}.odc-code{display:block;min-width:0;color:var(--dsw-alias-label-primary,inherit);font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.odc-timing{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l4,transparent)}.odc-timing .odc-metric{min-height:0}.odc-settings>.odc-notice{margin-bottom:14px}.odc-model-details>summary{min-height:32px;padding:6px 0}
.odc-turn-monitor{display:grid;gap:0;margin:12px 0 0}.odc-turn-monitor>div:first-child{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:0 0 6px}.odc-turn-monitor>div:first-child dt{font-size:12px;font-weight:600}.odc-turn-monitor-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;min-width:0;min-height:0;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l4,transparent)}.odc-turn-monitor-row dt{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);min-width:0}.odc-turn-monitor-row dd{margin:0;min-width:0;text-align:right}.odc-turn-monitor-row .odc-metric-value{font-size:13px;font-variant-numeric:tabular-nums}.odc-turn-monitor-last dd{display:grid;gap:3px;justify-items:end}.odc-turn-monitor-verdict{font-size:12px;font-weight:600;overflow-wrap:anywhere;text-align:right}.odc-turn-monitor-last time{font-size:11px;font-variant-numeric:tabular-nums}
.odc-field-error{color:var(--dsw-alias-state-error-primary,inherit);color:color-mix(in srgb,var(--dsw-alias-state-error-primary,CanvasText) 85%,var(--dsw-alias-label-primary,CanvasText))}
.odc-model-groups{align-items:start}.odc-label,.odc-hint,.odc-meta,.odc-window dt,.odc-quota-footer dt,.odc-quota-footer dd,.odc-window-details>summary,.odc-model-details>summary,.odc-model-item code,.odc-model-meta,.odc-model-count,.odc-code{font-size:12px}.odc-field-compact .odc-input,.odc-button-small{font-size:12px}.odc-button-small{min-height:32px}.odc-chip{font-size:11px}
.odc-settings{--odc-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);max-width:720px;padding:16px;line-height:1.6}
.odc-settings h2{font-size:16px;letter-spacing:0}.odc-intro{margin:4px 0 12px!important}.odc-tabs{flex-wrap:wrap;overflow:visible;gap:4px;padding:0;border:0;margin-bottom:14px}
.odc-tab{border:1px solid transparent;border-radius:999px;padding:6px 12px;font-size:12px}.odc-tab[aria-selected=true]{border-color:transparent;background:color-mix(in srgb,var(--odc-accent) 16%,transparent);font-weight:600}
.odc-card{border-radius:10px;background:transparent;padding:14px}.odc-panel{gap:12px}.odc-card-head{margin-bottom:10px}.odc-button-primary{background:color-mix(in srgb,var(--odc-accent) 12%,transparent);border-color:color-mix(in srgb,var(--odc-accent) 65%,transparent);color:var(--dsw-alias-label-primary,CanvasText)}.odc-button-primary:hover:not(:disabled){background:color-mix(in srgb,var(--odc-accent) 18%,transparent)}
.odc-quota-panel{display:grid;gap:8px;min-width:0}.odc-quota-panel>.odc-card-head{margin:0}.odc-quota-status{--odc-state:var(--odc-accent);display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--odc-state) 28%,transparent);border-radius:10px;background:color-mix(in srgb,var(--odc-state) 10%,transparent);font-size:13px;font-weight:600}.odc-quota-status[data-tone=good]{--odc-state:var(--dsw-alias-state-success-primary,Highlight)}.odc-quota-status[data-tone=warn]{--odc-state:var(--dsw-alias-state-warn-primary,Highlight)}.odc-quota-status[data-tone=critical]{--odc-state:var(--dsw-alias-state-error-primary,Highlight)}.odc-state-mark{display:grid;place-items:center;width:28px;height:28px;border:1px solid color-mix(in srgb,var(--odc-state) 65%,transparent);border-radius:8px;flex:none;font-size:15px;font-weight:700}.odc-state-copy{display:grid;gap:1px;min-width:0}.odc-state-copy .odc-hint{font-weight:400}
.odc-window{--odc-window-color:var(--dsw-alias-label-secondary,CanvasText);gap:5px;margin:0;padding:10px 12px;border:0;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 5%,transparent)}.odc-window[data-tone=good]{--odc-window-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,Highlight) 70%,var(--dsw-alias-label-primary,CanvasText))}.odc-window[data-tone=warn]{--odc-window-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,Highlight) 70%,var(--dsw-alias-label-primary,CanvasText))}.odc-window[data-tone=critical]{--odc-window-color:var(--dsw-alias-state-error-primary,Highlight)}.odc-window-remaining strong{font-size:18px}.odc-window progress{appearance:none;height:7px;border:0;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 18%,transparent);accent-color:var(--odc-window-color)}.odc-window progress::-webkit-progress-bar{background:color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 18%,transparent);border-radius:999px}.odc-window progress::-webkit-progress-value{background:var(--odc-window-color);border-radius:999px}
.odc-window-usage{display:block;margin:0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;overflow-wrap:anywhere}.odc-window-bottom{display:flex;align-items:baseline;justify-content:space-between;gap:4px 12px;flex-wrap:wrap}.odc-window-reset{display:flex;align-items:baseline;justify-content:flex-start;flex-wrap:wrap;gap:4px 6px;padding:0;border:0}.odc-window-details>summary{min-height:28px;padding:4px 0}.odc-window-details[open]{flex-basis:100%}.odc-window-details dl>div{display:flex;justify-content:space-between;gap:12px}
@media(forced-colors:active){.odc-window progress{appearance:auto;accent-color:Highlight;forced-color-adjust:auto}.odc-window progress::-webkit-progress-value{background:Highlight}.odc-image-toggle input{forced-color-adjust:auto}.odc-image-reset{border-color:ButtonText;background:ButtonFace;color:ButtonText}.odc-context-option input{forced-color-adjust:auto}.odc-context-option{border-color:ButtonText}.odc-context-option:has(input:checked){border-color:Highlight}}
.odc-balance-list,.odc-timing{display:grid;gap:0;margin:0}.odc-balance-row,.odc-timing-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;min-width:0;min-height:0;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l4,transparent)}.odc-balance-row:first-child,.odc-timing-row:first-child{border-top:0}.odc-balance-row>div,.odc-timing-row>div{min-width:0}.odc-balance-row dt,.odc-timing-row dt{font-size:12px;font-weight:600}.odc-balance-row dd,.odc-timing-row dd{margin:0;min-width:0;text-align:right}.odc-balance-row .odc-metric-value{font-size:13px}.odc-timing-row .odc-metric-text{font-size:13px;white-space:nowrap}.odc-timing-row .odc-hint{display:block}.odc-timing{padding:4px 14px}
.odc-model-item{background:transparent;border:1px solid var(--dsw-alias-border-l4,transparent)}.odc-model-item:has(details[open]){border-color:color-mix(in srgb,var(--odc-accent) 55%,transparent);background:color-mix(in srgb,var(--odc-accent) 5%,transparent)}
.odc-price-summary{margin:5px 0 0!important;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}.odc-pricing-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.odc-price-tier{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l4,transparent)}.odc-price-tier dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;margin:6px 0 0}.odc-price-tier dl>div{display:flex;justify-content:space-between;gap:8px}.odc-price-tier dt{color:var(--dsw-alias-label-secondary,inherit)}.odc-price-tier dd{margin:0;font-variant-numeric:tabular-nums}
.odc-settings :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:3px}@media(max-width:680px){.odc-quota-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.odc-model-groups{grid-template-columns:1fr}.odc-model-editor{grid-template-columns:1fr}}@media(max-width:380px){.odc-quota-grid{grid-template-columns:1fr}.odc-card{padding:12px}}
@container(max-width:680px){.odc-quota-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.odc-model-groups,.odc-model-editor{grid-template-columns:1fr}}@container(max-width:380px){.odc-quota-grid{grid-template-columns:1fr}.odc-card{padding:12px}}
@container(max-width:480px){.odc-timing-row{align-items:flex-start}.odc-timing-row>div{flex:1 1 0}.odc-timing-row dd{flex:0 0 auto;max-width:50%;overflow-wrap:anywhere}.odc-timing-row .odc-metric-text{white-space:normal}}
${QUICK_CONTEXT_CSS}`;
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
    const response = await withTimeout(Promise.resolve(operation.invoke(remote, input)), RPC_TIMEOUT_MS, controller.signal);
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

export function formatTime(value: string | undefined): string {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
}

/** Relative time uses the actual scheduled instant, not the refresh interval. */
export function formatRelativeDeadline(value: string | undefined, now: number, dueText: string): string {
  const at = value === undefined ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '—';
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return dueText;
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}天${Math.floor(seconds % 86400 / 3600)}小时后`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分钟后`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分${seconds % 60}秒后`;
  return `${seconds}秒后`;
}

export function formatRefreshCountdown(value: string | undefined, now: number): string {
  return formatRelativeDeadline(value, now, '即将刷新');
}

function RelativeDeadline({ at, busy = false, dueText, titleLabel, futureSuffix = '' }: { at: string | undefined; busy?: boolean | undefined; dueText: string; titleLabel: string; futureSuffix?: string | undefined }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (at === undefined || !Number.isFinite(Date.parse(at))) return;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [at]);
  if (busy) return h('span', null, '刷新中…');
  if (at === undefined || !Number.isFinite(Date.parse(at))) return h('span', null, '—');
  const relative = formatRelativeDeadline(at, now, dueText) + (Date.parse(at) > now ? futureSuffix : '');
  return h('time', { dateTime: at, title: `${titleLabel}：${formatTime(at)}`, 'aria-label': `${relative}，${titleLabel}：${formatTime(at)}` }, relative);
}

/** Token capacities use the same zh-CN grouping as amounts so large windows stay readable. */
export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天赠送窗口`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时赠送窗口`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟赠送窗口`;
  return `${seconds} 秒赠送窗口`;
}

/** Compact credits for the summary; exact figures remain available to assistive technology. */
export function formatWindowCredits(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

type QuotaTone = 'neutral' | 'good' | 'warn' | 'critical';
function windowTone(window: QuotaWindow): QuotaTone {
  return window.percent >= 100 ? 'critical' : window.percent >= 71 ? 'warn' : 'good';
}
function windowDue(window: QuotaWindow, now: number): boolean {
  if (window.resetsAt === undefined) return false;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) && at <= now;
}
export function quotaStatusView(quota: QuotaSnapshot, now: number): { title: string; tone: QuotaTone; icon: string; window?: QuotaWindow } {
  if (quota.state === 'error') return { title: QUOTA_LABELS.error, tone: 'critical', icon: '!' };
  if (quota.state === 'need-login') return { title: QUOTA_LABELS['need-login'], tone: 'neutral', icon: 'i' };
  if (quota.stale) return { title: '显示上次成功读数', tone: 'warn', icon: '?' };
  if (quota.state === 'partial') return { title: QUOTA_LABELS.partial, tone: 'warn', icon: '?' };
  if (quota.eligible === false) return { title: '未开通 Design Plan', tone: 'neutral', icon: 'i' };
  const windows = quota.windows.filter(window => Number.isFinite(window.percent));
  if (!windows.length) return { title: '暂无赠送窗口数据', tone: 'neutral', icon: 'i' };
  if (windows.some(window => windowDue(window, now))) return { title: '等待更新窗口额度', tone: 'neutral', icon: '…' };
  const window = windows.reduce((worst, next) => next.percent > worst.percent ? next : worst);
  const tone = windowTone(window);
  const title = tone === 'critical' ? '赠送窗口额度已用尽' : window.percent >= 91 ? '赠送窗口额度即将用尽' : tone === 'warn' ? '赠送窗口额度偏少' : '赠送窗口额度充足';
  return { title, tone, icon: tone === 'good' ? '✓' : tone === 'warn' ? '!' : '×', window };
}

export interface QuotaViewProps {
  quota: QuotaSnapshot | undefined;
  nextAutoRefreshAt?: string | undefined;
  refreshIntervalSeconds?: number | undefined;
  busy?: boolean | undefined;
}

/** Earliest still-future window reset; quota recovery comes only from `windows[].resetsAt`. */
export function nextWindowResetAt(windows: readonly QuotaWindow[], now: number): string | undefined {
  let earliest: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const window of windows) {
    if (window.resetsAt === undefined) continue;
    const ms = Date.parse(window.resetsAt);
    if (!Number.isFinite(ms) || ms <= now || ms >= earliestMs) continue;
    earliest = window.resetsAt;
    earliestMs = ms;
  }
  return earliest;
}

const SOURCE_LABELS: Record<NonNullable<QuotaSnapshot['source']>, string> = {
  desktop: '桌面登录态',
  login: '独立登录',
  environment: '环境凭据',
};
const RESET_MODE_LABELS: Record<string, string> = {
  activity_triggered: '按使用触发',
  anchored_recurring: '固定周期',
};

export function QuotaView({ quota, nextAutoRefreshAt, refreshIntervalSeconds, busy = false }: QuotaViewProps) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => { setNow(Date.now()); }, [quota?.windows]);
  React.useEffect(() => {
    const future = (quota?.windows ?? []).map(window => Date.parse(window.resetsAt ?? '')).filter(at => Number.isFinite(at) && at > now);
    const update = () => setNow(Date.now());
    const timer = future.length ? setTimeout(update, Math.min(2_147_483_647, Math.max(1, Math.min(...future) - now + 10))) : undefined;
    document.addEventListener('visibilitychange', update);
    return () => { if (timer !== undefined) clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, [quota?.windows, now]);
  if (quota === undefined) return h('p', { className: 'odc-hint', role: 'status' }, '正在读取额度…');
  const metrics = [
    { label: '套餐余额', value: formatUsd(quota.balances.subscriptionUsd), hint: '订阅剩余可用金额' },
    { label: '充值 / 赠送金额', value: formatUsd(quota.balances.rechargeUsd), hint: '充值与赠送的可用金额' },
    { label: '总额度', value: formatUsd(quota.balances.totalUsd), hint: '钱包当前可用总额' },
  ];
  const timing = [
    {
      label: '订阅账期结束',
      value: h(RelativeDeadline, { at: quota.subscriptionPeriodEnd, dueText: '已到结束时间', titleLabel: '账期结束时间' }),
      hint: `账期开始：${formatTime(quota.subscriptionPeriodStart)}`,
    },
    {
      label: '下次额度恢复',
      value: h(RelativeDeadline, { at: nextWindowResetAt(quota.windows, Date.now()), dueText: '等待更新', titleLabel: '额度恢复时间' }),
      hint: '最早恢复的赠送窗口；不代表钱包到账时间',
    },
    {
      label: '下次自动刷新',
      value: h(RelativeDeadline, { at: quota.state === 'need-login' || quota.autoRefreshPaused ? undefined : nextAutoRefreshAt, busy: busy && quota.state !== 'need-login' && !quota.autoRefreshPaused, dueText: '即将刷新', titleLabel: '计划刷新时间' }),
      hint: quota.state === 'need-login' ? '登录后自动刷新' : quota.autoRefreshPaused ? '连续失败，自动重试已暂停；点击刷新额度重试' : refreshIntervalSeconds === undefined ? '未启用自动刷新' : quota.refreshFailures ? `刷新失败 ${quota.refreshFailures} 次，正在延迟重试` : `每 ${refreshIntervalSeconds} 秒自动刷新`,
    },
  ];
  const tierLine = [
    quota.tier === undefined ? undefined : `当前套餐：${quota.tier}`,
    quota.eligible === undefined ? undefined : `套餐资格：${quota.eligible ? '已开通' : '未开通'}`,
  ].filter((value): value is string => value !== undefined).join(' · ');
  const quotaStatus = quotaStatusView(quota, now);
  return h(React.Fragment, null,
    h('div', { className: 'odc-quota-panel' },
      h('div', { className: 'odc-card-head' },
        h('div', null,
          h('h3', null, '套餐赠送窗口'),
          tierLine === '' ? null : h('p', { className: 'odc-hint' }, tierLine)),
        quota.stale ? h('span', { className: 'odc-chip' }, '上次成功读数') : null),
      h('div', { className: 'odc-quota-status', 'data-state': quota.state, 'data-tone': quotaStatus.tone },
        h('span', { className: 'odc-state-mark', 'aria-hidden': true }, quotaStatus.icon),
        h('div', { className: 'odc-state-copy' },
          h('strong', null, quotaStatus.title),
          quotaStatus.window === undefined ? null : h('span', { className: 'odc-hint' }, `${windowLabel(quotaStatus.window.durationSeconds).replace('赠送窗口', '')} · 剩余 ${Math.max(0, Math.min(100, 100 - quotaStatus.window.percent)).toFixed(1)}%`,
            quotaStatus.window.resetsAt === undefined ? null : h(React.Fragment, null, ' · ', h(RelativeDeadline, { at: quotaStatus.window.resetsAt, dueText: '等待更新', titleLabel: '预计恢复时间', futureSuffix: '恢复' }))))),
      quota.windows.length === 0
        ? quota.eligible === false
          ? h('p', { className: 'odc-hint', role: 'status' }, '当前账号未开通 Design Plan，没有赠送额度窗口。')
          : h(React.Fragment, null,
            h('p', { className: 'odc-metric-value' }, '—'),
            h('p', { className: 'odc-hint' }, '暂时无法获取额度窗口。'))
        : quota.windows.map((window, index) => {
          const label = windowLabel(window.durationSeconds);
          const remainingPercent = Math.max(0, Math.min(100, 100 - window.percent));
          const tone = quota.state === 'ok' && !quota.stale && !windowDue(window, now) ? windowTone(window) : 'neutral';
          return h('section', { className: 'odc-window', key: `${window.durationSeconds}-${index}`, 'aria-label': label, 'data-tone': tone },
            h('div', { className: 'odc-window-head' },
              h('h4', null, label),
              h('div', { className: 'odc-window-remaining' },
                h('strong', null, `${remainingPercent.toFixed(1)}%`), h('span', { className: 'odc-label' }, '剩余比例'))),
            h('progress', { max: 100, value: remainingPercent, 'aria-label': `${label}剩余额度` }),
            h('p', { className: 'odc-window-usage', title: `已用 ${window.used} / 总计 ${window.limit} 积分`, 'aria-label': `窗口积分：已用 ${window.used}，总计 ${window.limit}` }, `已用 ${formatWindowCredits(window.used)} / 总计 ${formatWindowCredits(window.limit)} 积分`),
            h('div', { className: 'odc-window-bottom' },
              h('div', { className: 'odc-window-reset' },
                h('span', { className: 'odc-label' }, '下次恢复'),
                h(RelativeDeadline, { at: window.resetsAt, dueText: '已到恢复时间，等待更新', titleLabel: '预计恢复时间' })),
              h('details', { className: 'odc-window-details' },
                h('summary', null, '窗口详情'),
                h('dl', null,
                  h('div', null, h('dt', null, '接口剩余积分'), h('dd', null, window.remaining === undefined ? '—' : window.remaining)),
                  window.windowStart === undefined ? null : h('div', null, h('dt', null, '窗口开始'), h('dd', null, h('time', { dateTime: window.windowStart }, formatTime(window.windowStart)))),
                  window.resetMode === undefined ? null : h('div', null, h('dt', null, '重置方式'), h('dd', null, RESET_MODE_LABELS[window.resetMode] ?? window.resetMode))))));
        })),
    h('section', { className: 'odc-card', 'aria-label': '钱包余额' },
      h('h3', null, '钱包余额'),
      h('dl', { className: 'odc-balance-list' }, metrics.map(metric =>
        h('div', { className: 'odc-balance-row odc-metric', key: metric.label },
          h('div', null, h('dt', { title: metric.hint }, metric.label)),
          h('dd', null, h('strong', { className: 'odc-metric-value' }, metric.value)))))),
    h('dl', { className: 'odc-card odc-timing', 'aria-label': '额度时间安排' }, timing.map(metric =>
      h('div', { className: 'odc-timing-row odc-metric', key: metric.label },
        h('div', null, h('dt', null, metric.label), h('span', { className: 'odc-hint' }, metric.hint)),
        h('dd', null, h('strong', { className: 'odc-metric-value odc-metric-text' }, metric.value))))),
    h('dl', { className: 'odc-quota-footer', 'aria-label': '额度数据来源与更新时间' },
      h('div', null, h('dt', null, '最近更新'), h('dd', null, h('time', { dateTime: quota.updatedAt }, formatTime(quota.updatedAt)))),
      quota.source === undefined ? null : h('div', null, h('dt', null, '数据来源'), h('dd', null, SOURCE_LABELS[quota.source]))),
    h('details', { className: 'odc-model-details' },
      h('summary', null, '如何理解这些额度？'),
      h('p', { className: 'odc-hint' }, '赠送窗口显示周期内的使用量。套餐余额和充值 / 赠送金额是钱包的不同分池，总额度是钱包合计。— 表示暂无数据。')),
    quota.note !== undefined ? h('p', { className: 'odc-notice', 'data-kind': quota.state === 'error' ? 'error' : 'status', role: quota.state === 'error' ? 'alert' : 'status' }, quota.note) : null);
}

/** 异常结束监控卡片：协议拦截与新监控计数分列，未知值保持未知，不补零；计数均从插件加载起累计。 */
export function TurnMonitorView({ turnMonitor, guardedTurns, enabled = true, reviewEnabled = true }: { turnMonitor?: Status['turnMonitor']; guardedTurns?: number | undefined; enabled?: boolean | undefined; reviewEnabled?: boolean | undefined }) {
  const metrics = [
    { label: '空响应／残留拦截', hint: '空回答或协议标记残留的拦截次数，从插件加载起累计', value: guardedTurns === undefined ? '—' : String(guardedTurns) },
    { label: '请求重试', hint: '本插件空响应错误恢复中已开始的重试次数，从插件加载起累计', value: turnMonitor === undefined ? '—' : String(turnMonitor.requestRetries) },
    { label: '结束核验', hint: '任务收尾的有界核验次数，从插件加载起累计', value: turnMonitor === undefined ? '—' : String(turnMonitor.checks) },
    { label: '任务续办', hint: '结束检查点追加的核验或任务步骤次数，从插件加载起累计', value: turnMonitor === undefined ? '—' : String(turnMonitor.continuations) },
  ];
  const last = turnMonitor?.last;
  const lastAt = last === undefined || !Number.isFinite(Date.parse(last.at)) ? undefined : last.at;
  const lastDecision = last === undefined ? undefined : REVIEW_DECISION_LABELS[last.decision];
  const lastReason = last === undefined ? undefined : REVIEW_REASON_LABELS[last.reason];
  return h('dl', { className: 'odc-card odc-turn-monitor', 'aria-label': '异常结束监控' },
    h('div', null, h('dt', null, '监控指标'),
      h('span', { className: 'odc-hint', role: 'status' },
        !enabled ? '监控已关闭；以下为本次加载的累计记录。' : turnMonitor === undefined
          ? guardedTurns === undefined ? '暂无监控数据' : '仅协议拦截计数可用'
          : turnMonitor.available && reviewEnabled
            ? `收尾核验可用，已核验 ${turnMonitor.checks} 次。`
            : '仅协议保护可用；收尾核验未启用。')),
    metrics.map(metric => h('div', { className: 'odc-turn-monitor-row', key: metric.label },
      h('dt', { title: metric.hint }, metric.label),
      h('dd', null, h('strong', { className: 'odc-metric-value' }, metric.value)))),
    h('div', { className: 'odc-turn-monitor-row odc-turn-monitor-last', key: 'last' },
      h('dt', null, '最近决定'),
      h('dd', null,
        lastDecision === undefined || lastReason === undefined || lastAt === undefined
          ? h('span', { className: 'odc-hint' }, '—')
          : h(React.Fragment, null,
            h('span', { className: 'odc-turn-monitor-verdict' }, `${lastDecision} · ${lastReason}`),
            h('time', { className: 'odc-hint', dateTime: lastAt, title: `最近决定时间：${formatTime(lastAt)}`, 'aria-label': `最近决定：${lastDecision}，原因：${lastReason}，时间：${formatTime(lastAt)}` }, formatTime(lastAt))))));
}

/** Whole-map model settings writer: absent entry means "inherit every default". */
export function writeModelSettings(map: ModelSettingsMap | undefined, id: string, next: ModelSettings | undefined): ModelSettingsMap {
  const out: ModelSettingsMap = { ...(map ?? {}) };
  if (next === undefined) {
    delete out[id];
    return out;
  }
  const entry: ModelSettings = {};
  if (next.enabled !== undefined) entry.enabled = next.enabled;
  if (next.imageInput !== undefined) entry.imageInput = next.imageInput;
  if (next.temperature !== undefined) entry.temperature = next.temperature;
  if (next.topP !== undefined) entry.topP = next.topP;
  if (next.maxTokens !== undefined) entry.maxTokens = next.maxTokens;
  if (next.contextWindow !== undefined) entry.contextWindow = next.contextWindow;
  if (next.contextTier !== undefined) entry.contextTier = next.contextTier;
  if (next.reasoningEffort !== undefined) entry.reasoningEffort = next.reasoningEffort;
  if (Object.keys(entry).length === 0) delete out[id];
  else out[id] = entry;
  return out;
}

/** One model's explicit settings; unknown ids read as "no overrides". */
export function modelSettingsEntry(map: ModelSettingsMap | undefined, id: string): ModelSettings {
  return { ...(map?.[id] ?? {}) };
}

/**
 * Explicit settings always win. When the settings map is authoritative (a ready form snapshot or
 * the Host's mirror), an absent entry means "enabled"; only a non-authoritative view falls back to
 * `Status.models[].enabled`, which can lag one refresh behind a reset.
 */
export function modelEnabled(model: StatusModel, settings: ModelSettings | undefined, authoritative = true): boolean {
  if (settings?.enabled !== undefined) return settings.enabled;
  if (authoritative) return true;
  return model.enabled !== false;
}

/** Manual image policy wins; automatic mode only treats an explicit catalog image modality as confirmed. */
export function modelImageInput(model: StatusModel, settings: ModelSettings | undefined): boolean {
  if (settings?.imageInput !== undefined) return settings.imageInput;
  return model.inputModalities === undefined ? true : model.inputModalities.includes('image');
}

/** Enabled rows come first without changing the catalog's order within either state. */
export function sortModelsByEnabled(models: readonly StatusModel[], settingsMap: ModelSettingsMap, authoritative: boolean): StatusModel[] {
  return models.map((model, index) => ({ model, index, enabled: modelEnabled(model, settingsMap[model.id], authoritative) }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.index - b.index)
    .map(({ model }) => model);
}

function imageInputSource(model: StatusModel, settings: ModelSettings): string {
  if (settings.imageInput !== undefined) return settings.imageInput ? '手动 · 开启' : '手动 · 关闭';
  if (model.inputModalities === undefined) return '自动 · 未知，尝试发送';
  return model.inputModalities.includes('image')
    ? '自动 · 支持图片'
    : '自动 · 仅文本';
}

export interface NumberInputSpec {
  label: string;
  min: number;
  max: number;
  integer?: boolean;
  allowEmpty?: boolean;
}
export type NumberInputResult = { ok: true; value: number | undefined } | { ok: false; message: string };
/** Plain decimal syntax only: `Number('0x10')` or `'1e3'` must not silently become a setting. */
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/** Parse a label-bound numeric setting; an empty string means "inherit" when allowed. */
export function parseNumberInput(raw: string, spec: NumberInputSpec): NumberInputResult {
  const text = raw.trim();
  if (text === '') {
    return spec.allowEmpty === true ? { ok: true, value: undefined } : { ok: false, message: `${spec.label}不能为空。` };
  }
  const integral = spec.integer === true;
  const value = DECIMAL_TEXT.test(text) ? Number(text) : Number.NaN;
  if (!DECIMAL_TEXT.test(text) || !Number.isFinite(value) || value < spec.min || value > spec.max || (integral && !Number.isSafeInteger(value))) {
    return {
      ok: false,
      message: `${spec.label}需为 ${spec.min} 到 ${spec.max} 之间的${integral ? '整数' : '数字'}${spec.allowEmpty === true ? '，或留空继承默认。' : '。'}`,
    };
  }
  return { ok: true, value };
}

/** Absolute endpoint of the selected protocol; the gateway itself stays read-only. */
export function protocolEndpoint(baseURL: string, protocol: ApiProtocol): string {
  return inferenceEndpoint(baseURL, protocol);
}

export function normaliseQuotaRefreshSeconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < MIN_QUOTA_REFRESH_SECONDS || value > MAX_QUOTA_REFRESH_SECONDS) return undefined;
  return value;
}

export interface QuotaAutoRefresh {
  delayMs: number;
  at: string;
  intervalSeconds: number;
}

/**
 * Schedule the next quota refresh: the automatic interval normally, or earlier when the Host's
 * cache policy reports its next planned read (`nextRefreshAt`, which is never a quota reset).
 * During failure backoff the host plan wins, even when the normal interval is shorter.
 * A timestamp that is already past must not create a 0 ms retry loop, so it falls back to the
 * regular interval instead of hammering the console.
 */
export function quotaAutoRefresh(secondsRaw: number | undefined, nextRefreshAt: string | undefined, now: number, backingOff = false): QuotaAutoRefresh | undefined {
  const intervalSeconds = normaliseQuotaRefreshSeconds(secondsRaw);
  if (intervalSeconds === undefined) return undefined;
  const intervalMs = intervalSeconds * 1000;
  const planMs = nextRefreshAt === undefined ? Number.NaN : Date.parse(nextRefreshAt);
  const planDelay = Number.isFinite(planMs) ? planMs - now : Number.POSITIVE_INFINITY;
  const plannedDelay = Math.max(1_000, Math.floor(planDelay) + 500);
  const delayMs = Number.isFinite(planDelay) && planDelay > 0 ? backingOff ? plannedDelay : Math.min(intervalMs, plannedDelay) : intervalMs;
  return { delayMs, at: new Date(now + delayMs).toISOString(), intervalSeconds };
}

export interface OverviewProps {
  status: Status | undefined;
  busy: boolean;
  onRefresh: () => void;
  nextAutoRefreshAt?: string | undefined;
  refreshIntervalSeconds?: number | undefined;
  onConnection?: (() => void) | undefined;
}

export function Overview({ status, busy, onRefresh, nextAutoRefreshAt, refreshIntervalSeconds, onConnection }: OverviewProps) {
  return h(React.Fragment, null,
    status !== undefined && (status.apiKeyConfigured === false || status.quota.state === 'need-login')
      ? h('section', { className: 'odc-card odc-row', 'aria-label': '连接待完成' },
        h('div', null, h('h3', null, '先完成连接'),
          h('p', { className: 'odc-hint' }, status.apiKeyConfigured === false ? '尚无当前网关的推理凭据；可完成设备授权或单独配置 API Key。' : 'API Key 已配置；登录后即可查看账号额度。')),
        onConnection === undefined ? null : h('button', { type: 'button', className: 'odc-button odc-button-primary', onClick: onConnection }, '前往连接与登录')) : null,
    h('div', { className: 'odc-card-head' },
      h('div', null, h('h3', null, '额度概览'), h('p', { className: 'odc-hint' }, '查看套餐用量、订阅余额和充值余额。')),
      h('button', { className: 'odc-button', type: 'button', disabled: busy, onClick: onRefresh }, busy ? '刷新中…' : '刷新额度')),
    h(QuotaView, { quota: status?.quota, nextAutoRefreshAt, refreshIntervalSeconds, busy }));
}

type NumericKey = 'temperature' | 'topP' | 'maxTokens';
interface NumericSpec { label: string; hint: string; min: number; max: number; integer?: boolean }
const NUMERIC_FIELDS: Record<NumericKey, NumericSpec> = {
  temperature: { label: '温度', hint: '0–2；留空继承默认。', min: 0, max: 2 },
  topP: { label: 'Top P', hint: '0–1；留空继承默认。', min: 0, max: 1 },
  maxTokens: { label: '最大输出（tokens）', hint: '正整数；留空按模型与当前总窗口自动预留。', min: 1, max: MAX_OUTPUT_TOKENS, integer: true },
};
const NUMERIC_ORDER: readonly NumericKey[] = ['temperature', 'topP', 'maxTokens'];

/**
 * The tier a saved override represents. A legacy number keeps its own meaning: even a
 * number that equals a tier's token count is a custom window, never a tier.
 */
export function selectedContextTier(settings: ModelSettings): ContextWindowPresetId | undefined {
  return contextWindowPreset(settings.contextWindow, settings.contextTier);
}

/** A tier above the known reference cannot be selected; the default tier is clamped instead. */
export function contextTierAvailable(tier: ContextWindowPresetId, reference: number | undefined): boolean {
  if (tier === 'default') return true;
  const preset = CONTEXT_WINDOW_PRESETS.find(item => item.id === tier);
  if (preset === undefined) return false;
  return reference === undefined || preset.tokens <= reference;
}

/** The working window a tier would produce for this model. */
export function contextTierWindow(tier: ContextWindowPresetId, reference: number | undefined): number {
  return effectiveContextWindow(reference, undefined, tier);
}

/** An explicit output limit that does not fit the effective working window. */
export function contextCapacityConflict(reference: number | undefined, next: ModelSettings): string | undefined {
  const output = next.maxTokens;
  if (output === undefined) return undefined;
  const window = effectiveContextWindow(reference, next.contextWindow, next.contextTier);
  if (output < window) return undefined;
  return `最大输出 ${formatTokens(output)} 不小于当前总窗口 ${formatTokens(window)}（含输出预留）；可清空或减小最大输出，或改选更大的上下文档位。`;
}

/** A tier change that would break an explicit output limit; the saved tier stays unchanged. */
export function contextTierConflict(reference: number | undefined, tier: ContextWindowPresetId, output: number | undefined): string | undefined {
  if (output === undefined) return undefined;
  const window = contextTierWindow(tier, reference);
  if (output < window) return undefined;
  const preset = CONTEXT_WINDOW_PRESETS.find(item => item.id === tier);
  return `无法切换到「${preset?.label ?? tier}」档：最大输出 ${formatTokens(output)} 不小于该档位的总窗口 ${formatTokens(window)}（含输出预留）；请先清空或减小最大输出，当前档位保持不变。`;
}

function OptionalNumberField({ id, field, value, disabled, restricted = false, invalid = false, conflict, maxOutputLimit, resetToken, onSave }: {
  id: string;
  field: NumericKey;
  value: number | undefined;
  disabled: boolean;
  restricted?: boolean;
  invalid?: boolean;
  conflict?: string | undefined;
  maxOutputLimit?: number | undefined;
  resetToken: number;
  onSave: (value: number | undefined) => Promise<boolean>;
}) {
  const spec = NUMERIC_FIELDS[field];
  const mounted = useMounted();
  const [draft, setDraft] = React.useState<string | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    setDraft(undefined);
    setError(undefined);
  }, [value, resetToken]);
  const commit = async (): Promise<void> => {
    if (disabled || draft === undefined) return;
    const result = parseNumberInput(draft, {
      label: spec.label,
      min: spec.min,
      max: spec.max,
      ...(spec.integer === true ? { integer: true } : {}),
      allowEmpty: true,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.value === value) {
      setDraft(undefined);
      setError(undefined);
      return;
    }
    const saved = await onSave(result.value);
    if (!mounted.current) return;
    if (saved) {
      setDraft(undefined);
      setError(undefined);
    } else setError('设置未保存，请重试。');
  };
  return h('div', { className: 'odc-field odc-field-compact' },
    h('label', { htmlFor: id }, spec.label),
    h('input', {
      id, className: 'odc-input', type: 'number', inputMode: 'decimal', min: spec.min, max: maxOutputLimit ?? spec.max,
      step: spec.integer === true ? 1 : field === 'topP' ? 0.01 : 0.1, value: draft ?? (value === undefined ? '' : String(value)), disabled,
      'aria-invalid': error !== undefined || invalid,
      'aria-describedby': `${id}-hint`,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      onBlur: () => { void commit(); },
    }),
    h('small', {
      className: error === undefined && conflict === undefined ? 'odc-hint' : 'odc-hint odc-field-error',
      id: `${id}-hint`,
      ...(error === undefined && conflict === undefined ? {} : { role: 'alert' as const }),
    }, error ?? conflict ?? (restricted ? field === 'temperature' ? 'Messages 仅接受 1；建议留空，且勿同时设置 Top P。' : 'Messages 仅接受 0.99；建议留空，且勿同时设置温度。' : maxOutputLimit !== undefined ? `Messages 最大输出 ${maxOutputLimit}；留空继承默认。` : spec.hint)));
}

/**
 * The mutually exclusive context-window tiers. Each tier is a combined input-plus-output
 * working window; the vendor reference stays the evidence value and only caps the tiers.
 */
function ContextWindowField({ id, reference, settings, disabled, reason, onSelect }: {
  id: string;
  reference: number | undefined;
  settings: ModelSettings;
  disabled: boolean;
  reason?: string | undefined;
  onSelect: (tier: ContextWindowPresetId) => void;
}) {
  const tier = selectedContextTier(settings);
  const legacy = settings.contextTier === undefined && settings.contextWindow !== undefined;
  const both = settings.contextTier !== undefined && settings.contextWindow !== undefined;
  const current = effectiveContextWindow(reference, settings.contextWindow, settings.contextTier);
  // A legacy number keeps its own value; only a tier is capped by the known reference.
  const requested = legacy ? undefined : CONTEXT_WINDOW_PRESETS.find(preset => preset.id === (tier ?? 'default'))?.tokens;
  const clamped = requested !== undefined && reference !== undefined && current < requested;
  const note = legacy
    ? '；旧自定义窗口按原值继续生效'
    : clamped ? `；参考容量 ${formatTokens(reference ?? 0)}，所选档位已按参考容量限幅` : '';
  const reasonId = `${id}-reason`;
  return h('fieldset', { className: 'odc-context', 'aria-describedby': reason === undefined ? undefined : reasonId },
    h('legend', { className: 'odc-context-legend' }, '上下文窗口（输入 + 输出合计）'),
    h('div', { className: 'odc-context-options' },
      CONTEXT_WINDOW_PRESETS.map(preset => {
        const available = contextTierAvailable(preset.id, reference);
        const inputId = `${id}-${preset.id}`;
        const hintId = `${inputId}-hint`;
        return h('label', {
          className: 'odc-context-option', key: preset.id, htmlFor: inputId,
          'data-preset': preset.id, 'data-available': available ? 'true' : 'false',
        },
          h('input', {
            id: inputId, type: 'radio', name: id, value: preset.id,
            checked: preset.id === tier,
            disabled: disabled || !available,
            'aria-describedby': reason === undefined ? hintId : `${hintId} ${reasonId}`,
            onChange: () => { onSelect(preset.id); },
          }),
          h('span', { className: 'odc-context-copy' },
            h('strong', null, preset.label),
            h('small', { className: 'odc-hint', id: hintId }, available
              ? `${formatTokens(preset.tokens)} tokens`
              : `${formatTokens(preset.tokens)} tokens · 超过参考容量 ${formatTokens(reference ?? 0)}`)));
      })),
    reason === undefined ? null : h('small', { className: 'odc-hint', id: reasonId }, reason),
    legacy ? h('p', { className: 'odc-context-legacy', role: 'status' }, `旧自定义 ${formatTokens(settings.contextWindow ?? 0)}，选择档位替换`) : null,
    both ? h('p', { className: 'odc-context-legacy', role: 'status' }, `旧自定义 ${formatTokens(settings.contextWindow ?? 0)} 与所选档位同时存在，请重新选择档位以只保留其一。`) : null,
    h('small', { className: 'odc-hint' },
      `当前总窗口 ${formatTokens(current)} tokens（含输出预留）${note}。`));
}

function EffortField({ id, model, value, disabled, pending, disabledReason, onSave }: {
  id: string;
  model: StatusModel;
  value: string | undefined;
  disabled: boolean;
  pending: boolean;
  disabledReason?: string | undefined;
  onSave: (value: string) => Promise<boolean>;
}) {
  const mounted = useMounted();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? '');
  const [baseValue, setBaseValue] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const listed = model.reasoningEfforts ?? [];
  const invalidDefault = value !== undefined && !listed.includes(value);
  const invalidDraft = editing && draft !== '' && !listed.includes(draft);
  const options = [...listed];
  for (const effort of [value, draft]) {
    if (effort !== undefined && effort !== '' && !options.includes(effort)) options.push(effort);
  }
  const unavailable = listed.length === 0;
  const busy = saving || pending;
  const reason = busy ? '正在保存模型设置，完成后可继续编辑。' : disabled ? `${disabledReason ?? '配置不可写'}，无法编辑。` : undefined;
  const externallyChanged = editing && value !== baseValue && !(saving && value === draft);
  const hint = reason ?? (editing
    ? externallyChanged ? '配置已从其他位置更新；取消可查看最新值，保存将使用当前草稿。'
      : invalidDraft ? '当前草稿不适用于此模型或协议，请选择其他档位或继承默认。'
        : '选择“继承默认”会删除已保存档位；保存前仅修改本地草稿。'
    : invalidDefault ? '已保存的档位不适用于当前模型或协议，可编辑后选择其他档位或继承默认。'
      : unavailable ? '当前模型或协议未提供可调整的思考档位。'
        : '未设置时使用服务端默认档位。');
  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setError(undefined);
  };
  const save = async (): Promise<void> => {
    if (disabled || pending || saving || invalidDraft) return;
    if (draft === (value ?? '')) {
      setEditing(false);
      setError(undefined);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const saved = await onSave(draft);
      if (!mounted.current) return;
      if (saved) {
        setEditing(false);
        setError(undefined);
      } else setError('设置未保存，已保留当前草稿，请重试。');
    } catch {
      if (mounted.current) setError('设置未保存，已保留当前草稿，请重试。');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return h('div', {
    className: 'odc-field odc-field-compact odc-effort', 'data-mode': editing ? 'editing' : 'summary',
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || !editing || saving) return;
      event.preventDefault();
      cancel();
    },
  },
    editing ? h(React.Fragment, null,
      h('label', { htmlFor: id }, '默认思考深度'),
      h('select', {
        id, className: 'odc-input', value: draft, disabled: busy || disabled,
        'aria-describedby': `${id}-hint${error === undefined ? '' : ` ${id}-error`}`, 'aria-invalid': invalidDraft || error !== undefined,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setDraft(event.target.value); setError(undefined); },
      }, [
        h('option', { key: '', value: '' }, '继承默认'),
        ...options.map(effort => h('option', { key: effort, value: effort, disabled: !listed.includes(effort) }, listed.includes(effort) ? effort : `${effort}（当前不可用）`)),
      ]),
      h('div', { className: 'odc-effort-actions' },
        h('button', { className: 'odc-button odc-button-small odc-button-primary', type: 'button', disabled: busy || disabled || invalidDraft, 'aria-label': '保存默认思考深度', onClick: () => { void save(); } }, saving ? '保存中…' : '保存'),
        h('button', { className: 'odc-button odc-button-small', type: 'button', disabled: saving, 'aria-label': '取消编辑默认思考深度', onClick: cancel }, '取消')))
      : h(React.Fragment, null,
        h('div', { className: 'odc-effort-head' },
          h('span', { className: 'odc-effort-label' }, '默认思考深度'),
          h('button', {
            className: 'odc-button odc-button-small', type: 'button', disabled: busy || disabled || (unavailable && value === undefined),
            'aria-label': '编辑默认思考深度', 'aria-describedby': `${id}-hint`,
            onClick: () => { setDraft(value ?? ''); setBaseValue(value); setError(undefined); setEditing(true); },
          }, '编辑')),
        h('p', { className: 'odc-effort-value' }, invalidDefault ? `${value}（当前不可用）` : value ?? '继承默认')),
    h('small', {
      className: 'odc-hint', id: `${id}-hint`,
    }, hint),
    error === undefined ? null : h('small', { className: 'odc-hint odc-field-error', id: `${id}-error`, role: 'alert' }, error));
}

const PRICE_SITE = 'https://corouter.open-design.ai/zh/models/';
function priceUnit(tier: PriceTier): string {
  return tier.unit === 'per_1m_tokens' ? '每百万 Token' : tier.unit === 'per_1k_tokens' ? '每千 Token' : '计价单位未标明';
}
function priceAmount(amount: number | null, currency: PriceTier['currency']): string {
  if (amount === null) return '未列出';
  return currency === 'USD' ? `$${amount}` : `${amount}（币种未标明）`;
}
function PriceDetails({ tiers }: { tiers: readonly PriceTier[] }) {
  return h('div', { className: 'odc-price-details', 'aria-label': '官网价格详情' }, tiers.map((tier, index) =>
    h('section', { className: 'odc-price-tier', key: `${index}-${tier.label}` },
      h('strong', null, `${tier.label} · ${priceUnit(tier)}`),
      h('dl', null, ([['输入', tier.input], ['输出', tier.output], ['缓存读取', tier.cacheRead], ['缓存写入', tier.cacheWrite]] as const).map(([label, value]) =>
        h('div', { key: label }, h('dt', null, label), h('dd', null, priceAmount(value, tier.currency))))))));
}

export interface ModelRowProps {
  model: StatusModel;
  settings: ModelSettings;
  /** Whether an absent settings entry means enabled rather than the host catalog flag. */
  authoritative: boolean;
  writable: boolean;
  pending: boolean;
  disabledReason?: string | undefined;
  protocol?: ApiProtocol;
  price?: PriceCatalog['models'][number] | undefined;
  priceKnown?: boolean | undefined;
  onCommit: (next: ModelSettings | undefined) => Promise<boolean>;
}

export function ModelRow({ model, settings, authoritative, writable, pending, disabledReason, protocol = 'chat-completions', price, priceKnown = false, onCommit }: ModelRowProps) {
  const id = React.useId();
  const mounted = useMounted();
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [resetToken, setResetToken] = React.useState(0);
  const enabled = modelEnabled(model, settings, authoritative);
  const imageInput = modelImageInput(model, settings);
  const imageInputManual = settings.imageInput !== undefined;
  const samplingRestricted = hasRestrictedClaudeSampling(model.id, protocol);
  const samplingError = claudeSamplingError(model.id, protocol, settings.temperature, settings.topP);
  const outputError = claudeOutputError(model.id, protocol, settings.maxTokens);
  const effectiveWindow = effectiveContextWindow(model.contextWindow, settings.contextWindow, settings.contextTier);
  // The automatic reservation follows the adapter: a quarter of the working window, never
  // above the model's output capability. An unknown capability stays unknown.
  const outputCap = model.maxOutputTokens ?? (protocol === 'messages' ? 4096 : undefined);
  const reserveCandidate = outputCap === undefined ? undefined : Math.min(outputCap, Math.floor(effectiveWindow / 4));
  const autoReserve = reserveCandidate !== undefined && claudeOutputError(model.id, protocol, reserveCandidate) === undefined
    ? reserveCandidate
    : undefined;
  // A saved output limit that no longer fits the working window is reported before any
  // save; the value stays visible and clearable instead of being rewritten silently.
  const outputConflict = contextCapacityConflict(model.contextWindow, settings);
  const hasOverrides = Object.keys(settings).length > 0;
  const commit = async (next: ModelSettings | undefined): Promise<boolean> => {
    const saved = await onCommit(next);
    if (mounted.current) setError(saved ? undefined : '设置未保存，请重试。');
    return saved;
  };
  const saveField = async (key: NumericKey, value: number | undefined): Promise<boolean> => {
    const next: ModelSettings = { ...settings };
    if (value === undefined) delete next[key];
    else next[key] = value;
    if ((key === 'temperature' || key === 'topP') && value !== undefined) {
      const reason = claudeSamplingError(model.id, protocol, next.temperature, next.topP);
      if (reason !== undefined) { setError(reason); return false; }
    }
    if (key === 'maxTokens' && value !== undefined) {
      const reason = claudeOutputError(model.id, protocol, value);
      if (reason !== undefined) { setError(reason); return false; }
    }
    // Without an explicit override the adapter reserves at most a quarter of the
    // window; the catalog's maximum output capability is not the sent default.
    const reason = contextCapacityConflict(model.contextWindow, next);
    if (reason !== undefined) { setError(reason); return false; }
    setError(undefined);
    return commit(next);
  };
  const selectContextTier = async (tier: ContextWindowPresetId): Promise<boolean> => {
    const next: ModelSettings = { ...settings };
    // A tier replaces the legacy number in one write; the two fields are never both saved.
    delete next.contextWindow;
    if (tier === 'default') delete next.contextTier;
    else next.contextTier = tier;
    const reason = contextTierConflict(model.contextWindow, tier, next.maxTokens);
    if (reason !== undefined) { setError(reason); return false; }
    setError(undefined);
    return commit(next);
  };
  const reset = async (): Promise<void> => {
    setError(undefined);
    setResetToken(token => token + 1);
    await commit(undefined);
  };
  const restoreImageInput = async (): Promise<void> => {
    if (!imageInputManual) return;
    const next: ModelSettings = { ...settings };
    delete next.imageInput;
    setError(undefined);
    await commit(next);
  };
  const imageDisabledReason = pending ? ' · 正在保存' : !writable ? ' · 配置不可写' : '';
  const facts = [
    `参考容量 ${formatTokens(model.contextWindow)}`,
    `当前总窗口 ${formatTokens(effectiveWindow)}（含输出预留）`,
    `输出能力参考 ${formatTokens(model.maxOutputTokens)}`,
    `自动输出预留 ${formatTokens(autoReserve)}`,
    ...(model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
      ? []
      : [`思考档位 ${model.reasoningEfforts.join(' / ')}`]),
  ].join(' · ');
  return h('li', { className: 'odc-model-item' },
    h('div', { className: 'odc-model-head' },
      h('label', { className: 'odc-switch odc-model-switch' },
        h('input', {
          type: 'checkbox', checked: enabled, disabled: !writable || pending,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { void commit({ ...settings, enabled: event.target.checked }); },
        }),
        h('span', null, h('strong', null, model.name), h('code', null, model.id))),
      h('div', { className: 'odc-actions' },
        enabled ? null : h('span', { className: 'odc-chip' }, '已禁用'),
        h('button', { className: 'odc-button odc-button-small', type: 'button', disabled: !writable || pending || !hasOverrides, onClick: () => { void reset(); } }, '重置'))),
    price !== undefined ? h('p', { className: 'odc-price-summary' }, `官网参考 · ${price.tiers[0]!.label} · 输入 ${priceAmount(price.tiers[0]!.input, price.tiers[0]!.currency)} / 输出 ${priceAmount(price.tiers[0]!.output, price.tiers[0]!.currency)} · ${priceUnit(price.tiers[0]!)}${price.tiers.length > 1 ? ` · 共 ${price.tiers.length} 档` : ''}`)
      : priceKnown ? h('p', { className: 'odc-price-summary' }, '官网暂未列出此模型价格') : null,
    h('div', { className: 'odc-model-image' },
      h('label', { className: 'odc-image-toggle' },
        h('input', {
          type: 'checkbox', checked: imageInput, disabled: !writable || pending,
          'aria-label': `${model.name} 图片输入`, 'aria-describedby': `${id}-image-state`,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setError(undefined); void commit({ ...settings, imageInput: event.target.checked }); },
        }),
        h('span', null, '图片输入')),
      h('small', { className: 'odc-image-state', id: `${id}-image-state` }, imageInputSource(model, settings) + imageDisabledReason),
      imageInputManual ? h('button', {
        className: 'odc-image-reset', type: 'button',
        disabled: !writable || pending,
        'aria-label': `${model.name} 恢复图片输入自动`,
        title: '仅移除图片输入手动覆盖，保留其他模型设置',
        onClick: () => { void restoreImageInput(); },
      }, '恢复自动') : null),
    h('details', { className: 'odc-model-details' },
      h('summary', { 'aria-label': `${model.name} 参数设置${price === undefined ? '' : '与价格'}` }, `${price === undefined ? '参数设置' : '参数与价格'} · ${hasOverrides ? '已自定义' : '使用默认值'}`),
      h('p', { className: 'odc-model-meta' }, facts),
      model.id === 'claude-opus-5.5' && model.contextWindow === 1_000_000 ? h('p', { className: 'odc-hint' }, '上下文 1,000,000 为厂商参考，网关实际容量未验证；档位总窗口不会超过该参考容量。') : null,
      model.id === 'muse-wonder' && model.contextWindow === 1_048_576 ? h('p', { className: 'odc-hint' }, '上下文 1,048,576 为暂定参考，网关型号映射及实际容量未验证；档位总窗口不会超过该参考容量。') : null,
      samplingRestricted && model.id === 'claude-opus-4.8' ? h('p', { className: 'odc-hint' }, '厂商默认关闭思考，选择思考深度可启用自适应思考；网关实际行为可能不同。') : null,
      samplingRestricted && model.maxOutputTokens === undefined && settings.maxTokens === undefined ? h('p', { className: 'odc-hint' }, 'Messages 默认最大输出 4096；较高思考深度可能需要增大。') : null,
      price === undefined ? null : h(PriceDetails, { tiers: price.tiers }),
      h('p', { className: 'odc-hint' }, '数值离开输入框后保存，留空继承默认；上下文窗口为三档互斥选择。'),
      h('div', { className: 'odc-model-editor' },
        h(ContextWindowField, {
          id: `${id}-context`, reference: model.contextWindow, settings,
          disabled: !writable || pending,
          reason: pending ? '正在保存模型设置，完成后可继续选择档位。' : !writable ? (disabledReason ?? '配置不可写') : undefined,
          onSelect: tier => { void selectContextTier(tier); },
        }),
        NUMERIC_ORDER.map(key => h(OptionalNumberField, {
          key, id: `${id}-${key}`, field: key, value: settings[key],
          disabled: !writable || pending,
          restricted: samplingRestricted && (key === 'temperature' || key === 'topP'),
          invalid: (samplingError !== undefined && settings[key] !== undefined && (key === 'temperature' || key === 'topP')) || (key === 'maxTokens' && (outputError !== undefined || outputConflict !== undefined)),
          conflict: key === 'maxTokens' ? outputConflict : undefined,
          maxOutputLimit: samplingRestricted && key === 'maxTokens' ? CLAUDE_MESSAGES_MAX_OUTPUT : undefined, resetToken,
          onSave: value => saveField(key, value),
        })),
        h(EffortField, {
          id: `${id}-effort`, model, value: settings.reasoningEffort, disabled: !writable, pending, disabledReason,
          onSave: async value => {
            const next: ModelSettings = { ...settings };
            if (value === '') delete next.reasoningEffort;
            else next.reasoningEffort = value;
            setError(undefined);
            return onCommit(next);
          },
        }))),
    error !== undefined ? h('p', { className: 'odc-hint odc-field-error', role: 'alert' }, error) : null);
}

function ModelGroup({ title, group, models, settingsMap, authoritative, writable, pending, disabledReason, protocol, onCommit, prices }: {
  title: string;
  group: StatusModel['group'];
  models: readonly StatusModel[];
  settingsMap: ModelSettingsMap;
  authoritative: boolean;
  writable: boolean;
  pending: boolean;
  disabledReason: string;
  protocol: ApiProtocol;
  prices?: PriceCatalog | undefined;
  onCommit: (id: string, next: ModelSettings | undefined) => Promise<boolean>;
}) {
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState(false);
  const id = React.useId();
  const normalized = query.trim().toLocaleLowerCase();
  const groupModels = sortModelsByEnabled(models.filter(model => model.group === group), settingsMap, authoritative);
  const filtered = groupModels.filter(model => normalized === ''
    || `${model.name} ${model.id}`.toLocaleLowerCase().includes(normalized));
  const visible = normalized !== '' || expanded ? filtered : filtered.slice(0, 6);
  const enabledCount = groupModels.filter(model => modelEnabled(model, settingsMap[model.id], authoritative)).length;
  return h('section', { className: 'odc-card', 'aria-labelledby': `${id}-title` },
    h('div', { className: 'odc-card-head' },
      h('h3', { id: `${id}-title` }, title),
      h('span', { className: 'odc-model-count' }, `${enabledCount} / ${groupModels.length} 已启用`)),
    h('label', { className: 'odc-label', htmlFor: `${id}-search` }, `搜索${title}`),
    h('input', {
      id: `${id}-search`, className: 'odc-input', type: 'search', value: query,
      placeholder: '搜索全部模型的名称或 ID', onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
    }),
    filtered.length === 0 ? h('p', { className: 'odc-hint', role: 'status' }, '没有匹配的模型。') :
      h('ul', { id: `${id}-list`, className: 'odc-model-list' }, visible.map(model =>
        h(ModelRow, {
          key: model.id, model, settings: modelSettingsEntry(settingsMap, model.id), authoritative,
          writable, pending, disabledReason, protocol, price: prices?.models.find(entry => entry.id === model.id), priceKnown: prices !== undefined && (prices.state !== 'error' || prices.stale),
          onCommit: next => onCommit(model.id, next),
        }))),
    normalized === '' && filtered.length > 6 ? h('button', {
      type: 'button', className: 'odc-button', style: { marginTop: 12 },
      'aria-expanded': expanded, 'aria-controls': `${id}-list`,
      onClick: () => setExpanded(value => !value),
    }, expanded ? '收起模型列表' : `显示全部 ${filtered.length} 个模型`) : null);
}

export interface ModelsProps {
  status: Status | undefined;
  formSnapshot: FormSnapshot;
  setFormField: (field: string, value: unknown, baseValue?: unknown) => Promise<boolean>;
  pendingField: readonly string[];
  onRefreshModels: () => void;
  refreshingModels: boolean;
  notice: Notice | null;
  prices?: PriceCatalog | undefined;
  refreshingPrices?: boolean | undefined;
  onRefreshPrices?: (() => void) | undefined;
}

export function Models({ status, formSnapshot, setFormField, pendingField, onRefreshModels, refreshingModels, notice, prices, refreshingPrices = false, onRefreshPrices }: ModelsProps) {
  // A ready form snapshot is authoritative; before it is ready, trust the Host's credential-free
  // mirror instead of assuming every model is enabled.
  const formReady = formSnapshot.status === 'ready' && formSnapshot.value !== undefined;
  const settingsMap = formReady ? (formSnapshot.value?.modelSettings ?? {}) : (status?.config.modelSettings ?? {});
  const authoritative = formReady || status?.config.modelSettings !== undefined;
  const writable = formSnapshot.status === 'ready' && formSnapshot.value !== undefined && formSnapshot.writable;
  const disabledReason = formSnapshot.status === 'loading' ? '正在载入配置' : formSnapshot.status === 'unavailable' ? '配置暂不可用' : !formSnapshot.writable ? '当前设置为只读' : '配置不可写';
  const pending = pendingField.includes('modelSettings');
  const latestSettings = React.useRef<ModelSettingsMap>(settingsMap);
  React.useEffect(() => { latestSettings.current = settingsMap; }, [settingsMap]);
  const saving = React.useRef(false);
  const commit = async (id: string, next: ModelSettings | undefined): Promise<boolean> => {
    if (!writable || pending || saving.current) return false;
    saving.current = true;
    try {
      return await setFormField('modelSettings', writeModelSettings(latestSettings.current, id, next), latestSettings.current);
    } finally {
      saving.current = false;
    }
  };
  const source = status?.modelsSource === 'openai' ? '当前网关' : status?.modelsSource === 'builtin' ? '内置目录' : '尚未确认';
  const updated = status?.modelsUpdatedAt === undefined ? '' : ` · 更新于 ${formatTime(status.modelsUpdatedAt)}`;
  const protocol = formSnapshot.value?.apiProtocol ?? status?.config.apiProtocol ?? 'chat-completions';
  const models = (status?.models ?? []).map(model => {
    const reasoningEfforts = modelReasoningEfforts(model, protocol);
    return { ...model, ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }) };
  });
  return h(React.Fragment, null,
    h('div', { className: 'odc-card-head' },
      h('div', null,
        h('h3', null, '可用模型'),
        h('p', { className: 'odc-hint' }, '按分组搜索模型，设置启用状态与默认参数。上下文为参考预算；刷新后会采用网关报告的较小窗口，实际限制可能不同，可在模型设置中选择总窗口档位。')),
      h('div', { className: 'odc-actions' },
        h('span', { className: 'odc-label', role: 'status' }, `来源：${source}${updated}`),
        h('button', {
          className: 'odc-button', type: 'button',
          disabled: refreshingModels || status === undefined || status.apiKeyConfigured === false,
          onClick: onRefreshModels,
          title: '从当前配置的网关读取可用模型目录',
        }, refreshingModels ? '正在刷新模型…' : '刷新模型目录'))),
    status?.apiKeyConfigured === false ? h('p', { className: 'odc-hint' }, '刷新模型需要可用的 API Key；保存 Key 后重试。') : null,
    status?.modelsError !== undefined ? h('p', { className: 'odc-notice', 'data-kind': 'error', role: 'alert' }, status.modelsError) : null,
    h(NoticeView, { notice }),
    h('section', { className: 'odc-card', 'aria-label': '官网模型价格' },
      h('div', { className: 'odc-pricing-head' },
        h('h3', null, '官网参考价格'),
        h('button', { className: 'odc-button', type: 'button', disabled: refreshingPrices || onRefreshPrices === undefined, onClick: onRefreshPrices }, refreshingPrices ? '正在更新价格…' : '更新价格')),
      h('p', { className: 'odc-hint', role: 'status' }, refreshingPrices ? '正在读取官网价格…' : prices === undefined ? '等待读取官网价格。' : prices.state === 'error' ? prices.stale ? `读取失败，显示上次价格（${formatTime(prices.fetchedAt)}）。` : '官网价格暂不可用，请稍后重试。' : `已更新：${formatTime(prices.fetchedAt)}${prices.state === 'partial' ? '；部分价格未能读取' : ''}`),
      h('p', { className: 'odc-hint' }, '官网分档价格仅供参考；实际费用以账户账单为准。', ' ', h('a', { className: 'odc-link', href: PRICE_SITE, target: '_blank', rel: 'noreferrer noopener' }, '查看官网价格'))),
    models.length === 0 ? h('p', { className: 'odc-hint', role: 'status' }, '暂无可用模型；可刷新模型列表后重试。') :
      h('div', { className: 'odc-model-groups' },
        h(ModelGroup, { title: '套餐赠送模型', group: 'plan', models, settingsMap, authoritative, writable, pending, disabledReason, protocol, onCommit: commit, prices }),
        h(ModelGroup, { title: '付费模型', group: 'paid', models, settingsMap, authoritative, writable, pending, disabledReason, protocol, onCommit: commit, prices })));
}

export interface AdvancedProps {
  status: Status | undefined;
  formSnapshot: FormSnapshot;
  setFormField: (field: string, value: unknown) => Promise<boolean>;
  clearFormField: (field: string) => Promise<boolean>;
  pendingField: readonly string[];
}

function NumberField({ id, label, hint, value, min, max, integer, disabled, onCommit }: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  integer: boolean;
  disabled: boolean;
  onCommit: (value: number) => Promise<boolean>;
}) {
  const mounted = useMounted();
  const [draft, setDraft] = React.useState(String(value));
  const [error, setError] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    setDraft(String(value));
    setError(undefined);
  }, [value]);
  const commit = async (): Promise<void> => {
    const result = parseNumberInput(draft, { label, min, max, ...(integer ? { integer: true } : {}) });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.value === undefined || result.value === value) {
      setDraft(String(value));
      setError(undefined);
      return;
    }
    const saved = await onCommit(result.value);
    if (!mounted.current) return;
    if (saved) setError(undefined);
    else setError('设置未保存，请重试。');
  };
  return h('div', { className: 'odc-field' },
    h('label', { htmlFor: id }, label),
    h('input', {
      id, className: 'odc-input', type: 'number', inputMode: 'numeric', min, max, step: integer ? 1 : 0.1,
      value: draft, disabled, 'aria-invalid': error !== undefined, 'aria-describedby': `${id}-hint`,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      onBlur: () => { void commit(); },
    }),
    h('small', {
      className: error === undefined ? 'odc-hint' : 'odc-hint odc-field-error',
      id: `${id}-hint`,
      ...(error === undefined ? {} : { role: 'alert' as const }),
    }, error ?? hint));
}

export function Advanced({ status, formSnapshot, setFormField, clearFormField, pendingField }: AdvancedProps) {
  const [apiKeyEnv, setApiKeyEnv] = React.useState(status?.config.apiKeyEnv ?? '');
  const [keyNotice, setKeyNotice] = React.useState<Notice | null>(null);
  const mounted = useMounted();
  React.useEffect(() => {
    setApiKeyEnv(formSnapshot.value?.apiKeyEnv ?? status?.config.apiKeyEnv ?? '');
  }, [formSnapshot.value?.apiKeyEnv, status?.config.apiKeyEnv]);
  const writable = formSnapshot.status === 'ready' && formSnapshot.value !== undefined && formSnapshot.writable;
  const configuredProtocol = formSnapshot.value?.apiProtocol ?? status?.config.apiProtocol;
  const protocol = configuredProtocol !== undefined && API_PROTOCOL_OPTIONS.some(option => option.id === configuredProtocol)
    ? configuredProtocol
    : 'chat-completions';
  const baseURL = formSnapshot.value?.baseURL ?? status?.config.baseURL ?? '';
  const requestTimeout = formSnapshot.value?.requestTimeoutMs ?? status?.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const streamIdleTimeout = formSnapshot.value?.streamIdleTimeoutMs ?? status?.config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const refreshSeconds = formSnapshot.value?.quotaRefreshSeconds ?? status?.config.quotaRefreshSeconds ?? DEFAULT_QUOTA_REFRESH_SECONDS;
  const imageBudget = formSnapshot.value?.maxRequestImageBytes ?? status?.config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES;
  const turnContinuations = formSnapshot.value?.turnReviewMaxContinuations ?? status?.config.turnReviewMaxContinuations ?? DEFAULT_TURN_REVIEW_MAX_CONTINUATIONS;
  const turnNoProgress = formSnapshot.value?.turnReviewNoProgressLimit ?? status?.config.turnReviewNoProgressLimit ?? DEFAULT_TURN_REVIEW_NO_PROGRESS_LIMIT;
  const guard = formSnapshot.value?.emptyTurnGuard ?? status?.config.emptyTurnGuard ?? true;
  const review = formSnapshot.value?.turnCompletionReview ?? status?.config.turnCompletionReview ?? false;
  const selected = API_PROTOCOL_OPTIONS.find(option => option.id === protocol);
  const saveKeyRef = async () => {
    const value = apiKeyEnv.trim();
    if (value === '') {
      // An empty field means "name nothing": drop the saved name instead of storing an empty one.
      setKeyNotice(null);
      try {
        const cleared = await clearFormField('apiKeyEnv');
        if (mounted.current) {
          setKeyNotice(cleared
            ? { kind: 'status', text: `已清除引用名；请求沿用默认引用 ${DEFAULT_KEY_REF}。` }
            : { kind: 'error', text: '引用名未清除，请重试。' });
        }
      } catch {
        if (mounted.current) setKeyNotice({ kind: 'error', text: GENERIC_ERROR });
      }
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) {
      setKeyNotice({ kind: 'error', text: '引用名需为 1–128 位字母、数字或下划线，且不能以数字开头。' });
      return;
    }
    setKeyNotice(null);
    try {
      const accepted = await setFormField('apiKeyEnv', value);
      if (mounted.current) setKeyNotice(accepted ? { kind: 'status', text: '配置已保存。' } : { kind: 'error', text: '配置未保存，请刷新后重试。' });
    } catch {
      if (mounted.current) setKeyNotice({ kind: 'error', text: GENERIC_ERROR });
    }
  };
  return h(React.Fragment, null,
    h('section', { className: 'odc-card' },
      h('h3', null, '异常结束监控'),
      h('p', { className: 'odc-hint' }, '检测 DeepSeek V4.1 Flash 工具对话中的空回答、协议标记残留或说明下一步后未执行的提前结束。'),
      h('div', { style: { marginTop: 14 } }, h(Switch, {
        checked: guard,
        disabled: !writable || pendingField.includes('emptyTurnGuard'),
        label: '启用异常结束监控',
        hint: `已累计 ${status?.guardedTurns ?? '—'} 次空响应或残留拦截。协议空响应恢复持续到成功或取消。`,
        onChange: checked => { void setFormField('emptyTurnGuard', checked); },
      })),
      h('div', { style: { marginTop: 14 } }, h(Switch, {
        checked: review,
        disabled: !writable || !guard || pendingField.includes('turnCompletionReview'),
        label: '启用结束回合核验',
        hint: !guard
          ? '需要先开启异常结束监控，结束回合核验才会工作。'
          : '回复结束后要求模型调用收尾工具报告完成、等待用户、等待后台工作或阻塞状态；关闭时回复结束即结束回合。收尾核验有界，可能额外消耗额度。',
        onChange: checked => { void setFormField('turnCompletionReview', checked); },
      })),
      h(TurnMonitorView, { turnMonitor: status?.turnMonitor, guardedTurns: status?.guardedTurns, enabled: guard, reviewEnabled: guard && review }),
      h(NumberField, {
        id: 'odc-turn-continuations', label: '收尾核验最大续办次数', hint: `核验未完成时最多自动续办的次数，${MIN_TURN_REVIEW_MAX_CONTINUATIONS}–${MAX_TURN_REVIEW_MAX_CONTINUATIONS}；默认 ${DEFAULT_TURN_REVIEW_MAX_CONTINUATIONS} 次。`,
        value: turnContinuations, min: MIN_TURN_REVIEW_MAX_CONTINUATIONS, max: MAX_TURN_REVIEW_MAX_CONTINUATIONS, integer: true,
        disabled: !writable || !guard || !review || pendingField.includes('turnReviewMaxContinuations'),
        onCommit: value => setFormField('turnReviewMaxContinuations', value),
      }),
      h(NumberField, {
        id: 'odc-turn-no-progress', label: '无进展停止上限', hint: `连续无进展的核验达到该次数即停止续办，${MIN_TURN_REVIEW_NO_PROGRESS_LIMIT}–${MAX_TURN_REVIEW_NO_PROGRESS_LIMIT}；默认 ${DEFAULT_TURN_REVIEW_NO_PROGRESS_LIMIT} 次。`,
        value: turnNoProgress, min: MIN_TURN_REVIEW_NO_PROGRESS_LIMIT, max: MAX_TURN_REVIEW_NO_PROGRESS_LIMIT, integer: true,
        disabled: !writable || !guard || !review || pendingField.includes('turnReviewNoProgressLimit'),
        onCommit: value => setFormField('turnReviewNoProgressLimit', value),
      })),
    h('section', { className: 'odc-card' },
      h('h3', null, '推理协议'),
      h('p', { className: 'odc-hint' }, '选择当前网关支持的推理协议。模型目录始终从该网关读取。'),
      h('div', { className: 'odc-field' },
        h('label', { htmlFor: 'odc-api-protocol' }, 'API 协议'),
        h('select', {
          id: 'odc-api-protocol', className: 'odc-input', value: protocol,
          disabled: !writable || pendingField.includes('apiProtocol'),
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { void setFormField('apiProtocol', event.target.value); },
        }, API_PROTOCOL_OPTIONS.map(option => h('option', { key: option.id, value: option.id }, option.name))),
        h('small', { className: 'odc-hint' }, selected?.description ?? '选择与网关兼容的推理协议。')),
      h('div', { className: 'odc-readonly' },
        h('div', null,
          h('span', { className: 'odc-label' }, '当前网关地址（只读）'),
          h('code', { className: 'odc-code' }, baseURL === '' ? '—' : baseURL)),
        h('div', null,
          h('span', { className: 'odc-label' }, '当前推理路径（只读）'),
          h('code', { className: 'odc-code' }, protocolEndpoint(baseURL, protocol))),
        h('small', { className: 'odc-hint' }, '地址由插件配置提供，无需在此填写；切换协议只改变请求路径与报文格式。'))),
    h('section', { className: 'odc-card' },
      h('h3', null, '凭据与网关'),
      h('p', { className: 'odc-hint' }, `这里只保存凭据引用名称，不填写 Key 本身；网关地址由插件配置托管。引用名留空时请求沿用 ${DEFAULT_KEY_REF}，保存空值即清除已保存的引用名。`),
      h('div', { className: 'odc-field' },
        h('label', { htmlFor: 'odc-api-key-env' }, 'API Key 环境变量 / 凭据引用名'),
        h('input', {
          id: 'odc-api-key-env', className: 'odc-input', type: 'text', value: apiKeyEnv, placeholder: DEFAULT_KEY_REF,
          disabled: !writable || pendingField.includes('apiKeyEnv'),
          autoCapitalize: 'off', spellCheck: false,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setApiKeyEnv(event.target.value),
        }),
        h('small', { className: 'odc-hint' }, '引用名对应的凭据仍优先于本插件保存的 Key；DSH 模型页只报告这里设置的引用名，不显示本插件保存的 Key 与设备登录。')),
      h('div', { className: 'odc-actions', style: { marginTop: 10 } },
        h('button', { className: 'odc-button', type: 'button', disabled: !writable || pendingField.includes('apiKeyEnv'), onClick: () => { void saveKeyRef(); } }, '保存引用名')),
      h(NoticeView, { notice: keyNotice })),
    h('section', { className: 'odc-card' },
      h('h3', null, '图片请求预算'),
      h('p', { className: 'odc-hint' }, '历史图片超出预算时，由宿主将最旧图片替换为占位符并重试；原附件保留。摘要请求也使用此预算。'),
      h(NumberField, {
        id: 'odc-image-budget', label: '单次请求图片预算（MiB）', hint: '1–100 MiB；网关限制较低时可调小。',
        value: imageBudget / (1024 * 1024), min: MIN_REQUEST_IMAGE_BYTES / (1024 * 1024), max: MAX_REQUEST_IMAGE_BYTES / (1024 * 1024), integer: false,
        disabled: !writable || pendingField.includes('maxRequestImageBytes'),
        onCommit: value => setFormField('maxRequestImageBytes', Math.round(value * 1024 * 1024)),
      })),
    h('section', { className: 'odc-card' },
      h('h3', null, '请求时限与自动刷新'),
      h('p', { className: 'odc-hint' }, '输入有效范围内的整数，离开输入框后保存。'),
      h(NumberField, {
        id: 'odc-request-timeout', label: '请求总超时（毫秒）', hint: '从发出请求到响应结束的上限，1000–3600000。',
        value: requestTimeout, min: MIN_REQUEST_TIMEOUT_MS, max: MAX_REQUEST_TIMEOUT_MS, integer: true,
        disabled: !writable || pendingField.includes('requestTimeoutMs'),
        onCommit: value => setFormField('requestTimeoutMs', value),
      }),
      h(NumberField, {
        id: 'odc-stream-idle-timeout', label: '流式空闲超时（毫秒）', hint: '流式响应无新数据的最长等待，1000–1800000。',
        value: streamIdleTimeout, min: MIN_STREAM_IDLE_TIMEOUT_MS, max: MAX_STREAM_IDLE_TIMEOUT_MS, integer: true,
        disabled: !writable || pendingField.includes('streamIdleTimeoutMs'),
        onCommit: value => setFormField('streamIdleTimeoutMs', value),
      }),
      h(NumberField, {
        id: 'odc-quota-refresh', label: '额度自动刷新间隔（秒）', hint: `5–3600；默认 ${DEFAULT_QUOTA_REFRESH_SECONDS} 秒，页面关闭后停止。`,
        value: refreshSeconds, min: MIN_QUOTA_REFRESH_SECONDS, max: MAX_QUOTA_REFRESH_SECONDS, integer: true,
        disabled: !writable || pendingField.includes('quotaRefreshSeconds'),
        onCommit: value => setFormField('quotaRefreshSeconds', value),
      })));
}

function Switch({ checked, disabled, label, ariaLabel, hint, onChange }: {
  checked: boolean; disabled: boolean; label: string; ariaLabel?: string; hint: string; onChange: (checked: boolean) => void;
}) {
  const hintId = React.useId();
  return h('label', { className: 'odc-switch' },
    h('input', { type: 'checkbox', checked, disabled, 'aria-label': ariaLabel, 'aria-describedby': hintId, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked) }),
    h('span', null, h('span', { className: 'odc-switch-text' }, label), h('small', { className: 'odc-hint', id: hintId }, hint)));
}

function loginInFlight(state: LoginState['state']): boolean {
  return state === 'launching' || state === 'waiting' || state === 'verifying';
}

/** Open-in-window labels: the Host launches a temporary Chrome, the link stays as fallback. */
const ACTIVATION_OPEN_LABELS: Record<ActivationOpenState['code'], string> = {
  opened: '已在新窗口打开官方授权页；请在该窗口确认设备码。',
  'no-link': '授权码已失效，请重新申请。',
  'invalid-url': '授权链接无效，请取消并重新开始登录。',
  unavailable: '无法启动临时浏览器，请确认已安装 Chrome；也可复制链接手动打开。',
  failed: '临时浏览器窗口未能打开，请复制链接手动打开。',
};

/** Approval is an ordinary official link; the Host may also show it in a temporary window. */
export function LoginApproval({ login, onOpen, opening, notice }: {
  login: LoginState | undefined;
  onOpen?: () => void;
  opening?: boolean;
  notice?: { kind: 'status' | 'error'; text: string } | null;
}) {
  const mounted = useMounted();
  const copyVersion = React.useRef(0);
  const [copyState, setCopyState] = React.useState<'idle' | 'copying' | 'copied' | 'manual'>('idle');
  React.useEffect(() => {
    copyVersion.current += 1;
    setCopyState('idle');
  }, [login?.jobId, login?.state, login?.activationUrl]);
  if (login?.state !== 'waiting' || login.userCode === undefined || login.expiresAt === undefined) return null;
  const url = validateActivationUrl(login.activationUrl, login.userCode);
  if (url === null) return null;
  const copyLink = async () => {
    const version = ++copyVersion.current;
    setCopyState('copying');
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(url);
      if (mounted.current && version === copyVersion.current) setCopyState('copied');
    } catch {
      if (mounted.current && version === copyVersion.current) setCopyState('manual');
    }
  };
  return h('div', { className: 'odc-readonly', 'aria-label': '设备授权' },
    h('span', { className: 'odc-label' }, '核对授权码'),
    h('code', { className: 'odc-metric-value', 'aria-label': '设备授权码' }, login.userCode),
    h('div', { className: 'odc-actions' },
      h('button', {
        className: 'odc-button odc-button-primary', type: 'button', disabled: opening === true || onOpen === undefined,
        onClick: () => { onOpen?.(); },
      }, opening === true ? '正在打开…' : '在新窗口打开授权页'),
      h('button', { className: 'odc-button', type: 'button', disabled: copyState === 'copying', onClick: () => { void copyLink(); } }, copyState === 'copying' ? '正在复制…' : '复制授权链接'),
      h('a', { className: 'odc-link', href: url, target: '_blank', rel: 'noreferrer noopener' }, '官方授权页')),
    copyState === 'copied' ? h('p', { className: 'odc-hint', role: 'status' }, '链接已复制，可在常用浏览器中粘贴打开。') : null,
    copyState === 'manual' ? h('label', { className: 'odc-field' },
      h('span', null, '请选择并复制授权链接'),
      h('input', { className: 'odc-input', type: 'text', readOnly: true, value: url, onFocus: (event: React.FocusEvent<HTMLInputElement>) => event.target.select() })) : null,
    notice ? h(NoticeView, { notice }) : null,
    h('p', { className: 'odc-hint' }, `授权码有效至 ${formatTime(login.expiresAt)}。在授权窗口确认后，返回此页查看结果。`),
    h('p', { className: 'odc-hint' }, '临时 Chrome 窗口需要单独登录；也可复制链接到已登录的常用浏览器。仅确认你本人发起的授权。'));
}

function Connection({ status, formSnapshot, setFormField, pendingField, caller, onLoginStatus, onStatus }: {
  status: Status | undefined;
  formSnapshot: FormSnapshot;
  setFormField: (field: string, value: unknown) => Promise<boolean>;
  pendingField: readonly string[];
  caller: RpcCaller;
  onLoginStatus: (login: LoginState) => void;
  onStatus: (status: Status) => void;
}) {
  const mounted = useMounted();
  const actionVersion = React.useRef(0);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [apiKey, setApiKey] = React.useState('');
  const [keyBusy, setKeyBusy] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const [activationNotice, setActivationNotice] = React.useState<Notice | null>(null);
  /** Which login job the current activation notice belongs to. */
  const activationJob = React.useRef<string | null>(null);
  /** The single activation request allowed to own the busy label right now. */
  const activationToken = React.useRef(0);
  // Only a login started here may auto-open; polling must never reopen a failed window.
  const autoOpenPending = React.useRef(false);
  React.useEffect(() => () => { actionVersion.current += 1; }, []);
  const login = status?.login;
  React.useEffect(() => {
    // A new approval cycle starts with its own feedback: never carry the last one over.
    const job = login?.jobId ?? null;
    if (activationJob.current === job) return;
    activationJob.current = job;
    activationToken.current += 1;
    setActivationNotice(null);
    setOpening(false);
  }, [login?.jobId]);
  const state = login?.state ?? 'idle';
  const inFlight = loginInFlight(state);

  const startLogin = async () => {
    if (status === undefined || busy || keyBusy) return;
    const version = ++actionVersion.current;
    setBusy(true);
    autoOpenPending.current = true;
    setNotice({ kind: 'status', text: '正在申请设备授权…' });
    try {
      const next = await caller<LoginState>('startLogin', { expectedRevision: status.revision });
      if (!mounted.current || version !== actionVersion.current) return;
      onLoginStatus(next);
      setNotice(null);
      setActivationNotice(null);
    } catch {
      autoOpenPending.current = false;
      if (mounted.current && version === actionVersion.current) setNotice({ kind: 'error', text: '登录请求暂未确认，请重试。' });
    } finally {
      if (mounted.current && version === actionVersion.current) setBusy(false);
    }
  };
  const cancelLogin = async () => {
    if (login?.jobId == null || busy || keyBusy) return;
    const version = ++actionVersion.current;
    setBusy(true);
    try {
      const next = await caller<LoginState>('cancelLogin', { jobId: login.jobId });
      if (!mounted.current || version !== actionVersion.current) return;
      autoOpenPending.current = false;
      onLoginStatus(next);
      setNotice({ kind: 'status', text: next.message ?? LOGIN_LABELS[next.state] });
    } catch {
      if (mounted.current && version === actionVersion.current) setNotice({ kind: 'error', text: '取消未完成，请稍后重试。' });
    } finally {
      if (mounted.current && version === actionVersion.current) setBusy(false);
    }
  };
  const saveKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (status === undefined || busy || inFlight || keyBusy || apiKey.trim() === '') {
      if (apiKey.trim() === '') setNotice({ kind: 'error', text: '请输入 API Key 后再保存。' });
      return;
    }
    const version = ++actionVersion.current;
    setKeyBusy(true);
    setNotice(null);
    try {
      const next = await caller<Status>('saveApiKey', { value: apiKey, expectedRevision: status.revision });
      if (!mounted.current || version !== actionVersion.current) return;
      setApiKey('');
      onStatus(next);
      setNotice({ kind: 'status', text: next.apiKeySource === 'reference'
        ? `API Key 已保存；当前仍优先使用环境或凭据引用 ${next.config.apiKeyEnv || DEFAULT_KEY_REF}。`
        : next.apiKeySource === 'stored' ? 'API Key 已保存并用于当前网关。' : 'API Key 已保存。' });
    } catch {
      if (!mounted.current || version !== actionVersion.current) return;
      setApiKey('');
      setNotice({ kind: 'error', text: '保存结果暂未确认，请稍后重试。' });
    } finally {
      if (mounted.current && version === actionVersion.current) setKeyBusy(false);
    }
  };

  const openActivation = async () => {
    if (status === undefined || busy || keyBusy || opening || login?.state !== 'waiting') return;
    // This action owns `opening` only. Sharing the login action version would let a
    // concurrent cancel swallow the reset and strand the button in its busy label.
    // The outcome is tagged with its job: a result from a login that already ended must
    // not appear as feedback for the next one.
    const job = login.jobId;
    // A request token owns both the busy label and the notice. They differ from the login
    // action version: a page settling late must not clear a newer request's busy state.
    const token = ++activationToken.current;
    activationJob.current = job;
    setOpening(true);
    setActivationNotice(null);
    const current = () => mounted.current && activationToken.current === token && activationJob.current === job;
    try {
      const result = await caller<ActivationOpenState>('openActivationPage');
      if (current()) setActivationNotice({ kind: result.opened ? 'status' : 'error', text: ACTIVATION_OPEN_LABELS[result.code] });
    } catch {
      if (current()) setActivationNotice({ kind: 'error', text: ACTIVATION_OPEN_LABELS.failed });
    } finally {
      if (mounted.current && activationToken.current === token) setOpening(false);
    }
  };
  React.useEffect(() => {
    if (!autoOpenPending.current || busy || keyBusy || opening || status === undefined) return;
    if (state === 'waiting') {
      autoOpenPending.current = false;
      void openActivation();
    } else if (state === 'error' || state === 'cancelled' || state === 'success') {
      autoOpenPending.current = false;
    }
  }, [state, login?.jobId, busy, keyBusy, opening, status]);
  const desktopChecked = formSnapshot.value?.useDesktopCredential ?? status?.config.useDesktopCredential ?? true;
  const keySource = status?.apiKeySource === 'reference' ? `环境或凭据引用（${status.config.apiKeyEnv || DEFAULT_KEY_REF}）`
    : status?.apiKeySource === 'stored' ? '已保存的 API Key'
    : status?.apiKeySource === 'device' ? '设备授权'
    : status?.apiKeyConfigured ? '尚未确认' : '未配置';
  return h(React.Fragment, null,
    h('section', { className: 'odc-card' },
      h('h3', null, '连接方式'),
      h('p', { className: 'odc-hint' }, '优先复用 OpenDesign 桌面端已有登录态，无需复制桌面凭据。关闭后使用独立登录或环境凭据。'),
      h('div', { style: { marginTop: 14 } },
        h(Switch, {
          checked: desktopChecked,
          disabled: formSnapshot.status !== 'ready' || formSnapshot.value === undefined || !formSnapshot.writable || pendingField.includes('useDesktopCredential'),
          label: '优先使用桌面登录态',
          hint: '优先显示桌面端登录账号的额度。',
          onChange: checked => { void setFormField('useDesktopCredential', checked); },
        })),
      h('p', { className: 'odc-meta' }, `当前会话来源：${status?.sessionSource === undefined ? '—' : { desktop: '桌面登录态', login: '独立登录', environment: '环境凭据' }[status.sessionSource]}`)),
    h('section', { className: 'odc-card' },
      h('h3', null, '设备授权登录'),
      h('p', { className: 'odc-hint' }, '申请授权码后，由插件启动临时窗口显示官方授权页，也可复制链接到你自己的常用浏览器。确认后自动保存设备令牌，用于查询额度及官方网关推理。'),
      h('div', { className: 'odc-actions', style: { marginTop: 14 } },
        h('button', { className: 'odc-button odc-button-primary', type: 'button', disabled: status === undefined || busy || keyBusy || inFlight, onClick: () => { void startLogin(); } }, '开始设备授权'),
        inFlight ? h('button', { className: 'odc-button', type: 'button', disabled: busy || keyBusy || login?.jobId == null, onClick: () => { void cancelLogin(); } }, '取消登录') : null,
        h('a', { className: 'odc-link', href: OFFICIAL_SITE, target: '_blank', rel: 'noreferrer noopener' }, '打开 CoRouter 官网')),
      h(LoginApproval, { login, onOpen: () => { void openActivation(); }, opening, notice: activationNotice }),
      h('p', { className: 'odc-meta', role: state === 'error' ? 'alert' : 'status' }, login?.message ?? LOGIN_LABELS[state]),
      h(NoticeView, { notice })),
    h('section', { className: 'odc-card' },
      h('h3', null, 'API Key'),
      h('p', { className: 'odc-meta', 'aria-label': '当前生效的推理凭据来源' }, `当前生效来源：${keySource}`),
      h('p', { className: 'odc-hint' }, status?.apiKeyConfigured === true ? '当前网关已配置推理凭据。可在此保存插件专用的 API Key。' : '当前网关尚无推理凭据。可完成设备授权以使用官方网关，或为当前网关单独保存 API Key。'),
      h('form', { onSubmit: (event: React.FormEvent) => { void saveKey(event); } },
        h('div', { className: 'odc-field' },
          h('label', { htmlFor: 'odc-api-key' }, '新的 API Key'),
          h('input', {
            id: 'odc-api-key', className: 'odc-input', type: 'password', value: apiKey,
            autoComplete: 'new-password', autoCapitalize: 'off', spellCheck: false,
            disabled: status === undefined || busy || inFlight || keyBusy, placeholder: '仅用于本次保存，不会回填',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value),
          }),
          h('small', { className: 'odc-hint' }, 'Key 保存后清空，不写入网页存储。额度属于当前登录账号，未验证与此 Key 的工作空间一致。')),
        h('div', { className: 'odc-actions', style: { marginTop: 12 } },
          h('button', { className: 'odc-button', type: 'submit', disabled: status === undefined || busy || inFlight || keyBusy || apiKey.trim() === '' }, keyBusy ? '保存中…' : '保存 API Key')))));
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
  const [refreshingModels, setRefreshingModels] = React.useState(false);
  const [prices, setPrices] = React.useState<PriceCatalog>();
  const [refreshingPrices, setRefreshingPrices] = React.useState(false);
  const pricesBusy = React.useRef(false);
  const pricesRequested = React.useRef(false);
  const [modelsNotice, setModelsNotice] = React.useState<Notice | null>(null);
  const writes = React.useMemo(() => configWritesFor(form), [form]);
  const writeState = React.useSyncExternalStore(
    React.useCallback(listener => writes.subscribe(listener), [writes]),
    React.useCallback(() => writes.getSnapshot(), [writes]),
    React.useCallback(() => writes.getSnapshot(), [writes]),
  );
  const pendingField = writeState.pendingFields;
  const [formNotice, setFormNotice] = React.useState<Notice | null>(null);
  const [scheduleTick, setScheduleTick] = React.useState(0);
  const statusVersion = React.useRef(0);
  const quotaVersion = React.useRef(0);
  const loginVersion = React.useRef(0);
  const modelsVersion = React.useRef(0);
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = React.useId();
  const acceptedFormSnapshot = useFormSnapshot(form);
  const batchWriteFailed = React.useRef(false);
  const pageBatchActive = React.useRef(false);
  const formSnapshot: FormSnapshot = React.useMemo(() => ({
    ...acceptedFormSnapshot,
    value: acceptedFormSnapshot.value === undefined ? undefined : { ...acceptedFormSnapshot.value, ...writeState.pendingValues },
  }), [acceptedFormSnapshot, writeState]);
  React.useEffect(() => {
    if (pendingField.length !== 0 || !pageBatchActive.current) return;
    pageBatchActive.current = false;
    setFormNotice(batchWriteFailed.current
      ? { kind: 'error', text: '设置未保存，已恢复原值，请重试。' }
      : { kind: 'status', text: '设置已保存。' });
  }, [pendingField]);

  const acceptLoginStatus = React.useCallback((login: LoginState) => {
    // Action responses supersede reads started before that action completed.
    statusVersion.current += 1;
    loginVersion.current += 1;
    setStatus(previous => previous === undefined ? previous : { ...previous, login });
    setError(undefined);
  }, []);
  const acceptStatus = React.useCallback((next: Status) => {
    statusVersion.current += 1;
    loginVersion.current += 1;
    setStatus(next);
    setModelsNotice(null);
    setError(undefined);
  }, []);

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
  const forcedRefreshPending = React.useRef(false);
  const refresh = React.useCallback(async (force = false): Promise<void> => {
    if (refreshBusy.current) {
      if (force) forcedRefreshPending.current = true;
      return;
    }
    refreshBusy.current = true;
    const version = ++quotaVersion.current;
    setRefreshing(true);
    setError(undefined);
    try {
      const quota = await caller<QuotaSnapshot>(force ? 'refreshQuotaNow' : 'refreshQuota');
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
        if (forcedRefreshPending.current) {
          forcedRefreshPending.current = false;
          void refresh(true);
        }
      }
    }
  }, [caller, loadStatus, mounted]);
  React.useEffect(() => {
    void loadStatus();
    void refresh();
    return () => {
      statusVersion.current += 1;
      quotaVersion.current += 1;
      loginVersion.current += 1;
      modelsVersion.current += 1;
      refreshBusy.current = false;
      forcedRefreshPending.current = false;
    };
  }, [loadStatus, refresh]);

  const setFormField = React.useCallback(async (field: string, value: unknown, baseValue?: unknown): Promise<boolean> => {
    const snapshot = form.getSnapshot();
    if (snapshot.status !== 'ready' || snapshot.value === undefined || !snapshot.writable || writes.getSnapshot().pendingFields.includes(field)) return false;
    if (writes.getSnapshot().pendingFields.length === 0) batchWriteFailed.current = false;
    pageBatchActive.current = true;
    setFormNotice({ kind: 'status', text: '正在保存设置…' });
    try {
      const accepted = await writes.set(field, value, baseValue);
      if (!accepted) batchWriteFailed.current = true;
      // Quota is an independent network read; it must not keep a saved control locked.
      if (accepted && mounted.current && (field === 'useDesktopCredential' || field === 'quotaRefreshSeconds')) void refresh(true);
      return accepted;
    } catch {
      batchWriteFailed.current = true;
      return false;
    } finally {
      if (mounted.current && writes.getSnapshot().pendingFields.length === 0) {
        pageBatchActive.current = false;
        setFormNotice(batchWriteFailed.current
          ? { kind: 'error', text: '设置未保存，已恢复原值，请重试。' }
          : { kind: 'status', text: '设置已保存。' });
      }
    }
  }, [form, mounted, refresh, writes]);

  const clearFormField = React.useCallback(async (field: string): Promise<boolean> => {
    const snapshot = form.getSnapshot();
    if (snapshot.status !== 'ready' || snapshot.value === undefined || !snapshot.writable || writes.getSnapshot().pendingFields.includes(field)) return false;
    if (writes.getSnapshot().pendingFields.length === 0) batchWriteFailed.current = false;
    pageBatchActive.current = true;
    setFormNotice({ kind: 'status', text: '正在保存设置…' });
    try {
      const accepted = await writes.clear(field);
      if (!accepted) batchWriteFailed.current = true;
      // The cleared field disappears from the form; status still carries the old name until reread.
      if (accepted && mounted.current) void loadStatus();
      return accepted;
    } catch {
      batchWriteFailed.current = true;
      return false;
    } finally {
      if (mounted.current && writes.getSnapshot().pendingFields.length === 0) {
        pageBatchActive.current = false;
        setFormNotice(batchWriteFailed.current
          ? { kind: 'error', text: '设置未保存，已恢复原值，请重试。' }
          : { kind: 'status', text: '设置已保存。' });
      }
    }
  }, [form, mounted, writes, loadStatus]);

  const refreshModelsBusy = React.useRef(false);
  const refreshModels = React.useCallback(async () => {
    if (refreshModelsBusy.current) return;
    refreshModelsBusy.current = true;
    const version = ++modelsVersion.current;
    setRefreshingModels(true);
    setModelsNotice(null);
    try {
      const next = await caller<Status>('refreshModels');
      if (!mounted.current || version !== modelsVersion.current) return;
      setStatus(next);
      setError(undefined);
      // A failed discovery returns the previous catalog plus `modelsError`; never claim success then.
      setModelsNotice(next.modelsError === undefined
        ? { kind: 'status', text: `已从当前网关刷新模型目录，共 ${next.models.length} 个模型。` }
        : null);
    } catch {
      if (mounted.current && version === modelsVersion.current) setModelsNotice({ kind: 'error', text: '模型刷新未完成，请检查凭据、网关与网络后重试。' });
    } finally {
      if (mounted.current && version === modelsVersion.current) {
        setRefreshingModels(false);
        refreshModelsBusy.current = false;
      }
    }
  }, [caller, mounted]);

  const refreshPrices = React.useCallback(async () => {
    if (pricesBusy.current) return;
    pricesBusy.current = true;
    setRefreshingPrices(true);
    try {
      const next = await caller<PriceCatalog>('refreshPrices');
      if (mounted.current) setPrices(next);
    } catch {
      if (mounted.current) setPrices(previous => previous?.fetchedAt === undefined
        ? { state: 'error', stale: false, models: [] }
        : { ...previous, state: 'error', stale: true });
    } finally {
      pricesBusy.current = false;
      if (mounted.current) setRefreshingPrices(false);
    }
  }, [caller, mounted]);
  React.useEffect(() => {
    if (tab !== 'models' || pricesRequested.current) return;
    pricesRequested.current = true;
    void refreshPrices();
  }, [tab, refreshPrices]);

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
        if (!loginInFlight(login.state) && login.state !== 'success') void loadStatus();
      } catch {
        // Keep the last good state; the next bounded poll can recover transient failures.
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1_200);
    return () => { stopped = true; clearInterval(timer); loginVersion.current += 1; };
  }, [caller, loadStatus, loginActive, mounted, refresh]);

  React.useEffect(() => {
    if (loginState !== 'success') return;
    // Connection status is independent of the first quota network read.
    void loadStatus();
    void refresh(true);
  }, [loginState, status?.login.jobId, loadStatus, refresh]);

  const configuredSeconds = formSnapshot.value?.quotaRefreshSeconds ?? status?.config.quotaRefreshSeconds;
  const refreshIntervalSeconds = configuredSeconds === undefined
    ? DEFAULT_QUOTA_REFRESH_SECONDS
    : normaliseQuotaRefreshSeconds(configuredSeconds);
  const quotaNextRefreshAt = status?.quota.nextRefreshAt;
  const schedule = React.useMemo(
    () => status?.quota.state === 'need-login' || status?.quota.autoRefreshPaused ? undefined : quotaAutoRefresh(refreshIntervalSeconds, quotaNextRefreshAt, Date.now(), Boolean(status?.quota.refreshFailures)),
    [refreshIntervalSeconds, quotaNextRefreshAt, status?.quota.state, status?.quota.autoRefreshPaused, status?.quota.refreshFailures, scheduleTick],
  );
  React.useEffect(() => {
    if (schedule === undefined) return;
    const timer = setTimeout(() => {
      void refresh().finally(() => {
        if (mounted.current) setScheduleTick(tick => tick + 1);
      });
    }, schedule.delayMs);
    return () => clearTimeout(timer);
  }, [schedule, refresh, mounted]);

  const selectTab = (next: TabId) => {
    setTab(next);
    if (next === 'overview' && tab !== 'overview') void refresh();
  };

  let content: React.ReactNode;
  if (tab === 'overview') {
    content = h(Overview, {
      status, busy: refreshing, onRefresh: () => { void refresh(true); }, onConnection: () => selectTab('connection'),
      nextAutoRefreshAt: schedule?.at, refreshIntervalSeconds,
    });
  } else if (tab === 'models') {
    content = h(Models, {
      status, formSnapshot, setFormField, pendingField,
      onRefreshModels: () => { void refreshModels(); }, refreshingModels, notice: modelsNotice,
      prices, refreshingPrices, onRefreshPrices: () => { void refreshPrices(); },
    });
  } else if (tab === 'connection') {
    content = h(Connection, { status, formSnapshot, setFormField, pendingField, caller, onLoginStatus: acceptLoginStatus, onStatus: acceptStatus });
  } else {
    content = h(Advanced, { status, formSnapshot, setFormField, clearFormField, pendingField });
  }

  return h('div', { className: 'odc-settings' },
    h('h2', null, 'OpenDesign CoRouter'),
    h('p', { className: 'odc-intro' }, '查看额度，管理模型、连接与请求设置。'),
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
    acceptedFormSnapshot.status !== 'ready' || acceptedFormSnapshot.value === undefined
      ? h(NoticeView, { notice: { kind: 'status', text: acceptedFormSnapshot.status === 'unavailable' ? '配置暂不可用，请检查插件是否已启用。' : '正在载入配置，完成后即可修改。' } })
      : !acceptedFormSnapshot.writable ? h(NoticeView, { notice: { kind: 'status', text: '当前设置为只读，无法保存修改。' } }) : null,
    h(NoticeView, { notice: pendingField.length > 0 ? { kind: 'status', text: '正在保存设置…' } : formNotice }),
    h('div', {
      className: 'odc-panel', role: 'tabpanel', id: `${baseId}-panel`, tabIndex: 0,
      'aria-labelledby': `${baseId}-tab-${tab}`,
    }, content),
    loading ? h('p', { className: 'odc-meta', role: 'status' }, '正在连接服务…') : null,
    error !== undefined ? h(NoticeView, { notice: { kind: 'error', text: error } }) : null,
    );
}

export const name = 'dsh-opendesign-corouter';
export const inject = ['slots', 'remote'];

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'opendesign-corouter: settings styles');
  ctx.effect(() => ctx.remote.$mount(openDesignCoRouterRemote), 'opendesign-corouter: mount remote');
  const caller = createCaller(ctx);
  ctx.inject(['configForms'], scope => {
    const form = scope.configForms.get(SETTINGS_NS);
    const writes = configWritesFor(form);
    scope.effect(() => () => writes.dispose(), 'opendesign-corouter: shared settings writes');
    scope.effect(() => scope.slots.inject('settings.section', () => scope.slots.register<SettingsProps>({
      name: 'settings.section', id: 'opendesign-corouter', order: 65,
      label: () => 'OpenDesign CoRouter', inject: () => ({ caller, form }),
    }, SettingsPage)), 'opendesign-corouter: settings section');
    scope.inject(['modelDirectories'], modelScope => {
      modelScope.effect(() => modelScope.slots.inject('conversation.input.right', () => modelScope.slots.register<ContextQuickProps>({
        name: 'conversation.input.right', id: 'opendesign-corouter-context', order: 9,
        inject: sessionId => ({ directory: modelScope.modelDirectories.directoryFor(sessionId).store, form, caller }),
      }, ContextQuickSwitch)), 'opendesign-corouter: session context switch');
    });
  });
}
