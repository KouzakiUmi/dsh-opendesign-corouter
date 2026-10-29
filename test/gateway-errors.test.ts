/**
 * 上游失败分类的离线契约：全部在内存里合成信封，不触网、不读写凭据。
 *
 * 覆盖 OpenAI / Anthropic 两种信封、中文/英文/未知代码、钱包与套餐额度、401/403、
 * 429、超时、服务端，以及固定文案不回显上游 body 或密钥。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicError, gatewayError, inBandError } from '../src/protocols/errors.js';

const SECRET = 'PRIVATE_BODY_sk-live-9f3a';
const FIXED = {
  context: 'OpenDesign：请求超出模型上下文长度，请缩短输入后重试',
  account: 'OpenDesign：套餐或账户额度不足，请检查套餐额度后重试',
  wallet: 'OpenDesign：钱包或积分余额不足，请充值后重试',
  credential: 'OpenDesign：API Key 无效或缺失，请在设置中更新凭据',
  auth: 'OpenDesign：认证未通过，请重新登录后重试',
  permission: 'OpenDesign：当前账户无权访问该模型',
  rate: 'OpenDesign：请求过于频繁，请稍后重试',
  timeout: 'OpenDesign：请求超时，请稍后重试',
  server: 'OpenDesign：上游服务暂不可用，请稍后重试',
  tooLarge: 'OpenDesign：请求内容超过上游大小限制，请压缩历史、减少图片或缩小输入后重试',
} as const;

/** 分类结果必须只含固定中文文案与结构化状态，绝不带任何上游字符串。 */
function check(error: { code: string; message: string; failure?: unknown }, code: string, message: string, status?: number) {
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('sk-live'), false);
  assert.equal(serialized.includes('上游原文'), false);
  if (status === undefined) assert.equal(JSON.stringify(error.failure).includes('"status"'), false);
  else assert.equal((error.failure as { status?: number }).status, status);
}

test('OpenAI 信封：明确点名无效或缺失的 Key 才算凭据错误', () => {
  check(gatewayError(401, { error: { code: 'invalid_api_key', message: SECRET } }), 'INVALID_CREDENTIAL', FIXED.credential, 401);
  check(gatewayError(400, { error: { code: 'missing_api_key', message: SECRET } }), 'INVALID_CREDENTIAL', FIXED.credential, 400);
  check(gatewayError(401, { error: { type: 'invalid_request_error', message: 'Incorrect API key provided: sk-live-9f3a' } }), 'INVALID_CREDENTIAL', FIXED.credential, 401);
});

test('普通 401/403 只表达认证或权限，不断言 Key 无效', () => {
  const unauthorized = gatewayError(401, { error: { message: `Unauthorized ${SECRET}` } });
  check(unauthorized, 'AUTH', FIXED.auth, 401);
  assert.equal(unauthorized.message.includes('Key'), false);
  check(gatewayError(403, {}), 'PERMISSION', FIXED.permission, 403);
  check(gatewayError(403, { error: { message: 'Forbidden: model access denied' } }), 'PERMISSION', FIXED.permission, 403);
  check(anthropicError(401, { type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } }), 'AUTH', FIXED.auth, 401);
  check(anthropicError(403, { type: 'error', error: { type: 'permission_error', message: 'no access' } }), 'PERMISSION', FIXED.permission, 403);
});

test('Anthropic 信封识别明确的 invalid x-api-key，并保留限流/服务端分类', () => {
  check(anthropicError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), 'INVALID_CREDENTIAL', FIXED.credential, 401);
  check(anthropicError(429, { type: 'error', error: { type: 'rate_limit_error', message: `slow down ${SECRET}` } }), 'RATE_LIMIT', FIXED.rate, 429);
  check(anthropicError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 'SERVER', FIXED.server, 529);
  check(anthropicError(500, { type: 'error', error: { type: 'api_error', message: SECRET } }), 'SERVER', FIXED.server, 500);
});

