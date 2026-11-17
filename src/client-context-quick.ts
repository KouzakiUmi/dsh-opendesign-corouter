import * as React from 'react';
import type { ConfigForm, RpcCaller } from './client.js';
import type { Status } from './remote.js';
import type { ModelSettings } from './model-settings.js';
import { configWritesFor } from './client-config-writes.js';
import { contextWindowPreset, contextTierAvailable, effectiveContextWindow, type ContextWindowPresetId } from './context-budget.js';
import { ContextWindowControl, formatContextShort } from './client-model-controls.js';

const h = React.createElement;
const EMPTY_GROUPS: readonly unknown[] = [];

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
.odc-quick{display:inline-flex;align-items:center;gap:var(--odc-control-gap,4px);flex-wrap:wrap;max-inline-size:100%;color:var(--dsw-alias-label-primary,CanvasText);font:12px/1.5 system-ui,sans-serif}
.odc-quick .odc-context-control{margin:0;flex:none;max-inline-size:100%}.odc-quick .odc-context-caption{font-size:inherit}.odc-quick .odc-context-info{display:none}
.odc-quick-feedback{font-size:inherit;color:var(--dsw-alias-label-secondary,CanvasText);max-inline-size:100%;overflow-wrap:anywhere}.odc-quick-error{color:var(--dsw-alias-state-error-primary,CanvasText)}
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
  const alive = React.useRef(true);
  const generation = React.useRef(0);
  const id = React.useId();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const loadStatus = React.useCallback(async () => {
    const version = ++generation.current;
    setLoading(true); setLoadError(false);
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
  const values = { ...(formState.value ?? status?.config), ...writeState.pendingValues };
  const settingsMap = values.modelSettings ?? {};
  const settings = settingsMap[modelId] ?? {};
  const row = status?.models.find(model => model.id === modelId && model.group === (provider === 'opendesign-corouter-plan' ? 'plan' : 'paid'));
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
  return h('div', { className: 'odc-quick', 'aria-label': `CoRouter 上下文 · ${modelId}`, title: `修改 ${modelId} 的默认窗口，使用此模型的其他会话同步。` },
    h(ContextWindowControl, { id, reference: row?.contextWindow, settings, disabled: reason !== undefined && !pending, pending,
      ...(reason === undefined ? {} : { reason }), onSelect: tier => { void choose(tier); } }),
    loadError ? h('button', { type: 'button', className: 'odc-button odc-button-small', onClick: () => { void loadStatus(); } }, '重试读取模型信息') : null,
    error === undefined ? null : h('span', { className: 'odc-quick-feedback odc-quick-error', role: 'alert' }, error),
    notice === undefined ? null : h('span', { className: 'odc-quick-feedback', role: 'status' }, notice));
}
