// Tests for src/auth.ts. No real credential file is read: every case injects text or a reader.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DESKTOP_PROFILES,
  DEFAULT_API_URL,
  cookieSession,
  desktopConfigDir,
  desktopConfigPath,
  desktopSession,
  deviceSession,
  deviceGrant,
  isOfficialRuntimeUrl,
  endpoints,
  isOfficialApiUrl,
  normalizeApiUrl,
  parseDesktopConfigText,
  readDesktopCredential,
  resolveProfile,
  resolveSession,
} from '../src/auth.js';

const CONTROL_KEY = 'ctrl-test-token-value';
const COOKIE = 'better-auth.session_token=cookie-test-value; od_attr=1';

function config(profiles: Record<string, unknown>) {
  return JSON.stringify({ profiles });
}

test('parseDesktopConfigText reads the prod profile and drops nothing sensitive into extras', () => {
  const read = parseDesktopConfigText(config({
    prod: {
      controlKey: CONTROL_KEY,
      runtimeKey: 'rt',
      apiUrl: 'https://amr-api.open-design.ai',
      user: { id: 'u1', email: 'someone@example.com', plan: 'go' },
    },
  }));
  assert.equal(read.state, 'credential');
  if (read.state !== 'credential') return;
  assert.equal(read.credential.controlKey, CONTROL_KEY);
  assert.equal(read.credential.apiUrl, 'https://amr-api.open-design.ai');
  assert.equal(read.credential.plan, 'go');
  assert.equal(read.credential.signedIn, true);
  // PII and the runtime key stay out of the projection entirely.
  const serialized = JSON.stringify(read.credential);
  assert.equal(serialized.includes('someone@example.com'), false);
  assert.equal(serialized.includes('"rt"'), false);
});

test('parseDesktopConfigText treats a config for another profile as incomplete, not invalid', () => {
  assert.deepEqual(parseDesktopConfigText(config({ test: { controlKey: 'x' } }), 'prod'), { state: 'incomplete', profile: 'prod' });
});

test('parseDesktopConfigText rejects broken JSON and control characters without echoing the text', () => {
  assert.deepEqual(parseDesktopConfigText('{not json'), { state: 'invalid' });
  assert.deepEqual(parseDesktopConfigText(config({ prod: { controlKey: `bad\r\nInjected: 1` } })), { state: 'invalid' });
  assert.deepEqual(parseDesktopConfigText(config({ prod: { runtimeKey: 'rt' } })), { state: 'incomplete', profile: 'prod' });
});

test('a non-official apiUrl is reported instead of being silently dropped', () => {
  const evil = parseDesktopConfigText(config({ prod: { controlKey: CONTROL_KEY, apiUrl: 'https://evil.example' } }));
  assert.deepEqual(evil, { state: 'unsafe-api-url', profile: 'prod' });
  const sibling = parseDesktopConfigText(config({ prod: { controlKey: CONTROL_KEY, apiUrl: 'https://corouter.open-design.ai' } }));
  assert.deepEqual(sibling, { state: 'unsafe-api-url', profile: 'prod' });
});

test('a non-prod profile is refused rather than sent to the prod endpoint', () => {
  const read = parseDesktopConfigText(config({ prod: { controlKey: CONTROL_KEY } }), 'test');
  assert.deepEqual(read, { state: 'incomplete', profile: 'test' });
  // A test-profile token exists but its environment is not supported.
  const withKey = parseDesktopConfigText(config({ test: { controlKey: CONTROL_KEY } }), 'test');
  assert.deepEqual(withKey, { state: 'unsupported-profile', profile: 'test' });
});

