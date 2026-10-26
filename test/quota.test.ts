import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, normalizeBalances, normalizeSubscription, readQuota, consoleJson, CURRENT_URL, SUMMARY_URL, usageUrl, preflightUrl, ConsoleError, type Session } from '../src/quota.js';
const usage = { eligible: true, tier: 'pro', windows: [{ durationSeconds: 604800, usedCredits: '10', limitCredits: '100', remainingCredits: '87', resetsAt: '2026-10-29T12:00:00Z', windowStart: '2026-10-22T12:00:00Z', resetMode: 'anchored_recurring' }] };
const summary = {
  creditsPerUsd: 10000,
  balances: { subscriptionCredits: '500000', rechargeCredits: '200000', totalAvailableCredits: '700000' },
  balanceUsd: '70.00',
  membershipTier: 'plus',
  subscriptionCurrentPeriodStart: '2026-10-01T00:00:00Z',
  subscriptionCurrentPeriodEnd: '2026-11-01T00:00:00Z',
};
const session: Session = { source: 'login', headers: { cookie: 'fixture=test-only' } };
function fake(responses: Record<string, unknown | number>, seen: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input); seen.push(url);
    assert.equal((init?.headers as Record<string, string>).cookie, 'fixture=test-only');
    const value = responses[url];
    if (typeof value === 'number') return new Response('{}', { status: value });
    return Response.json(value ?? {});
  };
}
test('four layers are independent and missing balances remain unknown', () => {
  const data = normalizeQuota(usage, summary);
  assert.equal(data.windows[0]?.remaining, 87); // provider's counter, not 100 - 10
  assert.deepEqual(data.balances, { subscriptionUsd: 50, rechargeUsd: 20, totalUsd: 70 });
  assert.deepEqual(normalizeBalances({}), {});
  assert.deepEqual(normalizeSubscription({}), {});
  assert.throws(() => normalizeQuota({ workspaceId: 'present-but-not-quota' }), ConsoleError);
});
test('window provenance is normalized; unparsable timestamps stay unknown', () => {
  const data = normalizeQuota({ eligible: true, windows: [{ durationSeconds: 18000, usedCredits: '1', limitCredits: '10', resetsAt: '2026-10-18T12:00:00Z', windowStart: '2026-10-18T07:00:00Z', resetMode: 'activity_triggered' }] });
  assert.equal(data.windows[0]?.resetsAt, '2026-10-18T12:00:00.000Z');
  assert.equal(data.windows[0]?.windowStart, '2026-10-18T07:00:00.000Z');
  assert.equal(data.windows[0]?.resetMode, 'activity_triggered');
  const broken = normalizeQuota({ eligible: true, windows: [{ durationSeconds: 18000, usedCredits: '1', limitCredits: '10', resetsAt: 'nope', windowStart: 5 }] });
  assert.equal(broken.windows[0]?.resetsAt, undefined);
  assert.equal(broken.windows[0]?.windowStart, undefined);
});
test('billing period comes from summary when parseable and is never derived', () => {
  const data = normalizeQuota(usage, summary);
  assert.equal(data.subscriptionPeriodStart, '2026-10-01T00:00:00.000Z');
  assert.equal(data.subscriptionPeriodEnd, '2026-11-01T00:00:00.000Z');
  const broken = normalizeQuota(usage, { ...summary, subscriptionCurrentPeriodStart: 'not-a-date', subscriptionCurrentPeriodEnd: undefined });
  assert.equal(broken.subscriptionPeriodStart, undefined);
  assert.equal(broken.subscriptionPeriodEnd, undefined);
});
test('membershipTier is a fallback only, never overriding the usage tier', () => {
  assert.equal(normalizeQuota({ eligible: true, windows: [] }, { membershipTier: 'plus' }).tier, 'plus');
  assert.equal(normalizeQuota(usage, summary).tier, 'pro');
  assert.equal(normalizeQuota({ tier: null, windows: [] }, { membershipTier: 'plus' }).tier, undefined);
  assert.equal(normalizeQuota({ eligible: false, windows: [] }, { membershipTier: 'plus' }).tier, undefined);
});
test('real workspace id is resolved before billing; personal account gets all pools', async () => {
  const seen: string[] = [];
  const data = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [SUMMARY_URL]: summary, [usageUrl('ws_test')]: usage }, seen));
  assert.equal(data.state, 'ok');
  assert.equal(seen[0], CURRENT_URL);
  assert.equal(seen.some(x => x.endsWith('/current/billing/coding-plan-usage')), false);
  assert.equal(data.subscriptionPeriodEnd, '2026-11-01T00:00:00.000Z');
  assert.equal(data.nextRefreshAt, undefined); // owned by the host cache policy
});
test('ordinary pool failures degrade independently and keep the billing period', async () => {
  const responses = { [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [SUMMARY_URL]: summary, [usageUrl('ws_test')]: 502 };
  const partial = await readQuota(session, undefined, fake(responses));
  assert.equal(partial.state, 'partial');
  assert.equal(partial.subscriptionPeriodEnd, '2026-11-01T00:00:00.000Z');
  await assert.rejects(readQuota(session, undefined, fake({ ...responses, [usageUrl('ws_test')]: 401 })), { kind: 'auth' });
});
test('403 permissions only degrade the restricted pool, while 401 still invalidates identity', async () => {
  const result = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [usageUrl('ws_test')]: usage, [SUMMARY_URL]: 403 }));
  assert.equal(result.state, 'partial');
  assert.equal(result.windows.length, 1);
  assert.deepEqual(result.balances, {});
  assert.equal(result.subscriptionPeriodEnd, undefined);
});
test('team workspace does not display personal wallet numbers', async () => {
  const seen: string[] = [];
  const result = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'team', workspaceType: 'team' }, [usageUrl('team')]: usage }, seen));
  assert.deepEqual(result.balances, {});
  assert.equal(seen.includes(SUMMARY_URL), false);
  assert.equal(result.state, 'partial');
  assert.equal(result.subscriptionPeriodStart, undefined);
  assert.equal(result.subscriptionPeriodEnd, undefined);
});
test('a definite no-subscription answer is named instead of a zero window', async () => {
  const data = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [SUMMARY_URL]: summary, [usageUrl('ws_test')]: { eligible: false, tier: null, windows: [] } }));
  assert.equal(data.state, 'ok');
  assert.deepEqual(data.windows, []);
  assert.equal(data.eligible, false);
  assert.match(data.note ?? '', /没有 Design Plan 订阅/u);
  assert.deepEqual(data.balances, { subscriptionUsd: 50, rechargeUsd: 20, totalUsd: 70 });
  assert.equal(data.subscriptionPeriodEnd, '2026-11-01T00:00:00.000Z');
  assert.equal(data.nextRefreshAt, undefined);
  assert.equal(normalizeQuota({ tier: null, windows: [] }).eligible, false);
});

