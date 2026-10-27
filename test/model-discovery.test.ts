// Tests for src/model-discovery.ts: OpenAI `GET /models` normalization over synthesized fetch
// stubs only. 不读凭据、不访问真实 API、不读宿主 Profile；stub 记录请求以便断言协议形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { DISCOVERY_TIMEOUT_MS, MAX_DISCOVERY_BODY_BYTES, ModelDiscoveryError, fetchModelCatalog } from '../src/model-discovery.js';
import { findModel } from '../src/catalog.js';

const BASE = 'https://amr-link.open-design.ai/v1';
/** 只在内存里存在的合成凭据；断言失败信息也不得包含它。 */
const KEY = 'fixture-key';

interface Call { url: string; init: RequestInit }
type Handler = (call: Call) => Response | Promise<Response>;

/** A fetch stub that records every call and answers from `handler`. */
function stub(handler: Handler): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { fetcher, calls };
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

/** Await a call that must fail and return its classified error. */
async function failure(promise: Promise<unknown>): Promise<ModelDiscoveryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ModelDiscoveryError, `expected ModelDiscoveryError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the discovery call to fail');
}

test('GET {base}/models carries Bearer auth, attribution and refuses redirects', async () => {
  const { fetcher, calls } = stub(() => Response.json({ object: 'list', data: [{ id: 'glm-5.2' }] }));
  const rows = await fetchModelCatalog(`${BASE}/`, KEY, undefined, fetcher);
  // 已知 id 继承目录里的分组与厂商档位（GLM-5.2 的官方取值含 none/minimal）。
  assert.deepEqual(rows, [{
    id: 'glm-5.2',
    name: 'GLM-5.2',
    group: 'paid',
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  }]);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `${BASE}/models`);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'error');
  const headers = headersOf(call);
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['user-agent'], attributionHeaders()['user-agent']);
  // 发现请求自带 20 秒界限：传输层拿到的是与调用方信号合成的信号。
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(call.init.signal.aborted, false);
  assert.equal(DISCOVERY_TIMEOUT_MS, 20_000);
});

test('a bare gateway origin still discovers through the OpenAI v1 models endpoint', async () => {
  const { fetcher, calls } = stub(() => Response.json({ data: [] }));
  await fetchModelCatalog('https://amr-link.open-design.ai', KEY, undefined, fetcher);
  assert.equal(calls[0]?.url, `${BASE}/models`);
});

test('the credential is trimmed once and unusable credentials fail before any request', async () => {
  const { fetcher, calls } = stub(() => Response.json({ data: [] }));
  assert.deepEqual(await fetchModelCatalog(BASE, `  ${KEY}  `, undefined, fetcher), []);
  assert.equal(headersOf(calls[0]!).authorization, `Bearer ${KEY}`);
  // 空、纯空白或含非可打印 ASCII 的凭据在发请求前就被拒，绝不进入请求头。
  for (const key of ['', '   ', 'fixture\nkey', 'fixture-key-é']) {
    const rejected = await failure(fetchModelCatalog(BASE, key, undefined, fetcher));
    assert.equal(rejected.kind, 'credential');
    assert.equal(rejected.message.includes(KEY), false);
  }
  assert.equal(calls.length, 1);
});

test('known ids inherit catalog grouping and capabilities; new ids are paid rows with no invented capacity', async () => {
  const { fetcher } = stub(() => Response.json({
    object: 'list',
    data: [
      { id: 'claude-opus-5', object: 'model', name: 'api-supplied-name' },
      { id: 'deepseek-v4.1-flash', object: 'model', name: 'api-supplied-name' },
      { id: 'brand-new-chat', object: 'model', name: '  Brand New  ', context_window: 999999, capabilities: { vision: true }, architecture: { output_modalities: ['image'] } },
    ],
  }));
  const rows = await fetchModelCatalog(BASE, KEY, undefined, fetcher);
  assert.deepEqual(rows.map(row => row.id), ['claude-opus-5', 'deepseek-v4.1-flash', 'brand-new-chat']);
  // 已知 id：分组、能力与显示名沿用目录取证值，不受上游名称影响；副本是独立对象。
  const paid = rows[0]!;
  assert.deepEqual(paid, findModel('claude-opus-5'));
  assert.notEqual(paid, findModel('claude-opus-5'));
  assert.equal(paid.group, 'paid');
  // Anthropic 型号的 effort 只有 low/medium/high/xhigh/max，没有 none/minimal。
  assert.deepEqual(paid.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  const plan = rows[1]!;
  assert.deepEqual(plan, findModel('deepseek-v4.1-flash'));
  assert.equal(plan.group, 'plan');
  assert.equal(plan.contextWindow, 1_000_000);
  assert.deepEqual(plan.inputModalities, ['text', 'image']);
  assert.deepEqual(plan.reasoningEfforts, ['low', 'high', 'max']);
  // 新 id：只保留 id/name 并归 paid，未识别的上游能力字段一律不猜。
  const fresh = rows[2]!;
  assert.deepEqual(fresh, { id: 'brand-new-chat', name: 'Brand New', group: 'paid' });
  assert.equal(fresh.contextWindow, undefined);
  assert.equal(fresh.maxOutputTokens, undefined);
  assert.equal(fresh.inputModalities, undefined);
  assert.equal(fresh.reasoningEfforts, undefined);
});

test('five verified API additions retain their catalog labels without inventing capabilities', async () => {
  const ids = ['gemini-4-argon', 'kimi-k3.1-pro', 'minimax-m3.1-flash', 'muse-spark-1.3', 'muse-wonder'];
  /** 各型号的厂商档位；Muse Wonder 精确别名未确认，档位保持缺省。 */
  const efforts: Record<string, readonly string[] | undefined> = {
    'gemini-4-argon': ['low', 'medium', 'high'],
    'kimi-k3.1-pro': ['low', 'high', 'max'],
    'minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
    'muse-spark-1.3': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    'muse-wonder': undefined,
  };
  const { fetcher } = stub(() => Response.json({ data: ids.map(id => ({ id })) }));
  const rows = await fetchModelCatalog(BASE, KEY, undefined, fetcher);
  assert.deepEqual(rows.map(row => row.id), ids);
  for (const row of rows) {
    assert.deepEqual(row, findModel(row.id));
    assert.equal(row.group, row.id === 'minimax-m3.1-flash' ? 'plan' : 'paid');
    // 容量类字段仍无可核实取值，不因发现接口返回了这些 id 就补上。
    assert.equal(row.contextWindow, undefined);
    assert.equal(row.maxOutputTokens, undefined);
    assert.equal(row.inputModalities, undefined);
    assert.deepEqual(row.reasoningEfforts, efforts[row.id], `${row.id} reasoningEfforts`);
  }
});

test('drops unusable and duplicate rows instead of inventing models', async () => {
  const { fetcher } = stub(() => Response.json({
    data: [
      { id: 'usable-model', name: 'Usable' },
      { id: 'usable-model', name: 'Duplicate' },
      { id: 'bad id', name: 'Space' },
      { id: 'a'.repeat(129), name: 'Too long' },
      { id: 'bad+id', name: 'Plus' },
      { id: 42, name: 'Number id' },
      { id: null, name: 'Null id' },
      { name: 'No id' },
      'usable-model',
      null,
      { id: 'second-model', name: 7 },
    ],
  }));
  const rows = await fetchModelCatalog(BASE, KEY, undefined, fetcher);
  assert.deepEqual(rows, [
    { id: 'usable-model', name: 'Usable', group: 'paid' },
    // 名称缺失或不是字符串时回退为 id，而不是编造显示名。
    { id: 'second-model', name: 'second-model', group: 'paid' },
  ]);
});

test('explicit media-output models stay out of the chat catalog', async () => {
  const media = ['gpt-image-2', 'nano-banana-2', 'seedream-5-lite', 'seedream-5-pro', 'imagen-4', 'veo-3', 'doubao-seedance-1', 'sora-2'];
  const { fetcher } = stub(() => Response.json({ data: [...media.map(id => ({ id })), { id: 'gpt-6-luna' }] }));
  const rows = await fetchModelCatalog(BASE, KEY, undefined, fetcher);
  assert.deepEqual(rows.map(row => row.id), ['gpt-6-luna']);
});

test('an empty or oversized list is bounded', async () => {
  const empty = stub(() => Response.json({ object: 'list', data: [] }));
  assert.deepEqual(await fetchModelCatalog(BASE, KEY, undefined, empty.fetcher), []);
  const oversize = stub(() => Response.json({ data: Array.from({ length: 513 }, (_, index) => ({ id: `model-${index}` })) }));
  assert.equal((await failure(fetchModelCatalog(BASE, KEY, undefined, oversize.fetcher))).kind, 'response');
  // 上限内部先于条目校验生效，因此重复 id 也不能绕过。
  const duplicated = stub(() => Response.json({ data: Array.from({ length: 513 }, () => ({ id: 'same-model' })) }));
  assert.equal((await failure(fetchModelCatalog(BASE, KEY, undefined, duplicated.fetcher))).kind, 'response');
});

test('invalid base URLs fail as `url` before any request is made', async () => {
  const { fetcher, calls } = stub(() => Response.json({ data: [] }));
  for (const base of ['not a URL', 'ftp://example.com/v1', 'http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?secret=fixture', 'https://example.com/v1#fragment', '']) {
    const rejected = await failure(fetchModelCatalog(base, KEY, undefined, fetcher));
    assert.equal(rejected.kind, 'url', base);
    assert.equal(rejected.message.includes(KEY), false);
  }
  assert.equal(calls.length, 0);
});

test('HTTP failures map to fixed categories and never echo upstream bodies', async () => {
  const cases: readonly [number, string][] = [
    [401, 'auth'], [403, 'permission'], [429, 'rate-limit'], [408, 'timeout'], [504, 'timeout'], [500, 'server'], [503, 'server'], [400, 'response'], [404, 'response'],
  ];
  for (const [status, kind] of cases) {
    const { fetcher } = stub(() => new Response('{"error":{"message":"SECRET-BODY-MARKER"}}', { status }));
    const rejected = await failure(fetchModelCatalog(BASE, KEY, undefined, fetcher));
    assert.equal(rejected.kind, kind, String(status));
    assert.equal(rejected.status, status);
    assert.equal(rejected.message.includes('SECRET-BODY-MARKER'), false);
    assert.equal(rejected.message.includes(KEY), false);
    assert.equal(String(rejected).includes('SECRET-BODY-MARKER'), false);
  }
});

test('non-listing bodies and bodies over 2 MiB are refused as `response`', async () => {
  for (const body of [{}, { data: {} }, { data: null }, { data: 'list' }, [], null, { object: 'list' }]) {
    const { fetcher } = stub(() => Response.json(body));
    assert.equal((await failure(fetchModelCatalog(BASE, KEY, undefined, fetcher))).kind, 'response', JSON.stringify(body));
  }
  const html = stub(() => new Response('<html>SECRET-BODY-MARKER</html>', { status: 200 }));
  const rejected = await failure(fetchModelCatalog(BASE, KEY, undefined, html.fetcher));
  assert.equal(rejected.kind, 'response');
  assert.equal(rejected.message.includes('SECRET-BODY-MARKER'), false);
  assert.equal(MAX_DISCOVERY_BODY_BYTES, 2 * 1024 * 1024);
  // 声明长度超限：不读 body 直接拒绝。
  const declared = stub(() => new Response('{}', { headers: { 'content-length': String(MAX_DISCOVERY_BODY_BYTES + 1) } }));
  assert.equal((await failure(fetchModelCatalog(BASE, KEY, undefined, declared.fetcher))).kind, 'response');
  // 流式长度超限：读满上限后同样拒绝。
  const streamed = stub(() => new Response('x'.repeat(MAX_DISCOVERY_BODY_BYTES + 1)));
  assert.equal((await failure(fetchModelCatalog(BASE, KEY, undefined, streamed.fetcher))).kind, 'response');
});

test('a body cut off mid-stream by cancellation is `aborted`, not a format error', async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      controller.abort();
      stream.error(new Error('connection reset'));
    },
  });
  const { fetcher } = stub(() => new Response(body));
  const rejected = await failure(fetchModelCatalog(BASE, KEY, controller.signal, fetcher));
  assert.equal(rejected.kind, 'aborted');
});

test('transport failures and cancellation keep their own categories', async () => {
  const broken = stub(() => { throw new TypeError('fetch failed'); });
  const network = await failure(fetchModelCatalog(BASE, KEY, undefined, broken.fetcher));
  assert.equal(network.kind, 'network');
  assert.equal(network.status, undefined);
  assert.equal(network.message.includes(KEY), false);
  // 调用方已取消：传输层的异常折叠为 `aborted`，不误报为网络故障。
  const controller = new AbortController();
  controller.abort();
  const cancelled = stub(() => { throw new Error('aborted by caller'); });
  const aborted = await failure(fetchModelCatalog(BASE, KEY, controller.signal, cancelled.fetcher));
  assert.equal(aborted.kind, 'aborted');
  // 20 秒界限由 combinedSignal 组合而来（见上面的 DISCOVERY_TIMEOUT_MS 断言）；
  // 这里不再等待 20 秒真实超时，超时分类由传输层信号触发后的同一分支覆盖。
});