test('额度区分套餐/账户与钱包/积分，并优先于 429/401 状态', () => {
  // 套餐/订阅/账户额度 → ACCOUNT_QUOTA
  check(anthropicError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your subscription credits are exhausted' } }), 'ACCOUNT_QUOTA', FIXED.account, 400);
  check(gatewayError(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } }), 'ACCOUNT_QUOTA', FIXED.account, 429);
  check(gatewayError(401, { error: { message: '套餐额度已用尽，请等待下一个计费周期' } }), 'ACCOUNT_QUOTA', FIXED.account, 401);
  // 钱包/充值/积分/余额 → QUOTA
  check(gatewayError(402, { error: { message: 'insufficient balance' } }), 'QUOTA', FIXED.wallet, 402);
  check(gatewayError(400, { error: { message: 'Your credit balance is too low to access the API' } }), 'QUOTA', FIXED.wallet, 400);
  check(anthropicError(400, { type: 'error', error: { type: 'invalid_request_error', message: '积分余额不足，请充值后重试' } }), 'QUOTA', FIXED.wallet, 400);
  check(gatewayError(401, { error: { message: '当前账户额度不足' } }), 'ACCOUNT_QUOTA', FIXED.account, 401);
});

test('429 限流不会被泛化成额度；结构化 code/type 优先于正文背景词', () => {
  check(gatewayError(429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' } }), 'RATE_LIMIT', FIXED.rate, 429);
  check(gatewayError(429, { error: { message: 'rate_limit_exceeded' } }), 'RATE_LIMIT', FIXED.rate, 429);
  check(gatewayError(429, { error: { message: 'Too many requests, see your quota dashboard for details.' } }), 'RATE_LIMIT', FIXED.rate, 429);
  // 结构化额度信号即使状态是 429 也保持额度分类。
  check(gatewayError(429, { error: { code: 'quota_exceeded', message: 'rate limit exceeded' } }), 'ACCOUNT_QUOTA', FIXED.account, 429);
  // 结构化限流信号即使正文提到额度也保持限流分类。
  check(gatewayError(429, { error: { code: 'rate_limit_exceeded', message: 'Insufficient quota for this minute' } }), 'RATE_LIMIT', FIXED.rate, 429);
  // 纯状态兜底仍为限流。
  check(gatewayError(429, {}), 'RATE_LIMIT', FIXED.rate, 429);
});

test('5xx 是服务端事实：没有结构化代码时不被正文的认证或额度措辞改判', () => {
  check(gatewayError(500, { error: { message: 'Unauthorized: invalid api key' } }), 'SERVER', FIXED.server, 500);
  check(gatewayError(502, { error: { message: '额度不足，请联系管理员' } }), 'SERVER', FIXED.server, 502);
  check(gatewayError(504, { error: { message: 'upstream timeout' } }), 'TIMEOUT', FIXED.timeout, 504);
});

test('上下文、超时、服务端保持稳定分类，背景词不误判', () => {
  check(gatewayError(400, { error: { code: 'context_length_exceeded', message: `too long ${SECRET}` } }), 'CONTEXT_WINDOW_EXCEEDED', FIXED.context, 400);
  check(anthropicError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }), 'CONTEXT_WINDOW_EXCEEDED', FIXED.context, 400);
  check(gatewayError(400, { error: { message: '请求超出上下文长度限制' } }), 'CONTEXT_WINDOW_EXCEEDED', FIXED.context, 400);
  check(gatewayError(408, { error: { message: `request timed out ${SECRET}` } }), 'TIMEOUT', FIXED.timeout, 408);
  check(gatewayError(504, {}), 'TIMEOUT', FIXED.timeout, 504);
  check(gatewayError(503, {}), 'SERVER', FIXED.server, 503);
  check(inBandError({ code: 'server_error', message: SECRET }), 'SERVER', FIXED.server);
  // “上下文/额度”只是正文背景时不得改判。
  check(gatewayError(400, { error: { message: 'context is required for this tool; quota field missing' } }), 'INVALID_REQUEST', 'OpenDesign：请求被上游拒绝', 400);
  check(anthropicError(400, { type: 'error', error: { type: 'invalid_request_error', message: '模型上下文缓存配置无效' } }), 'INVALID_REQUEST', 'OpenDesign：请求被上游拒绝', 400);
});

