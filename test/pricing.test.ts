// Tests for src/pricing.ts: 官网公开价格页的解析与抓取边界。
// 只用内存里的合成响应：不访问真实官网、不读凭据、不做真实计费或预检。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRICING_BODY_BYTES,
  PRICING_CATALOG_PATH,
  PRICING_ORIGIN,
  PRICING_TIMEOUT_MS,
  PricingError,
  fetchPricingSnapshot,
  findModelPricing,
  parseModelDetailPricing,
  parsePricingCatalog,
} from '../src/pricing.js';

interface Call { url: string; init: RequestInit }
type Handler = (call: Call) => Response | Promise<Response>;

/** 记录每次调用的 fetch 替身。 */
function stub(handler: Handler): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { fetcher, calls };
}

/** 一个模型面板，结构与官网渲染结果一致。 */
function panel(options: {
  id: string;
  name: string;
  slug: string;
  tiers: { label: string; input: string; output: string; cacheRead: string; cacheWrite: string }[];
}): string {
  const tiers = options.tiers
    .map((tier) => [
      '<div class="model-explorer-tier">',
      `<h4>${tier.label}</h4>`,
      '<dl class="model-explorer-metrics">',
      `<div><dt>输入 / 百万 Token</dt><dd${tier.cacheWrite === '—' ? ' aria-label="工作台未单列价格"' : ''}>${tier.input === '—' ? '—' : `$${tier.input}`}</dd></div>`,
      `<div><dt>输出 / 百万 Token</dt><dd${tier.output === '—' ? ' aria-label="工作台未单列价格"' : ''}>${tier.output === '—' ? '—' : `$${tier.output}`}</dd></div>`,
      `<div><dt>缓存读取 / 百万 Token</dt><dd${tier.cacheRead === '—' ? ' aria-label="工作台未单列价格"' : ''}>${tier.cacheRead === '—' ? '—' : `$${tier.cacheRead}`}</dd></div>`,
      `<div><dt>缓存写入 / 百万 Token</dt><dd${tier.cacheWrite === '—' ? ' aria-label="工作台未单列价格"' : ''}>${tier.cacheWrite === '—' ? '—' : `$${tier.cacheWrite}`}</dd></div>`,
      '</dl>',
      '</div>',
    ].join(''))
    .join('');
  return [
    `<div class="model-explorer-panel" id="model-panel-${options.id}" role="tabpanel" tabindex="0" data-model-panel="${options.id}">`,
    '<header class="model-explorer-heading">',
    '<div><h3>',
    options.name,
    '</h3></div>',
    '</header>',
    '<div class="model-explorer-pricing">',
    tiers,
    '</div>',
    `<a class="model-explorer-detail-link" href="/zh/models/${options.slug}/">查看详情<span aria-hidden="true">↗</span></a>`,
    '</div>',
  ].join('');
}

test('inconsistent pricing units or currencies cannot be merged into one tier', () => {
  const html = catalogPage();
  const mixedCurrency = html.replace('<dd>$10</dd>', '<dd>€10</dd>');
  assert.notEqual(mixedCurrency, html);
  assert.throws(() => parsePricingCatalog(mixedCurrency), PricingError);
  const mixedUnit = html.replace('输出 / 百万 Token', '输出 / 千 Token');
  assert.notEqual(mixedUnit, html);
  assert.throws(() => parsePricingCatalog(mixedUnit), PricingError);
});

/** 一个目录页，包含多档模型、缺价模型与厂商按钮。 */
function catalogPage(): string {
  return [
    '<!doctype html><html lang="zh-CN"><body>',
    '<div class="corouter-landing" data-corouter-root data-page-name="corouter_models" data-locale="zh">',
    '<div class="workspace-model-catalog">',
    '<div class="model-explorer" data-model-explorer>',
    '<div class="model-explorer-details">',
    panel({
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      slug: 'gpt-6-1-sol',
      tiers: [
        { label: '27.2 万 Token 及以内', input: '2', output: '10', cacheRead: '0.1', cacheWrite: '2.5' },
        { label: '超过 27.2 万 Token', input: '4', output: '15', cacheRead: '0.2', cacheWrite: '5' },
      ],
    }),
    panel({
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      slug: 'deepseek-v4-1-flash',
      tiers: [{ label: '不按输入长度分档', input: '0.3', output: '1.2', cacheRead: '0.006', cacheWrite: '—' }],
    }),
    '</div>',
    '<div role="tablist">',
    '<button type="button" role="tab" id="model-tab-gpt-6-1-sol" aria-selected="true" tabindex="0" data-model-tab="gpt-6.1-sol" data-provider="OpenAI"><span><strong>GPT-6.1 Sol</strong></span></button>',
    '<button type="button" role="tab" id="model-tab-deepseek-v4-1-flash" aria-selected="false" tabindex="-1" hidden data-model-tab="deepseek-v4.1-flash" data-provider="DeepSeek"><span><strong>DeepSeek V4.1 Flash</strong></span></button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
    '</body></html>',
  ].join('');
}

