import test from 'node:test';
import assert from 'node:assert/strict';
import { readDesktopQuota, type VelaRunner } from '../src/desktop-quota.js';
import { desktopSession } from '../src/auth.js';
const session = desktopSession({ profile: 'prod', controlKey: 'fixture-desktop', signedIn: true });
const fetcher: typeof fetch = async (url, init) => {
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
  const result = await readDesktopQuota(session, undefined, runner, fetcher);
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.balances, { totalUsd: 80.5 });
  assert.equal(result.windows[0]?.percent, 20);
  assert.deepEqual(args, [['team-projects', 'list'], ['billing', 'funding-check', '--workspace-id', 'workspace_fixture', '--format', 'json']]);
});
test('missing CLI can still display desktop wallet, not a fabricated zero quota', async () => {
  const result = await readDesktopQuota(session, undefined, async () => { throw new Error('fixture-no-cli'); }, fetcher);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.balances, { totalUsd: 80.5 });
  assert.equal(result.state, 'partial');
});