test('isOfficialApiUrl accepts exactly the control-plane host and rejects every other origin', () => {
  assert.equal(isOfficialApiUrl('https://amr-api.open-design.ai'), true);
  assert.equal(isOfficialApiUrl('https://corouter.open-design.ai'), false);
  assert.equal(isOfficialApiUrl('https://open-design.ai'), false);
  assert.equal(isOfficialApiUrl('http://amr-api.open-design.ai'), false);
  assert.equal(isOfficialApiUrl('https://amr-api.open-design.ai.evil.example'), false);
  assert.equal(isOfficialApiUrl('https://user:pass@amr-api.open-design.ai'), false);
  assert.equal(isOfficialApiUrl('https://amr-api.open-design.ai/?redirect=evil'), false);
  assert.equal(isOfficialApiUrl('https://amr-api.open-design.ai/proxy'), false);
  assert.equal(normalizeApiUrl('https://AMR-API.open-design.ai') , 'https://amr-api.open-design.ai');
  assert.equal(normalizeApiUrl('https://evil.example'), undefined);
  assert.equal(normalizeApiUrl(undefined), undefined);
});

test('desktopConfigDir honours AMR_HOME expansions and defaults to ~/.amr', () => {
  assert.equal(desktopConfigDir({}, '/home/u'), join('/home/u', '.amr'));
  assert.equal(desktopConfigDir({ AMR_HOME: '~' }, '/home/u'), '/home/u');
  assert.equal(desktopConfigDir({ AMR_HOME: '~/state' }, '/home/u'), join('/home/u', 'state'));
  assert.equal(desktopConfigDir({ AMR_HOME: '/abs/dir' }, '/home/u'), '/abs/dir');
  assert.equal(desktopConfigPath({ AMR_HOME: '/abs' }, '/home/u'), join('/abs', 'config.json'));
});

test('resolveProfile follows OPEN_DESIGN_AMR_PROFILE > VELA_PROFILE > prod and ignores unknown names', () => {
  assert.equal(resolveProfile({}), 'prod');
  assert.equal(resolveProfile({ VELA_PROFILE: 'test' }), 'test');
  assert.equal(resolveProfile({ VELA_PROFILE: 'test', OPEN_DESIGN_AMR_PROFILE: 'feature-test' }), 'feature-test');
  assert.equal(resolveProfile({ OPEN_DESIGN_AMR_PROFILE: 'staging' }), 'prod');
  assert.deepEqual([...DESKTOP_PROFILES], ['prod', 'test', 'feature-test', 'local']);
});

