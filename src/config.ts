import Schema from '@deepseek-ai/schemastery';
import { API_PROTOCOL_IDS, type ApiProtocol } from './protocol-options.js';
import { parseModelSettingsMap, type ModelSettingsMap } from './model-settings.js';
export const SETTINGS_NS = 'llm-opendesign-corouter';
export const PLAN_PROVIDER = 'opendesign-corouter-plan';
export const PAID_PROVIDER = 'opendesign-corouter-paid';
export const DEFAULT_BASE_URL = 'https://amr-link.open-design.ai/v1';
export const Config = Schema.object({
  apiKeyEnv: Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u).default('COROUTER_API_KEY').description('CoRouter API Key 的环境变量或 DSH 凭据引用名').volatile(),
  baseURL: Schema.transform(Schema.string(), value => assertBaseURL(value)).default(DEFAULT_BASE_URL).description('CoRouter 网关地址；不用于控制台登录或额度查询').volatile(),
  apiProtocol: Schema.union(API_PROTOCOL_IDS).default('chat-completions').description('推理 API 协议；模型发现始终使用 OpenAI models 接口').volatile(),
  modelSettings: Schema.transform(Schema.dict(Schema.any<unknown>()), value => parseModelSettingsMap(value)).default({}).description('逐模型启用状态和请求参数').volatile(),
  useDesktopCredential: Schema.boolean().default(true).description('优先读取 OpenDesign 桌面端登录态查询额度').volatile(),
  emptyTurnGuard: Schema.boolean().default(true).description('监控套餐赠送模型的空轮/协议残渣；由宿主重试策略处理，可能额外消耗赠送额度').volatile(),
  quotaRefreshSeconds: Schema.natural().min(5).max(3600).default(60).description('额度自动刷新间隔（秒）').volatile(),
  requestTimeoutMs: Schema.natural().min(1000).max(3600000).default(1800000).description('推理请求总超时（毫秒）').volatile(),
  streamIdleTimeoutMs: Schema.natural().min(1000).max(1800000).default(300000).description('流式响应无数据超时（毫秒）').volatile(),
});
export type LiveConfig = ReturnType<typeof Config>;
export interface RuntimeConfig {
  apiKeyEnv: string; baseURL: string; useDesktopCredential: boolean; emptyTurnGuard: boolean; requestTimeoutMs: number; streamIdleTimeoutMs: number;
  apiProtocol?: ApiProtocol;
  modelSettings?: ModelSettingsMap;
  quotaRefreshSeconds?: number;
}
export function assertBaseURL(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('推理 Base URL 必须是绝对 URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('推理 Base URL 不可包含凭据、查询串或片段');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非本机推理地址必须使用 HTTPS');
  return url.href.replace(/\/+$/u, '');
}
export function readConfig(config: LiveConfig): RuntimeConfig {
  return {
    apiKeyEnv: config.apiKeyEnv.get(), baseURL: assertBaseURL(config.baseURL.get()),
    apiProtocol: config.apiProtocol.get(), modelSettings: parseModelSettingsMap(config.modelSettings.get()),
    quotaRefreshSeconds: config.quotaRefreshSeconds.get(),
    useDesktopCredential: config.useDesktopCredential.get(), emptyTurnGuard: config.emptyTurnGuard.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(), streamIdleTimeoutMs: config.streamIdleTimeoutMs.get(),
  };
}
