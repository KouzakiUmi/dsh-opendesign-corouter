/**
 * 上游失败的稳定分类。
 *
 * 三种协议的信封不同，但对外只暴露固定的中文文字与机器码；上游 `message`、请求头、
 * 凭据与响应体一律不进入错误文字，避免密钥或第三方内容进入日志与 UI。
 *
 * 判定顺序（前者优先）：
 * 1. 信封内结构化的 `code` / `type`：只认明确的枚举式写法；
 * 2. 主题明确的 `message`：上下文溢出、额度耗尽、限流、超时、服务端、认证/权限；
 * 3. HTTP 状态：仅作为补充事实，不覆盖上面更具体的分类；唯一例外是 5xx——
 *    没有结构化代码时直接按服务端处理（504 仍按超时），不因正文措辞改判。
 *
 * 关键取舍：
 * - 额度分两池：套餐/订阅/账户额度 → `ACCOUNT_QUOTA`；钱包/充值/积分/余额 → `QUOTA`。
 *   只有“额度不足”而没有池信息时按账户额度处理。
 * - 普通 401/403 只表达认证或权限语义（`AUTH` / `PERMISSION`），不推断 API Key 无效；
 *   只有上游明确点名 Key/凭据无效或缺失（结构化 code 或明确文案）才是 `INVALID_CREDENTIAL`。
 *   结构化只给出认证/权限语义时，点名 Key 的明确文案可以把结论细化为凭据错误。
 * - `quota` / `context` 单独出现只是背景词；必须同时出现“耗尽/超出”等语义才算数，
 *   因此 `rate_limit_exceeded` 不会被泛化成额度不足，也不会因为正文提到“上下文缓存”而误判。
 * - HTTP 状态与结构化错误冲突时以结构化错误为准：典型的 429 + `insufficient_quota`
 *   归入额度而不是限流，401 + 额度证据归入额度而不是认证。
 */