test('HTTP 413 reports a request-size limit without claiming a token-window overflow', () => {
  check(gatewayError(413, {}), 'REQUEST_TOO_LARGE', FIXED.tooLarge, 413);
  check(anthropicError(413, { type: 'error', error: { type: 'request_too_large', message: SECRET } }), 'REQUEST_TOO_LARGE', FIXED.tooLarge, 413);
  check(gatewayError(413, { error: { code: 'context_length_exceeded', message: SECRET } }), 'CONTEXT_WINDOW_EXCEEDED', FIXED.context, 413);
});

test('中文/英文/未知代码都落到固定分类，未知文案按状态兜底', () => {
  check(gatewayError(400, { error: { code: 'some_unknown_code', message: '未知的上游原因' } }), 'INVALID_REQUEST', 'OpenDesign：请求被上游拒绝', 400);
  check(gatewayError(418, { error: { message: SECRET } }), 'INVALID_REQUEST', 'OpenDesign：请求被上游拒绝', 418);
  check(gatewayError(undefined, { error: { code: 'totally_unknown', message: SECRET } }), 'INVALID_REQUEST', 'OpenDesign：请求被上游拒绝');
  check(inBandError({ message: SECRET }), 'INVALID_RESPONSE', 'OpenDesign：上游响应格式无效');
  check(inBandError({ message: SECRET }, 'SERVER'), 'SERVER', FIXED.server);
  check(gatewayError(400, { error: { message: '请求过于频繁，请稍后重试' } }), 'RATE_LIMIT', FIXED.rate, 400);
  check(gatewayError(400, { error: { message: 'API Key 无效，请更新设置' } }), 'INVALID_CREDENTIAL', FIXED.credential, 400);
  check(gatewayError(400, { error: { message: '认证失败，请重新登录' } }), 'AUTH', FIXED.auth, 400);
  check(gatewayError(400, { error: { message: '无权限访问该模型' } }), 'PERMISSION', FIXED.permission, 400);
  check(gatewayError(400, { error: { message: '服务暂不可用，请稍后再试' } }), 'SERVER', FIXED.server, 400);
  check(gatewayError(400, { error: { message: '请求超时' } }), 'TIMEOUT', FIXED.timeout, 400);
});

test('错误对象不携带上游响应原文、请求头或凭据', () => {
  const bodies = [
    gatewayError(401, { error: { code: 'invalid_api_key', message: `bad key ${SECRET}`, type: 'authentication_error' } }),
    gatewayError(429, { error: { code: 'insufficient_quota', message: `quota ${SECRET}` }, request_id: 'req_secret' }),
    anthropicError(400, { type: 'error', error: { type: 'invalid_request_error', message: `prompt too long ${SECRET}` } }),
    inBandError({ code: 'unknown', message: SECRET }),
  ];
  for (const error of bodies) {
    assert.match(error.message, /^OpenDesign：/u);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes('req_secret'), false);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    assert.equal(JSON.stringify(error).includes('req_secret'), false);
  }
});

test('pool names without an exhaustion signal are not quota errors', () => {
  assert.equal(gatewayError(400, { error: { code: 'wallet_balance_parse_error' } }).code, 'INVALID_REQUEST');
  assert.equal(gatewayError(400, { error: { code: 'subscription_schema_invalid' } }).code, 'INVALID_REQUEST');
  assert.equal(gatewayError(400, { error: { code: 'credit_balance_too_low' } }).code, 'QUOTA');
  assert.equal(gatewayError(400, { error: { code: 'subscription_quota_exceeded' } }).code, 'ACCOUNT_QUOTA');
});

test('空信封与坏形状不抛异常，也不猜测分类', () => {
  for (const body of [undefined, null, {}, [], 'PRIVATE_BODY_sk-live-9f3a', { error: null }, { error: [] }, { error: 42 }]) {
    const error = gatewayError(400, body);
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.message, 'OpenDesign：请求被上游拒绝');
    assert.equal(error.message.includes(SECRET), false);
  }
  assert.equal(anthropicError(401, { type: 'error', error: { message: 'Unauthorized' } }).code, 'AUTH');
  assert.equal(inBandError(undefined).code, 'INVALID_RESPONSE');
});
