/**
 * OpenAI Chat Completions 协议（既有实现的唯一包装点）。
 *
 * 请求投影继续复用 `conversion.ts` 的 chat 消息/工具投影与思考回放规则；
 * 流式解析继续复用 `stream.ts#consumeSse`，因此该协议的行为与拆分前完全一致。
 */

import { LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { chatMessages, chatTools } from '../conversion.js';
import { consumeSse } from '../stream.js';
import { streamHeaders } from './headers.js';
import { inferenceEndpoint } from '../protocol-options.js';
import type { Protocol, ProtocolContext, WireRequest } from './types.js';

/** 构造 Chat Completions 请求。 */
export function buildChatCompletionsRequest(ctx: ProtocolContext): WireRequest {
  const { options, model } = ctx;
  const replayReasoning = model.id.startsWith('deepseek-') || model.id.startsWith('kimi-');
  const messages = chatMessages(options, ref => ctx.images.get(ref.attachmentId), replayReasoning);
  const tools = chatTools(options);
  const body: Record<string, unknown> = { model: model.id, messages, stream: true, stream_options: { include_usage: true } };
  if (tools) body.tools = tools;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (ctx.topP !== undefined) body.top_p = ctx.topP;
  if (options.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) throw new LlmError('maxTokens 必须是正整数', 'INVALID_REQUEST');
    body.max_tokens = options.maxTokens;
  }
  if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort;
  if (options.stop?.length) body.stop = options.stop;
  return { url: inferenceEndpoint(ctx.baseURL, 'chat-completions'), headers: streamHeaders(ctx.apiKey), body };
}

export const chatCompletions: Protocol = {
  id: 'chat-completions',
  build: buildChatCompletionsRequest,
  stream(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleMs: number): AsyncIterable<StreamChunk> {
    return consumeSse(body, signal, idleMs);
  },
};
