import type { CatalogModel } from './catalog.js';
import type { ApiProtocol } from './protocol-options.js';

const PROTOCOL_EFFORTS: Readonly<Record<ApiProtocol, readonly string[]>> = {
  'chat-completions': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'],
  responses: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  messages: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

/** Whether this request format can encode an effort without remapping it. */
export function protocolAcceptsEffort(protocol: ApiProtocol, effort: string): boolean {
  return PROTOCOL_EFFORTS[protocol].includes(effort);
}

/** Intersect documented model choices with the active request format. */
export function modelReasoningEfforts(model: Pick<CatalogModel, 'reasoningEfforts'>, protocol: ApiProtocol): readonly string[] | undefined {
  return model.reasoningEfforts?.filter(effort => protocolAcceptsEffort(protocol, effort));
}

/**
 * Vendor-declared default effort, but only while the active request format can
 * encode it. Omission means the vendor documents no default for this model, so
 * the route keeps the provider's own default instead of a guess.
 */
export function vendorDefaultEffort(model: Pick<CatalogModel, 'reasoningEfforts' | 'defaultEffort'>, protocol: ApiProtocol): string | undefined {
  const available = modelReasoningEfforts(model, protocol);
  return model.defaultEffort !== undefined && available?.includes(model.defaultEffort) === true ? model.defaultEffort : undefined;
}

/**
 * The default one exact route reports and applies: the saved user choice while
 * it is still valid for the active protocol, otherwise the vendor default. A
 * saved value outside the supported set resolves to nothing — the stale value
 * stays visible and clearable instead of being silently rewritten.
 */
export function defaultReasoningEffort(model: Pick<CatalogModel, 'reasoningEfforts' | 'defaultEffort'>, protocol: ApiProtocol, configured?: string): string | undefined {
  if (configured === undefined) return vendorDefaultEffort(model, protocol);
  return modelReasoningEfforts(model, protocol)?.includes(configured) === true ? configured : undefined;
}
