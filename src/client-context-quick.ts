import * as React from 'react';
import type { ConfigForm, RpcCaller } from './client.js';
import type { StatusModel } from './remote.js';
import type { ModelSettings } from './model-settings.js';
import { cachedModelRow, ensureModelRows } from './client-model-capacity.js';
import { configWritesFor } from './client-config-writes.js';
import { quickControlState, useQuickStores } from './client-control-state.js';
import { contextWindowPreset, contextTierAvailable, effectiveContextWindow, type ContextWindowPresetId } from './context-budget.js';
import { ContextWindowControl, formatContextShort } from './client-model-controls.js';

const h = React.createElement;

/** Minimal projection of the Core per-session model directory. */
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
export const quickWindowLabel = formatContextShort;
export const QUICK_CONTEXT_CSS = `
.odc-quick{--odc-quick-space:2px;--odc-quick-gap:1px;--odc-quick-inset:7px;--odc-quick-radius:999px;--odc-quick-font:10.5px;--odc-quick-border:rgba(128,128,128,.3);position:relative;display:inline-flex;align-items:center;flex:none;max-inline-size:100%;color:inherit;font:inherit}
.odc-quick .odc-context-control{--odc-control-font:var(--odc-quick-font);display:inline-flex;align-items:center;flex-wrap:nowrap;gap:var(--odc-quick-space);margin:0;flex:none;max-inline-size:100%;color:inherit}
.odc-quick .odc-context-options{display:inline-flex;align-items:center;gap:var(--odc-quick-gap);padding:var(--odc-quick-space);border:1px solid var(--odc-quick-border);border-radius:var(--odc-quick-radius);background:transparent}
.odc-quick .odc-context-option{min-height:0;padding:var(--odc-quick-space) var(--odc-quick-inset);border:0;border-radius:var(--odc-quick-radius);font:inherit;font-size:var(--odc-quick-font);font-weight:500;color:inherit;opacity:.68;background:transparent;cursor:pointer}
.odc-quick .odc-context-option[aria-pressed=true]{border:0;background:color-mix(in srgb,currentColor 14%,transparent);color:inherit;font-weight:700;opacity:1;cursor:default}
.odc-quick .odc-context-option:hover:not(:disabled){background:transparent;color:inherit}.odc-quick .odc-context-option[aria-pressed=true]:hover:not(:disabled){background:color-mix(in srgb,currentColor 14%,transparent)}
.odc-quick[data-disabled=true] .odc-context-control{opacity:.55}.odc-quick .odc-context-option:disabled{cursor:default;opacity:.68}.odc-quick .odc-context-option[aria-pressed=true]:disabled{opacity:1}.odc-quick .odc-context-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:var(--odc-quick-space)}
.odc-quick .odc-context-caption,.odc-quick .odc-context-info{display:none}
.odc-quick .odc-context-note,.odc-quick-feedback{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none}
.odc-quick[data-error=true] .odc-context-options{border-color:var(--dsw-alias-state-error-primary,CanvasText)}
.odc-quick[data-error=true]:is(:hover,:focus-within)::after{content:attr(data-error-message);position:absolute;inset-inline-start:0;bottom:calc(100% + 6px);z-index:var(--odc-quick-tooltip-layer,50);width:max-content;max-width:min(260px,calc(100vw - 24px));box-sizing:border-box;padding:8px;border:1px solid var(--dsw-alias-state-error-primary,CanvasText);border-radius:6px;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:11px/1.5 system-ui,sans-serif;white-space:normal;overflow-wrap:anywhere;pointer-events:none}
.odc-quick .odc-quick-retry{min-height:0;padding:var(--odc-quick-space) var(--odc-quick-inset);border:1px solid var(--odc-quick-border);border-radius:var(--odc-quick-radius);background:transparent;color:inherit;font:inherit;font-size:var(--odc-quick-font);cursor:pointer}
@media(forced-colors:active){.odc-quick .odc-context-options{border-color:ButtonText}.odc-quick .odc-context-option[aria-pressed=true]{background:Highlight;color:HighlightText;forced-color-adjust:none}.odc-quick .odc-context-option:disabled{color:GrayText;opacity:1}}
`;

/** Each slot follows its Session; the shared writer changes only that model's defaults. */
export function ContextQuickSwitch({ directory, form, caller }: ContextQuickProps): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(
    React.useCallback(listener => directory.subscribe(listener), [directory]),
    React.useCallback(() => directory.getSnapshot(), [directory]),
    React.useCallback(() => directory.getSnapshot(), [directory]),
  );
  const current = snapshot.current;
  if (current === null || !isCoRouterProvider(current.provider)) return null;
  return h(ContextQuickControl, {
    key: `${current.provider}/${current.model}`, modelId: current.model,
    directory, form, caller,
  });
}