/** 详情页：官网把模型数据放在 data-model 属性里。 */
function detailPage(model: Record<string, unknown>, copy: Record<string, unknown> = {}): string {
  const merged = { unit: '美元 / 百万 Token', base_tier: '标准输入', long_tier: '长输入', ...copy };
  return [
    '<!doctype html><html lang="zh-CN"><body>',
    '<div class="corouter-landing" data-corouter-root data-page-name="corouter_models_gpt_6_1_sol" data-locale="zh">',
    '<section class="model-detail wrap" data-model-detail',
    ` data-model="${JSON.stringify(model).replace(/&/gu, '&amp;').replace(/"/gu, '&quot;')}"`,
    ` data-copy="${JSON.stringify(merged).replace(/&/gu, '&amp;').replace(/"/gu, '&quot;')}"`,
    '>',
    '<h1>GPT-6.1 Sol</h1>',
    '<code>gpt-6.1-sol</code>',
    '</section>',
    '</div>',
    '</body></html>',
  ].join('');
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

test('目录页解析：精确 ID、厂商、slug 与分档价格', () => {
  const catalog = parsePricingCatalog(catalogPage());
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.currency, 'USD');
  assert.equal(catalog.unit, 'per_1m_tokens');
  const gpt = catalog.models[0]!;
  assert.equal(gpt.id, 'gpt-6.1-sol');
  assert.equal(gpt.name, 'GPT-6.1 Sol');
  assert.equal(gpt.provider, 'OpenAI');
  assert.equal(gpt.slug, 'gpt-6-1-sol');
  assert.equal(gpt.detailUrl, `${PRICING_ORIGIN}/zh/models/gpt-6-1-sol/`);
});

test('多档模型保留官网原始标签、顺序与档位序号', () => {
  const catalog = parsePricingCatalog(catalogPage());
  const tiers = catalog.models[0]!.tiers;
  assert.equal(tiers.length, 2);
  assert.deepEqual(tiers.map((tier) => tier.label), ['27.2 万 Token 及以内', '超过 27.2 万 Token']);
  assert.deepEqual(tiers.map((tier) => tier.index), [0, 1]);
  assert.deepEqual(tiers[0], {
    index: 0,
    label: '27.2 万 Token 及以内',
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    currency: 'USD',
    unit: 'per_1m_tokens',
  });
  assert.deepEqual(tiers[1], {
    index: 1,
    label: '超过 27.2 万 Token',
    input: 4,
    output: 15,
    cacheRead: 0.2,
    cacheWrite: 5,
    currency: 'USD',
    unit: 'per_1m_tokens',
  });
});

test('官网未列出的价格记为 null，不补零也不推算', () => {
  const catalog = parsePricingCatalog(catalogPage());
  const tier = catalog.models[1]!.tiers[0]!;
  assert.equal(tier.label, '不按输入长度分档');
  assert.equal(tier.input, 0.3);
  assert.equal(tier.output, 1.2);
  assert.equal(tier.cacheRead, 0.006);
  assert.equal(tier.cacheWrite, null);
});

test('拿到的不是价格目录页时判为 invalid-page', () => {
  const homepage = '<!doctype html><html><body><div data-page-name="corouter"></div></body></html>';
  assert.throws(() => parsePricingCatalog(homepage), (error: unknown) => {
    assert.ok(error instanceof PricingError);
    assert.equal(error.kind, 'invalid-page');
    return true;
  });
});

test('详情页解析：官网 JSON 里的精确 ID、单价与两档', () => {
  const pricing = parseModelDetailPricing(detailPage({
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    family: 'GPT',
    provider: 'OpenAI',
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    longInput: { threshold: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
    slug: 'gpt-6-1-sol',
  }));
  assert.equal(pricing.id, 'gpt-6.1-sol');
  assert.equal(pricing.provider, 'OpenAI');
  assert.equal(pricing.tiers.length, 2);
  assert.deepEqual(pricing.tiers[0], {
    index: 0,
    label: '标准输入',
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    currency: 'USD',
    unit: 'per_1m_tokens',
  });
  assert.equal(pricing.tiers[1]!.index, 1);
  assert.equal(pricing.tiers[1]!.label, '长输入');
  assert.equal(pricing.tiers[1]!.input, 4);
});

test('详情页里未提供的缓存写入价是 null', () => {
  const pricing = parseModelDetailPricing(detailPage({
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    provider: 'DeepSeek',
    input: 0.3,
    output: 1.2,
    cacheRead: 0.006,
    cacheWrite: null,
    slug: 'deepseek-v4-1-flash',
  }));
  assert.equal(pricing.tiers.length, 1);
  assert.equal(pricing.tiers[0]!.cacheWrite, null);
});

test('详情页缺模型数据时判为 invalid-model', () => {
  const homepage = '<!doctype html><html><body><div data-page-name="corouter"></div></body></html>';
  assert.throws(() => parseModelDetailPricing(homepage), (error: unknown) => {
    assert.ok(error instanceof PricingError);
    assert.equal(error.kind, 'invalid-model');
    return true;
  });
});

test('默认只请求一次官网目录页，且不带任何凭据', async () => {
  const { fetcher, calls } = stub(() => html(catalogPage()));
  const snapshot = await fetchPricingSnapshot({ fetcher, now: () => new Date('2026-10-27T10:00:00.000Z') });
  assert.equal(snapshot.status, 'ok');
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `${PRICING_ORIGIN}${PRICING_CATALOG_PATH}`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.credentials, 'omit');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.accept, 'text/html');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
});

