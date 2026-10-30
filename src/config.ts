import Schema from '@deepseek-ai/schemastery';
import { API_PROTOCOL_IDS, type ApiProtocol } from './protocol-options.js';
import { parseModelSettingsMap, type ModelSettingsMap } from './model-settings.js';
import { serializableTransform } from './schema-serialization.js';
import { parseModelCatalogSnapshot, type ModelCatalogSnapshot } from './model-catalog-snapshot.js';
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, MAX_REQUEST_IMAGE_BYTES, MIN_REQUEST_IMAGE_BYTES } from './image-budget.js';
export { DEFAULT_MAX_REQUEST_IMAGE_BYTES } from './image-budget.js';
export const SETTINGS_NS = 'llm-opendesign-corouter';
export const PLAN_PROVIDER = 'opendesign-corouter-plan';
export const PAID_PROVIDER = 'opendesign-corouter-paid';
export const DEFAULT_BASE_URL = 'https://amr-link.open-design.ai/v1';
export const Config = Schema.object({
  apiKeyEnv: Schema.string().max(128).pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u).default('COROUTER_API_KEY').description('CoRouter API Key 的环境变量或 DSH 凭据引用名').volatile(),
  baseURL: Schema.transform(Schema.string(), serializableTransform(assertBaseURL)).default(DEFAULT_BASE_URL).description('CoRouter 网关地址；不用于控制台登录或额度查询').volatile(),
  apiProtocol: Schema.union(API_PROTOCOL_IDS).default('chat-completions').description('网关支持的推理协议；模型目录通过该网关的兼容接口读取').volatile(),
  modelSettings: Schema.transform(Schema.dict(Schema.any<unknown>()), serializableTransform(parseModelSettingsMap)).default({}).description('逐模型启用状态、图片输入和请求参数').volatile(),
  modelCatalog: Schema.transform(Schema.any<unknown>(), serializableTransform(parseModelCatalogSnapshot)).description('上次成功读取的网关模型目录快照；重启后继续使用，直到再次刷新').volatile(),
  useDesktopCredential: Schema.boolean().default(true).description('优先读取 OpenDesign 桌面端登录态查询额度').volatile(),
  emptyTurnGuard: Schema.boolean().default(true).description('保护 DeepSeek V4.1 Flash 工具对话：恢复空回答与已知协议残留结束').volatile(),
  turnCompletionReview: Schema.boolean().default(false).description('回复结束后追加有界的结构化收尾核验，要求模型调用收尾工具报告状态').volatile(),
  turnReviewMaxContinuations: Schema.natural().min(1).max(10).default(3).description('每轮任务的收尾核验最多续办次数').volatile(),
  turnReviewNoProgressLimit: Schema.natural().min(1).max(5).default(2).description('连续缺少新成功工具结果时停止收尾续办的次数').volatile(),
  quotaRefreshSeconds: Schema.natural().min(5).max(3600).default(60).description('额度自动刷新间隔（秒）').volatile(),
  requestTimeoutMs: Schema.natural().min(1000).max(3600000).default(1800000).description('推理请求总超时（毫秒）').volatile(),
  streamIdleTimeoutMs: Schema.natural().min(1000).max(1800000).default(300000).description('流式响应无数据超时（毫秒）').volatile(),
  maxRequestImageBytes: Schema.natural().min(MIN_REQUEST_IMAGE_BYTES).max(MAX_REQUEST_IMAGE_BYTES).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).description('单次请求的内联图片预算（字节）').volatile(),
});
export type LiveConfig = ReturnType<typeof Config>;
export interface RuntimeConfig {
  apiKeyEnv: string; baseURL: string; useDesktopCredential: boolean; emptyTurnGuard: boolean; requestTimeoutMs: number; streamIdleTimeoutMs: number;
  apiProtocol?: ApiProtocol;
  modelSettings?: ModelSettingsMap;
  modelCatalog?: ModelCatalogSnapshot;
  quotaRefreshSeconds?: number;
  maxRequestImageBytes?: number;
  turnCompletionReview?: boolean;
  turnReviewMaxContinuations?: number;
  turnReviewNoProgressLimit?: number;
}
// Schemastery serializes transform callbacks as source; keep this function closure-free.
export function assertBaseURL(raw: string): string {
  if (raw.length > 2048) throw new Error('推理 Base URL 最多允许 2048 字符');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('推理 Base URL 必须是绝对 URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('推理 Base URL 不可包含凭据、查询串或片段');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非本机推理地址必须使用 HTTPS');
  const normalized = url.href.replace(/\/+$/u, '');
  if (normalized.length > 2048) throw new Error('推理 Base URL 最多允许 2048 字符');
  return normalized;
}
export function readConfig(config: LiveConfig): RuntimeConfig {
  const modelCatalog = parseModelCatalogSnapshot(config.modelCatalog.get());
  return {
    apiKeyEnv: config.apiKeyEnv.get(), baseURL: assertBaseURL(config.baseURL.get()),
    apiProtocol: config.apiProtocol.get(), modelSettings: parseModelSettingsMap(config.modelSettings.get()),
    ...(modelCatalog === undefined ? {} : { modelCatalog }),
    quotaRefreshSeconds: config.quotaRefreshSeconds.get(),
    useDesktopCredential: config.useDesktopCredential.get(), emptyTurnGuard: config.emptyTurnGuard.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(), streamIdleTimeoutMs: config.streamIdleTimeoutMs.get(),
    maxRequestImageBytes: config.maxRequestImageBytes.get(),
    turnCompletionReview: config.turnCompletionReview.get(),
    turnReviewMaxContinuations: config.turnReviewMaxContinuations.get(), turnReviewNoProgressLimit: config.turnReviewNoProgressLimit.get(),
  };
}
