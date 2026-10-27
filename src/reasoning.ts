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
