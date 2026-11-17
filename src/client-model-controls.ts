import * as React from 'react';
import type { ModelSettings } from './model-settings.js';
import { contextWindowPresets, contextWindowPreset, contextTierAvailable, effectiveContextWindow, type ContextWindowPresetId } from './context-budget.js';

const h = React.createElement;

export const MODEL_CONTROLS_CSS = `
.odc-context-control,.odc-effort{--odc-control-space:4px;--odc-control-gap:8px;--odc-control-radius:8px;--odc-control-font:12px;--odc-control-height:32px;color:var(--dsw-alias-label-primary,CanvasText);font-size:var(--odc-control-font)}
.odc-context.odc-context-control{display:flex;align-items:center;flex-wrap:wrap;gap:var(--odc-control-gap);min-width:0;padding:0;margin:0;border:0;border-radius:0}
.odc-context-control .odc-context-options{display:inline-flex;align-items:center;gap:0;min-width:0;margin:0;padding:var(--odc-control-space);border:1px solid var(--dsw-alias-border-l3,ButtonText);border-radius:var(--odc-control-radius)}
.odc-context-control .odc-context-option{display:inline-flex;align-items:center;justify-content:center;min-height:var(--odc-control-height);min-width:0;padding:var(--odc-control-space) var(--odc-control-gap);margin:0;border:1px solid transparent;border-radius:var(--odc-control-space);background:transparent;color:var(--dsw-alias-label-secondary,CanvasText);font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}
.odc-context-control .odc-context-option:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
.odc-context-control .odc-context-option[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,Highlight);background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-weight:700}
.odc-context-control .odc-context-option:disabled{opacity:.55;cursor:not-allowed}
.odc-context-control :focus-visible,.odc-effort :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:var(--odc-control-space)}
.odc-context-control .odc-context-caption,.odc-context-control .odc-context-note{color:var(--dsw-alias-label-secondary,CanvasText);font-size:var(--odc-control-font)}
.odc-context-control .odc-context-note{flex-basis:100%;margin:0;overflow-wrap:anywhere}
.odc-context-control .odc-context-info{min-width:0;color:var(--dsw-alias-label-secondary,CanvasText)}
.odc-context-info summary{cursor:pointer;font-size:var(--odc-control-font)}
.odc-context-info[open]{flex-basis:100%}.odc-context-info p{margin:var(--odc-control-space) 0 0;overflow-wrap:anywhere}
.odc-effort .odc-effort-head{display:flex;align-items:center;flex-wrap:wrap;gap:var(--odc-control-gap)}.odc-effort .odc-effort-head>.odc-effort-value{flex:1;min-width:0}.odc-effort .odc-effort-head>button{margin-inline-start:auto}
.odc-effort .odc-effort-value{margin:0;font-size:var(--odc-control-font);overflow-wrap:anywhere}.odc-effort .odc-effort-actions{display:flex;flex-wrap:wrap;gap:var(--odc-control-gap)}
.odc-effort .odc-effort-label{font-size:var(--odc-control-font)}.odc-effort .odc-hint{font-size:var(--odc-control-font)}
.odc-effort [role=alert]{color:var(--dsw-alias-state-error-primary,CanvasText)}
@media(forced-colors:active){.odc-context-control .odc-context-options{border-color:ButtonText}.odc-context-control .odc-context-option[aria-pressed=true]{border-color:Highlight;background:Highlight;color:HighlightText}.odc-context-control .odc-context-option:disabled{color:GrayText;opacity:1}}
`;

/** Compact display only; accessible descriptions retain the exact token count. */
export function formatContextShort(tokens: number | undefined): string {
  if (tokens === undefined) return '容量未知';
  const binary = tokens >= 1024 && Number.isInteger(Math.log2(tokens));
  const kilo = binary ? 1024 : 1000;
  if (tokens >= kilo * kilo) return `${tokens / (kilo * kilo)}M`;
  if (tokens >= kilo && tokens % kilo === 0) return `${tokens / kilo}K`;
  return tokens.toLocaleString('en-US');
}

export interface ContextWindowControlProps {
  id: string;
  reference: number | undefined;
  settings: ModelSettings;
  disabled: boolean;
  reason?: string | undefined;
  pending?: boolean;
  onSelect: (tier: ContextWindowPresetId) => void;
}

