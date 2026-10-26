/**
 * 三种线协议的公开入口。
 *
 * 模型发现（OpenAI `GET /models`）与推理协议解耦：无论这里选中哪种协议，
 * 目录拉取始终走 OpenAI 兼容端口，见 `model-discovery.ts`。
 */

import { LlmError } from '@deepseek-ai/dsh-llm';
import type { ApiProtocol } from '../protocol-options.js';
import { chatCompletions } from './chat-completions.js';
import { messages } from './messages.js';
import { responses } from './responses.js';
import type { Protocol } from './types.js';

const PROTOCOLS: Readonly<Record<ApiProtocol, Protocol>> = {
  'chat-completions': chatCompletions,
  responses,
  messages,
};

/**
 * 按配置 id 取协议实现。
 *
 * @param id 设置里保存的协议 id（来自固定三种）。
 * @throws {LlmError} 配置里出现未知 id（例如降级安装保留了更新版本的设置）。
 */
export function protocolFor(id: ApiProtocol): Protocol {
  const protocol = PROTOCOLS[id];
  if (!protocol) throw new LlmError(`未知的推理协议：${String(id)}`, 'INVALID_REQUEST');
  return protocol;
}

export type { Protocol, ProtocolContext, WireRequest } from './types.js';
export { MESSAGES_DEFAULT_MAX_TOKENS, messagesURL } from './messages.js';
