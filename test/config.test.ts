import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Config, assertBaseURL, readConfig } from '../src/config.js';
import Schema from '@deepseek-ai/schemastery';
import { volatileForm } from '../node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js';
test('configuration rejects unsafe URLs before persistence and exposes live defaults', () => {
  const config = readConfig(Config({}));
  assert.equal(config.emptyTurnGuard, true);
  assert.equal(config.useDesktopCredential, true);
  assert.equal(config.baseURL, 'https://amr-link.open-design.ai/v1');
  assert.equal(config.apiProtocol, 'chat-completions');
  assert.deepEqual(config.modelSettings, {});
  assert.equal(config.quotaRefreshSeconds, 60);
  assert.equal(config.maxRequestImageBytes, 20 * 1024 * 1024);
  assert.equal(assertBaseURL('https://example.com/v1/'), 'https://example.com/v1');
  for (const baseURL of ['https://user:password@example.com/v1', 'https://example.com/v1?secret=fixture', 'https://example.com/v1#fragment', 'http://example.com/v1', 'not a URL']) assert.throws(() => Config({ baseURL }));
  assert.equal(readConfig(Config({ baseURL: 'http://127.0.0.1:8080/v1' })).baseURL, 'http://127.0.0.1:8080/v1');
  const customized = readConfig(Config({ apiProtocol: 'messages', modelSettings: { 'gpt-6-luna': { enabled: false, temperature: 0.3, maxTokens: 4096 } } }));
  assert.equal(customized.apiProtocol, 'messages');
  assert.equal(customized.modelSettings?.['gpt-6-luna']?.enabled, false);
  assert.throws(() => Reflect.apply(Config, undefined, [{ apiProtocol: 'not-a-protocol' }]));
  assert.throws(() => Config({ modelSettings: { 'gpt-6-luna': { apiKey: 'must-not-persist' } } }));
  assert.throws(() => Config({ quotaRefreshSeconds: 0 }));
  assert.equal(readConfig(Config({ maxRequestImageBytes: 8 * 1024 * 1024 })).maxRequestImageBytes, 8 * 1024 * 1024);
  assert.throws(() => Config({ maxRequestImageBytes: 1024 * 1024 - 1 }));
  assert.throws(() => Config({ maxRequestImageBytes: 100 * 1024 * 1024 + 1 }));
});

type DecodedConfig = (value: Parameters<typeof Config>[0]) => ReturnType<typeof readConfig>;

/** Execute the installed constructor in an isolated realm, including its new Function. */
function rehydrateInFreshVM(serialized = JSON.stringify(Config.toJSON())): DecodedConfig {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@deepseek-ai/schemastery');
  return runInNewContext(`${readFileSync(entry, 'utf8')}
    const wire = JSON.parse(schemaJSON);
    // The browser decoder validates plain form values rather than Host Volatiles.
    for (const node of Object.values(wire.refs)) delete node.meta.volatile;
    new module.exports(wire);`, {
    module: { exports: {} }, require: createRequire(entry), URL,
    schemaJSON: serialized,
  }) as DecodedConfig;
}

test('real Host volatile form projection survives repeated JSON hops before browser validation', () => {
  const form = volatileForm(Config);
  assert.ok(form);
  let current = form;
  const values = readConfig(Config({ emptyTurnGuard: false, useDesktopCredential: false, modelSettings: { model: { imageInput: false } } }));
  for (let hop = 0; hop < 4; hop++) {
    const wire = JSON.stringify(current.toJSON());
    const decoded = rehydrateInFreshVM(wire);
    assert.deepEqual(JSON.parse(JSON.stringify(decoded(structuredClone(values)))), JSON.parse(JSON.stringify(values)));
    assert.equal(decoded({ ...values, emptyTurnGuard: true }).emptyTurnGuard, true);
    assert.throws(() => decoded({ ...values, baseURL: 'https://user:secret@example.com/v1' }));
    assert.throws(() => decoded({ ...values, modelSettings: { model: { apiKey: 'secret' } } }));
    current = new Schema(JSON.parse(wire));
  }
});

