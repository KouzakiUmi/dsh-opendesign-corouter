import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextWindowControl, EffortField, formatContextShort, type ContextWindowControlProps, type EffortFieldProps } from '../src/client-model-controls.js';

const h = React.createElement;
const context = (props: Partial<ContextWindowControlProps> = {}) => renderToStaticMarkup(h(ContextWindowControl, {
  id: 'context-fixture', reference: 1_000_000, settings: {}, disabled: false, onSelect: () => {}, ...props,
}));
const effort = (props: Partial<EffortFieldProps> = {}) => renderToStaticMarkup(h(EffortField, {
  id: 'effort-fixture', model: {}, value: undefined, disabled: false, pending: false, onSave: async () => true, ...props,
}));
const presetButtons = (html: string) => [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gu)]
  .filter(match => match[1]!.includes('data-preset='));

test('context labels are compact while exact decimal and binary references stay distinct', () => {
  for (const [tokens, expected] of [
    [undefined, '容量未知'], [256_000, '256K'], [1_050_000, '1.05M'],
    [65_536, '64K'], [131_072, '128K'], [1_048_576, '1M'], [1, '1'], [8_193, '8,193'],
  ] as const) assert.equal(formatContextShort(tokens), expected);
});

test('six model references render one inline group of three native capacity buttons', () => {
  for (const [reference, labels, exact] of [
    [1_000_000, ['256K', '512K', '1M'], ['256,000', '512,000', '1,000,000']],
    [1_050_000, ['256K', '512K', '1.05M'], ['256,000', '512,000', '1,050,000']],
    [1_048_576, ['256K', '512K', '1M'], ['262,144', '524,288', '1,048,576']],
    [262_144, ['64K', '128K', '256K'], ['65,536', '131,072', '262,144']],
    [500_000, ['128K', '256K', '500K'], ['128,000', '256,000', '500,000']],
    [96_000, ['32K', '64K', '96K'], ['32,000', '64,000', '96,000']],
  ] as const) {
    const html = context({ reference });
    assert.match(html, /class="odc-context odc-context-control" role="group" aria-label="上下文窗口"/u);
    const buttons = presetButtons(html);
    assert.deepEqual(buttons.map(match => match[2]), [...labels]);
    for (const [index, name] of ['默认', '扩展', '最大'].entries()) {
      assert.ok(buttons[index]![1]!.includes(`aria-label="${name} ${labels[index]}"`));
      assert.ok(buttons[index]![1]!.includes(`${exact[index]} tokens`), `${reference}/${name} exact title`);
      assert.ok(buttons[index]![1]!.includes('共享默认'));
      assert.ok(buttons[index]![1]!.includes('输入与输出合计'));
    }
    assert.equal(buttons.filter(match => match[1]!.includes('aria-pressed="true"')).length, 1);
    assert.doesNotMatch(html, /popover|type="radio"/u);
  }
});

test('legacy numeric windows remain custom even when equal to a generated tier', () => {
  for (const saved of [256_000, 512_000, 1_000_000]) {
    const html = context({ reference: 96_000, settings: { contextWindow: saved } });
    assert.ok(html.includes(`自定义 ${formatContextShort(saved)}`));
    assert.ok(html.includes(`${saved.toLocaleString('en-US')} tokens`));
    assert.equal(presetButtons(html).filter(match => match[1]!.includes('aria-pressed="true"')).length, 0);
  }
  const extended = presetButtons(context({ settings: { contextTier: 'extended' } }));
  assert.ok(extended[1]![1]!.includes('aria-pressed="true"'));
});

test('unknown capacity omits fake tiers and only offers reset when an override exists', () => {
  for (const reference of [undefined, 0, NaN]) {
    const html = context({ reference });
    assert.match(html, /容量未知/u);
    assert.match(html, /模型参考容量未核实/u);
    assert.equal(presetButtons(html).length, 0);
    assert.doesNotMatch(html, /<button|272K|最大|—/u);
    for (const settings of [{ contextWindow: 512_000 }, { contextTier: 'maximum' as const }]) {
      const custom = context({ reference, settings });
      assert.match(custom, />恢复默认<\/button>/u);
      assert.equal(presetButtons(custom).length, 0);
    }
  }
});

test('duplicate tiny tiers and pending writes disable the appropriate native buttons', () => {
  const tiny = presetButtons(context({ reference: 1 }));
  assert.equal(tiny.length, 3);
  assert.ok(!tiny[0]![1]!.includes('disabled'));
  assert.ok(tiny[1]![1]!.includes('disabled'));
  assert.ok(tiny[2]![1]!.includes('disabled'));
  const pending = context({ pending: true, reason: '正在保存，请稍候。' });
  assert.match(pending, /aria-busy="true" aria-describedby="context-fixture-reason"/u);
  assert.ok(presetButtons(pending).every(match => match[1]!.includes('disabled')));
  assert.match(pending, /id="context-fixture-reason"[^>]*role="status">正在保存，请稍候。/u);
});

test('graded effort exposes its current default and an explicit edit action', () => {
  const html = effort({ model: { reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' } });
  assert.match(html, /data-mode="summary" data-kind="graded"/u);
  assert.match(html, /aria-label="编辑默认思考深度"/u);
  assert.match(html, /模型默认（高 · high）/u);
  assert.doesNotMatch(html, /<select|保存默认思考深度/u, 'the initial summary is not an immediately saving select');
  assert.match(effort({ model: { reasoningEfforts: ['medium', 'high'] }, value: 'medium' }), /中 · medium/u);
});

test('toggle uses on/off wording while fixed and unknown remain separate read-only states', () => {
  const toggle = { reasoningMode: 'toggle' as const, reasoningEfforts: ['none', 'high'], defaultEffort: 'high' };
  const on = effort({ model: toggle });
  assert.match(on, /思考模式/u);
  assert.match(on, /模型默认（开启）/u);
  assert.match(on, /aria-label="编辑思考模式"/u);
  assert.doesNotMatch(on, /高 · high|低档|高档/u);
  assert.match(effort({ model: toggle, value: 'none' }), />关闭<\/p>/u);
  const fixed = effort({ model: { reasoningMode: 'fixed', reasoningEfforts: ['high'] } });
  assert.match(fixed, /固定思考 · 始终开启/u);
  assert.doesNotMatch(fixed, /<button|<select|档思考/u);
  const unknown = effort();
  assert.match(unknown, /思考能力未核实/u);
  assert.doesNotMatch(unknown, /不支持|<button|<select/u);
  const discrete = effort({ model: { reasoningEfforts: [] } });
  assert.match(discrete, /未提供离散思考控制/u);
  assert.doesNotMatch(discrete, /不支持|思考能力未核实/u);
});

test('legacy effort defaults remain visible and clearable for fixed, unknown and unlisted controls', () => {
  for (const model of [{ reasoningMode: 'fixed' as const }, {}, { reasoningEfforts: [] }]) {
    const html = effort({ model, value: 'old-effort' });
    assert.match(html, /旧设置 old-effort（可清除）/u);
    assert.match(html, /aria-label="编辑默认思考深度"[^>]*>清除旧设置<\/button>/u);
    assert.match(html, /可编辑并清除旧设置/u);
  }
  const pending = effort({ model: { reasoningEfforts: ['high'] }, pending: true });
  assert.match(pending, /aria-busy="true"/u);
  assert.match(pending, /<button[^>]*disabled/u);
  assert.match(pending, /正在保存模型设置/u);
});
