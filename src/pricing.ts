/**
 * 官网公开模型价格读取。
 *
 * 契约：
 * - 只访问公开官网的固定 origin（`https://corouter.open-design.ai`），不携带任何凭据、
 *   不读宿主 Profile、不触发真实计费或预检。主机与路径由模块常量决定，调用方无法改写。
 * - 官网没有 JSON 接口，价格只存在于服务端渲染的 HTML：
 *   - 目录页 `/zh/models/`：每个模型一个 `model-explorer-panel`，`data-model-panel` 是官网的
 *     精确模型 ID，面板内按档位（`model-explorer-tier`）列出输入/输出/缓存读取/缓存写入单价。
 *   - 详情页 `/zh/models/<slug>/`：`data-model` 属性内是官网自己的 JSON，含精确 ID 与单价，
 *     可用于交叉核对目录页读到的 ID 与价格。
 * - 单价单位是“美元 / 百万 Token”，币种由价格前的 `$` 符号判定。官网把未列出的价格写成
 *   `—`（目录页 `aria-label="工作台未单列价格"`，详情页 `null`），本模块一律记为 `null`，
 *   不用任何方式推算或补齐。
 * - 缺路由时官网会返回首页且 HTTP 200，因此每个页面都用 `data-page-name` 标记与
 *   `data-model` 的 ID 校验来识别“拿到的不是目标页”，宁可判失败也不解析错页。
 * - 默认只发一次目录页请求。请求有超时、响应体字节上限与取消处理；失败不抛给调用方，
 *   而是折叠进 `PricingSnapshot.issues` 并区分 `status`。
 */

import { combinedSignal } from './util.js';

/** 官网固定 origin；公开页面无鉴权，模块不接受调用方替换主机。 */
export const PRICING_ORIGIN = 'https://corouter.open-design.ai';
/** 价格目录页路径（含语言前缀）。 */
export const PRICING_CATALOG_PATH = '/zh/models/';
/** 单次请求的默认时限（毫秒）。 */
export const PRICING_TIMEOUT_MS = 15_000;
/** 单次响应的默认字节上限；目录页约 0.5 MiB。 */
export const MAX_PRICING_BODY_BYTES = 4 * 1024 * 1024;

/** 官网价格使用的币种。 */
export type PricingCurrency = 'USD';
/** 官网价格的计价单位。 */
export type PricingUnit = 'per_1m_tokens' | 'per_1k_tokens';
/** 目录页与详情页共有的价格分项。 */
export type PricingMetric = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/**
 * 一个价格档位。`null` 表示官网没有列出该分项的价格，不代表零价。
 * `label` 是官网原文，档位之间按官网顺序排列并带 `index`，展示时不得跨档合并。
 */
export interface ModelPriceTier {
  /** 档位序号（从 0 开始，按官网顺序）。 */
  index: number;
  /** 官网给出的档位标签，例如 `27.2 万 Token 及以内` / `超过 27.2 万 Token` / `不按输入长度分档`。 */
  label: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  currency: PricingCurrency | null;
  unit: PricingUnit | null;
}

/** 一个模型的官网价格。 */
export interface ModelPricing {
  /** 官网精确模型 ID，例如 `gpt-6.1-sol`。 */
  id: string;
  /** 官网展示名。 */
  name: string;
  /** 官网标注的厂商。 */
  provider: string | null;
  /** 官网详情页 slug；与模型 ID 不同名，仅用于定位详情页。 */
  slug: string | null;
  /** 详情页绝对地址。 */
  detailUrl: string | null;
  /** 按官网顺序排列的价格档位；长度大于 1 表示该模型按输入长度分档定价。 */
  tiers: ModelPriceTier[];
}

/** 价格来源。 */
export interface PricingSource {
  kind: 'official-website';
  origin: string;
  catalogUrl: string;
}

/** 失败分类。 */
export type PricingErrorKind =
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'status'
  | 'too-large'
  | 'invalid-page'
  | 'invalid-model';

/** 快照里的一条失败记录。 */
export interface PricingIssue {
  code: PricingErrorKind;
  message: string;
  url?: string;
  status?: number;
}

/** 价格快照。`status` 为 `failed` 时 `models` 为空。 */
export interface PricingSnapshot {
  status: 'ok' | 'partial' | 'failed';
  source: PricingSource;
  /** 采集时间（ISO 8601）。 */
  fetchedAt: string;
  currency: PricingCurrency | null;
  unit: PricingUnit | null;
  models: ModelPricing[];
  issues: PricingIssue[];
}

