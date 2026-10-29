import * as React from 'react';
import type { ConfigForm, RpcCaller } from './client.js';
import type { Status } from './remote.js';
import type { ModelSettings } from './model-settings.js';
import { configWritesFor } from './client-config-writes.js';
import { CONTEXT_WINDOW_PRESETS, contextWindowPreset, effectiveContextWindow, type ContextWindowPresetId } from './context-budget.js';

const h = React.createElement;
const EMPTY_GROUPS: readonly unknown[] = [];

/** Minimal projection of the Core 0.2.1 per-session model directory. */
export interface QuickDirectorySnapshot {
  current: { provider: string; model: string } | null;
  pending: { provider: string; model: string } | null;
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error';
  groups: readonly unknown[];
  routable?: boolean | null;
}
export interface QuickDirectoryStore {
  getSnapshot(): QuickDirectorySnapshot;
  subscribe(listener: () => void): () => void;
}
export interface ModelDirectoryService {
  directoryFor(sessionId: string): { store: QuickDirectoryStore };
}
export interface ContextQuickProps { directory: QuickDirectoryStore; form: ConfigForm; caller: RpcCaller }

export function isCoRouterProvider(provider: string): boolean {
  return provider === 'opendesign-corouter-plan' || provider === 'opendesign-corouter-paid';
}
export function quickWindowLabel(tokens: number): string {
  return tokens % 1000 === 0 ? `${tokens / 1000}K` : tokens.toLocaleString('en-US');
}

export const QUICK_CONTEXT_CSS = `
.odc-quick{display:inline-flex;color:var(--dsw-alias-label-primary,CanvasText);font:12px/1.5 system-ui,sans-serif}
.odc-quick-trigger{display:inline-flex;align-items:center;gap:4px;min-height:30px;padding:3px 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,CanvasText);font:inherit;font-variant-numeric:tabular-nums;cursor:pointer}
.odc-quick-trigger:hover,.odc-quick-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
/* Off-viewport until the first position() call: a popover that paints at the static
   position would sit at the top-left corner and swallow outside clicks. */
.odc-quick-panel{position:fixed;inset:auto;left:-9999px;top:-9999px;margin:0;box-sizing:border-box;width:min(320px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l3,CanvasText);border-radius:10px;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-shadow-lv2,0 4px 20px #0002);font:12px/1.6 system-ui,sans-serif;color-scheme:light}
body[data-ds-dark-theme] .odc-quick-panel{color-scheme:dark}
.odc-quick-panel:popover-open{display:grid;gap:8px}.odc-quick-panel h3,.odc-quick-panel p{margin:0}.odc-quick-panel h3{font-size:14px}.odc-quick-panel small{font-size:12px;color:var(--dsw-alias-label-secondary,CanvasText)}
.odc-quick-options{display:grid;gap:6px;margin:0;padding:0;border:0;min-width:0}.odc-quick-options legend{margin-bottom:4px}.odc-quick-option{display:flex;align-items:center;gap:8px;min-height:38px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,CanvasText);border-radius:7px;cursor:pointer}.odc-quick-option:has(input:checked){border-color:var(--dsw-alias-brand-primary,Highlight)}.odc-quick-option:has(input:disabled){cursor:not-allowed;opacity:.65}.odc-quick-option input{accent-color:var(--dsw-alias-brand-primary,Highlight);flex:none}.odc-quick-option span{display:grid;overflow-wrap:anywhere}
.odc-quick-error{color:var(--dsw-alias-state-error-primary,CanvasText);color:color-mix(in srgb,var(--dsw-alias-state-error-primary,CanvasText) 85%,var(--dsw-alias-label-primary,CanvasText))}.odc-quick :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:2px}
@media(forced-colors:active){.odc-quick-trigger,.odc-quick-option,.odc-quick-panel{border-color:ButtonText}.odc-quick-option:has(input:checked){border-color:Highlight}.odc-quick-option input{forced-color-adjust:auto}}
`;

/** The slot belongs to a Session; saving changes the selected model's shared default. */
export function ContextQuickSwitch({ directory, form, caller }: ContextQuickProps): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(
    React.useCallback(listener => directory.subscribe(listener), [directory]),
    React.useCallback(() => directory.getSnapshot(), [directory]),
    React.useCallback(() => directory.getSnapshot(), [directory]),
  );
  const current = snapshot.current;
  if (current === null || !isCoRouterProvider(current.provider)) return null;
  return h(ContextQuickControl, {
    key: `${current.provider}/${current.model}`, provider: current.provider, modelId: current.model,
    selecting: snapshot.pending !== null || snapshot.status === 'selecting',
    directoryUnavailable: snapshot.status !== 'ready',
    catalog: snapshot.groups.length === 0 ? EMPTY_GROUPS : snapshot.groups, form, caller,
  });
}

