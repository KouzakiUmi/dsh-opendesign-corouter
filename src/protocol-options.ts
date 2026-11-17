export const API_PROTOCOL_IDS = ['chat-completions', 'responses', 'messages'] as const;
export type ApiProtocol = typeof API_PROTOCOL_IDS[number];
export const API_PROTOCOL_SELECTION_IDS = ['auto', ...API_PROTOCOL_IDS] as const;
export type ProtocolSelection = typeof API_PROTOCOL_SELECTION_IDS[number];

/** Resolve a preference; unconfirmed routes use Responses by explicit product policy. */
export function effectiveProtocol(model: { nativeProtocol?: ApiProtocol }, selection: ProtocolSelection = 'auto', override?: ProtocolSelection): ApiProtocol {
  if (override !== undefined && override !== 'auto') return override;
  if (selection !== 'auto') return selection;
  return model.nativeProtocol ?? 'responses';
}

/** The public gateway origin and an explicit versioned API base are both accepted. */
export function openAiBaseURL(baseURL: string): string {
  const base = baseURL.replace(/\/+$/u, '');
  return new URL(base).pathname === '/' ? `${base}/v1` : base;
}

/** Shared by request builders and the settings preview so their paths cannot diverge. */
export function inferenceEndpoint(baseURL: string, protocol: ApiProtocol): string {
  const suffix = protocol === 'responses' ? '/responses' : protocol === 'messages' ? '/messages' : '/chat/completions';
  return baseURL.trim() === '' ? suffix : `${openAiBaseURL(baseURL.trim())}${suffix}`;
}

export const API_PROTOCOL_OPTIONS: readonly { id: ProtocolSelection; name: string; description: string }[] = [
  { id: 'auto', name: '自动（按模型）', description: '使用有证据的模型首选协议；未确认原生端口时使用 Responses，不保证网关无转译。' },
  { id: 'chat-completions', name: 'OpenAI Chat Completions', description: '使用 Chat Completions 请求与流式响应。' },
  { id: 'responses', name: 'OpenAI Responses', description: '使用 Responses 请求与流式响应。' },
  { id: 'messages', name: 'Anthropic Messages', description: '使用 Messages 请求与流式响应。' },
];