test('an empty window list without a subscription answer remains partial', async () => {
  const data = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [SUMMARY_URL]: summary, [usageUrl('ws_test')]: { windows: [] } }));
  assert.equal(data.state, 'partial');
  assert.equal(data.eligible, undefined);
  assert.match(data.note ?? '', /暂不可确认/u);
});

const device: Session = { source: 'login', credentialType: 'device', headers: { authorization: 'Bearer fixture-control' } };
function deviceFetch(responses: Record<string, unknown | number>, seen: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input); seen.push(url);
    assert.equal(new URL(url).origin, 'https://amr-api.open-design.ai');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer fixture-control');
    assert.equal((init?.headers as Record<string, string>).cookie, undefined);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const value = responses[url];
    return typeof value === 'number' ? new Response('{}', { status: value }) : Response.json(value ?? {});
  };
}
test('device quota uses active workspace preflight and explicit personal summary with independent pools', async () => {
  const seen: string[] = [];
  const data = await readQuota(device, undefined, deviceFetch({ [CURRENT_URL]: { activeWorkspaceId: 'active', workspaceId: 'other', workspaceType: 'personal' }, [preflightUrl('active')]: { codingPlan: usage, balanceUsd: '71' }, [SUMMARY_URL]: summary }, seen));
  assert.equal(data.state, 'ok');
  assert.equal(data.source, 'login');
  assert.deepEqual(data.balances, { subscriptionUsd: 50, rechargeUsd: 20, totalUsd: 71 });
  assert.equal(data.windows[0]?.remaining, 87);
  assert.equal(data.subscriptionPeriodEnd, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(seen, [CURRENT_URL, preflightUrl('active'), SUMMARY_URL]);
});
test('device 403 degrades only that layer, including a fully permission-restricted account', async () => {
  const baseline = { [CURRENT_URL]: { workspaceId: 'ws', workspaceType: 'personal' }, [preflightUrl('ws')]: { codingPlan: usage, balanceUsd: '9' }, [SUMMARY_URL]: summary };
  const planOnly = await readQuota(device, undefined, deviceFetch({ ...baseline, [SUMMARY_URL]: 403 }));
  assert.equal(planOnly.state, 'partial');
  assert.equal(planOnly.windows.length, 1);
  assert.deepEqual(planOnly.balances, { totalUsd: 9 });
  assert.equal(planOnly.subscriptionPeriodEnd, undefined);
  const walletOnly = await readQuota(device, undefined, deviceFetch({ ...baseline, [preflightUrl('ws')]: 403 }));
  assert.equal(walletOnly.state, 'partial');
  assert.deepEqual(walletOnly.windows, []);
  assert.deepEqual(walletOnly.balances, { subscriptionUsd: 50, rechargeUsd: 20, totalUsd: 70 });
  for (const responses of [{ ...baseline, [preflightUrl('ws')]: 403, [SUMMARY_URL]: 403 }, { [CURRENT_URL]: 403 }]) {
    const restricted = await readQuota(device, undefined, deviceFetch(responses));
    assert.equal(restricted.state, 'partial');
    assert.deepEqual(restricted.windows, []);
    assert.deepEqual(restricted.balances, {});
  }
  for (const endpoint of [CURRENT_URL, preflightUrl('ws'), SUMMARY_URL]) await assert.rejects(readQuota(device, undefined, deviceFetch({ ...baseline, [endpoint]: 401 })), { kind: 'auth' });
});
test('device team and unknown workspaces never mix a personal billing summary or invent membership', async () => {
  for (const workspaceType of ['team', undefined]) {
    const seen: string[] = [];
    const result = await readQuota(device, undefined, deviceFetch({ [CURRENT_URL]: { workspaceId: 'ws', workspaceType, personalMembershipTier: 'pro' }, [preflightUrl('ws')]: { codingPlan: usage, balanceUsd: 999 }, [SUMMARY_URL]: summary }, seen));
    assert.equal(result.state, 'partial');
    assert.equal(result.windows.length, 1);
    assert.deepEqual(result.balances, {});
    assert.equal(result.subscriptionPeriodEnd, undefined);
    assert.equal(seen.includes(SUMMARY_URL), false);
  }
});
test('device malformed data stays unknown; no-subscription is distinct from zero windows', async () => {
  const current = { workspaceId: 'ws', workspaceType: 'personal' };
  const missing = await readQuota(device, undefined, deviceFetch({ [CURRENT_URL]: current, [preflightUrl('ws')]: { codingPlan: { windows: [] } }, [SUMMARY_URL]: summary }));
  assert.equal(missing.eligible, undefined);
  assert.equal(missing.state, 'partial');
  const absent = await readQuota(device, undefined, deviceFetch({ [CURRENT_URL]: current, [preflightUrl('ws')]: { codingPlan: { eligible: false, tier: null, windows: [] } }, [SUMMARY_URL]: summary }));
  assert.equal(absent.state, 'ok');
  assert.equal(absent.eligible, false);
  assert.deepEqual(absent.windows, []);
  await assert.rejects(readQuota(device, undefined, deviceFetch({ [CURRENT_URL]: { workspaceId: '../bad' } })), { kind: 'response' });
  await assert.rejects(readQuota(device, undefined, deviceFetch({ [CURRENT_URL]: current })), { kind: 'response' });
});
test('device readers cancel before network and bound response bytes without leaking body errors', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readQuota(device, controller.signal, async () => { throw new Error('must not fetch'); }), { name: 'AbortError' });
  await assert.rejects(readQuota(device, undefined, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), { kind: 'response' });
  await assert.rejects(readQuota(device, undefined, async () => new Response(new ReadableStream({ start(stream) { stream.error(new Error('PRIVATE_RESPONSE')); } }))), error => error instanceof ConsoleError && !error.message.includes('PRIVATE_RESPONSE'));
});