test('readDesktopCredential separates missing, unreadable and invalid states', async () => {
  const missing = await readDesktopCredential({ env: { AMR_HOME: '/nope' }, readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.deepEqual(missing, { state: 'missing' });
  const denied = await readDesktopCredential({ env: { AMR_HOME: '/nope' }, readFile: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.deepEqual(denied, { state: 'unreadable' });
  const ok = await readDesktopCredential({ env: { AMR_HOME: '/nope' }, readFile: async () => config({ prod: { controlKey: CONTROL_KEY } }) });
  assert.equal(ok.state, 'credential');
});

test('resolveSession prefers the desktop credential over every other source', async () => {
  const outcome = await resolveSession({
    env: { AMR_HOME: '/nope' },
    readFile: async () => config({ prod: { controlKey: CONTROL_KEY, user: { plan: 'pro' } } }),
    readGrant: async () => ({ cookie: COOKIE }),
    resolveRef: async () => COOKIE,
  });
  assert.equal(outcome.state, 'ready');
  if (outcome.state !== 'ready') return;
  assert.equal(outcome.session.via, 'desktop');
  assert.equal(outcome.session.source, 'desktop');
  assert.equal(outcome.session.apiUrl, DEFAULT_API_URL);
  assert.deepEqual(outcome.session.headers, { authorization: `Bearer ${CONTROL_KEY}` });
  assert.equal(outcome.session.plan, 'pro');
});

test('resolveSession falls back to the saved login grant, then to environment references', async () => {
  const fromGrant = await resolveSession({ env: { AMR_HOME: '/nope' }, readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, readGrant: async () => ({ cookie: COOKIE }) });
  assert.equal(fromGrant.state, 'ready');
  if (fromGrant.state === 'ready') {
    assert.equal(fromGrant.session.via, 'login');
    assert.equal(fromGrant.session.source, 'login');
    assert.deepEqual(fromGrant.session.headers, { cookie: COOKIE });
  }
  const fromEnv = await resolveSession({ env: { AMR_HOME: '/nope' }, readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, resolveRef: async ref => (ref === 'OPEN_DESIGN_COOKIE' ? COOKIE : undefined) });
  assert.equal(fromEnv.state, 'ready');
  if (fromEnv.state === 'ready') {
    assert.equal(fromEnv.session.via, 'environment');
    assert.equal(fromEnv.session.source, 'environment');
  }
});

test('resolveSession reports need-login with a reason when nothing is configured', async () => {
  const outcome = await resolveSession({ env: { AMR_HOME: '/nope' }, readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.deepEqual(outcome.state, 'need-login');
  if (outcome.state !== 'need-login') return;
  assert.equal(outcome.reason, 'no-credential');
});

test('an expired login grant is not offered as a session', async () => {
  const outcome = await resolveSession({
    env: { AMR_HOME: '/nope' },
    readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    readGrant: async () => ({ cookie: COOKIE, expiresAt: 1_000 }),
    now: () => 2_000,
  });
  assert.equal(outcome.state, 'need-login');
});

test('an unsafe VELA_API_URL disables the desktop token instead of rerouting it', async () => {
  const outcome = await resolveSession({
    env: { AMR_HOME: '/nope', VELA_API_URL: 'https://evil.example' },
    readFile: async () => config({ prod: { controlKey: CONTROL_KEY } }),
  });
  assert.equal(outcome.state, 'need-login');
  if (outcome.state !== 'need-login') return;
  assert.deepEqual(outcome.warnings, ['unsafe-api-url']);
});

test('an unsafe desktop apiUrl is reported and never becomes a session', async () => {
  const outcome = await resolveSession({
    env: { AMR_HOME: '/nope' },
    readFile: async () => config({ prod: { controlKey: CONTROL_KEY, apiUrl: 'https://evil.example' } }),
  });
  assert.equal(outcome.state, 'need-login');
  if (outcome.state !== 'need-login') return;
  assert.equal(outcome.reason, 'unsafe-api-url');
  assert.equal(JSON.stringify(outcome).includes(CONTROL_KEY), false);
});

test('an unsupported profile falls back to the plugin login but says why', async () => {
  const outcome = await resolveSession({
    env: { AMR_HOME: '/nope', VELA_PROFILE: 'test' },
    readFile: async () => config({ test: { controlKey: CONTROL_KEY } }),
    readGrant: async () => ({ cookie: COOKIE }),
  });
  assert.equal(outcome.state, 'ready');
  if (outcome.state !== 'ready') return;
  assert.equal(outcome.session.via, 'login');
  assert.deepEqual(outcome.warnings, ['unsupported-profile']);
});

test('useDesktop: false ignores the desktop file entirely', async () => {
  let read = 0;
  const outcome = await resolveSession({
    env: { AMR_HOME: '/nope' },
    useDesktop: false,
    readFile: async () => { read += 1; return config({ prod: { controlKey: CONTROL_KEY } }); },
    readGrant: async () => ({ cookie: COOKIE }),
  });
  assert.equal(read, 0);
  assert.equal(outcome.state, 'ready');
  if (outcome.state === 'ready') assert.equal(outcome.session.via, 'login');
});

test('a desktop file with no controlKey surfaces desktop-incomplete but still tries later sources', async () => {
  const outcome = await resolveSession({
    env: { AMR_HOME: '/nope' },
    readFile: async () => config({ prod: { runtimeKey: 'rt' } }),
    readGrant: async () => ({ cookie: COOKIE }),
  });
  assert.equal(outcome.state, 'ready');
  if (outcome.state !== 'ready') return;
  assert.equal(outcome.session.via, 'login');
  assert.deepEqual(outcome.warnings, ['desktop-incomplete']);
});

test('a value without "=" is not a cookie and is skipped', () => {
  assert.equal(cookieSession('sk-not-a-cookie', 'login'), undefined);
  assert.equal(cookieSession('   ', 'login'), undefined);
  const session = cookieSession(COOKIE, 'login');
  assert.ok(session);
  assert.equal(session?.headers['cookie'], COOKIE);
});

test('desktopSession normalizes the origin and never carries the runtime key', () => {
  const session = desktopSession({ profile: 'prod', controlKey: CONTROL_KEY, signedIn: true, apiUrl: 'https://evil.example' });
  assert.equal(session.apiUrl, DEFAULT_API_URL);
  const json = JSON.stringify(session);
  assert.equal(json.includes('controlKey'), false);
  assert.equal(json.includes('rt'), false);
});

test('no resolved outcome embeds a credential value anywhere but its header', async () => {
  const outcome = await resolveSession({ env: { AMR_HOME: '/nope' }, readFile: async () => config({ prod: { controlKey: CONTROL_KEY } }) });
  assert.equal(outcome.state, 'ready');
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes(CONTROL_KEY), true, 'the header must carry it');
  assert.equal(serialized.split(CONTROL_KEY).length - 1, 1, 'exactly once, inside the header');
});

test('device grants are whole snapshots and do not inherit device-code expiry', async () => {
  const grant = { kind: 'device' as const, controlKey: 'fixture-control', runtimeKey: 'fixture-runtime', expiresAt: 1 };
  const result = await resolveSession({ useDesktop: false, readGrant: async () => grant, resolveRef: async () => COOKIE, now: () => 999_999 });
  assert.equal(result.state, 'ready');
  if (result.state !== 'ready') return;
  assert.deepEqual(result.session, deviceSession(grant));
  assert.equal(result.session.credentialType, 'device');
  assert.equal(result.session.apiUrl, DEFAULT_API_URL);
  assert.deepEqual(result.session.headers, { authorization: 'Bearer fixture-control' });
  assert.equal(JSON.stringify(result).includes('fixture-runtime'), false);
  assert.equal(deviceGrant({ kind: 'device', controlKey: 'fixture-control' }), undefined);
  assert.equal(deviceGrant({ ...grant, runtimeKey: 'bad\r\nheader' }), undefined);
  const invalid = await resolveSession({ useDesktop: false, readGrant: async () => ({ ...grant, runtimeKey: '' }), resolveRef: async () => COOKIE });
  assert.equal(invalid.state, 'ready');
  if (invalid.state === 'ready') assert.equal(invalid.session.via, 'environment');
});

test('device authorization remains below desktop priority', async () => {
  const result = await resolveSession({ env: {}, readFile: async () => config({ prod: { controlKey: CONTROL_KEY } }), readGrant: async () => ({ kind: 'device', controlKey: 'other-account', runtimeKey: 'runtime' }) });
  assert.equal(result.state, 'ready');
  if (result.state === 'ready') assert.equal(result.session.source, 'desktop');
});

test('device runtime origin gate rejects custom ports, sibling hosts and URL credentials', () => {
  for (const url of ['https://amr-link.open-design.ai/v1', 'https://AMR-LINK.open-design.ai:443/v2']) assert.equal(isOfficialRuntimeUrl(url), true);
  for (const url of ['http://amr-link.open-design.ai/v1', 'https://amr-link.open-design.ai:8443/v1', 'https://amr-link.open-design.ai.evil.example/v1', 'https://custom.example/v1', 'https://user:pass@amr-link.open-design.ai/v1', 'https://amr-link.open-design.ai/v1?key=x']) assert.equal(isOfficialRuntimeUrl(url), false);
  assert.equal(isOfficialApiUrl('https://amr-api.open-design.ai:8443'), false);
});

test('endpoints mirror quota.ts for an arbitrary official origin', () => {
  const api = endpoints('https://corouter.open-design.ai');
  assert.equal(api.current, 'https://corouter.open-design.ai/api/v1/workspaces/current');
  assert.equal(api.summary, 'https://corouter.open-design.ai/api/v1/billing/summary');
  assert.equal(api.usage('a b'), 'https://corouter.open-design.ai/api/v1/workspaces/a%20b/billing/coding-plan-usage');
});
