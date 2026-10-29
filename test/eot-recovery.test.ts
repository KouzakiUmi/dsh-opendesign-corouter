import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { PLAN_PROVIDER, PAID_PROVIDER } from '../src/config.js';
import { OPENDESIGN_EOT } from '../src/eot-code.js';
import { EotRecovery, installEotRecovery, type RecoveryPayload } from '../src/eot-recovery.js';

function fixture(code = OPENDESIGN_EOT, provider = PLAN_PROVIDER) {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const agent = { session: { append: (type: 'llm/retry' | 'llm/retry-started', data: Record<string, unknown>) => { events.push({ type, data }); } } };
  const controller = new AbortController();
  const payload: RecoveryPayload = { agent, turn: 1, step: 2, provider, failure: { code, message: 'fixture failure' }, signal: controller.signal };
  return { events, payload, controller };
}

test('EOT retries remain unlimited and emit durable retry events for each attempt', async () => {
  const { events, payload } = fixture();
  const delays: number[] = [];
  const recovery = new EotRecovery(() => true, async ms => { delays.push(ms); return true; });
  try {
    for (let n = 1; n <= 12; n++) assert.deepEqual(await recovery.handle(payload, async () => undefined), { kind: 'retry' });
    assert.equal(events.length, 24);
    assert.deepEqual(events.filter(e => e.type === 'llm/retry').map(e => e.data.retry), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.deepEqual(delays.slice(0, 6), [500, 1000, 2000, 4000, 8000, 10000]);
    assert.ok(delays.every(ms => ms <= 10000));
    assert.equal(new Set(events.filter(e => e.type === 'llm/retry').map(e => e.data.retryId)).size, 1);
    assert.ok(events.filter(e => e.type === 'llm/retry').every(e => e.data.mode === 'always' && !Object.hasOwn(e.data, 'maxRetries')));
  } finally { await recovery.dispose(); }
});

test('other providers, errors and disabled protection delegate without changing their policy', async () => {
  const recovery = new EotRecovery(() => true, async () => true);
  let delegated = 0;
  const next = async () => { delegated++; return undefined; };
  try {
    for (const item of [fixture('AUTH'), fixture('QUOTA'), fixture('SERVER'), fixture('EMPTY_RESPONSE'), fixture(OPENDESIGN_EOT, PAID_PROVIDER)]) {
      assert.equal(await recovery.handle(item.payload, next), undefined);
      assert.equal(item.events.length, 0);
    }
    const disabled = new EotRecovery(() => false, async () => true);
    try { assert.equal(await disabled.handle(fixture().payload, next), undefined); } finally { await disabled.dispose(); }
    assert.equal(delegated, 6);
  } finally { await recovery.dispose(); }
});

test('cancel and plugin disposal abort the wait and do not start another attempt', async () => {
  for (const cancelBy of ['request', 'dispose'] as const) {
    const { events, payload, controller } = fixture();
    const recovery = new EotRecovery(() => true);
    const operation = recovery.handle(payload, async () => undefined);
    assert.equal(events.length, 1, 'planned retry is durable before waiting');
    if (cancelBy === 'request') controller.abort(); else await recovery.dispose();
    assert.equal(await operation, undefined);
    assert.equal(events.filter(e => e.type === 'llm/retry-started').length, 0);
    await recovery.dispose();
  }
});

test('disabling the monitor during backoff prevents the next request', async () => {
  const { events, payload } = fixture();
  let enabled = true;
  const recovery = new EotRecovery(() => enabled, async () => { enabled = false; return true; });
  try {
    assert.equal(await recovery.handle(payload, async () => undefined), undefined);
    assert.deepEqual(events.map(e => e.type), ['llm/retry']);
  } finally { await recovery.dispose(); }
});

test('retry telemetry counts admitted retries only, never a cancelled backoff', async () => {
  let retries = 0;
  const admitted = new EotRecovery(() => true, async () => true, () => { retries++; });
  try { await admitted.handle(fixture().payload, async () => undefined); assert.equal(retries, 1); }
  finally { await admitted.dispose(); }
  const { payload, controller } = fixture();
  const cancelled = new EotRecovery(() => true, async () => { controller.abort(); return false; }, () => { retries++; });
  try { await cancelled.handle(payload, async () => undefined); assert.equal(retries, 1); }
  finally { await cancelled.dispose(); }
});

test('failure to persist a planned retry never starts another request', async () => {
  const { payload } = fixture();
  payload.agent.session.append = () => { throw new Error('fixture log failure'); };
  let waited = false;
  const recovery = new EotRecovery(() => true, async () => { waited = true; return true; });
  try {
    await assert.rejects(recovery.handle(payload, async () => undefined), /fixture log failure/u);
    assert.equal(waited, false);
  } finally { await recovery.dispose(); }
});

test('retries are isolated by agent and step', async () => {
  const a = fixture(), b = fixture();
  const recovery = new EotRecovery(() => true, async () => true);
  try {
    await recovery.handle(a.payload, async () => undefined);
    await recovery.handle(a.payload, async () => undefined);
    await recovery.handle(b.payload, async () => undefined);
    await recovery.handle({ ...a.payload, step: 3 }, async () => undefined);
    assert.deepEqual(a.events.filter(e => e.type === 'llm/retry').map(e => e.data.retry), [1, 2, 1]);
    assert.deepEqual(b.events.filter(e => e.type === 'llm/retry').map(e => e.data.retry), [1]);
  } finally { await recovery.dispose(); }
});

test('host waterfall registration delegates unrelated failures and removes its listener on disposal', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(scope => installEotRecovery(scope, () => true));
  const dispatch = ctx as unknown as { waterfall(name: string, payload: RecoveryPayload, next: () => Promise<RecoveryAction>): Promise<RecoveryAction> };
  type RecoveryAction = { kind: 'retry' } | undefined;
  let delegated = 0;
  const next = async () => { delegated++; return undefined; };
  try {
    assert.equal(await dispatch.waterfall('agent/request-error', fixture('AUTH').payload, next), undefined);
    assert.equal(delegated, 1);
  } finally { await fiber.dispose(); }
  assert.equal(await dispatch.waterfall('agent/request-error', fixture().payload, next), undefined);
  assert.equal(delegated, 2);
});