test('device control bearer cannot be sent to a custom control-plane origin', async () => {
  for (const url of ['https://custom.example/api/v1/workspaces/current', 'http://amr-api.open-design.ai/api/v1/workspaces/current', 'https://amr-api.open-design.ai:8443/api/v1/workspaces/current']) {
    await assert.rejects(consoleJson(url, device, undefined, async () => { assert.fail('must not send the device bearer'); }), { kind: 'response' });
  }
});

test('quota cancellation bounds fetch and body transports that ignore AbortSignal', async () => {
  for (const body of [false, true]) {
    const controller = new AbortController();
    let cancelObserved = false;
    const pending = readQuota(device, controller.signal, async () => body
      ? new Response(new ReadableStream({ cancel() { cancelObserved = true; } }))
      : new Promise<Response>(() => undefined));
    const abort = setTimeout(() => controller.abort(), 5);
    try { await assert.rejects(pending, { name: 'AbortError' }); }
    finally { clearTimeout(abort); }
    if (body) assert.equal(cancelObserved, true);
  }
});

test('HTTP 200 authentication envelopes do not masquerade as successful quota data', async () => {
  await assert.rejects(readQuota(session, undefined, fake({ [CURRENT_URL]: { code: 401 } })), { kind: 'auth' });
  await assert.rejects(readQuota(session, undefined, fake({ [CURRENT_URL]: { code: '403' } })), { kind: 'permission' });
});
