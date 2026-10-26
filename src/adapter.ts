import {
  LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, assertUsableApiKey,
  type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { modelsFor, findModel, type CatalogModel } from './catalog.js';
import { PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from './config.js';
import { chatMessages, chatTools, estimateTokens } from './conversion.js';
import { consumeSse, gatewayError } from './stream.js';
import { combinedSignal } from './util.js';
import { EmptyTurnTracker } from './empty-turn.js';

export interface AdapterOptions {
  config(): RuntimeConfig;
  apiKey(ref: string): Promise<string | undefined>;
  imageDataUrl?(image: ImageAttachmentRef, signal: AbortSignal): Promise<string | undefined>;
  onEmptyTurn?(): void;
  fetch?: typeof fetch;
}
function group(provider: string): 'plan' | 'paid' {
  if (provider === PLAN_PROVIDER) return 'plan';
  if (provider === PAID_PROVIDER) return 'paid';
  throw new LlmError('未知的 CoRouter Provider', 'INVALID_REQUEST');
}
function modelOf(provider: string, id: string): CatalogModel {
  const model = findModel(id);
  if (!model || model.group !== group(provider)) throw new LlmError('该模型不属于当前 CoRouter Provider；请在模型选择器中选择对应通道', 'INVALID_REQUEST');
  return model;
}
function outputReserve(model: CatalogModel): number | undefined {
  return model.maxOutputTokens === undefined ? undefined : model.contextWindow === undefined ? model.maxOutputTokens : Math.min(model.maxOutputTokens, Math.floor(model.contextWindow / 4));
}
function metadata(provider: string, row: CatalogModel): LlmResolvedModelInfo {
  const reserve = outputReserve(row);
  return {
    provider, id: row.id, name: row.name,
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.contextWindow === undefined ? {} : { context: { contextWindow: row.contextWindow - (reserve ?? 0) } }),
    ...(reserve === undefined ? {} : { defaultMaxTokens: reserve }),
    ...(row.reasoningEfforts?.length ? { reasoning: { efforts: row.reasoningEfforts.map(id => ({ id: ReasoningEffortId(id), name: ({ none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '较高', ultra: '极高', max: '最高' } as Record<string, string>)[id] ?? id })) } } : {}),
  };
}
export class CoRouterAdapter extends LlmAdapter {
  readonly #lifetime = new AbortController();
  constructor(readonly options: AdapterOptions) { super(); }
  dispose(): void { this.#lifetime.abort(new LlmError('CoRouter 插件已卸载', 'ABORTED')); }
  override providerInfo(provider: string) {
    return { id: provider, name: group(provider) === 'plan' ? 'OpenDesign CoRouter · 套餐赠送' : 'OpenDesign CoRouter · 付费模型' };
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return modelsFor(group(provider)).map(row => ({ provider, id: row.id, name: row.name, ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}) }));
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted();
    return metadata(provider, modelOf(provider, model));
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted();
    const config = this.options.config(), row = modelOf(provider, model);
    return { model: metadata(provider, row), stream: options => this.#stream(options, config, row) };
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.#stream(options, this.options.config(), modelOf(options.provider, options.model));
  }
  async *#stream(options: GenerateOptions, config: RuntimeConfig, row: CatalogModel): AsyncGenerator<StreamChunk> {
    const signal = AbortSignal.any([combinedSignal(options.signal, config.requestTimeoutMs), this.#lifetime.signal]);
    signal.throwIfAborted();
    const raw = await this.options.apiKey(config.apiKeyEnv);
    if (!raw) throw new LlmError('未配置 CoRouter API Key；请在插件设置中保存或设置对应环境变量', 'MISSING_CREDENTIAL');
    const key = assertUsableApiKey(raw, 'dsh-opendesign-corouter', config.apiKeyEnv);
    const images = new Map<string, string>();
    if (row.inputModalities?.includes('image') && this.options.imageDataUrl) for (const message of options.messages.filter(row => row.role === 'user' || row.role === 'tool')) for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded || images.has(block.attachment.attachmentId)) continue;
      const url = await this.options.imageDataUrl(block.attachment, signal);
      if (url) images.set(block.attachment.attachmentId, url);
    }
    const messages = chatMessages(options, ref => images.get(ref.attachmentId), row.id.startsWith('deepseek-') || row.id.startsWith('kimi-'));
    const tools = chatTools(options);
    const body: Record<string, unknown> = { model: row.id, messages, stream: true, stream_options: { include_usage: true }, ...(tools ? { tools } : {}) };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    const requested = options.maxTokens ?? outputReserve(row);
    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested <= 0) throw new LlmError('maxTokens 必须是正整数', 'INVALID_REQUEST');
      const capped = Math.min(requested, row.maxOutputTokens ?? requested);
      const room = row.contextWindow === undefined ? capped : row.contextWindow - estimateTokens({ messages, tools });
      if (room < 1) throw new LlmError('当前输入没有为输出留下上下文空间', 'CONTEXT_WINDOW_EXCEEDED');
      body.max_tokens = Math.min(capped, Math.floor(room));
    }
    if (options.reasoningEffort !== undefined) {
      if (row.reasoningEfforts && !row.reasoningEfforts.includes(options.reasoningEffort)) throw new LlmError('该模型不支持所选思考深度', 'UNSUPPORTED_OPTION');
      body.reasoning_effort = options.reasoningEffort;
    }
    if (options.stop?.length) body.stop = options.stop;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${config.baseURL}/chat/completions`, {
        method: 'POST', headers: { ...attributionHeaders(), authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal, redirect: 'error',
      });
    } catch {
      if (options.signal?.aborted || this.#lifetime.signal.aborted) signal.throwIfAborted();
      throw new LlmError(signal.aborted ? 'CoRouter 请求超过总超时' : '无法连接 CoRouter 推理服务', signal.aborted ? 'TIMEOUT' : 'SERVER');
    }
    if (!response.ok) {
      // Only parse bounded JSON for taxonomy; no upstream text enters logs/errors.
      let error: unknown = {};
      const reader = response.body?.getReader();
      if (reader) {
        let size = 0, raw = '';
        const decoder = new TextDecoder();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) { raw = ''; break; }
            raw += decoder.decode(chunk.value, { stream: true });
          }
          if (raw) error = JSON.parse(raw + decoder.decode());
        } catch { /* Non-JSON/error bodies are deliberately not projected. */ }
        finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      throw gatewayError(response.status, error);
    }
    if (!response.body) throw new LlmError('CoRouter 返回空响应', 'EMPTY_RESPONSE');
    const tracker = new EmptyTurnTracker({ enabled: row.group === 'plan' && config.emptyTurnGuard && Boolean(options.tools?.length), onEmptyTurn: () => this.options.onEmptyTurn?.() });
    try {
      for await (const chunk of consumeSse(response.body, signal, config.streamIdleTimeoutMs)) {
        tracker.observe(chunk);
        if (chunk.type === 'finish' && row.group === 'plan' && config.emptyTurnGuard) {
          const reason = tracker.resolve(chunk.reason);
          yield { ...chunk, reason };
        } else yield chunk;
      }
    } catch (error) {
      if (options.signal?.aborted || this.#lifetime.signal.aborted) signal.throwIfAborted();
      if (signal.aborted) throw new LlmError('CoRouter 请求超过总超时', 'TIMEOUT');
      if (error instanceof LlmError) throw error;
      throw new LlmError('CoRouter 响应流连接中断', 'SERVER');
    }
  }
}
