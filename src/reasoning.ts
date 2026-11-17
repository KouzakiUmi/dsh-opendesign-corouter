import type { CatalogModel } from './catalog.js';
import type { ApiProtocol } from './protocol-options.js';

const PROTOCOL_EFFORTS: Readonly<Record<ApiProtocol, readonly string[]>> = {
  'chat-completions': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'],
  responses: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  messages: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

type ReasoningModel = Pick<CatalogModel, 'reasoningEfforts'> & Partial<Pick<CatalogModel, 'id' | 'reasoningMode'>>;
const MIMO_TOGGLE_IDS = ['mimo-v2.6-pro', 'mimo-v2.6-flash'] as const;
const HY_TOGGLE_IDS = ['hy4', 'hy4-flash'] as const;

/** Preserve established Chat replay policy, with only the two documented MiMo IDs added. */
export function usesReasoningContent(modelId: string): boolean {
  return modelId.startsWith('deepseek-') || modelId.startsWith('kimi-') || MIMO_TOGGLE_IDS.some(id => id === modelId);
}

/** Toggle labels must not advertise the internal `high` token as a depth level. */
export function reasoningEffortName(effort: string, mode?: 'toggle' | 'fixed'): string {
  if (mode === 'toggle' && effort === 'high') return '开启';
  const names: Readonly<Record<string, string>> = {
    none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '较高', ultra: '极高', max: '最高',
  };
  return names[effort] ?? effort;
}

/**
 * Exact-model protocol projection. `undefined` preserves the generic wire contract;
 * `null` rejects an explicit value without pretending another protocol supports it.
 */
export function reasoningParameters(modelId: string, protocol: ApiProtocol, effort: string): Record<string, unknown> | null | undefined {
  if (MIMO_TOGGLE_IDS.some(id => id === modelId)) {
    if (effort !== 'none' && effort !== 'high') return null;
    return protocol === 'responses' ? { reasoning: { effort } } : { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } };
  }
  if (modelId === 'qwen3.7-max') {
    if (protocol !== 'chat-completions' || (effort !== 'none' && effort !== 'high')) return null;
    return { enable_thinking: effort === 'high' };
  }
  if (HY_TOGGLE_IDS.some(id => id === modelId)) {
    if (effort !== 'none' && effort !== 'high') return null;
    if (protocol === 'chat-completions') return { reasoning_effort: effort === 'none' ? 'no_think' : 'high' };
    return effort === 'none' ? null : undefined;
  }
  return undefined;
}

/** Whether this request format can encode an effort without remapping it. */
export function protocolAcceptsEffort(protocol: ApiProtocol, effort: string): boolean {
  return PROTOCOL_EFFORTS[protocol].includes(effort);
}

/** Intersect documented model choices with the active request format. */
export function modelReasoningEfforts(model: ReasoningModel, protocol: ApiProtocol): readonly string[] | undefined {
  if (model.reasoningMode === 'fixed') return [];
  if (model.id === 'qwen3.7-max' && protocol !== 'chat-completions') return [];
  return model.reasoningEfforts?.filter(effort => protocolAcceptsEffort(protocol, effort)
    && (model.id === undefined || reasoningParameters(model.id, protocol, effort) !== null));
}

/**
 * Vendor-declared default effort, but only while the active request format can
 * encode it. Omission means the vendor documents no default for this model, so
 * the route keeps the provider's own default instead of a guess.
 */
export function vendorDefaultEffort(model: ReasoningModel & Pick<CatalogModel, 'defaultEffort'>, protocol: ApiProtocol): string | undefined {
  const available = modelReasoningEfforts(model, protocol);
  return model.defaultEffort !== undefined && available?.includes(model.defaultEffort) === true ? model.defaultEffort : undefined;
}

/**
 * The default one exact route reports and applies: the saved user choice while
 * it is still valid for the active protocol, otherwise the vendor default. A
 * saved value outside the supported set resolves to nothing — the stale value
 * stays visible and clearable instead of being silently rewritten.
 */
export function defaultReasoningEffort(model: ReasoningModel & Pick<CatalogModel, 'defaultEffort'>, protocol: ApiProtocol, configured?: string): string | undefined {
  if (configured === undefined) return vendorDefaultEffort(model, protocol);
  return modelReasoningEfforts(model, protocol)?.includes(configured) === true ? configured : undefined;
}
