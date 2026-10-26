import {
  LlmAdapter, LlmError, ReasoningEffortId, assertUsableApiKey,
  type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { MODELS, type CatalogModel } from './catalog.js';
import { PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from './config.js';
import { chatMessages, chatTools, estimateTokens } from './conversion.js';
import { gatewayError } from './stream.js';
import { combinedSignal } from './util.js';
import { EmptyTurnTracker } from './empty-turn.js';
import { applyModelSettings, isModelEnabled, type ModelSettings } from './model-settings.js';
import { protocolFor } from './protocols/index.js';
import type { ApiProtocol } from './protocol-options.js';

export interface AdapterOptions {
  config(): RuntimeConfig;
  models?(): readonly CatalogModel[];
  apiKey(ref: string, baseURL?: string): Promise<string | undefined>;
  imageDataUrl?(image: ImageAttachmentRef, signal: AbortSignal): Promise<string | undefined>;
  onEmptyTurn?(): void;
  fetch?: typeof fetch;
}
function group(provider: string): 'plan' | 'paid' {
  if (provider === PLAN_PROVIDER) return 'plan';
  if (provider === PAID_PROVIDER) return 'paid';
  throw new LlmError('未知的 CoRouter Provider', 'INVALID_REQUEST');
}
function outputReserve(model: CatalogModel, protocol: ApiProtocol): number | undefined {
  const limit = model.maxOutputTokens ?? (protocol === 'messages' ? 4096 : undefined);
  return limit === undefined ? undefined : model.contextWindow === undefined ? limit : Math.min(limit, Math.floor(model.contextWindow / 4));
}
function metadata(provider: string, row: CatalogModel, config: RuntimeConfig): LlmResolvedModelInfo {
  const setting = config.modelSettings?.[row.id];
  const reserve = setting?.maxTokens ?? outputReserve(row, config.apiProtocol ?? 'chat-completions');
  const efforts = row.reasoningEfforts ?? (setting?.reasoningEffort ? [setting.reasoningEffort] : undefined);
  return {
    provider, id: row.id, name: row.name,
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.contextWindow === undefined ? {} : { context: { contextWindow: row.contextWindow - (reserve ?? 0) } }),
    ...(reserve === undefined ? {} : { defaultMaxTokens: reserve }),
    ...(efforts?.length ? { reasoning: {
      efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: ({ none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '较高', ultra: '极高', max: '最高' } as Record<string, string>)[id] ?? id })),
      ...(setting?.reasoningEffort ? { defaultEffort: ReasoningEffortId(setting.reasoningEffort) } : {}),
    } } : {}),
  };
}
export class CoRouterAdapter extends LlmAdapter {
  readonly #lifetime = new AbortController();
  constructor(readonly options: AdapterOptions) { super(); }
  dispose(): void { this.#lifetime.abort(new LlmError('CoRouter 插件已卸载', 'ABORTED')); }
  override providerInfo(provider: string) {
    return { id: provider, name: group(provider) === 'plan' ? 'OpenDesign CoRouter · 套餐赠送' : 'OpenDesign CoRouter · 付费模型' };
  }
  private modelOf(provider: string, id: string, config: RuntimeConfig): CatalogModel {
    const row = (this.options.models?.() ?? MODELS).find(candidate => candidate.id === id);
    if (!row || row.group !== group(provider)) throw new LlmError('该模型不属于当前 CoRouter Provider；请刷新模型列表并选择对应通道', 'INVALID_REQUEST');
    if (!isModelEnabled(id, config.modelSettings)) throw new LlmError('该模型已在 CoRouter 设置中停用', 'MODEL_DISABLED');
    const configured = applyModelSettings(row, config.modelSettings?.[id]);
    const output = config.modelSettings?.[id]?.maxTokens;
    if (output !== undefined && configured.contextWindow !== undefined && output >= configured.contextWindow) throw new LlmError('模型最大输出必须小于上下文预算，请调整模型参数', 'INVALID_REQUEST');
    return configured;
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options.config(), selectedGroup = group(provider);
    return (this.options.models?.() ?? MODELS).filter(row => row.group === selectedGroup && isModelEnabled(row.id, config.modelSettings))
      .map(row => ({ provider, id: row.id, name: row.name, ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}) }));
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted();
    const config = this.options.config();
    return metadata(provider, this.modelOf(provider, model, config), config);
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted();
    const config = this.options.config(), row = this.modelOf(provider, model, config);
    return { model: metadata(provider, row, config), stream: options => this.#stream(options, config, row) };
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = this.options.config();
    return this.#stream(options, config, this.modelOf(options.provider, options.model, config));
  }
  async *#stream(options: GenerateOptions, config: RuntimeConfig, row: CatalogModel): AsyncGenerator<StreamChunk> {
    const signal = AbortSignal.any([combinedSignal(options.signal, config.requestTimeoutMs), this.#lifetime.signal]);
    signal.throwIfAborted();
    const raw = await this.options.apiKey(config.apiKeyEnv, config.baseURL);
    if (!raw) throw new LlmError('未配置当前网关的推理凭据；请完成设备授权或配置对应 API Key', 'MISSING_CREDENTIAL');
    const key = assertUsableApiKey(raw, 'dsh-opendesign-corouter', config.apiKeyEnv);
    const setting: ModelSettings = config.modelSettings?.[row.id] ?? {};
    const protocolId = config.apiProtocol ?? 'chat-completions';
    const images = new Map<string, string>();
    const attemptedImages = new Set<string>();
    const unreadableImages = new Set<string>();
    if (row.inputModalities?.includes('image') && this.options.imageDataUrl) for (const message of options.messages.filter(item => item.role === 'user' || item.role === 'tool')) for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded || attemptedImages.has(block.attachment.attachmentId)) continue;
      attemptedImages.add(block.attachment.attachmentId);
      try {
        const url = await this.options.imageDataUrl(block.attachment, signal);
        signal.throwIfAborted();
        if (url) images.set(block.attachment.attachmentId, url);
        else unreadableImages.add(block.attachment.attachmentId);
      } catch {
        // A missing image becomes the named placeholder; cancellation must still stop the call.
        signal.throwIfAborted();
        unreadableImages.add(block.attachment.attachmentId);
      }
    }
    const projectedOptions: GenerateOptions = unreadableImages.size === 0 ? options : {
      ...options,
      messages: options.messages.map(message => message.role !== 'user' && message.role !== 'tool' ? message : {
        ...message,
        content: message.content.map(block => block.type === 'image' && !block.offloaded && unreadableImages.has(block.attachment.attachmentId)
          ? { type: 'text' as const, text: `[Image ${JSON.stringify(block.attachment.name ?? 'attachment')} could not be read; attachment ${block.attachment.attachmentId}. The model's image capability has not changed.]` }
          : block),
      }),
    };
    const messages = chatMessages(projectedOptions, ref => images.get(ref.attachmentId), row.id.startsWith('deepseek-') || row.id.startsWith('kimi-'));
    const tools = chatTools(options);
    let maxTokens = options.maxTokens ?? setting.maxTokens ?? outputReserve(row, protocolId);
    if (maxTokens !== undefined) {
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new LlmError('maxTokens 必须是正整数', 'INVALID_REQUEST');
      const capped = Math.min(maxTokens, row.maxOutputTokens ?? maxTokens);
      const room = row.contextWindow === undefined ? capped : row.contextWindow - estimateTokens({ messages, tools });
      if (room < 1) throw new LlmError('当前输入没有为输出留下上下文空间', 'CONTEXT_WINDOW_EXCEEDED');
      maxTokens = Math.min(capped, Math.floor(room));
    }
    const effort = options.reasoningEffort ?? (setting.reasoningEffort ? ReasoningEffortId(setting.reasoningEffort) : undefined);
    if (effort !== undefined && row.reasoningEfforts && !row.reasoningEfforts.includes(effort)) throw new LlmError('该模型不支持所选思考深度', 'UNSUPPORTED_OPTION');
    const effective: GenerateOptions = {
      ...projectedOptions,
      ...((options.temperature ?? setting.temperature) === undefined ? {} : { temperature: options.temperature ?? setting.temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
    const protocol = protocolFor(protocolId);
    const request = protocol.build({ baseURL: config.baseURL, apiKey: key, model: row, options: effective, images, ...(setting.topP === undefined ? {} : { topP: setting.topP }) });
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal, redirect: 'error',
      });
    } catch {
      if (options.signal?.aborted || this.#lifetime.signal.aborted) signal.throwIfAborted();
      throw new LlmError(signal.aborted ? 'CoRouter 请求超过总超时' : '无法连接 CoRouter 推理服务', signal.aborted ? 'TIMEOUT' : 'SERVER');
    }
    if (!response.ok) {
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
        } catch { /* Untrusted non-JSON errors are not projected. */ }
        finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      throw gatewayError(response.status, error);
    }
    if (!response.body) throw new LlmError('CoRouter 返回空响应', 'EMPTY_RESPONSE');
    const tracker = new EmptyTurnTracker({ enabled: row.group === 'plan' && config.emptyTurnGuard && Boolean(options.tools?.length), onEmptyTurn: () => this.options.onEmptyTurn?.() });
    try {
      for await (const chunk of protocol.stream(response.body, signal, config.streamIdleTimeoutMs)) {
        tracker.observe(chunk);
        if (chunk.type === 'finish' && row.group === 'plan' && config.emptyTurnGuard) yield { ...chunk, reason: tracker.resolve(chunk.reason) };
        else yield chunk;
      }
    } catch (error) {
      if (options.signal?.aborted || this.#lifetime.signal.aborted) signal.throwIfAborted();
      if (signal.aborted) throw new LlmError('CoRouter 请求超过总超时', 'TIMEOUT');
      if (error instanceof LlmError) throw error;
      throw new LlmError('CoRouter 响应流连接中断', 'SERVER');
    }
  }
}
