export const API_PROTOCOL_IDS = ['chat-completions', 'responses', 'messages'] as const;
export type ApiProtocol = typeof API_PROTOCOL_IDS[number];

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

export const API_PROTOCOL_OPTIONS: readonly { id: ApiProtocol; name: string; description: string }[] = [
  { id: 'chat-completions', name: 'OpenAI Chat Completions', description: '使用 Chat Completions 请求与流式响应。' },
  { id: 'responses', name: 'OpenAI Responses', description: '使用 Responses 请求与流式响应。' },
  { id: 'messages', name: 'Anthropic Messages', description: '使用 Messages 请求与流式响应。' },
];
