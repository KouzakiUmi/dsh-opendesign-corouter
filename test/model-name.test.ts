import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../src/catalog.js';
import { MAX_MODEL_NAME_LENGTH, modelNameFromId, normalizeModelName } from '../src/model-name.js';

test('the normalizer reproduces the catalog display name for every evidenced id except the one evidence rename', () => {
  // hy4-preview 的目录名是取证改名（Hunyuan H4 Preview），本地格式化只给出 Hy4 Preview。
  const exceptions = new Map([['hy4-preview', 'Hy4 Preview']]);
  for (const row of MODELS) {
    const expected = exceptions.get(row.id) ?? row.name;
    assert.equal(modelNameFromId(row.id), expected, row.id);
  }
});

test('new ids from observed families format into readable names', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['gpt-6.1-sol-remote', 'GPT-6.1 Sol Remote'],
    ['gpt-7-sol', 'GPT-7 Sol'],
    ['gpt-4o', 'GPT-4o'],
    ['gpt-4o-mini', 'GPT-4o Mini'],
    ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet 20241022'],
    ['claude-opus-4-5-2025-05-14', 'Claude Opus 4.5 2025-05-14'],
    ['qwen3-30b-a3b', 'Qwen3 30B A3B'],
    ['qwen-4-max', 'Qwen4 Max'],
    ['llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct'],
    ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'],
    ['glm-6-flashx', 'GLM-6 Flash-X'],
    ['deepseek-v5-flash-eco', 'DeepSeek V5 Flash Eco'],
    ['minimax-m4-flash', 'MiniMax M4 Flash'],
    ['vendor/model:v1', 'Vendor Model V1'],
    ['mistral-large-latest', 'Mistral Large Latest'],
    ['xyz', 'Xyz'],
  ];
  for (const [id, expected] of cases) assert.equal(modelNameFromId(id), expected, id);
});

test('an upstream real name wins; an echoed id, empty or oversized name falls back to the normalized id', () => {
  assert.equal(normalizeModelName('new-model', '  New   model  '), 'New model');
  assert.equal(normalizeModelName('new-model', 'new-model'), 'New Model');
  assert.equal(normalizeModelName('new-model', 'NEW-MODEL'), 'New Model');
  assert.equal(normalizeModelName('new-model', ''), 'New Model');
  assert.equal(normalizeModelName('new-model', '   '), 'New Model');
  assert.equal(normalizeModelName('new-model', 'x'.repeat(MAX_MODEL_NAME_LENGTH + 1)), 'New Model');
  assert.equal(normalizeModelName('gpt-7-sol', undefined), 'GPT-7 Sol');
  assert.equal(normalizeModelName('gpt-7-sol', 'GPT-7 Sol'), 'GPT-7 Sol');
});

test('the result is bounded and never throws for any valid id shape', () => {
  // 两个 flashx 各增长一个字符，使 127 字符的 id 归一化后越界 → 回退原始 id。
  const long = `flashx-flashx-${'a'.repeat(113)}`;
  assert.equal(long.length, 127);
  assert.equal(modelNameFromId(long), long);
  const shapes = ['a', 'a-b', 'a_b', 'a/b', 'a:b', 'a.b', '123', 'v1', 'k3.1', '20241022', '2024-10-22', 'a3b', '7b', 'o3', '-', '__', 'a--b'];
  for (const id of shapes) {
    const name = modelNameFromId(id);
    assert.ok(name.length > 0 && name.length <= MAX_MODEL_NAME_LENGTH, id);
  }
  // 全目录 id 与一批随机组合都不抛异常且输出有界。
  for (const row of MODELS) assert.ok(modelNameFromId(row.id).length <= MAX_MODEL_NAME_LENGTH);
});
