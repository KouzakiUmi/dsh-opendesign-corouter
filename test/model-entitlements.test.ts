import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCoverage, readModelEntitlements, readModelScope, resolveModelAccount, type ModelAccount, type ModelScope } from '../src/model-entitlements.js';
import type { CatalogModel } from '../src/catalog.js';

const account: ModelAccount = { source: 'device', session: { apiUrl: 'https://amr-api.open-design.ai', headers: { authorization: 'Bearer fixture-control' }, via: 'login', source: 'login', credentialType: 'device' } };
const scope: ModelScope = { workspaceId: 'fixture-ws', memberId: 'fixture-member', source: 'device' };
const rows: readonly CatalogModel[] = [
  { id: 'formerly-included', name: 'Formerly included', group: 'plan' },
  { id: 'new-covered', name: 'New covered', group: 'paid' },
  { id: 'failed-model', name: 'Failed', group: 'plan' },
];
const evidence = (modelId: string, covered: boolean, funding = covered ? 'coding_plan' : 'gateway', eligible = true) => ({
  schemaVersion: 1, workspaceId: scope.workspaceId, workspaceMemberId: scope.memberId, modelId, generatedAt: '2026-11-17T12:00:00Z',
  modelCovered: covered, funding, codingPlan: { eligible, workspaceId: scope.workspaceId, tier: eligible ? 'pro' : null },
});

test('only the exact issued runtime/control pair supplies account entitlements', async () => {
  const grant = { kind: 'device' as const, runtimeKey: 'runtime-fixture', controlKey: 'control-fixture' };
  const paired = await resolveModelAccount(grant.runtimeKey, 'https://amr-link.open-design.ai/v1', grant, false);
  assert.equal(paired?.source, 'device');
  assert.equal(paired?.session.headers.authorization, 'Bearer control-fixture');
  assert.equal(await resolveModelAccount('other-api-key', 'https://amr-link.open-design.ai/v1', grant, false), undefined);
  assert.equal(await resolveModelAccount(grant.runtimeKey, 'https://custom.invalid/v1', grant, false), undefined);
});

test('scope requires matching active workspace and member, not a plan name', async () => {
  const valid = { workspaceId: scope.workspaceId, activeWorkspaceId: scope.workspaceId, workspaceMemberId: scope.memberId, memberStatus: 'active' };
  assert.deepEqual(await readModelScope(account, undefined, async () => Response.json(valid)), scope);
  for (const bad of [{ ...valid, activeWorkspaceId: 'other' }, { ...valid, workspaceMemberId: '' }, { ...valid, memberStatus: 'disabled' }]) {
    await assert.rejects(readModelScope(account, undefined, async () => Response.json(bad)));
  }
});

test('coverage checks exact workspace/member/model and stays included when quota falls back', () => {
  assert.equal(parseModelCoverage(evidence('m', true, 'wallet'), scope, 'm')?.coverage, 'included');
  assert.equal(parseModelCoverage(evidence('m', true, 'gateway'), scope, 'm')?.coverage, 'included');
  assert.equal(parseModelCoverage(evidence('m', false), scope, 'm')?.coverage, 'not-included');
  assert.equal(parseModelCoverage(evidence('m', true, 'wallet', false), scope, 'm')?.coverage, 'not-included');
  for (const patch of [{ modelId: 'other' }, { workspaceId: 'other' }, { workspaceMemberId: 'other' }, { modelCovered: null }, { schemaVersion: 2 }, { codingPlan: { eligible: true } }]) {
    assert.equal(parseModelCoverage({ ...evidence('m', true), ...patch }, scope, 'm'), undefined);
  }
});

test('real preflight classification replaces seed groups and preserves unknown on partial failures', async () => {
  const requested: string[] = [];
  const result = await readModelEntitlements(rows, { account, scope, fetcher: async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-control');
    const target = new URL(String(url));
    const model = target.searchParams.get('modelId')!; requested.push(model);
    if (model === 'failed-model') return new Response('{}', { status: 503 });
    return Response.json(evidence(model, model === 'new-covered'));
  } });
  assert.deepEqual(requested.sort(), rows.map(row => row.id).sort());
  assert.deepEqual(result.models.map(({ id, group, coverage }) => ({ id, group, coverage })), [
    { id: 'formerly-included', group: 'paid', coverage: 'not-included' },
    { id: 'new-covered', group: 'plan', coverage: 'included' },
    { id: 'failed-model', group: 'paid', coverage: 'unknown' },
  ]);
  assert.equal(result.summary.state, 'partial');
  assert.equal(result.summary.tier, 'pro');
  assert.equal(rows[0]?.group, 'plan', 'source rows are never mutated');
});

test('no paired account does no network I/O and never inherits catalog inclusion', async () => {
  const result = await readModelEntitlements(rows, { fetcher: async () => { throw new Error('must not request'); } });
  assert.equal(result.summary.state, 'unavailable');
  assert.ok(result.models.every(model => model.group === 'paid' && model.coverage === 'unknown'));
});

test('inconsistent subscription readings are not published as one authoritative catalog', async () => {
  const result = await readModelEntitlements(rows, { account, scope, fetcher: async url => {
    const id = new URL(String(url)).searchParams.get('modelId')!;
    const item = evidence(id, true);
    item.codingPlan.tier = id === 'new-covered' ? 'plus' : 'pro';
    return Response.json(item);
  } });
  assert.equal(result.summary.state, 'unavailable');
  assert.ok(result.models.every(row => row.coverage === 'unknown'));
});

test('preflight concurrency is bounded and cancellation stops the entire batch', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(readModelEntitlements(Array.from({ length: 20 }, (_, index) => ({ id: `m-${index}`, name: 'M', group: 'plan' })), {
    account, scope, signal: controller.signal, fetcher: async () => { calls++; controller.abort(); throw new Error('cancelled'); },
  }));
  assert.ok(calls <= 3);
});