export function ContextWindowControl({ id, reference, settings, disabled, reason, pending = false, onSelect }: ContextWindowControlProps): React.ReactElement {
  const presets = contextWindowPresets(reference);
  const known = presets[2]?.tokens !== undefined;
  const tier = contextWindowPreset(settings.contextWindow, settings.contextTier);
  const legacy = settings.contextWindow !== undefined && settings.contextTier === undefined;
  const current = effectiveContextWindow(reference, settings.contextWindow, settings.contextTier);
  const busy = disabled || pending;
  const element = React.useRef<HTMLDivElement>(null);
  const restoreFocus = React.useRef<ContextWindowPresetId | undefined>(undefined);
  React.useEffect(() => {
    if (busy || restoreFocus.current === undefined) return;
    const target = element.current?.querySelector<HTMLButtonElement>(`button[data-preset="${restoreFocus.current}"]`);
    if (target && (document.activeElement === document.body || element.current?.contains(document.activeElement))) target.focus();
    restoreFocus.current = undefined;
  }, [busy]);
  const note = reason ?? (pending ? '正在保存上下文设置…' : !known ? '模型参考容量未核实，暂不设置本地窗口上限。' : undefined);
  const exact = (tokens: number) => `${tokens.toLocaleString('en-US')} tokens`;
  const select = (next: ContextWindowPresetId) => {
    if (!busy && contextTierAvailable(next, reference) && (next !== tier || settings.contextWindow !== undefined || !known)) onSelect(next);
  };
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-preset]:not(:disabled)'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };
  return h('div', {
    id, ref: element, className: 'odc-context odc-context-control', role: 'group', 'aria-label': '上下文窗口',
    'aria-busy': pending, 'aria-describedby': note === undefined ? undefined : `${id}-reason`, onKeyDown: moveFocus,
  },
    h('span', { className: 'odc-context-caption' }, '上下文'),
    legacy ? h('span', { className: 'odc-context-value', title: exact(settings.contextWindow!) }, `自定义 ${formatContextShort(settings.contextWindow)}`) : null,
    known ? h('div', { className: 'odc-context-options' }, presets.map(preset => {
      const available = contextTierAvailable(preset.id, reference);
      const title = `${preset.label} ${exact(preset.tokens!)}；输入与输出合计；修改此模型共享默认，其他会话同步。${available ? '' : '与较低档位相同，不可选择。'}`;
      return h('button', {
        key: preset.id, type: 'button', className: 'odc-context-option', 'data-preset': preset.id,
        'aria-label': `${preset.label} ${formatContextShort(preset.tokens)}`, 'aria-pressed': preset.id === tier,
        'aria-describedby': note === undefined ? undefined : `${id}-reason`, title, disabled: busy || !available,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          if (document.activeElement === event.currentTarget) restoreFocus.current = preset.id;
          select(preset.id);
        },
      }, formatContextShort(preset.tokens));
    })) : h(React.Fragment, null,
      h('span', { className: 'odc-context-value' }, '容量未知'),
      settings.contextWindow !== undefined || settings.contextTier !== undefined ? h('button', {
        type: 'button', className: 'odc-button odc-button-small', disabled: busy, onClick: () => select('default'),
      }, '恢复默认') : null),
    note === undefined ? null : h('small', { id: `${id}-reason`, className: 'odc-context-note', role: 'status' }, note),
    known ? h('details', { className: 'odc-context-info' },
      h('summary', null, '说明'),
      h('p', null, `总窗口含输出预留；修改此模型共享默认，其他会话同步。当前 ${current === undefined ? '容量未知' : exact(current)}，参考 ${exact(reference!)}。${legacy ? '旧自定义值按原值保留，选择档位可替换。' : ''}`)) : null);
}

interface EffortModel {
  reasoningEfforts?: readonly string[];
  defaultEffort?: string;
  reasoningMode?: 'toggle' | 'fixed';
}
export interface EffortFieldProps {
  id: string;
  model: EffortModel;
  value: string | undefined;
  disabled: boolean;
  pending: boolean;
  disabledReason?: string | undefined;
  onSave: (value: string) => Promise<boolean>;
}
const EFFORT_LABELS: Record<string, string> = {
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '较高', ultra: '最高', max: '最高',
};

