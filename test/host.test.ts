import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { CredentialProvider, type CredentialKey, type CredentialRecord, type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { OpenDesignCoRouterService, type HostDependencies } from '../src/index.js';
import type { RuntimeConfig } from '../src/config.js';
import { ConsoleError, type QuotaSnapshot } from '../src/quota.js';
class MemoryCredentials extends CredentialProvider {
  readonly data = new Map<CredentialKey, CredentialRecord>();
  constructor(ctx: Context) { super(ctx); }
  async resolve(_ref: CredentialRef) { return undefined; }
  async describe(_ref: CredentialRef) { return { configured: false, writable: true }; }
  async set(_ref: CredentialRef, _value: string) { throw new Error('references are not written'); }
  async unset(_ref: CredentialRef) { throw new Error('references are not written'); }
  async readRecord(key: CredentialKey) { return structuredClone(this.data.get(key)); }
  async describeRecord(key: CredentialKey) { const value = this.data.get(key); return { configured: value !== undefined, writable: true, ...(value ? { kind: value.kind } : {}) }; }
  async listRecords() { return [...this.data.entries()].map(([key, value]) => ({ key, kind: value.kind })); }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) { const next = await mutate(await this.readRecord(key)); if (next) this.data.set(key, structuredClone(next)); return this.readRecord(key); }
  async deleteRecord(key: CredentialKey) { this.data.delete(key); }
}
const config: RuntimeConfig = { apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://amr-link.open-design.ai/v1', useDesktopCredential: true, emptyTurnGuard: true, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 };
const quota: QuotaSnapshot = { state: 'ok', source: 'login', updatedAt: '2026-10-26T08:00:00Z', windows: [], balances: { subscriptionUsd: 10, rechargeUsd: 2, totalUsd: 12 } };
function dependencies(calls: boolean[]): HostDependencies {
  return {
    resolveSession: async deps => {
      const desktop = deps?.useDesktop !== false; calls.push(desktop);
      return { state: 'ready', warnings: [], session: { source: desktop ? 'desktop' : 'login', via: desktop ? 'desktop' : 'login', apiUrl: 'https://amr-api.open-design.ai', headers: desktop ? { authorization: 'Bearer fixture' } : { cookie: 'fixture=session' } } };
    },
    readDesktopQuota: async () => { throw new ConsoleError('auth', 401); },
    readQuota: async () => structuredClone(quota),
  };
}
test('expired desktop credentials fall back to a single console identity, and quota refresh is throttled', async () => {
  const ctx = new Context(), calls: boolean[] = [];
  const credentials = await ctx.plugin(MemoryCredentials);
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, dependencies(calls)); });
  try {
    const service = ctx.openDesignCoRouter;
    const result = await service.refreshQuota();
    assert.deepEqual(calls, [true, false]);
    assert.deepEqual(result, quota);
    await service.refreshQuota();
    assert.deepEqual(calls, [true, false]); // valid cache prevents another CLI/network burst
    assert.equal((await service.status()).sessionSource, 'login');
  } finally { await fiber.dispose(); await credentials.dispose(); }
});
test('API key saves use owned credential records, reject stale writes and never echo values', async () => {
  const ctx = new Context();
  const credentials = await ctx.plugin(MemoryCredentials);
  const fiber = await ctx.plugin(scope => { new OpenDesignCoRouterService(scope, () => config, dependencies([])); });
  try {
    const service = ctx.openDesignCoRouter, before = await service.status();
    const after = await service.saveApiKey({ value: 'fixture-secret-not-echoed', expectedRevision: before.revision });
    assert.equal(after.apiKeyConfigured, true);
    assert.notEqual(after.revision, before.revision);
    assert.equal(JSON.stringify(after).includes('fixture-secret-not-echoed'), false);
    assert.equal(await service.resolveApiKey('FIXTURE_KEY'), 'fixture-secret-not-echoed');
    await assert.rejects(service.saveApiKey({ value: 'fixture-stale', expectedRevision: before.revision }), { code: 'opendesign/revision-conflict' });
    assert.equal(await service.resolveApiKey('FIXTURE_KEY'), 'fixture-secret-not-echoed');
  } finally { await fiber.dispose(); await credentials.dispose(); }
});
