import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  DEVICE_AUTH_ENDPOINT, DEVICE_AUTH_PLUGIN_VERSION, DEVICE_RESPONSE_MAX_BYTES, DeviceAuthError,
  parseDeviceAuthorization, parseDevicePoll, postDeviceJson, validateActivationUrl,
} from '../src/device-auth.js';

const activation = 'https://open-design.ai/cloud/cli/activate';
const device = () => ({ deviceId: 'device-1', deviceSecret: 'private-device-secret', userCode: 'ABCD-1234', activationUrl: `${activation}?code=ABCD-1234`, pollIntervalSeconds: 2, expiresAt: '2026-11-01T00:00:00.000Z' });
const isCode = (code: string) => (error: unknown) => error instanceof DeviceAuthError && error.code === code;
const mock = (response: Response): typeof fetch => async () => response;
const signal = () => new AbortController().signal;

test('device authorization identifies the actual plugin version, not an official CLI', () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest !== null && typeof manifest === 'object' && 'version' in manifest);
  assert.equal(DEVICE_AUTH_PLUGIN_VERSION, manifest.version);
});

test('activation links are canonical, official and contain only a matching user code', () => {
  assert.equal(validateActivationUrl(activation), activation);
  assert.equal(validateActivationUrl(`${activation}?code=ABCD-1234`, 'ABCD-1234'), `${activation}?code=ABCD-1234`);
  assert.equal(validateActivationUrl(`${activation}?code=%41BCD-1234`, 'ABCD-1234'), `${activation}?code=%41BCD-1234`);
  assert.equal(validateActivationUrl(`${activation}?user_code=ABCD-1234`, 'ABCD-1234'), `${activation}?user_code=ABCD-1234`);
  for (const url of [
    'http://open-design.ai/cloud/cli/activate', 'https://evil.test/cloud/cli/activate',
    'https://open-design.ai.evil.test/cloud/cli/activate', 'https://open-design.ai@evil.test/cloud/cli/activate',
    'https://user:password@open-design.ai/cloud/cli/activate', `${activation}#secret`, `${activation}#`,
    `${activation}?deviceSecret=private-device-secret`, `${activation}?code=ABCD-1234&token=secret`,
    `${activation}?code=ABCD-1234&code=ABCD-1234`, `${activation}?code=WRONG`, `${activation}?user_code=WRONG`,
    `${activation}/`, `${activation}/../activate`, 'https://open-design.ai/cloud/cli/%61ctivate',
    'https://open-design.ai:443/cloud/cli/activate', `${activation}?code=ABCD-1234\n`,
    `${activation}?code=ABCD%5c1234`, `${activation}?code=ABCD%001234`,
    'javascript:alert(1)', ` ${activation}`, `${activation}?code=`,
  ]) assert.equal(validateActivationUrl(url, 'ABCD-1234'), null, url);
});

test('live deviceId/userCode links are accepted only as a bounded matching pair', () => {
  const url = `${activation}?deviceId=device-1&userCode=ABCD-1234`;
  assert.equal(validateActivationUrl(url, 'ABCD-1234', 'device-1'), url);
  assert.equal(validateActivationUrl(url), url, 'the opener shares the same allowlist');
  assert.equal(validateActivationUrl(`${activation}?userCode=ABCD-1234&deviceId=device-1`, 'ABCD-1234', 'device-1'), `${activation}?userCode=ABCD-1234&deviceId=device-1`);
  assert.equal(parseDeviceAuthorization({ ...device(), activationUrl: url }).activationUrl, url);
  for (const query of [
    'deviceId=device-1', 'userCode=ABCD-1234',
    'deviceId=device-1&deviceId=device-1', 'userCode=ABCD-1234&userCode=ABCD-1234',
    'deviceId=&userCode=ABCD-1234', 'deviceId=..%2Felsewhere&userCode=ABCD-1234',
    `deviceId=${'x'.repeat(201)}&userCode=ABCD-1234`,
    'deviceId=device-1&userCode=WRONG', 'deviceId=device-1&userCode=ABCD%001234',
    'deviceId=device-1&code=ABCD-1234',
    'deviceId=device-1&userCode=ABCD-1234&deviceSecret=private-device-secret',
    'deviceId=device-1&userCode=ABCD-1234&userCode=ABCD-1234',
  ]) assert.equal(validateActivationUrl(`${activation}?${query}`, 'ABCD-1234', 'device-1'), null);
  assert.throws(() => parseDeviceAuthorization({ ...device(), deviceId: 'other-device', activationUrl: url }), isCode('opendesign/login-response'));
  assert.throws(() => parseDeviceAuthorization({ ...device(), deviceSecret: 'device-1', activationUrl: url }), isCode('opendesign/login-response'));
});