/** 目录页解析结果。 */
export interface PricingCatalog {
  models: ModelPricing[];
  currency: PricingCurrency | null;
  unit: PricingUnit | null;
}

/** 抓取选项。 */
export interface PricingFetchOptions {
  /** `fetch` 替换实现（测试与自定义传输）。 */
  fetcher?: typeof fetch;
  /** 单次请求时限（毫秒）。 */
  timeoutMs?: number;
  /** 单次响应字节上限。 */
  maxBytes?: number;
  /** 调用方取消信号。 */
  signal?: AbortSignal;
  /** 采集时间来源。 */
  now?: () => Date;
}

const MESSAGES: Record<PricingErrorKind, string> = {
  timeout: '官网价格请求超过时限',
  aborted: '官网价格请求已取消',
  network: '无法连接官网',
  status: '官网返回了非 200 状态',
  'too-large': '官网价格响应体超过上限',
  'invalid-page': '拿到的页面不是官网模型价格页',
  'invalid-model': '拿到的页面不是官网模型价格详情页',
};

/** 价格读取失败。消息为固定文案，不回显响应体。 */
export class PricingError extends Error {
  constructor(readonly kind: PricingErrorKind, readonly status?: number) {
    super(MESSAGES[kind]);
    this.name = 'PricingError';
  }
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:quot|amp|lt|gt|apos|nbsp|mdash|ndash);/gu, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d+);/gu, (_match, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    });
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim();
}

function metricOf(label: string): PricingMetric | undefined {
  if (/缓存读取|cache\s+read/iu.test(label)) return 'cacheRead';
  if (/缓存写入|cache\s+write/iu.test(label)) return 'cacheWrite';
  // 汉字不是 `\w` 字符，不能用 `\b` 判断边界，否则 `输入 / 百万 Token` 匹配不到。
  if (/^\s*(?:输入|input)/iu.test(label)) return 'input';
  if (/^\s*(?:输出|output)/iu.test(label)) return 'output';
  return undefined;
}

function unitOf(label: string): PricingUnit | null {
  if (/百万\s*token|1m\s*tokens?/iu.test(label)) return 'per_1m_tokens';
  if (/千\s*token|1k\s*tokens?/iu.test(label)) return 'per_1k_tokens';
  return null;
}

function currencyOf(value: string): PricingCurrency | null {
  if (value.includes('$')) return 'USD';
  return null;
}

/** 价格数值。`—` / `–` / 空值 / 无法解析时返回 `null`，绝不猜测。 */
function priceOf(value: string): number | null {
  const text = value.replace(/[$\u20ac\u00a3\u00a5\u00a4,\s]/gu, '');
  if (text === '' || /^[–—−\-]+$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/u;

/** 从官网详情页链接里取 slug。 */
function slugOf(href: string): string | null {
  const match = /\/models\/([A-Za-z0-9._-]+)\/?(?:#.*)?$/u.exec(href);
  if (!match) return null;
  const slug = match[1]!;
  return SLUG.test(slug) ? slug : null;
}

interface PanelMatch {
  id: string;
  body: string;
}

/** 面板的最后一项是“查看详情”链接；把正文截到该链接结束，避免把面板之后的标记算进本模型。 */
function trimPanelBody(body: string): string {
  const anchor = /<a\b[^>]*class="[^"]*\bmodel-explorer-detail-link\b[^"]*"[^>]*>/u.exec(body);
  if (!anchor) return body;
  const close = body.indexOf('</a>', anchor.index + anchor[0].length);
  if (close < 0) return body.slice(0, anchor.index);
  return body.slice(0, close + 4);
}

function collectPanels(html: string): PanelMatch[] {
  const openTag = /<div\b[^>]*class="[^"]*\bmodel-explorer-panel\b[^"]*"[^>]*>/gu;
  const opens: { id: string; start: number; end: number }[] = [];
  for (const match of html.matchAll(openTag)) {
    const id = /data-model-panel="([^"]*)"/u.exec(match[0])?.[1];
    if (!id || !MODEL_ID.test(id)) continue;
    opens.push({ id, start: match.index, end: match.index + match[0].length });
  }
  const panels: PanelMatch[] = [];
  for (let index = 0; index < opens.length; index += 1) {
    const open = opens[index]!;
    const next = opens[index + 1];
    const body = html.slice(open.end, next ? next.start : html.length);
    panels.push({ id: open.id, body: trimPanelBody(body) });
  }
  return panels;
}

function collectProviders(html: string): Map<string, string> {
  const providers = new Map<string, string>();
  for (const match of html.matchAll(/<button\b[^>]*>/gu)) {
    const tag = match[0];
    const id = /data-model-tab="([^"]*)"/u.exec(tag)?.[1];
    const provider = /data-provider="([^"]*)"/u.exec(tag)?.[1];
    if (!id || !provider) continue;
    providers.set(id, provider.trim());
  }
  return providers;
}

