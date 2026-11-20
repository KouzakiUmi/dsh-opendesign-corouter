import test from 'node:test';
import assert from 'node:assert/strict';
import { SelectorBridge } from '../src/selector-bridge.js';

test('the bridge republishes only when the advertised projection changes', () => {
  let projection = 'a';
  let replaces = 0;
  const bridge = new SelectorBridge({ projection: () => projection, replace: () => { replaces++; } });
  bridge.notify();
  assert.equal(replaces, 0, 'an identical projection is a no-op');
  projection = 'b';
  bridge.notify();
  assert.equal(replaces, 1);
  bridge.notify();
  assert.equal(replaces, 1, 'repeating the same new projection is a no-op');
  projection = 'a';
  bridge.notify();
  assert.equal(replaces, 2, 'reverting to an older projection is a real change');
  bridge.dispose();
});

test('a rejected replace propagates synchronously and keeps the advertised state retryable', () => {
  let projection = 'a';
  let attempts = 0;
  const bridge = new SelectorBridge({
    projection: () => projection,
    replace: () => { attempts++; throw new Error('selector rejected'); },
  });
  projection = 'b';
  assert.throws(() => bridge.notify(), /selector rejected/u);
  assert.equal(attempts, 1);
  // The selector kept its old routes, so the same change must be retryable.
  assert.throws(() => bridge.notify(), /selector rejected/u);
  assert.equal(attempts, 2);
  bridge.dispose();
});

test('dispose stops further notifications', () => {
  let projection = 'a';
  let replaces = 0;
  const bridge = new SelectorBridge({ projection: () => projection, replace: () => { replaces++; } });
  bridge.dispose();
  projection = 'b';
  bridge.notify();
  assert.equal(replaces, 0);
});
