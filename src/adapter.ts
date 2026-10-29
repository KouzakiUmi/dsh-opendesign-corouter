import { createHmac, randomBytes } from 'node:crypto';
import {
  IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ReasoningEffortId, assertUsableApiKey, requiredImageOffload,
  type GenerateOptions, type ImageBlock, type LlmModelInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { MODELS, type CatalogModel } from './catalog.js';
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, PLAN_PROVIDER, PAID_PROVIDER, type RuntimeConfig } from './config.js';
import { chatMessages, chatTools, estimateTokens } from './conversion.js';
import { gatewayError } from './stream.js';
import { combinedSignal } from './util.js';
import { EmptyTurnTracker } from './empty-turn.js';
import { OPENDESIGN_EOT } from './eot-code.js';
import { applyModelSettings, isModelEnabled, type ModelSettings } from './model-settings.js';
import { protocolFor } from './protocols/index.js';
import { PrematureEndError } from './protocols/errors.js';
import type { ApiProtocol } from './protocol-options.js';
import { modelReasoningEfforts } from './reasoning.js';
import { validateClaudeOutput, validateClaudeSampling } from './claude-parameters.js';
import { claudeOutputError, hasRestrictedClaudeSampling } from './claude-capabilities.js';

export interface AdapterOptions {
  config(): RuntimeConfig;
  models?(): readonly CatalogModel[];
  apiKey(ref: string, baseURL?: string): Promise<string | undefined>;
  imageDataUrl?(image: ImageAttachmentRef, signal: AbortSignal): Promise<string | undefined>;
  onEmptyTurn?(): void;
  fetch?: typeof fetch;
  /** Caller-owned random binding-secret bytes from the Host credential service. */
  replayBindingSecret?(signal: AbortSignal): Promise<Uint8Array>;
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
  const proposedReserve = setting?.maxTokens ?? outputReserve(row, config.apiProtocol ?? 'chat-completions');
  const reserve = claudeOutputError(row.id, config.apiProtocol ?? 'chat-completions', proposedReserve) === undefined ? proposedReserve : undefined;
  const efforts = modelReasoningEfforts(row, config.apiProtocol ?? 'chat-completions');
  const defaultEffort = setting?.reasoningEffort !== undefined && efforts?.includes(setting.reasoningEffort) ? setting.reasoningEffort : undefined;
  return {
    provider, id: row.id, name: row.name,
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.contextWindow === undefined ? {} : { context: { contextWindow: row.contextWindow } }),
    ...(reserve === undefined ? {} : { defaultMaxTokens: reserve }),
    ...(efforts?.length ? { reasoning: {
      efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: ({ none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '较高', ultra: '极高', max: '最高' } as Record<string, string>)[id] ?? id })),
      ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
    } } : {}),
  };
}
export class CoRouterAdapter extends LlmAdapter {
  readonly #lifetime = new AbortController();
  readonly #credentialSecret = randomBytes(32);
  constructor(readonly options: AdapterOptions) { super(); }
  dispose(): void {
    this.#lifetime.abort(new LlmError('CoRouter 插件已卸载', 'ABORTED'));
    this.#credentialSecret.fill(0);
  }
  async #credentialIdentity(baseURL: string, key: string, model: string, signal: AbortSignal): Promise<string> {
    let secret: Uint8Array | undefined;
    let abort: () => void = () => {};
    try {
      if (this.options.replayBindingSecret && hasRestrictedClaudeSampling(model, 'messages')) {
        const operation = this.options.replayBindingSecret(signal).then(bytes => {
          if (signal.aborted) { bytes.fill(0); throw new LlmError('Claude 回放绑定已取消', 'ABORTED'); }
          return bytes;
        });
        const aborted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new LlmError('Claude 回放绑定已取消', 'ABORTED'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        secret = await Promise.race([operation, aborted]);
      } else secret = Buffer.from(this.#credentialSecret);
      signal.throwIfAborted();
      if (secret.length !== 32) throw new Error('invalid binding');
      return createHmac('sha256', secret).update('opendesign-claude-replay-v1\0').update(new URL(baseURL).origin).update('\0').update(key).digest('hex');
    } catch {
      if (signal.aborted) throw new LlmError('Claude 回放绑定已取消', 'ABORTED');
      throw new LlmError('无法读取或安全保存 Claude 回放绑定密钥，请检查 DSH 凭据服务后重试。', 'INVALID_REQUEST');
    } finally { signal.removeEventListener('abort', abort); secret?.fill(0); }
  }
  override providerInfo(provider: string) {
    return { id: provider, name: group(provider) === 'plan' ? 'OpenDesign CoRouter · 套餐赠送' : 'OpenDesign CoRouter · 付费模型' };
  }
  private modelOf(provider: string, id: string, config: RuntimeConfig): CatalogModel {
    const row = (this.options.models?.() ?? MODELS).find(candidate => candidate.id === id);
    if (!row || row.group !== group(provider)) throw new LlmError('该模型不属于当前 CoRouter Provider；请刷新模型列表并选择对应通道', 'INVALID_REQUEST');
    if (!isModelEnabled(id, config.modelSettings)) throw new LlmError('该模型已在 CoRouter 设置中停用', 'MODEL_DISABLED');
    const configured = applyModelSettings(row, config.modelSettings?.[id]);
    const output = config.modelSettings?.[id]?.maxTokens;
    if (output !== undefined && configured.contextWindow !== undefined && output >= configured.contextWindow) throw new LlmError('模型最大输出必须小于当前总窗口（含输出预留），请调整模型参数', 'INVALID_REQUEST');
    return configured;
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options.config(), selectedGroup = group(provider);
    return (this.options.models?.() ?? MODELS).filter(row => row.group === selectedGroup && isModelEnabled(row.id, config.modelSettings))
      .map(row => {
        const effective = applyModelSettings(row, config.modelSettings?.[row.id]);
        return { provider, id: effective.id, name: effective.name, ...(effective.inputModalities ? { inputModalities: effective.inputModalities } : {}) };
      });
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
    const setting: ModelSettings = config.modelSettings?.[row.id] ?? {};
    const protocolId = config.apiProtocol ?? 'chat-completions';
    const effort = options.reasoningEffort ?? (setting.reasoningEffort ? ReasoningEffortId(setting.reasoningEffort) : undefined);
    if (effort !== undefined && !modelReasoningEfforts(row, protocolId)?.includes(effort)) throw new LlmError('所选思考深度不适用于当前模型或协议；请修改默认值或选择其他档位', 'UNSUPPORTED_OPTION');
    if (protocolId === 'messages') {
      validateClaudeSampling(row.id, options.temperature ?? setting.temperature, setting.topP);
      validateClaudeOutput(row.id, options.maxTokens ?? setting.maxTokens);
    }
    const raw = await this.options.apiKey(config.apiKeyEnv, config.baseURL);
    if (!raw) throw new LlmError('未配置当前网关的推理凭据；请完成设备授权或配置对应 API Key', 'MISSING_CREDENTIAL');
    const key = assertUsableApiKey(raw, 'dsh-opendesign-corouter', config.apiKeyEnv);
    signal.throwIfAborted();
    let credentialIdentity: string | undefined;
    if (protocolId === 'messages') {
      try { credentialIdentity = await this.#credentialIdentity(config.baseURL, key, row.id, signal); }
      catch (error) {
        if (signal.aborted && !options.signal?.aborted && !this.#lifetime.signal.aborted) throw new LlmError('CoRouter 请求超过总超时', 'TIMEOUT');
        throw error;
      }
    }
    const images = new Map<string, string>();
    const attemptedImages = new Set<string>();
    const unreadableImages = new Set<string>();
    // Match the Host's contract: an absent modality list is unknown, not text-only.
    if (row.inputModalities === undefined || row.inputModalities.includes('image')) for (const message of options.messages.filter(item => item.role === 'user' || item.role === 'tool')) for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded || attemptedImages.has(block.attachment.attachmentId)) continue;
      attemptedImages.add(block.attachment.attachmentId);
      try {
        const url = await this.options.imageDataUrl?.(block.attachment, signal);
        signal.throwIfAborted();
        if (url) images.set(block.attachment.attachmentId, url);
        else unreadableImages.add(block.attachment.attachmentId);
      } catch {
        // A missing image becomes the named placeholder; cancellation must still stop the call.
        signal.throwIfAborted();
        unreadableImages.add(block.attachment.attachmentId);
      }
    }
    signal.throwIfAborted();
    // Keep zero-byte/unreadable occurrences in order: the Host offloads the oldest
    // surface occurrences, not just the attachments this request could read.
    const imageMessages = options.messages.filter(message => message.role === 'user' || message.role === 'tool');
    const imageBytes = (block: ImageBlock): number => Buffer.byteLength(images.get(block.attachment.attachmentId) ?? '', 'utf8');
    // The URL already includes base64 encoding; do not expand its byte count again.
    const offloadCount = (maxBytes: number): number => requiredImageOffload(imageMessages, { representation: 'raw', maxBytes }, imageBytes);
    const overBudget = offloadCount(config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES);
    if (overBudget > 0) throw new LlmError('OpenDesign：图片请求超出字节预算，需要退载较早图片后重试', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: overBudget });
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
    const effective: GenerateOptions = {
      ...projectedOptions,
      ...((options.temperature ?? setting.temperature) === undefined ? {} : { temperature: options.temperature ?? setting.temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
    const protocol = protocolFor(protocolId);
    const request = protocol.build({ baseURL: config.baseURL, apiKey: key, model: row, options: effective, images,
      ...(credentialIdentity === undefined ? {} : { credentialIdentity }), ...(setting.topP === undefined ? {} : { topP: setting.topP }) });
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
      signal.throwIfAborted();
      const failure = gatewayError(response.status, error);
      if (response.status === 413 && failure.code === 'REQUEST_TOO_LARGE') {
        const totalImageBytes = imageMessages.reduce((total, message) => total + message.content.reduce((sum, block) =>
          sum + (block.type === 'image' && !block.offloaded ? imageBytes(block) : 0), 0), 0);
        if (totalImageBytes > 0) {
          const offloadImages = offloadCount(Math.max(0, totalImageBytes - 4 * 1024 * 1024));
          if (offloadImages > 0) throw new LlmError('OpenDesign：请求体过大，需要退载较早图片后重试', IMAGE_OFFLOAD_REQUIRED_CODE, { status: 413, offloadImages });
        }
      }
      throw failure;
    }
    const monitor = row.group === 'plan' && row.id === 'deepseek-v4.1-flash' && config.emptyTurnGuard && Boolean(options.tools?.length);
    const reportEmptyTurn = () => {
      try { this.options.onEmptyTurn?.(); } catch { /* Diagnostic callbacks must not change the request outcome. */ }
    };
    if (!response.body) {
      if (monitor) reportEmptyTurn();
      throw new LlmError('CoRouter 返回空响应', monitor ? OPENDESIGN_EOT : 'EMPTY_RESPONSE');
    }
    const tracker = new EmptyTurnTracker({ enabled: monitor, onEmptyTurn: reportEmptyTurn });
    try {
      for await (const chunk of protocol.stream(response.body, signal, config.streamIdleTimeoutMs, {
        provider: options.provider, model: options.model, baseURL: config.baseURL,
        ...(credentialIdentity === undefined ? {} : { credentialIdentity }),
      })) {
        signal.throwIfAborted();
        tracker.observe(chunk);
        if (chunk.type === 'finish') {
          const reason = monitor ? tracker.resolve(chunk.reason) : chunk.reason;
          if (reason.kind === 'error' || reason.kind === 'aborted') yield { type: 'finish', reason };
          else yield { ...chunk, reason };
        } else yield chunk;
      }
    } catch (error) {
      if (options.signal?.aborted || this.#lifetime.signal.aborted) signal.throwIfAborted();
      if (signal.aborted) throw new LlmError('CoRouter 请求超过总超时', 'TIMEOUT');
      // A missing terminal is recoverable before any tool block; leave retry limits and
      // cancellation to the Host, and keep all other malformed responses unchanged.
      const retryOpusMessages = protocolId === 'messages' && row.group === 'paid' && row.id === 'claude-opus-5.5';
      if ((monitor || retryOpusMessages) && !tracker.sawToolCall && error instanceof PrematureEndError) throw new LlmError(error.message, 'TRANSPORT');
      if (monitor && !tracker.sawToolCall && error instanceof LlmError && error.code === 'EMPTY_RESPONSE') {
        reportEmptyTurn();
        throw new LlmError(error.message, OPENDESIGN_EOT);
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError('CoRouter 响应流连接中断', 'SERVER');
    }
  }
}