test('authorization shape, bounds and public fields are validated without exposing server data', () => {
  const parsed = parseDeviceAuthorization(device());
  assert.equal(parsed.pollMs, 2000);
  assert.equal(parseDeviceAuthorization({ ...device(), pollIntervalSeconds: 0.00001 }).pollMs, 1000);
  assert.equal(parseDeviceAuthorization({ ...device(), pollIntervalSeconds: 60 }).pollMs, 60_000);
  assert.equal(parseDeviceAuthorization({ ...device(), pollIntervalSeconds: 1e9 }).pollMs, 300_000);
  for (const changes of [
    { deviceId: '../elsewhere' }, { deviceId: 'x?key=secret' }, { deviceSecret: '' },
    { activationUrl: `${activation}?code=private-device-secret`, userCode: 'private-device-secret' },
    { deviceSecret: 'ABCD', userCode: 'ABCD-1234' }, { activationUrl: 'https://evil.test/' },
    { pollIntervalSeconds: NaN }, { pollIntervalSeconds: 0 }, { expiresAt: 'invalid' },
    { userCode: '<script>' }, { expiresAt: 'November 1, 2026' },
  ]) assert.throws(() => parseDeviceAuthorization({ ...device(), ...changes }), isCode('opendesign/login-response'));
});

test('only complete same-snapshot tokens authorize; pending is explicit and unknown states fail', () => {
  const tokens = { controlKey: 'test-control-token', runtimeKey: 'test-runtime-token' };
  assert.deepEqual(parseDevicePoll(tokens), { state: 'success', tokens });
  assert.deepEqual(parseDevicePoll({ user: tokens }), { state: 'success', tokens });
  assert.deepEqual(parseDevicePoll({ status: 'PENDING' }), { state: 'pending' });
  assert.deepEqual(parseDevicePoll({ status: 'authorization_pending' }), { state: 'pending' });
  for (const value of [{ controlKey: tokens.controlKey }, { user: { runtimeKey: tokens.runtimeKey } }, { controlKey: tokens.controlKey, user: { runtimeKey: tokens.runtimeKey } }]) {
    assert.throws(() => parseDevicePoll(value), isCode('opendesign/login-incomplete'));
  }
  assert.throws(() => parseDevicePoll({ ...tokens, user: { controlKey: 'other-account' } }), isCode('opendesign/login-response'));
  for (const status of ['cancelled', 'canceled', 'denied', 'rejected']) assert.throws(() => parseDevicePoll({ ...tokens, status }), isCode('opendesign/login-denied'));
  assert.throws(() => parseDevicePoll({ ...tokens, status: 'expired' }), isCode('opendesign/login-expired'));
  for (const error of ['access_denied', 'invalid_device_secret', { code: 'expired', message: 'private-device-secret' }]) assert.throws(() => parseDevicePoll({ ...tokens, error }), isCode('opendesign/login-response'));
  for (const value of [{}, { status: 'unknown' }, { status: 'success' }, null]) assert.throws(() => parseDevicePoll(value), isCode('opendesign/login-response'));
});

test('live pending null keys keep waiting but partial or failed snapshots never do', () => {
  const pending = { status: 'pending', controlKey: null, runtimeKey: null, user: null };
  assert.deepEqual(parseDevicePoll(pending), { state: 'pending' });
  assert.deepEqual(parseDevicePoll({ ...pending, status: 'authorization_pending', user: { controlKey: null, runtimeKey: null } }), { state: 'pending' });
  for (const value of [
    { ...pending, controlKey: 'fixture-control' },
    { ...pending, runtimeKey: 'fixture-runtime' },
    { ...pending, user: { controlKey: 'fixture-control' } },
    { ...pending, controlKey: '' },
    { ...pending, error: 'access_denied' },
    { ...pending, status: 'success' },
    { ...pending, status: 'unknown' },
    { ...pending, status: 'denied' },
    { ...pending, status: 'expired' },
  ]) assert.throws(() => parseDevicePoll(value), DeviceAuthError);
});