test('快照区分来源、采集时间与失败状态', async () => {
  const { fetcher } = stub(() => html(catalogPage()));
  const snapshot = await fetchPricingSnapshot({ fetcher, now: () => new Date('2026-10-27T10:00:00.000Z') });
  assert.equal(snapshot.fetchedAt, '2026-10-27T10:00:00.000Z');
  assert.deepEqual(snapshot.source, {
    kind: 'official-website',
    origin: PRICING_ORIGIN,
    catalogUrl: `${PRICING_ORIGIN}${PRICING_CATALOG_PATH}`,
  });
  assert.deepEqual(snapshot.issues, []);
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.unit, 'per_1m_tokens');
});

test('按精确 ID 查价格：命中、大小写不同与未知 ID', async () => {
  const { fetcher } = stub(() => html(catalogPage()));
  const snapshot = await fetchPricingSnapshot({ fetcher });
  const found = findModelPricing(snapshot, 'gpt-6.1-sol');
  assert.ok(found);
  assert.equal(found.id, 'gpt-6.1-sol');
  assert.equal(found.tiers.length, 2);
  assert.equal(findModelPricing(snapshot, 'GPT-6.1-SOL'), undefined);
  assert.equal(findModelPricing(snapshot, 'gpt-6-1-sol'), undefined);
  assert.equal(findModelPricing(snapshot, '  '), undefined);
});

test('非 200 状态被折叠成 failed 快照并记录状态码', async () => {
  const { fetcher } = stub(() => new Response('nope', { status: 503 }));
  const snapshot = await fetchPricingSnapshot({ fetcher });
  assert.equal(snapshot.status, 'failed');
  assert.deepEqual(snapshot.models, []);
  assert.equal(snapshot.issues.length, 1);
  assert.equal(snapshot.issues[0]!.code, 'status');
  assert.equal(snapshot.issues[0]!.status, 503);
  assert.equal(snapshot.issues[0]!.url, `${PRICING_ORIGIN}${PRICING_CATALOG_PATH}`);
});

test('网络异常折叠成 failed 快照', async () => {
  const { fetcher } = stub(() => { throw new Error('socket hang up'); });
  const snapshot = await fetchPricingSnapshot({ fetcher });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.issues[0]!.code, 'network');
});

test('抛出非 Error 的异常同样归为网络失败', async () => {
  const { fetcher } = stub(() => { throw 'boom'; });
  const snapshot = await fetchPricingSnapshot({ fetcher });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.issues[0]!.code, 'network');
});

test('响应体超过字节上限时拒绝解析', async () => {
  const { fetcher } = stub(() => html(catalogPage()));
  const snapshot = await fetchPricingSnapshot({ fetcher, maxBytes: 64 });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.issues[0]!.code, 'too-large');
});

test('声明的长度超过上限时不读取正文', async () => {
  const { fetcher } = stub(() => new Response('x', { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(MAX_PRICING_BODY_BYTES + 1) } }));
  const snapshot = await fetchPricingSnapshot({ fetcher });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.issues[0]!.code, 'too-large');
});

test('内容类型不是 HTML 时判为无效页面', async () => {
  const { fetcher } = stub(() => new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const snapshot = await fetchPricingSnapshot({ fetcher });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.issues[0]!.code, 'invalid-page');
});

test('请求超时折叠成 failed 快照', async () => {
  const fetcher: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const snapshot = await fetchPricingSnapshot({ fetcher, timeoutMs: 20 });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.issues[0]!.code, 'timeout');
});

test('deadline bounds a transport that ignores abort and a stalled response body', async () => {
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const ignored: typeof fetch = async () => new Promise<Response>(() => {});
    const first = await fetchPricingSnapshot({ fetcher: ignored, timeoutMs: 20 });
    assert.equal(first.issues[0]?.code, 'timeout');
    let cancelled = false;
    const stalled: typeof fetch = async () => new Response(new ReadableStream({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/html' } });
    const second = await fetchPricingSnapshot({ fetcher: stalled, timeoutMs: 20 });
    assert.equal(second.issues[0]?.code, 'timeout');
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test('调用方取消折叠成 failed 快照', async () => {
  const controller = new AbortController();
  const { fetcher } = stub(() => {
    controller.abort();
    throw new Error('aborted by caller');
  });
  const snapshot = await fetchPricingSnapshot({ fetcher, signal: controller.signal });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.issues[0]!.code, 'aborted');
});

test('默认时限与体积上限有固定取值', () => {
  assert.equal(PRICING_TIMEOUT_MS, 15_000);
  assert.equal(MAX_PRICING_BODY_BYTES, 4 * 1024 * 1024);
  assert.equal(PRICING_ORIGIN, 'https://corouter.open-design.ai');
  assert.equal(PRICING_CATALOG_PATH, '/zh/models/');
});
