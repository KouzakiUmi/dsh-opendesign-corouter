import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, normalizeBalances, normalizeSubscription, readQuota, CURRENT_URL, SUMMARY_URL, usageUrl, ConsoleError, type Session } from '../src/quota.js';
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

test('HTTP 200 authentication envelopes do not masquerade as successful quota data', async () => {
  await assert.rejects(readQuota(session, undefined, fake({ [CURRENT_URL]: { code: 401 } })), { kind: 'auth' });
  await assert.rejects(readQuota(session, undefined, fake({ [CURRENT_URL]: { code: '403' } })), { kind: 'permission' });
});
