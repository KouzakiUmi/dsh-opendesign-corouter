import test from 'node:test';
import assert from 'node:assert/strict';
import { CoRouterAdapter } from '../src/adapter.js';
import { PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { hasRestrictedClaudeSampling, claudeOutputError, claudeSamplingError } from '../src/claude-capabilities.js';
import { validateClaudeOutput, validateClaudeSampling } from '../src/claude-parameters.js';

const ids = ['claude-fable-5.1', 'claude-fable-5', 'claude-opus-5.5', 'claude-opus-5', 'claude-opus-4.8', 'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-haiku-5.5'];
const base: RuntimeConfig = { apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://example.com/v1', useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 10000, streamIdleTimeoutMs: 1000 };

async function consume(stream: AsyncIterable<unknown>): Promise<void> { for await (const _chunk of stream) { /* consume */ } }

test('Messages sampling restrictions use the eight exact evidenced model IDs', () => {
  for (const id of ids) {
    assert.equal(hasRestrictedClaudeSampling(id, 'messages'), true, id);
    assert.equal(hasRestrictedClaudeSampling(id, 'chat-completions'), false, id);
    assert.equal(hasRestrictedClaudeSampling(id, 'responses'), false, id);
    assert.doesNotThrow(() => validateClaudeSampling(id, undefined, undefined));
    assert.doesNotThrow(() => validateClaudeSampling(id, 1, undefined));
    assert.doesNotThrow(() => validateClaudeSampling(id, undefined, 0.99));
    assert.doesNotThrow(() => validateClaudeOutput(id, 128_000));
    assert.throws(() => validateClaudeOutput(id, 128_001), { code: 'UNSUPPORTED_OPTION' });
    for (const [temperature, topP] of [[0.4, undefined], [undefined, 1], [1, 0.99]] as const) {
      assert.throws(() => validateClaudeSampling(id, temperature, topP), { code: 'UNSUPPORTED_OPTION' });
    }
  }
  assert.equal(claudeSamplingError('claude-unknown', 'messages', 0.4, 0.5), undefined);
  assert.equal(claudeSamplingError('claude-sonnet-5', 'chat-completions', 0.4, 0.5), undefined);
  assert.equal(claudeOutputError('claude-sonnet-5', 'chat-completions', 128_001), undefined);
});

test('invalid Claude Messages output limit fails before credentials or network', async () => {
  const config: RuntimeConfig = { ...base, apiProtocol: 'messages', modelSettings: { 'claude-sonnet-5': { maxTokens: 128_001 } } };
  const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => { assert.fail('credential lookup is too late'); }, fetch: async () => { assert.fail('network is too late'); } });
  await assert.rejects(consume(adapter.stream({ provider: PAID_PROVIDER, model: 'claude-sonnet-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })), { code: 'UNSUPPORTED_OPTION' });
});

test('invalid Claude Messages sampling fails before credentials or network, including saved settings', async () => {
  for (const [temperature, topP, callTemperature] of [[0.4, undefined, undefined], [undefined, 1, undefined], [1, 0.99, undefined], [undefined, undefined, 0.4]] as const) {
    const config: RuntimeConfig = { ...base, apiProtocol: 'messages', modelSettings: { 'claude-sonnet-5': { ...(temperature === undefined ? {} : { temperature }), ...(topP === undefined ? {} : { topP }) } } };
    const adapter = new CoRouterAdapter({ config: () => config, apiKey: async () => { assert.fail('credential lookup is too late'); }, fetch: async () => { assert.fail('network is too late'); } });
    await assert.rejects(consume(adapter.stream({ provider: PAID_PROVIDER, model: 'claude-sonnet-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...(callTemperature === undefined ? {} : { temperature: callTemperature }) })), { code: 'UNSUPPORTED_OPTION' });
  }
});