test('HTTP requests use POST, JSON, redirect:error and omit browser credentials', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => { calls.push({ url: String(input), init }); return Response.json({ status: 'pending' }); };
  const body = { deviceSecret: 'private-device-secret' };
  await postDeviceJson(fetcher, `${DEVICE_AUTH_ENDPOINT}/device-1/token`, body, signal());
  assert.equal(calls[0]?.url, `${DEVICE_AUTH_ENDPOINT}/device-1/token`);
  const init = calls[0]?.init;
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'error');
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(String(init?.body)), body);
  assert.deepEqual(init?.headers, { accept: 'application/json', 'content-type': 'application/json' });
  assert.ok(init?.signal instanceof AbortSignal);
});

test('untrusted request targets, redirects and permission failures are safe errors', async () => {
  for (const url of ['https://evil.test/', `${DEVICE_AUTH_ENDPOINT}?x=secret`, `${DEVICE_AUTH_ENDPOINT}/../token`, `${DEVICE_AUTH_ENDPOINT}/foo%2fbar/token`]) {
    let called = false;
    await assert.rejects(postDeviceJson(async () => { called = true; return Response.json({}); }, url, {}, signal()), isCode('opendesign/login-url'));
    assert.equal(called, false);
  }
  for (const status of [301, 302, 307, 308]) await assert.rejects(postDeviceJson(mock(new Response(null, { status, headers: { location: 'https://evil.test/' } })), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-redirect'));
  const followed = Response.json({ controlKey: 'secret' });
  Object.defineProperties(followed, { redirected: { value: true }, url: { value: 'https://evil.test/' } });
  await assert.rejects(postDeviceJson(mock(followed), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-redirect'));
  const changed = Response.json({});
  Object.defineProperty(changed, 'url', { value: `${DEVICE_AUTH_ENDPOINT}/wrong` });
  await assert.rejects(postDeviceJson(mock(changed), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-redirect'));
  for (const status of [401, 403]) await assert.rejects(postDeviceJson(mock(new Response('secret-unsafe-message', { status })), DEVICE_AUTH_ENDPOINT, {}, signal()), error => isCode('opendesign/login-denied')(error) && !String(error).includes('secret-unsafe-message'));
  for (const status of [404, 410]) await assert.rejects(postDeviceJson(mock(new Response(null, { status })), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-expired'));
  await assert.rejects(postDeviceJson(mock(new Response('private-server-message', { status: 500 })), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-network'));
});

test('declared and streamed responses are size bounded; invalid JSON has a safe error', async () => {
  await assert.rejects(postDeviceJson(mock(new Response('{}', { headers: { 'content-length': String(DEVICE_RESPONSE_MAX_BYTES + 1) } })), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-response-size'));
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(DEVICE_RESPONSE_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(postDeviceJson(mock(new Response(stream)), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-response-size'));
  assert.equal(cancelled, true);
  for (const body of ['invalid private-secret json', '{"partial":', '']) await assert.rejects(postDeviceJson(mock(new Response(body)), DEVICE_AUTH_ENDPOINT, {}, signal()), isCode('opendesign/login-response'));
});

test('request deadline bounds even abort-ignoring transports and stalled body readers', async () => {
  let requestSignal: AbortSignal | null | undefined;
  const stuck: typeof fetch = async (_input, init) => { requestSignal = init?.signal; return new Promise<Response>(() => undefined); };
  await assert.rejects(postDeviceJson(stuck, DEVICE_AUTH_ENDPOINT, {}, signal(), 10), isCode('opendesign/login-request-timeout'));
  assert.equal(requestSignal?.aborted, true);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(postDeviceJson(mock(new Response(stream)), DEVICE_AUTH_ENDPOINT, {}, signal(), 10), isCode('opendesign/login-request-timeout'));
  assert.equal(cancelled, true);
});

test('external cancellation stops fetch and body consumption, and network text never leaks', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | null | undefined;
  const pending = postDeviceJson(async (_input, init) => { seen = init?.signal; return new Promise<Response>(() => undefined); }, DEVICE_AUTH_ENDPOINT, {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, isCode('opendesign/login-cancelled'));
  assert.equal(seen?.aborted, true);
  let cancelled = false;
  const bodyController = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const reading = postDeviceJson(mock(new Response(stream)), DEVICE_AUTH_ENDPOINT, {}, bodyController.signal);
  await new Promise(resolve => setTimeout(resolve, 1));
  bodyController.abort();
  await assert.rejects(reading, isCode('opendesign/login-cancelled'));
  assert.equal(cancelled, true);
  await assert.rejects(postDeviceJson(async () => { throw new Error('private-device-secret https://evil.test/'); }, DEVICE_AUTH_ENDPOINT, {}, signal()), error => isCode('opendesign/login-network')(error) && !String(error).includes('private-device-secret'));
});
