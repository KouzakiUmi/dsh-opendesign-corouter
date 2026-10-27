import type { ApiProtocol } from './protocol-options.js';

/** Models with restricted sampling under the 2023-06-01 Messages API. */
const RESTRICTED_MESSAGES_SAMPLING = new Set([
  'claude-fable-5.1', 'claude-fable-5', 'claude-opus-5.5', 'claude-opus-5',
  'claude-opus-4.8', 'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-haiku-5.5',
]);

/** This policy is scoped to the native Messages API and evidenced model IDs. */
export function hasRestrictedClaudeSampling(model: string, protocol: ApiProtocol): boolean {
  return protocol === 'messages' && RESTRICTED_MESSAGES_SAMPLING.has(model);
}

/** Return a validation reason without changing an explicitly requested value. */
export function claudeSamplingError(model: string, protocol: ApiProtocol, temperature: number | undefined, topP: number | undefined): string | undefined {
  if (!hasRestrictedClaudeSampling(model, protocol)) return undefined;
  if (temperature !== undefined && topP !== undefined) return '此 Claude 模型的 Messages 请求不能同时设置温度和 Top P，请至少清空一项。';
  if (temperature !== undefined && temperature !== 1) return '此 Claude 模型的 Messages 请求仅接受默认温度 1，请清空或改为 1。';
  if (topP !== undefined && topP !== 0.99) return '此 Claude 模型的 Messages 请求仅接受默认 Top P 0.99，请清空或改为 0.99。';
  return undefined;
}

/** Vendor-documented synchronous Messages output ceiling for these exact model IDs. */
export const CLAUDE_MESSAGES_MAX_OUTPUT = 128_000;
export function claudeOutputError(model: string, protocol: ApiProtocol, maxTokens: number | undefined): string | undefined {
  return hasRestrictedClaudeSampling(model, protocol) && maxTokens !== undefined && maxTokens > CLAUDE_MESSAGES_MAX_OUTPUT
    ? '此 Claude 模型的 Messages 最大输出为 128000，请减小输出上限。'
    : undefined;
}