interface MetricDraft {
  price: number | null;
  currency: PricingCurrency | null;
  unit: PricingUnit | null;
}

function collectTiers(body: string): { label: string; metrics: Map<PricingMetric, MetricDraft> }[] {
  const marker = /<div\b[^>]*class="[^"]*\bmodel-explorer-tier\b[^"]*"[^>]*>/gu;
  const starts: number[] = [];
  for (const match of body.matchAll(marker)) starts.push(match.index);
  const tiers: { label: string; metrics: Map<PricingMetric, MetricDraft> }[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = index + 1 < starts.length ? starts[index + 1]! : body.length;
    const chunk = body.slice(start, end);
    const label = stripTags(/<h4[^>]*>([\s\S]*?)<\/h4>/u.exec(chunk)?.[1] ?? '');
    const metrics = new Map<PricingMetric, MetricDraft>();
    for (const metric of chunk.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd([^>]*)>([\s\S]*?)<\/dd>/gu)) {
      const labelText = stripTags(metric[1] ?? '');
      const key = metricOf(labelText);
      if (!key) continue;
      const value = stripTags(metric[3] ?? '');
      metrics.set(key, { price: priceOf(value), currency: currencyOf(value), unit: unitOf(labelText) });
    }
    tiers.push({ label, metrics });
  }
  return tiers;
}

/** 目录页标记。缺失说明拿到的不是价格目录页。 */
function hasCatalogMarker(html: string): boolean {
  return /data-page-name="corouter_models"/u.test(html);
}

/** 全部档位一致时返回该币种，否则返回 `null`（不假设币种统一）。 */
function commonCurrency(values: readonly (PricingCurrency | null)[]): PricingCurrency | null {
  const seen = new Set(values.filter((value): value is PricingCurrency => value !== null));
  if (seen.size !== 1) return null;
  return seen.values().next().value ?? null;
}

/** 全部档位一致时返回该单位，否则返回 `null`（不假设单位统一）。 */
function commonUnit(values: readonly (PricingUnit | null)[]): PricingUnit | null {
  const seen = new Set(values.filter((value): value is PricingUnit => value !== null));
  if (seen.size !== 1) return null;
  return seen.values().next().value ?? null;
}

/**
 * 解析官网价格目录页。
 *
 * @param html 目录页 HTML。
 * @returns 目录页上的模型价格；每个模型保留官网自己的档位与档位标签。
 * @throws {PricingError} 页面不是价格目录页（`invalid-page`）。
 */