import {
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  INVALID_CREDENTIAL_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm';
import { record } from '../util.js';

/** Missing terminal event, distinguished from a malformed event without changing its base code. */
export class PrematureEndError extends LlmError {
  constructor(message: string) { super(message, 'INVALID_RESPONSE'); }
}

/** 固定文案：只说明分类与下一步，绝不拼接上游文字、状态以外的响应事实或凭据。 */
const MESSAGES: Readonly<Record<string, string>> = {
  [CONTEXT_WINDOW_EXCEEDED_CODE]: 'OpenDesign：请求超出模型上下文长度，请缩短输入后重试',
  [ACCOUNT_QUOTA_EXCEEDED_CODE]: 'OpenDesign：套餐或账户额度不足，请检查套餐额度后重试',
  [QUOTA_EXCEEDED_CODE]: 'OpenDesign：钱包或积分余额不足，请充值后重试',
  [INVALID_CREDENTIAL_CODE]: 'OpenDesign：API Key 无效或缺失，请在设置中更新凭据',
  AUTH: 'OpenDesign：认证未通过，请重新登录后重试',
  PERMISSION: 'OpenDesign：当前账户无权访问该模型',
  RATE_LIMIT: 'OpenDesign：请求过于频繁，请稍后重试',
  TIMEOUT: 'OpenDesign：请求超时，请稍后重试',
  SERVER: 'OpenDesign：上游服务暂不可用，请稍后重试',
  INVALID_REQUEST: 'OpenDesign：请求被上游拒绝',
  INVALID_RESPONSE: 'OpenDesign：上游响应格式无效',
};
const UNKNOWN_MESSAGE = 'OpenDesign：请求失败';

/* ── 结构化 code/type：只认枚举式写法，避免把普通单词当分类依据 ─────────────── */

const STRUCTURED_CREDENTIAL =
  /invalid[_-]?(?:x[_-]?)?api[_-]?key|missing[_-]?(?:x[_-]?)?api[_-]?key|incorrect[_-]?(?:x[_-]?)?api[_-]?key|api[_-]?key[_-]?(?:invalid|missing|incorrect)|invalid[_-]?credentials?|credentials?[_-]?(?:invalid|missing)/u;
const STRUCTURED_CONTEXT =
  /context[_-]?(?:length|window)[_-]?(?:exceeded|exceed|overflow)|context[_-]?overflow|(?:prompt|input)[_-]?too[_-]?long/u;
const STRUCTURED_WALLET =
  /(?:insufficient|low|exhausted|depleted|empty|zero)[_-]?(?:credits?|balance|funds)|(?:credits?|balance|wallet|funds)[_-]?(?:insufficient|exhausted|depleted|low|empty)|(?:credit|wallet)[_-]balance[_-](?:too[_-]low|insufficient|exhausted)/u;
const STRUCTURED_PLAN =
  /(?:insufficient|exceeded|exhausted|reached|over)[_-]?(?:quota|plan|usage[_-]?limit)|quota[_-]?(?:exceeded|exhausted|reached)|billing[_-]?hard[_-]?limit|usage[_-]?limit[_-]?(?:exceeded|reached)|(?:subscription|membership|plan)(?:[_-](?:quota|credits?|limit))?[_-](?:exceeded|exhausted|insufficient|reached)/u;
const STRUCTURED_RATE =
  /rate[_-]?limit|too[_-]?many[_-]?requests|resource[_-]?exhausted|(?:requests?|tokens?)[_-]?per[_-]?(?:minute|second)/u;
const STRUCTURED_TIMEOUT = /timeout|timed[_-]?out|deadline[_-]?exceeded/u;
const STRUCTURED_SERVER =
  /server[_-]?error|api[_-]?error|internal[_-]?(?:server[_-]?)?error|service[_-]?unavailable|unavailable|overloaded|bad[_-]?gateway|gateway[_-]?error/u;
const STRUCTURED_AUTH = /authentication|unauthorized|not[_-]?authenticated/u;
const STRUCTURED_PERMISSION = /permission|forbidden|access[_-]?denied|insufficient[_-]?scope/u;

/* ── message 文案：每条都必须带明确的失败语义，单纯的主题词不算 ─────────────── */

/** 只有明确点名 Key/凭据无效或缺失才算凭据错误；关键词本身不推断。 */
const PROSE_CREDENTIAL =
  /invalid[ _-]?(?:x[ _-]?)?api[ _-]?key|(?:x[ _-]?)?api[ _-]?key[ _-]?(?:is[ _-]?)?(?:invalid|missing|incorrect|not[ _-]?valid)|missing[ _-]?(?:x[ _-]?)?api[ _-]?key|incorrect[ _-]?(?:x[ _-]?)?api[ _-]?key|invalid[ _-]?credentials?\b|api[ _-]?key\s*(?:无效|缺失|错误)|密钥(?:无效|缺失|错误)/u;
const PROSE_CONTEXT_EN =
  /\b(?:prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:long|large)\b|\bmaximum context\b|\btokens? > \d+ maximum\b/u;
const PROSE_CONTEXT_ZH =
  /超出[^。]{0,8}上下文|上下文[^。]{0,16}(?:超出|超过|超限|过长|已满)|(?:输入|请求|提示词)[^。]{0,8}(?:过长|太长)|超过[^。]{0,8}上下文/u;
const PROSE_QUOTA_EN =
  /\b(?:credits?|balance|quota|funds|wallet)\b[^.;]{0,24}\b(?:insufficient|exhausted|depleted|used[ _-]?up|too[ _-]?low|empty|zero|exceeded)\b|\b(?:insufficient|exhausted|depleted|empty|zero)\b[^.;]{0,24}\b(?:credits?|balance|quota|funds|wallet)\b/u;
const PROSE_QUOTA_ZH =
  /(?:余额|积分|额度|配额|钱包)[^。]{0,12}(?:不足|用尽|耗尽|用完|超限|超出|已达上限|超过上限)|(?:不足|用尽|耗尽)[^。]{0,6}(?:余额|额度|配额|积分)/u;
const PROSE_QUOTA_PLAN =
  /套餐|订阅|会员|账户额度|账户配额|用量上限|使用上限|\bplan\b|\bsubscription\b|\bmembership\b|\bbilling\b|hard[ _-]?limit|usage[ _-]?limit/u;
const PROSE_QUOTA_WALLET =
  /钱包|充值|余额|积分|\bwallet\b|\brecharge\b|top[ _-]?up|\bbalance\b|\bcredits?\b|\bfunds?\b/u;
const PROSE_RATE = /rate[ _-]?limit|\btoo many requests\b|\bresource[ _-]?exhausted\b|请求过于频繁|频率超限|触发限流|接口限流/u;
const PROSE_TIMEOUT = /\btimeout\b|\btimed out\b|\bdeadline exceeded\b|请求超时|超时/u;
const PROSE_SERVER =
  /\bserver error\b|\bapi error\b|\binternal (?:server )?error\b|\bservice unavailable\b|\boverloaded\b|\bbad gateway\b|服务暂不可用|服务不可用|服务器错误|服务器繁忙|内部错误/u;
const PROSE_AUTH = /\bauthentication\b|\bunauthorized\b|\bnot authenticated\b|认证失败|登录已失效|未登录/u;
const PROSE_PERMISSION =
  /\bpermission\b|\bforbidden\b|\baccess denied\b|\bnot authorized\b|\binsufficient (?:permissions?|scope)\b|权限不足|无权限|无权访问/u;

/** 构造固定文案的错误；HTTP 状态只作为结构化事实保留，不拼进文字。 */
function fail(code: string, status: number | undefined): LlmError {
  const options = status === undefined ? {} : { status };
  return new LlmError(MESSAGES[code] ?? UNKNOWN_MESSAGE, code, options);
}

function matches(fields: readonly string[], pattern: RegExp): boolean {
  return fields.some(field => pattern.test(field));
}

/** 结构化额度按池拆分：钱包/积分优先，其余视为套餐或账户额度。 */
function structuredQuota(fields: readonly string[]): string | undefined {
  if (matches(fields, STRUCTURED_WALLET)) return QUOTA_EXCEEDED_CODE;
  if (matches(fields, STRUCTURED_PLAN)) return ACCOUNT_QUOTA_EXCEEDED_CODE;
  return undefined;
}

/** 文案额度同样按池拆分：套餐/订阅优先，其次钱包/积分，未指明池时按账户额度。 */
function proseQuota(detail: string): string {
  if (PROSE_QUOTA_PLAN.test(detail)) return ACCOUNT_QUOTA_EXCEEDED_CODE;
  if (PROSE_QUOTA_WALLET.test(detail)) return QUOTA_EXCEEDED_CODE;
  return ACCOUNT_QUOTA_EXCEEDED_CODE;
}

function classifyStructured(fields: readonly string[]): string | undefined {
  if (matches(fields, STRUCTURED_CREDENTIAL)) return INVALID_CREDENTIAL_CODE;
  if (matches(fields, STRUCTURED_CONTEXT)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  const quota = structuredQuota(fields);
  if (quota !== undefined) return quota;
  if (matches(fields, STRUCTURED_RATE)) return 'RATE_LIMIT';
  if (matches(fields, STRUCTURED_TIMEOUT)) return 'TIMEOUT';
  if (matches(fields, STRUCTURED_SERVER)) return 'SERVER';
  if (matches(fields, STRUCTURED_AUTH)) return 'AUTH';
  if (matches(fields, STRUCTURED_PERMISSION)) return 'PERMISSION';
  return undefined;
}

function classifyProse(detail: string): string | undefined {
  if (detail === '') return undefined;
  if (isContextWindowExceededError(detail) || PROSE_CONTEXT_EN.test(detail) || PROSE_CONTEXT_ZH.test(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (isQuotaExceededError(detail) || PROSE_QUOTA_EN.test(detail) || PROSE_QUOTA_ZH.test(detail)) return proseQuota(detail);
  if (PROSE_RATE.test(detail)) return 'RATE_LIMIT';
  if (PROSE_TIMEOUT.test(detail)) return 'TIMEOUT';
  if (PROSE_SERVER.test(detail)) return 'SERVER';
  if (PROSE_AUTH.test(detail)) return 'AUTH';
  if (PROSE_PERMISSION.test(detail)) return 'PERMISSION';
  return undefined;
}

/** HTTP 状态只补足结构化与文案都没有给出的类别；5xx 一律按服务端处理。 */
function classifyStatus(status: number | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 402) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return 'RATE_LIMIT';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status >= 500) return 'SERVER';
  return undefined;
}

interface Fields {
  /** `code` 与 `type` 分开保存，避免跨字段拼出并不存在的短语。 */
  readonly structured: readonly string[];
  readonly prose: string;
}

function fieldsOf(error: Record<string, unknown>): Fields {
  const structured: string[] = [];
  for (const value of [error.code, error.type]) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (normalized !== '') structured.push(normalized);
  }
  return { structured, prose: typeof error.message === 'string' ? error.message.toLowerCase() : '' };
}

/** 依据结构化字段、文案与 HTTP 状态给出稳定的 LlmError；`fallback` 决定无法归类时的机器码。 */
function classify(fields: Fields, status: number | undefined, fallback: string): LlmError {
  const structured = classifyStructured(fields.structured);
  // 结构化分类优先：明确的额度/上下文/限流/超时/服务端结论不会被 HTTP 状态改写。
  if (structured !== undefined && structured !== 'AUTH' && structured !== 'PERMISSION') return fail(structured, status);
  // 5xx 是明确的服务端事实（504 单独按超时处理）：没有结构化代码时不采信正文里的认证或额度措辞。
  if (structured === undefined && status !== undefined && status >= 500 && status !== 504) return fail('SERVER', status);
  // 上游只给出认证/权限语义时，明确点名 Key/凭据无效或缺失的文案可以升级为凭据错误。
  if (PROSE_CREDENTIAL.test(fields.prose)) return fail(INVALID_CREDENTIAL_CODE, status);
  if (structured !== undefined) return fail(structured, status);
  const prose = classifyProse(fields.prose);
  if (prose !== undefined) return fail(prose, status);
  // 状态只兜底：典型额度/认证类 401 已由上面的专用分类处理，不会退回成认证或限流。
  const byStatus = classifyStatus(status);
  return fail(byStatus ?? fallback, status);
}

/**
 * OpenAI 风格信封：`{ error: { code, type, message } }`（Chat Completions 与 Responses 实测一致）。
 *
 * @param status 上游 HTTP 状态；流内错误事件没有状态时省略。
 * @param body 已解析的响应体或流事件。
 */
export function gatewayError(status: number | undefined, body: unknown): LlmError {
  const error = record(body) && record(body.error) ? body.error : record(body) ? body : {};
  return classify(fieldsOf(error), status, 'INVALID_REQUEST');
}

/**
 * Anthropic 风格信封：`{ type: "error", error: { type, message } }`（Messages 端点实测）。
 *
 * @param status 上游 HTTP 状态；流内错误事件没有状态时省略。
 * @param body 已解析的响应体或流事件。
 */
export function anthropicError(status: number | undefined, body: unknown): LlmError {
  const error = record(body) && record(body.error) ? body.error : {};
  return classify(fieldsOf(error), status, 'INVALID_REQUEST');
}

/**
 * 流内错误事件（HTTP 已是 200，错误只能作为事件到达）。
 *
 * @param error 事件里的错误对象（两种信封都可）。
 * @param fallback 无法归类时使用的机器码，默认按格式错误处理。
 */
export function inBandError(error: unknown, fallback = 'INVALID_RESPONSE'): LlmError {
  return classify(fieldsOf(record(error) ? error : {}), undefined, fallback);
}