function ContextQuickControl({ provider, modelId, selecting, directoryUnavailable, catalog, form, caller }: {
  provider: string; modelId: string; selecting: boolean; directoryUnavailable: boolean; catalog: readonly unknown[]; form: ConfigForm; caller: RpcCaller;
}): React.ReactElement {
  const writes = React.useMemo(() => configWritesFor(form), [form]);
  const writeState = React.useSyncExternalStore(
    React.useCallback(listener => writes.subscribe(listener), [writes]),
    React.useCallback(() => writes.getSnapshot(), [writes]),
    React.useCallback(() => writes.getSnapshot(), [writes]),
  );
  const formState = React.useSyncExternalStore(
    React.useCallback(listener => form.subscribe(listener), [form]),
    React.useCallback(() => form.getSnapshot(), [form]),
    React.useCallback(() => form.getSnapshot(), [form]),
  );
  const [status, setStatus] = React.useState<Status>();
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const [open, setOpen] = React.useState(false);
  const popup = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const alive = React.useRef(true);
  const generation = React.useRef(0);
  const popupId = React.useId();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const loadStatus = React.useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setLoadError(false);
    try {
      const next = await caller<Status>('status');
      if (alive.current && version === generation.current) setStatus(next);
    } catch {
      if (alive.current && version === generation.current) setLoadError(true);
    } finally {
      if (alive.current && version === generation.current) setLoading(false);
    }
  }, [caller]);
  React.useEffect(() => { void loadStatus(); }, [loadStatus, catalog]);

  const position = React.useCallback(() => {
    const panel = popup.current, anchor = button.current;
    if (!panel || !anchor || !panel.matches(':popover-open')) return;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth, height = panel.offsetHeight;
    panel.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(rect.top - height - 8 >= 12 ? rect.top - height - 8 : rect.bottom + 8, window.innerHeight - height - 12))}px`;
  }, []);
  React.useEffect(() => {
    const panel = popup.current;
    if (!panel) return;
    // Native invoker semantics prevent light-dismiss from closing on pointerdown
    // and our trigger accidentally reopening the same popover on click.
    button.current?.setAttribute('popovertarget', popupId);
    button.current?.setAttribute('popovertargetaction', 'toggle');
    const toggle = () => {
      const shown = panel.matches(':popover-open');
      setOpen(shown);
      if (shown) {
        position();
        panel.querySelector<HTMLInputElement>('input:checked:not(:disabled),input:not(:disabled)')?.focus();
      }
    };
    panel.addEventListener('toggle', toggle);
    return () => { panel.removeEventListener('toggle', toggle); };
  }, [position, popupId]);
  React.useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      popup.current?.hidePopover(); button.current?.focus();
    };
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);

  const values = { ...(formState.value ?? status?.config), ...writeState.pendingValues };
  const settingsMap = values.modelSettings ?? {};
  const settings = settingsMap[modelId] ?? {};
  const row = status?.models.find(model => model.id === modelId && model.group === (provider === 'opendesign-corouter-plan' ? 'plan' : 'paid'));
  const tier = contextWindowPreset(settings.contextWindow, settings.contextTier);
  const windowSize = effectiveContextWindow(row?.contextWindow, settings.contextWindow, settings.contextTier);
  const pending = writeState.pendingFields.includes('modelSettings');
  const reason = selecting ? '正在切换模型，请稍候。'
    : directoryUnavailable ? '会话模型目录尚未就绪，请稍后重试。'
      : formState.status === 'unavailable' ? '模型设置暂不可用。'
        : formState.status !== 'ready' || formState.value === undefined ? '正在载入模型设置。'
      : !formState.writable ? '当前设置为只读。'
        : pending ? '正在保存模型设置…'
          : loading ? '正在读取模型参考容量…'
            : loadError ? '模型信息读取失败，请重试。'
              : row === undefined ? '当前模型不在 CoRouter 目录中。' : undefined;
  React.useEffect(() => { if (open) position(); }, [open, status, loading, error, notice, reason, position]);
  React.useEffect(() => {
    if (open && reason === undefined && document.activeElement === button.current) {
      popup.current?.querySelector<HTMLInputElement>('input:checked:not(:disabled),input:not(:disabled)')?.focus();
    }
  }, [open, reason]);
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (wasPending.current && !pending && open) popup.current?.querySelector<HTMLInputElement>('input:checked:not(:disabled)')?.focus();
    wasPending.current = pending;
  }, [pending, open]);
  const choose = async (nextTier: ContextWindowPresetId) => {
    if (reason !== undefined || row === undefined) return;
    const candidate: ModelSettings = { ...settings };
    delete candidate.contextWindow;
    if (nextTier === 'default') delete candidate.contextTier;
    else candidate.contextTier = nextTier;
    const capacity = effectiveContextWindow(row.contextWindow, undefined, nextTier);
    if (candidate.maxTokens !== undefined && candidate.maxTokens >= capacity) {
      setError(`最大输出 ${candidate.maxTokens.toLocaleString('en-US')} 不小于所选总窗口 ${capacity.toLocaleString('en-US')}；请先在设置页清空或减小最大输出。`);
      return;
    }
    setError(undefined); setNotice(undefined);
    const nextMap = { ...settingsMap, [modelId]: candidate };
    if (Object.keys(candidate).length === 0) delete nextMap[modelId];
    const saved = await writes.set('modelSettings', nextMap, settingsMap);
    if (!alive.current) return;
    if (saved) setNotice('上下文档位已保存。');
    else setError('设置未保存，已恢复原值，请重试。');
  };
  const show = () => {
    const panel = popup.current;
    if (!panel) return;
    if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
    panel.showPopover(); position();
    if (!loading) void loadStatus();
  };
  const label = row === undefined ? '上下文…' : `${tier === undefined ? '自定义 ' : ''}${quickWindowLabel(windowSize)}`;
  return h('div', { className: 'odc-quick' },
    h('button', {
      ref: button, className: 'odc-quick-trigger', type: 'button', 'aria-label': `CoRouter 上下文：${label}`,
      'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': popupId,
      title: `上下文总窗口（含输出预留）。修改 ${modelId} 的默认值，其他会话同步。`,
      onClick: () => { if (!popup.current?.matches(':popover-open') && !loading) void loadStatus(); },
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (!popup.current?.matches(':popover-open')) show();
        else popup.current.querySelector<HTMLInputElement>('input:checked:not(:disabled),input:not(:disabled)')?.focus();
      },
    }, label, h('span', { 'aria-hidden': true }, ' ▾')),
    h('div', { id: popupId, ref: popup, popover: 'auto', className: 'odc-quick-panel', role: 'dialog', 'aria-labelledby': `${popupId}-title` },
      h('h3', { id: `${popupId}-title` }, '上下文窗口'),
      h('small', null, modelId),
      h('p', null, '修改此模型的默认值，其他会话同步。'),
      h('fieldset', { className: 'odc-quick-options', 'aria-describedby': `${popupId}-reason` },
        h('legend', null, '上下文档位'),
        CONTEXT_WINDOW_PRESETS.map(preset => {
          const available = preset.id === 'default' || row?.contextWindow === undefined || preset.tokens <= row.contextWindow;
          return h('label', { className: 'odc-quick-option', key: preset.id },
            h('input', { type: 'radio', name: popupId, checked: tier === preset.id, disabled: reason !== undefined || !available, 'aria-describedby': `${popupId}-reason`, onChange: () => { void choose(preset.id); } }),
            h('span', null, `${preset.label} ${quickWindowLabel(preset.tokens)}`, !available ? h('small', null, `超过参考容量 ${row?.contextWindow?.toLocaleString('en-US')}`) : null));
        })),
      h('p', { id: `${popupId}-reason`, role: 'status' }, reason ?? `当前总窗口 ${windowSize.toLocaleString('en-US')} tokens（含输出预留）。${tier === undefined ? '旧自定义值按原值保留，选择档位可替换。' : ''}`),
      loadError ? h('button', { type: 'button', className: 'odc-button', onClick: () => { void loadStatus(); } }, '重试读取模型信息') : null,
      error === undefined ? null : h('p', { className: 'odc-quick-error', role: 'alert' }, error),
      notice === undefined ? null : h('p', { role: 'status' }, notice)));
}