export function parsePricingCatalog(html: string): PricingCatalog {
  if (!hasCatalogMarker(html)) throw new PricingError('invalid-page');
  const panels = collectPanels(html);
  if (panels.length === 0) throw new PricingError('invalid-page');
  const providers = collectProviders(html);
  const models: ModelPricing[] = [];
  for (const panel of panels) {
    const name = stripTags(/<h3[^>]*>([\s\S]*?)<\/h3>/u.exec(panel.body)?.[1] ?? '');
    const href = /<a\b[^>]*class="[^"]*\bmodel-explorer-detail-link\b[^"]*"[^>]*href="([^"]*)"/u.exec(panel.body)?.[1] ?? '';
    const slug = slugOf(href);
    const tiers: ModelPriceTier[] = collectTiers(panel.body).map((draft, index) => {
      const input = draft.metrics.get('input');
      const output = draft.metrics.get('output');
      const cacheRead = draft.metrics.get('cacheRead');
      const cacheWrite = draft.metrics.get('cacheWrite');
      // One tier is presented with one currency and unit. Never combine amounts whose
      // own labels disagree or whose currency is missing alongside a known currency.
      const priced = [input, output, cacheRead, cacheWrite].filter((value): value is MetricDraft => value !== undefined && value.price !== null);
      if (!draft.label || new Set(priced.map(value => value.currency)).size > 1 || new Set(priced.map(value => value.unit)).size > 1) throw new PricingError('invalid-page');
      return {
        index,
        label: draft.label,
        input: input?.price ?? null,
        output: output?.price ?? null,
        cacheRead: cacheRead?.price ?? null,
        cacheWrite: cacheWrite?.price ?? null,
        currency: input?.currency ?? output?.currency ?? cacheRead?.currency ?? cacheWrite?.currency ?? null,
        unit: input?.unit ?? output?.unit ?? cacheRead?.unit ?? cacheWrite?.unit ?? null,
      };
    });
    models.push({
      id: panel.id,
      name: name === '' ? panel.id : name,
      provider: providers.get(panel.id) ?? null,
      slug,
      detailUrl: slug ? `${PRICING_ORIGIN}${PRICING_CATALOG_PATH}${slug}/` : null,
      tiers,
    });
  }
  return {
    models,
    currency: commonCurrency(models.flatMap((model) => model.tiers.map((tier) => tier.currency))),
    unit: commonUnit(models.flatMap((model) => model.tiers.map((tier) => tier.unit))),
  };
}

/**
 * 解析官网模型详情页。
 *
 * 详情页把每个模型的价格写成 `data-model` 属性里的官网 JSON；用它可以交叉核对目录页
 * 读到的精确 ID 与单价。此处只做解析，不代替目录页作为常规取数路径。
 *
 * @param html 详情页 HTML。
 * @returns 该模型的价格；两个档位分别是官网的“标准输入”与“长输入”。
 * @throws {PricingError} 页面不含官网模型数据（`invalid-model`）。
 */
export function parseModelDetailPricing(html: string): ModelPricing {
  const raw = /data-model="([^"]*)"/u.exec(html)?.[1];
  if (!raw) throw new PricingError('invalid-model');
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(decodeEntities(raw));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    data = parsed as Record<string, unknown>;
  } catch {
    throw new PricingError('invalid-model');
  }
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!MODEL_ID.test(id)) throw new PricingError('invalid-model');
  const copy = readCopy(html);
  const tiers: ModelPriceTier[] = [
    {
      index: 0,
      label: copy?.baseTier ?? '',
      input: numberOf(data.input),
      output: numberOf(data.output),
      cacheRead: numberOf(data.cacheRead),
      cacheWrite: numberOf(data.cacheWrite),
      currency: copy?.currency ?? null,
      unit: copy?.unit ?? null,
    },
  ];
  const long = data.longInput;
  if (long !== null && typeof long === 'object' && !Array.isArray(long)) {
    const longRecord = long as Record<string, unknown>;
    tiers.push({
      index: 1,
      label: copy?.longTier ?? '',
      input: numberOf(longRecord.input),
      output: numberOf(longRecord.output),
      cacheRead: numberOf(longRecord.cacheRead),
      cacheWrite: numberOf(longRecord.cacheWrite),
      currency: copy?.currency ?? null,
      unit: copy?.unit ?? null,
    });
  }
  const slug = typeof data.slug === 'string' && SLUG.test(data.slug) ? data.slug : null;
  return {
    id,
    name: typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : id,
    provider: typeof data.provider === 'string' && data.provider.trim() !== '' ? data.provider.trim() : null,
    slug,
    detailUrl: slug ? `${PRICING_ORIGIN}${PRICING_CATALOG_PATH}${slug}/` : null,
    tiers,
  };
}

interface DetailCopy {
  baseTier: string | null;
  longTier: string | null;
  currency: PricingCurrency | null;
  unit: PricingUnit | null;
}

function readCopy(html: string): DetailCopy | null {
  const raw = /data-copy="([^"]*)"/u.exec(html)?.[1];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeEntities(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const unitText = typeof record.unit === 'string' ? record.unit : '';
  return {
    baseTier: typeof record.base_tier === 'string' ? record.base_tier : null,
    longTier: typeof record.long_tier === 'string' ? record.long_tier : null,
    currency: /美元|\bUSD\b/iu.test(unitText) ? 'USD' : null,
    unit: unitOf(unitText),
  };
}

