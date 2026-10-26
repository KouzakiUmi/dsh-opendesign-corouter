import test from 'node:test';
import assert from 'node:assert/strict';
import { readDesktopQuota, type VelaRunner } from '../src/desktop-quota.js';
import { desktopSession } from '../src/auth.js';
import { ConsoleError } from '../src/quota.js';
const session = desktopSession({ profile: 'prod', controlKey: 'fixture-desktop', signedIn: true });
const walletFetcher: typeof fetch = async (url, init) => {
  assert.equal(String(url), 'https://amr-api.open-design.ai/api/v1/wallet/balance');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-desktop');
  return Response.json({ balanceUsd: '80.50' });
};
test('desktop only uses evidenced wallet endpoint and read-only CLI, preserving unknown pools', async () => {
  const args: readonly string[][] = [];
  const runner: VelaRunner = async (argv, signal, profile) => {
    (args as string[][]).push([...argv]);
    assert.equal(signal.aborted, false); assert.equal(profile, 'prod');
    if (argv[0] === 'team-projects') return { workspaceId: 'workspace_fixture' };
    return { codingPlan: { eligible: true, tier: 'pro', windows: [{ durationSeconds: 18000, usedCredits: '20', limitCredits: '100', remainingCredits: '80' }] } };
  };
  const result = await readDesktopQuota(session, undefined, runner, walletFetcher);
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.balances, { totalUsd: 80.5 });
  assert.equal(result.windows[0]?.percent, 20);
  // `team-projects list` needs no `--format json`: the CLI prints JSON and the reference parser reads it directly.
  assert.deepEqual(args, [['team-projects', 'list'], ['billing', 'funding-check', '--workspace-id', 'workspace_fixture', '--format', 'json']]);
  // The subscription pool and its period are cookie-only evidence; desktop must leave them unknown.
  assert.equal(result.subscriptionPeriodStart, undefined);
  assert.equal(result.subscriptionPeriodEnd, undefined);
  assert.equal(result.nextRefreshAt, undefined);
});
test('server reading time and funding balance are kept; no subscription pool is invented', async () => {
  const runner: VelaRunner = async argv => argv[0] === 'team-projects'
    ? { workspaceId: 'workspace_fixture' }
    : { generatedAt: '2026-10-18T12:00:00Z', balanceUsd: '12.5', codingPlan: { eligible: true, tier: 'go', windows: [{ durationSeconds: 18000, usedCredits: '1', limitCredits: '10', remainingCredits: '9', resetsAt: '2026-10-18T17:00:00Z' }] } };
  const result = await readDesktopQuota(session, undefined, runner, async () => Response.json({}));
  assert.equal(result.updatedAt, '2026-10-18T12:00:00.000Z');
  assert.equal(result.balances.subscriptionUsd, undefined);
  assert.deepEqual(result.balances, { totalUsd: 12.5 });
  assert.equal(result.windows[0]?.resetsAt, '2026-10-18T17:00:00.000Z');
  assert.equal(result.subscriptionPeriodEnd, undefined);
});
test('wallet evidence keeps the subscription/recharge split it actually reports', async () => {
  const fetcher: typeof fetch = async () => Response.json({ creditsPerUsd: 10000, balances: { subscriptionCredits: '500000', rechargeCredits: '200000', totalAvailableCredits: '700000' }, balanceUsd: '70.00' });
  const result = await readDesktopQuota(session, undefined, async () => { throw new Error('fixture-no-cli'); }, fetcher);
  assert.deepEqual(result.balances, { subscriptionUsd: 50, rechargeUsd: 20, totalUsd: 70 });
  assert.equal(result.subscriptionPeriodEnd, undefined);
  assert.match(result.note ?? '', /未返回套餐窗口/u);
});
test('missing CLI can still display desktop wallet, not a fabricated zero quota', async () => {
  const result = await readDesktopQuota(session, undefined, async () => { throw new Error('fixture-no-cli'); }, walletFetcher);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.balances, { totalUsd: 80.5 });
  assert.equal(result.state, 'partial');
  assert.match(result.note ?? '', /未返回套餐窗口/u);
});
test('expired wallet authentication is not hidden by CLI windows or a no-plan result', async () => {
  for (const eligible of [true, false]) {
    const runner: VelaRunner = async argv => argv[0] === 'team-projects'
      ? { workspaceId: 'workspace_fixture' }
      : { codingPlan: { eligible, windows: eligible ? [{ durationSeconds: 18000, usedCredits: '1', limitCredits: '10' }] : [] } };
    await assert.rejects(readDesktopQuota(session, undefined, runner, async () => new Response('{}', { status: 401 })),
      error => error instanceof ConsoleError && error.kind === 'auth');
    const partial = await readDesktopQuota(session, undefined, runner, async () => new Response('{}', { status: 403 }));
    assert.equal(partial.state, 'partial', 'limited scope still preserves usable CLI readings');
  }
});

test('a definite no-subscription answer survives an unreadable wallet', async () => {
  const runner: VelaRunner = async argv => argv[0] === 'team-projects'
    ? { workspaceId: 'workspace_fixture' }
    : { codingPlan: { eligible: false, tier: null, windows: [] } };
  const result = await readDesktopQuota(session, undefined, runner, async () => new Response('{}', { status: 404 }));
  assert.equal(result.state, 'partial');
  assert.equal(result.eligible, false);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.balances, {});
  assert.match(result.note ?? '', /没有 Design Plan 订阅/u);
});