test('JSON-roundtripped settings validate complete checkbox values in a fresh VM', () => {
  const decoded = rehydrateInFreshVM();
  assert.deepEqual(JSON.parse(JSON.stringify(decoded({}))), readConfig(Config({})));
  const settings = { 'vendor/model:v1': { enabled: false, imageInput: true, temperature: 0, topP: 1, maxTokens: 4096, contextWindow: 8192, reasoningEffort: 'high' } };
  for (const emptyTurnGuard of [true, false]) {
    for (const useDesktopCredential of [true, false]) {
      const input = {
        apiKeyEnv: 'COROUTER_FIXTURE', baseURL: 'http://[::1]:8080/v1/', apiProtocol: 'responses' as const,
        modelSettings: settings, emptyTurnGuard, useDesktopCredential, quotaRefreshSeconds: 5,
        requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
      };
      assert.deepEqual(JSON.parse(JSON.stringify(decoded(input))), readConfig(Config(input)));
      assert.equal(decoded(input).baseURL, 'http://[::1]:8080/v1');
    }
  }
  assert.equal(settings['vendor/model:v1'].enabled, false);
  assert.equal(settings['vendor/model:v1'].temperature, 0);
});

test('fresh-VM settings retain URL, model allowlist, bounds and safe errors', () => {
  const decoded = rehydrateInFreshVM();
  for (const baseURL of ['not-a-url', 'ftp://example.com/v1', 'http://example.com/v1', 'https://fixture-secret@example.com/v1', 'https://example.com/v1?fixture-secret', 'https://example.com/v1#fixture-secret']) {
    assert.throws(() => decoded({ baseURL }), error => {
      assert.match(String(error), /推理 Base URL|必须使用 HTTPS/u);
      assert.doesNotMatch(String(error), /fixture-secret|is not defined/u);
      return true;
    });
  }
  const invalidSettings: unknown[] = [
    [], true, { model: null }, { model: [] }, { model: { enabled: 'false' } }, { model: { imageInput: 'false' } },
    { model: { temperature: -1 } }, { model: { temperature: 2.1 } }, { model: { temperature: Number.NaN } },
    { model: { topP: 1.1 } }, { model: { topP: Number.POSITIVE_INFINITY } },
    { model: { maxTokens: 0 } }, { model: { maxTokens: 1.5 } }, { model: { maxTokens: 10_000_001 } },
    { model: { contextWindow: 100_000_001 } }, { model: { reasoningEffort: 'invalid' } },
    { model: { maxTokens: 8192, contextWindow: 8192 } },
    { 'fixture-secret id': {} }, { ['a'.repeat(129)]: {} },
    Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`model-${i}`, {}])),
    { model: { apiKey: 'fixture-secret' } }, { model: { headers: { authorization: 'fixture-secret' } } },
    ...['__proto__', 'constructor', 'prototype'].map(key => JSON.parse(`{"${key}":{}}`)),
  ];
  for (const modelSettings of invalidSettings) {
    assert.throws(() => Reflect.apply(decoded, undefined, [{ modelSettings }]), error => {
      assert.doesNotMatch(String(error), /fixture-secret|is not defined/u);
      return true;
    });
  }
  const boundary = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`model-${i}`, {}]));
  assert.equal(Object.keys(decoded({ modelSettings: boundary }).modelSettings ?? {}).length, 512);
  assert.doesNotThrow(() => decoded({ modelSettings: { ['a'.repeat(128)]: { temperature: 2, topP: 0, maxTokens: 10_000_000, contextWindow: 100_000_000, reasoningEffort: 'max' } } }));
});

test('Host and JSON-decoded string bounds match the status transport', () => {
  for (const validate of [(value: Parameters<typeof Config>[0]) => readConfig(Config(value)), rehydrateInFreshVM()]) {
    assert.equal(validate({ apiKeyEnv: 'A'.repeat(128) }).apiKeyEnv.length, 128);
    assert.throws(() => validate({ apiKeyEnv: 'A'.repeat(129) }));
    const baseURL = `https://example.com/${'a'.repeat(2028)}`;
    assert.equal(baseURL.length, 2048);
    assert.equal(validate({ baseURL }).baseURL.length, 2048);
    assert.throws(() => validate({ baseURL: `${baseURL}a` }), /2048/u);
    // URL normalization percent-encodes Unicode; bound the persisted result too.
    assert.throws(() => validate({ baseURL: `https://example.com/${'中'.repeat(300)}` }), /2048/u);
  }
});