function classify(error: unknown, signal: AbortSignal | undefined, combined: AbortSignal): PricingError {
  if (error instanceof PricingError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (signal?.aborted) return new PricingError('aborted');
  if (name === 'TimeoutError' || combined.aborted) return new PricingError('timeout');
  return new PricingError('network');
}

/** 读至多 `maxBytes` 字节并解码一次；超限或被中断都不返回残缺正文。 */
async function readBounded(response: Response, maxBytes: number, signal: AbortSignal | undefined, combined: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new PricingError('invalid-page');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw new PricingError('too-large');
  }
  let size = 0;
  let raw = '';
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    if (combined.aborted) throw classify(combined.reason, signal, combined);
    while (true) {
      const chunk = await reader.read();
      if (combined.aborted) throw classify(combined.reason, signal, combined);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new PricingError('too-large');
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } catch (error) {
    if (error instanceof PricingError) throw error;
    throw classify(error, signal, combined);
  } finally {
    combined.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
  return raw;
}

async function fetchHtml(url: string, options: PricingFetchOptions, timeoutMs: number, maxBytes: number): Promise<string> {
  const request = options.fetcher ?? fetch;
  const combined = combinedSignal(options.signal, timeoutMs);
  let response: Response;
  try {
    response = await request(url, {
      method: 'GET',
      headers: { accept: 'text/html' },
      signal: combined,
      redirect: 'error',
      credentials: 'omit',
    });
  } catch (error) {
    throw classify(error, options.signal, combined);
  }
  if (combined.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw classify(combined.reason, options.signal, combined);
  }
  if (response.redirected || (response.url && response.url !== url)) {
    void response.body?.cancel().catch(() => undefined);
    throw new PricingError('invalid-page');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new PricingError('status', response.status);
  }
  const contentType = response.headers.get('content-type');
  if (contentType !== null && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
    void response.body?.cancel().catch(() => undefined);
    throw new PricingError('invalid-page');
  }
  return readBounded(response, maxBytes, options.signal, combined);
}

/**
 * 拉取官网模型价格。默认只发一次目录页请求。
 *
 * @param options 超时、体积上限、取消与采集时间来源。
 * @returns 价格快照；失败时 `status` 为 `failed` 且 `issues` 说明原因。
 */
export async function fetchPricingSnapshot(options: PricingFetchOptions = {}): Promise<PricingSnapshot> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? PRICING_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PRICING_BODY_BYTES;
  const catalogUrl = `${PRICING_ORIGIN}${PRICING_CATALOG_PATH}`;
  const source: PricingSource = { kind: 'official-website', origin: PRICING_ORIGIN, catalogUrl };
  const deadline = combinedSignal(options.signal, timeoutMs);
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new PricingError(options.signal?.aborted ? 'aborted' : 'timeout'));
  deadline.addEventListener('abort', onAbort, { once: true });
  try {
    if (deadline.aborted) throw classify(deadline.reason, options.signal, deadline);
    const html = await Promise.race([fetchHtml(catalogUrl, { ...options, signal: deadline }, timeoutMs, maxBytes), aborted]);
    const catalog = parsePricingCatalog(html);
    return {
      status: 'ok',
      source,
      fetchedAt: now().toISOString(),
      currency: catalog.currency,
      unit: catalog.unit,
      models: catalog.models,
      issues: [],
    };
  } catch (error) {
    const failure = deadline.aborted && !options.signal?.aborted ? new PricingError('timeout') : classify(error, options.signal, deadline);
    const issue: PricingIssue = { code: failure.kind, message: failure.message, url: catalogUrl };
    if (failure.status !== undefined) issue.status = failure.status;
    return { status: 'failed', source, fetchedAt: now().toISOString(), currency: null, unit: null, models: [], issues: [issue] };
  } finally { deadline.removeEventListener('abort', onAbort); }
}

/**
 * 按官网精确模型 ID 查价格。
 *
 * @param snapshot 价格快照。
 * @param id 精确模型 ID，例如 `gpt-6.1-sol`。
 * @returns 命中的模型价格；没有该 ID 时返回 `undefined`。
 */
export function findModelPricing(snapshot: PricingSnapshot, id: string): ModelPricing | undefined {
  const wanted = id.trim();
  if (wanted === '') return undefined;
  return snapshot.models.find((model) => model.id === wanted);
}