/**
 * The chat-side window switch.
 *
 * The capacity reference comes from the cached model rows ({@link cachedModelRow}): reading
 * `status` here, on mount and again on every model-directory publish, is what made this
 * control stall before a saved value appeared. A cached row renders immediately, one shared
 * read fills the cache at most once per refresh window, and a missing row degrades to the
 * existing unknown-capacity state instead of a wall of disabled buttons. A background
 * directory refresh likewise never disables the control: only a pending model switch, a
 * directory error, an unreadable form or an in-flight save blocks it.
 */
function ContextQuickControl({ modelId, directory, form, caller }: {
  modelId: string; directory: QuickDirectoryStore; form: ConfigForm; caller: RpcCaller;
}): React.ReactElement {
  const writes = React.useMemo(() => configWritesFor(form), [form]);
  const { snapshot, formState, writeState } = useQuickStores(directory, form, writes);
  const [row, setRow] = React.useState<StatusModel | undefined>(() => cachedModelRow(modelId));
  const [awaiting, setAwaiting] = React.useState(() => cachedModelRow(modelId) === undefined);
  const [loadError, setLoadError] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const alive = React.useRef(true);
  const id = React.useId();
  React.useEffect(() => {
    alive.current = true;
    const cached = cachedModelRow(modelId);
    setRow(cached);
    setLoadError(false);
    setAwaiting(cached === undefined);
    if (cached !== undefined) return () => { alive.current = false; };
    void ensureModelRows(caller).then(() => {
      if (!alive.current) return;
      const next = cachedModelRow(modelId);
      setRow(next);
      setLoadError(next === undefined);
      setAwaiting(false);
    });
    return () => { alive.current = false; };
  }, [caller, modelId]);
  const retry = React.useCallback(() => {
    setLoadError(false);
    setAwaiting(true);
    void ensureModelRows(caller, { force: true }).then(() => {
      if (!alive.current) return;
      const next = cachedModelRow(modelId);
      setRow(next);
      setLoadError(next === undefined);
      setAwaiting(false);
    });
  }, [caller, modelId]);
  const values = { ...(formState.value ?? {}), ...writeState.pendingValues };
  const { reason, pending, settings, settingsMap } = quickControlState({
    directory: snapshot, form: formState, values, pendingFields: writeState.pendingFields, modelId, row, awaiting,
  });
  const choose = async (nextTier: ContextWindowPresetId) => {
    if (reason !== undefined || row === undefined || !contextTierAvailable(nextTier, row.contextWindow)) return;
    if (settings.contextWindow === undefined && contextWindowPreset(undefined, settings.contextTier) === nextTier) return;
    const candidate: ModelSettings = { ...settings };
    delete candidate.contextWindow;
    if (nextTier === 'default') delete candidate.contextTier;
    else candidate.contextTier = nextTier;
    const capacity = effectiveContextWindow(row.contextWindow, undefined, nextTier);
    if (candidate.maxTokens !== undefined && capacity !== undefined && candidate.maxTokens >= capacity) {
      setError(`最大输出 ${candidate.maxTokens.toLocaleString('en-US')} 不小于所选总窗口 ${capacity.toLocaleString('en-US')}；请先在设置页清空或减小最大输出。`);
      return;
    }
    setError(undefined); setNotice(undefined);
    const nextMap = { ...settingsMap, [modelId]: candidate };
    if (Object.keys(candidate).length === 0) delete nextMap[modelId];
    const saved = await writes.set('modelSettings', nextMap, settingsMap);
    if (!alive.current) return;
    if (saved) setNotice('已保存');
    else setError('设置未保存，已恢复原值，请重试。');
  };
  return h('div', { className: 'odc-quick', 'data-error': error !== undefined, 'data-error-message': error, 'data-disabled': reason !== undefined,
    'aria-label': `CoRouter 上下文 · ${modelId}`, title: `${error ?? reason ?? ''} 修改 ${modelId} 的默认窗口，使用此模型的其他会话同步。`.trim() },
    h(ContextWindowControl, { id, reference: row?.contextWindow, settings, disabled: reason !== undefined && !pending, pending,
      ...(reason === undefined ? {} : { reason }), onSelect: tier => { void choose(tier); } }),
    loadError ? h('button', { type: 'button', className: 'odc-quick-retry', onClick: retry }, '重试读取模型信息') : null,
    error === undefined ? null : h('span', { className: 'odc-quick-feedback odc-quick-error', role: 'alert' }, error),
    notice === undefined ? null : h('span', { className: 'odc-quick-feedback', role: 'status' }, notice));
}
