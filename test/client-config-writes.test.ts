import assert from 'node:assert/strict';
import test from 'node:test';
import { configWritesFor } from '../src/client-config-writes.js';
import type { ConfigForm, FormSnapshot, FormValues } from '../src/client.js';

class FakeForm implements ConfigForm {
  status: FormSnapshot['status'] = 'ready';
  writable = true;
  value: FormValues = {};
  calls: Array<{ field: string; value: unknown }> = [];
  clears: string[] = [];
  outcome: 'accept' | 'reject' | 'throw' = 'accept';
  /** Hold every write until `release()` is called. */
  manual = false;
  /** The Host may store another shape than the value that was written. */
  normalize: ((field: string, value: unknown) => unknown) | undefined = undefined;
  private readonly listeners = new Set<() => void>();
  private readonly pending: Array<() => void> = [];

  getSnapshot(): FormSnapshot {
    return { status: this.status, value: this.value, writable: this.writable };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  set(field: string, value: unknown): Promise<boolean> {
    this.calls.push({ field, value });
    if (this.outcome === 'throw') return Promise.reject(new Error('write failed'));
    if (this.outcome === 'reject') return Promise.resolve(false);
    if (this.manual) {
      return new Promise<boolean>((resolve) => {
        this.pending.push(() => {
          this.value = { ...this.value, [field]: this.stored(field, value) as FormValues[keyof FormValues] };
          this.notify();
          resolve(true);
        });
      });
    }
    this.value = { ...this.value, [field]: this.stored(field, value) as FormValues[keyof FormValues] };
    this.notify();
    return Promise.resolve(true);
  }

  unset(field: string): Promise<boolean> {
    this.clears.push(field);
    if (this.outcome === 'throw') return Promise.reject(new Error('clear failed'));
    if (this.outcome === 'reject') return Promise.resolve(false);
    const apply = () => {
      const next: Record<string, unknown> = { ...this.value };
      Reflect.deleteProperty(next, field);
      this.value = next as FormValues;
      this.notify();
    };
    if (this.manual) return new Promise<boolean>((resolve) => { this.pending.push(() => { apply(); resolve(true); }); });
    apply();
    return Promise.resolve(true);
  }

  private stored(field: string, value: unknown): unknown {
    return this.normalize ? this.normalize(field, value) : value;
  }

  release(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

test('one coordinator is shared per form and forms stay isolated', () => {
  const form = new FakeForm();
  const other = new FakeForm();
  const first = configWritesFor(form);
  const second = configWritesFor(form);
  assert.equal(first, second, 'consumers of one form share the coordinator');
  assert.notEqual(first, configWritesFor(other), 'another form keeps its own coordinator');

  first.dispose();
  const remounted = configWritesFor(form);
  assert.notEqual(remounted, first, 'a disposed coordinator is dropped from the cache');
  remounted.dispose();
});

test('writes of different fields run one after another and every pending field is tracked', async () => {
  const form = new FakeForm();
  form.manual = true;
  const writes = configWritesFor(form);

  const first = writes.set('baseURL', 'https://example.test');
  const second = writes.set('apiProtocol', 'responses');
  await flush();

  assert.deepEqual(writes.getSnapshot().pendingFields, ['baseURL', 'apiProtocol']);
  assert.deepEqual(form.calls.map(call => call.field), ['baseURL'], 'the second write waits');

  form.release();
  await flush();
  assert.deepEqual(form.calls.map(call => call.field), ['baseURL', 'apiProtocol']);

  form.release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  writes.dispose();
});

test('a second write of a pending field is refused', async () => {
  const form = new FakeForm();
  form.manual = true;
  const writes = configWritesFor(form);

  const first = writes.set('baseURL', 'https://one.test');
  await flush();
  assert.equal(await writes.set('baseURL', 'https://two.test'), false);
  assert.deepEqual(form.calls.map(call => call.value), ['https://one.test']);

  form.release();
  await flush();
  assert.equal(await first, true);
  writes.dispose();
});

test('a rejected or throwing write clears the overlay and stays retryable', async () => {
  const form = new FakeForm();
  const writes = configWritesFor(form);

  form.outcome = 'reject';
  assert.equal(await writes.set('baseURL', 'https://one.test'), false);
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  assert.deepEqual(writes.getSnapshot().pendingValues, {});

  form.outcome = 'throw';
  assert.equal(await writes.set('baseURL', 'https://two.test'), false);
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  assert.deepEqual(writes.getSnapshot().pendingValues, {});

  form.outcome = 'accept';
  assert.equal(await writes.set('baseURL', 'https://three.test'), true);
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  writes.dispose();
});

test('a namespace that is not ready or not writable refuses the write', async () => {
  const form = new FakeForm();
  const writes = configWritesFor(form);

  form.status = 'loading';
  assert.equal(await writes.set('baseURL', 'https://one.test'), false);
  form.status = 'ready';
  form.writable = false;
  assert.equal(await writes.set('baseURL', 'https://one.test'), false);
  form.writable = true;
  assert.deepEqual(form.calls, []);
  writes.dispose();
});

test('model settings rebase field by field and keep concurrent external updates', async () => {
  const form = new FakeForm();
  form.manual = true;
  const writes = configWritesFor(form);

  // What the caller rendered.
  const base = { m1: { temperature: 0.2 } };
  form.value = { modelSettings: base };
  // A first write occupies the queue.
  const first = writes.set('baseURL', 'https://example.test');
  await flush();
  // The Host picks up an external change on another model and on the same model.
  const latest = {
    m1: { temperature: 0.2, maxTokens: 4096 },
    m2: { topP: 0.5, reasoningEffort: 'high' },
    m3: { enabled: false },
  };
  form.value = { baseURL: 'https://example.test', modelSettings: latest };

  const desired = { m1: { temperature: 0.7 } };
  const second = writes.set('modelSettings', desired, base);
  await flush();
  assert.deepEqual(writes.getSnapshot().pendingValues.modelSettings, desired, 'the desired map shows at once');

  form.release();
  await flush();
  // The rebased map is what the Host receives, and it is what the UI shows while the write runs.
  assert.deepEqual(writes.getSnapshot().pendingValues.modelSettings, {
    m1: { temperature: 0.7, maxTokens: 4096 },
    m2: { topP: 0.5, reasoningEffort: 'high' },
    m3: { enabled: false },
  });
  form.release();
  await flush();
  assert.equal(await first, true);
  assert.equal(await second, true);

  const written = form.calls.find(call => call.field === 'modelSettings')?.value as Record<string, Record<string, unknown>>;
  assert.deepEqual(written, {
    m1: { temperature: 0.7, maxTokens: 4096 },
    m2: { topP: 0.5, reasoningEffort: 'high' },
    m3: { enabled: false },
  });
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  assert.deepEqual(writes.getSnapshot().pendingValues, {}, 'the form snapshot takes the value back');
  writes.dispose();
});

test('a normalized Host value does not leave the overlay behind', async () => {
  const form = new FakeForm();
  form.normalize = () => ({ normalized: true });
  const writes = configWritesFor(form);

  assert.equal(await writes.set('modelSettings', { m1: { temperature: 0.7 } }), true);
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  assert.deepEqual(writes.getSnapshot().pendingValues, {}, 'the overlay ends with the write');

  // A later external change stays visible; no stale overlay masks it.
  form.value = { modelSettings: { m1: { temperature: 0.1 } } };
  form.notify();
  assert.deepEqual(writes.getSnapshot().pendingValues, {});
  writes.dispose();
});

test('every subscriber of a shared coordinator is notified', async () => {
  const form = new FakeForm();
  const writes = configWritesFor(form);

  const counts = Array.from({ length: 100 }, () => 0);
  const unsubscribes = counts.map((_, index) => writes.subscribe(() => { counts[index] = (counts[index] ?? 0) + 1; }));
  await writes.set('baseURL', 'https://one.test');
  assert.ok(counts.every(count => count > 0), 'no subscriber is dropped without notice');

  for (const unsubscribe of unsubscribes) unsubscribe();
  const seen = [...counts];
  await writes.set('apiProtocol', 'responses');
  assert.deepEqual(counts, seen, 'an unsubscribed consumer hears nothing');
  writes.dispose();
});

test('dropping a legacy context window and choosing a tier land in one write', async () => {
  const form = new FakeForm();
  const writes = configWritesFor(form);

  const base = { m1: { contextWindow: 500_000 } };
  form.value = { modelSettings: base };
  const desired = { m1: { contextTier: 'extended' } };
  await writes.set('modelSettings', desired, base);

  assert.equal(form.calls.length, 1);
  assert.deepEqual(form.calls[0]?.value, { m1: { contextTier: 'extended' } });
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  writes.dispose();
});

test('a model settings write without a baseline uses the current value as baseline', async () => {
  const form = new FakeForm();
  const writes = configWritesFor(form);

  form.value = { modelSettings: { m1: { temperature: 0.2 } } };
  await writes.set('modelSettings', { m1: { temperature: 0.9 } });

  assert.equal(form.calls.length, 1);
  assert.deepEqual(form.calls[0]?.value, { m1: { temperature: 0.9 } });
  writes.dispose();
});

test('disposal stops queued writes and releases the subscribers', async () => {
  const form = new FakeForm();
  form.manual = true;
  const writes = configWritesFor(form);

  let notified = 0;
  const unsubscribe = writes.subscribe(() => { notified += 1; });
  const first = writes.set('baseURL', 'https://one.test');
  const queued = writes.set('apiProtocol', 'responses');
  await flush();
  assert.deepEqual(form.calls.map(call => call.field), ['baseURL']);

  writes.dispose();
  const seen = notified;
  form.release();
  await flush();

  assert.deepEqual(form.calls.map(call => call.field), ['baseURL'], 'a queued write never starts');
  assert.equal(await first, true);
  assert.equal(await queued, false);
  assert.equal(notified, seen, 'a disposed coordinator does not update the UI');
  assert.deepEqual(writes.getSnapshot().pendingFields, []);
  unsubscribe();
});

test('a cleared field is dropped by the Host instead of being written as a value', async () => {
  const form = new FakeForm();
  form.value = { apiKeyEnv: 'TEAM_KEY' } as FormValues;
  const writes = configWritesFor(form);
  try {
    assert.equal(await writes.clear('apiKeyEnv'), true);
    assert.deepEqual(form.clears, ['apiKeyEnv']);
    assert.equal(form.calls.length, 0, 'a clear never travels as a value write');
    // The form snapshot is authoritative again, so the control falls back to the unnamed state.
    assert.deepEqual(writes.getSnapshot(), { pendingFields: [], pendingValues: {} });
    assert.equal(Object.prototype.hasOwnProperty.call(form.getSnapshot().value, 'apiKeyEnv'), false);
    // A queued clear locks the field without projecting a value for it.
    form.value = { apiKeyEnv: 'TEAM_KEY' } as FormValues;
    form.manual = true;
    const queued = writes.clear('apiKeyEnv');
    await flush();
    assert.deepEqual(writes.getSnapshot(), { pendingFields: ['apiKeyEnv'], pendingValues: {} });
    form.release();
    form.manual = false;
    assert.equal(await queued, true);
    // A rejected clear rolls back and stays retryable, like any other write.
    form.value = { apiKeyEnv: 'TEAM_KEY' } as FormValues;
    form.outcome = 'reject';
    assert.equal(await writes.clear('apiKeyEnv'), false);
    assert.deepEqual(writes.getSnapshot(), { pendingFields: [], pendingValues: {} });
    assert.deepEqual(form.getSnapshot().value, { apiKeyEnv: 'TEAM_KEY' });
  } finally {
    writes.dispose();
  }
});

test('a Host without a clear path refuses the clear instead of writing an empty name', async () => {
  const form = new FakeForm();
  form.value = { apiKeyEnv: 'TEAM_KEY' } as FormValues;
  // A Host that predates the clear path exposes no `unset` at all.
  const withoutUnset: ConfigForm = {
    getSnapshot: () => form.getSnapshot(),
    subscribe: listener => form.subscribe(listener),
    set: (field, value) => form.set(field, value),
  };
  const writes = configWritesFor(withoutUnset);
  try {
    assert.equal(await writes.clear('apiKeyEnv'), false);
    assert.equal(form.calls.length, 0);
    assert.deepEqual(form.getSnapshot().value, { apiKeyEnv: 'TEAM_KEY' });
  } finally {
    writes.dispose();
  }
});
