import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, normalizeBalances, readQuota, CURRENT_URL, SUMMARY_URL, usageUrl, ConsoleError, type Session } from '../src/quota.js';
const usage = { eligible: true, tier: 'pro', windows: [{ durationSeconds: 604800, usedCredits: '10', limitCredits: '100', remainingCredits: '87', resetsAt: '2026-10-29T12:00:00Z' }] };
const summary = { creditsPerUsd: 10000, balances: { subscriptionCredits: '500000', rechargeCredits: '200000', totalAvailableCredits: '700000' }, balanceUsd: '70.00' };
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
  assert.throws(() => normalizeQuota({ workspaceId: 'present-but-not-quota' }), ConsoleError);
});
test('real workspace id is resolved before billing; personal account gets all pools', async () => {
  const seen: string[] = [];
  const data = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [SUMMARY_URL]: summary, [usageUrl('ws_test')]: usage }, seen));
  assert.equal(data.state, 'ok');
  assert.equal(seen[0], CURRENT_URL);
  assert.equal(seen.some(x => x.endsWith('/current/billing/coding-plan-usage')), false);
});
test('ordinary pool failures degrade independently, auth failures never hide', async () => {
  const responses = { [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [SUMMARY_URL]: summary, [usageUrl('ws_test')]: 502 };
  assert.equal((await readQuota(session, undefined, fake(responses))).state, 'partial');
  await assert.rejects(readQuota(session, undefined, fake({ ...responses, [usageUrl('ws_test')]: 401 })), { kind: 'auth' });
});
test('403 permissions only degrade the restricted pool, while 401 still invalidates identity', async () => {
  const result = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'ws_test', workspaceType: 'personal' }, [usageUrl('ws_test')]: usage, [SUMMARY_URL]: 403 }));
  assert.equal(result.state, 'partial');
  assert.equal(result.windows.length, 1);
  assert.deepEqual(result.balances, {});
});
test('team workspace does not display personal wallet numbers', async () => {
  const seen: string[] = [];
  const result = await readQuota(session, undefined, fake({ [CURRENT_URL]: { workspaceId: 'team', workspaceType: 'team' }, [usageUrl('team')]: usage }, seen));
  assert.deepEqual(result.balances, {});
  assert.equal(seen.includes(SUMMARY_URL), false);
  assert.equal(result.state, 'partial');
});