export function EffortField({ id, model, value, disabled, pending, disabledReason, onSave }: EffortFieldProps): React.ReactElement {
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? '');
  const [baseValue, setBaseValue] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const kind = model.reasoningMode ?? (model.reasoningEfforts === undefined ? 'unknown' : model.reasoningEfforts.length === 0 ? 'discrete-unavailable' : 'graded');
  const adjustable = (kind === 'graded' || kind === 'toggle') && (model.reasoningEfforts?.length ?? 0) > 0;
  const listed = adjustable ? model.reasoningEfforts ?? [] : [];
  const label = (effort: string) => kind === 'toggle' ? effort === 'none' ? '关闭' : effort === 'high' ? '开启' : effort : EFFORT_LABELS[effort] ?? effort;
  const heading = kind === 'toggle' ? '思考模式' : '默认思考深度';
  const display = (effort: string) => kind === 'toggle' ? label(effort) : `${label(effort)} · ${effort}`;
  const defaultLabel = model.defaultEffort === undefined ? '使用模型默认' : `模型默认（${display(model.defaultEffort)}）`;
  const invalidDefault = value !== undefined && !listed.includes(value);
  const invalidDraft = editing && draft !== '' && !listed.includes(draft);
  const options = [...listed];
  for (const effort of [value, draft]) {
    if (effort !== undefined && effort !== '' && !options.includes(effort)) options.push(effort);
  }
  const busy = saving || pending;
  const reason = busy ? '正在保存模型设置，完成后可继续编辑。' : disabled ? `${disabledReason ?? '配置不可写'}，无法编辑。` : undefined;
  const externallyChanged = editing && value !== baseValue && !(saving && value === draft);
  const capability = kind === 'fixed' ? '固定思考 · 始终开启' : kind === 'unknown' ? '思考能力未核实' : kind === 'discrete-unavailable' ? '未提供离散思考控制' : kind === 'toggle' && !adjustable ? '当前协议未提供思考控制' : undefined;
  const hint = reason ?? (editing
    ? externallyChanged ? `配置已从其他位置更新为「${value === undefined ? defaultLabel : label(value)}」；取消可查看最新值，保存将使用当前草稿。`
      : invalidDraft ? '当前草稿不适用于此模型或协议，请选择其他选项或恢复模型默认。'
        : '选择模型默认会删除已保存设置；保存前仅修改本地草稿。'
    : capability !== undefined ? `${capability}。${value === undefined ? '' : '可编辑并清除旧设置。'}`
      : invalidDefault ? '已保存的档位不适用于当前模型或协议，可编辑后选择其他档位或恢复模型默认。'
        : model.defaultEffort === undefined ? '该模型未声明默认档位，未设置时不发送档位设置。'
          : `未设置时按模型默认「${label(model.defaultEffort)}」发送。`);
  const cancel = () => { if (!saving) { setEditing(false); setError(undefined); } };
  const save = async (): Promise<void> => {
    if (disabled || pending || saving || invalidDraft) return;
    if (draft === (value ?? '')) { setEditing(false); setError(undefined); return; }
    setSaving(true); setError(undefined);
    try {
      const saved = await onSave(draft);
      if (!mounted.current) return;
      if (saved) { setEditing(false); setError(undefined); }
      else setError('设置未保存，已保留当前草稿，请重试。');
    } catch {
      if (mounted.current) setError('设置未保存，已保留当前草稿，请重试。');
    } finally { if (mounted.current) setSaving(false); }
  };
  const summary = capability === undefined
    ? invalidDefault ? `${value}（当前不可用）` : value === undefined ? defaultLabel : display(value)
    : `${capability}${value === undefined ? '' : ` · 旧设置 ${value}（可清除）`}`;
  return h('div', {
    className: 'odc-field odc-field-compact odc-effort', 'data-mode': editing ? 'editing' : 'summary', 'data-kind': kind, 'aria-busy': busy,
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || !editing || saving) return;
      event.preventDefault(); cancel();
    },
  }, editing ? h(React.Fragment, null,
    h('label', { htmlFor: id }, heading),
    h('select', {
      id, className: 'odc-input', value: draft, disabled: busy || disabled,
      'aria-describedby': `${id}-hint${error === undefined ? '' : ` ${id}-error`}`, 'aria-invalid': invalidDraft || error !== undefined,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setDraft(event.target.value); setError(undefined); },
    }, [h('option', { key: '', value: '' }, defaultLabel), ...options.map(effort => h('option', {
      key: effort, value: effort, disabled: !listed.includes(effort),
    }, listed.includes(effort) ? `${label(effort)}${kind === 'toggle' ? '' : ` · ${effort}`}` : `${effort}（当前不可用）`))]),
    h('div', { className: 'odc-effort-actions' },
      h('button', { className: 'odc-button odc-button-small odc-button-primary', type: 'button', disabled: busy || disabled || invalidDraft, 'aria-label': `保存${heading}`, onClick: () => { void save(); } }, saving ? '保存中…' : '保存'),
      h('button', { className: 'odc-button odc-button-small', type: 'button', disabled: saving, 'aria-label': `取消编辑${heading}`, onClick: cancel }, '取消')))
    : h(React.Fragment, null,
      h('div', { className: 'odc-effort-head' },
        h('span', { className: 'odc-effort-label' }, heading),
        h('p', { className: 'odc-effort-value' }, summary),
        adjustable || value !== undefined ? h('button', {
          className: 'odc-button odc-button-small', type: 'button', disabled: busy || disabled,
          'aria-label': `编辑${heading}`, 'aria-describedby': `${id}-hint`,
          onClick: () => { setDraft(value ?? ''); setBaseValue(value); setError(undefined); setEditing(true); },
        }, adjustable ? '编辑' : '清除旧设置') : null)),
    h('small', { className: 'odc-hint', id: `${id}-hint` }, hint),
    error === undefined ? null : h('small', { className: 'odc-hint odc-field-error', id: `${id}-error`, role: 'alert' }, error));
}
