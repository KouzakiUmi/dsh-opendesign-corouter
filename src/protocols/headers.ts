/**
 * 三种推理协议共用的请求头。
 *
 * 每个上游请求都必须携带应用归因头（`attributionHeaders()`）；鉴权一律走
 * `Authorization: Bearer`——CoRouter 官方站点对 OpenAI 兼容调用与 Claude Code
 * （`ANTHROPIC_AUTH_TOKEN`）都使用该头，因此 Messages 协议不额外发送第二个密钥头。
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm';

/**
 * 构造流式推理请求头。
 *
 * @param apiKey 已由适配器校验可用的凭据；此处只做拼接，不回显、不记录。
 * @param extra 协议专属头（如 `anthropic-version`）。
 */
export function streamHeaders(apiKey: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    ...attributionHeaders(),
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...extra,
  };
}
