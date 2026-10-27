/**
 * 协议模块的公共契约。
 *
 * 适配器只负责：选定模型、准备凭据、解析图片、收敛 `maxTokens`、合并每模型默认值，
 * 然后把一次调用的**全部输入**交给协议模块。协议模块独占三件事：请求 URL/头/体、
 * 流式事件到 `StreamChunk` 的翻译、以及该协议的错误信封。
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CatalogModel } from '../catalog.js';
import type { ApiProtocol } from '../protocol-options.js';

/** 一次推理调用的协议无关输入。 */
export interface ProtocolContext {
  /** 上游 Base URL（已校验为绝对地址，去尾斜杠）。 */
  baseURL: string;
  /** 已校验可用的凭据。 */
  apiKey: string;
  /** 本次调用的目录模型（能力、限额来源）。 */
  model: CatalogModel;
  /** 已由适配器合并每模型默认值的请求。 */
  options: GenerateOptions;
  /** 附件 id → 可直接放进请求体的图片 URL。 */
  images: ReadonlyMap<string, string>;
  /** 每模型可选 `top_p`；未设置时不发送。 */
  topP?: number;
  /** Keyed credential/origin binding; adapter-private and never sent upstream. */
  credentialIdentity?: string;
}

/** 一个可直接 fetch 的请求。 */
export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Prepared request identity; contains no transport credentials. */
export interface ProtocolStreamContext {
  provider: string;
  model: string;
  baseURL: string;
  credentialIdentity?: string;
}

/** 一种线协议的实现。 */
export interface Protocol {
  readonly id: ApiProtocol;
  /** 把协议无关调用投影成本协议的请求。 */
  build(ctx: ProtocolContext): WireRequest;
  /** 把上游 SSE 响应体翻译成 DSH 流式块。 */
  stream(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleMs: number, context?: ProtocolStreamContext): AsyncIterable<StreamChunk>;
}
