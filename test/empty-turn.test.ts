// Adapter-callable empty-turn guard: decision table, monitor switch, telemetry.
//
// Every case runs against synthetic chunks and a bare reason object; the guard has no host,
// network, or timer to involve. What matters is the decision: a `stop` whose visible answer is
// nothing but protocol residue must become the scoped OPENDESIGN_EOT failure, and everything
// a real answer looks like must keep its exact reason.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolCallId, type FinishReason, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { OPENDESIGN_EOT } from '../src/eot-code.js';

import {
  EMPTY_TURN_MESSAGE,
  EmptyTurnTracker,
  isMarkupOnlyStop,
  isResidueOnly,
  stripProtocolResidue,
  type EmptyTurnOptions,
} from '../src/empty-turn.js';

const STOP: FinishReason = { kind: 'stop' };
const MAX_TOKENS: FinishReason = { kind: 'max-tokens' };
const ABORTED: FinishReason = { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } };
const FAILED: FinishReason = { kind: 'error', failure: { code: 'SERVER', message: 'server' } };

/** Streamed text, which is how a long reply arrives. */
const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text });
/** Streamed reasoning. */
const reasoningDelta = (text: string): StreamChunk => ({ type: 'reasoning-delta', index: 1, text });
/** A whole text block, which is how a short reply arrives. */
const textBlock = (text: string): StreamChunk => ({ type: 'block-end', index: 0, block: { type: 'text', text } });
const reasoningBlock = (text: string): StreamChunk => ({ type: 'block-end', index: 1, block: { type: 'reasoning', text } });
const toolStart: StreamChunk = { type: 'block-start', index: 2, blockType: 'tool-call' };
const toolEnd: StreamChunk = {
  type: 'block-end',
  index: 2,
  block: { type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{}' },
};
const toolDelta: StreamChunk = { type: 'tool-call-delta', index: 2, id: ToolCallId('call_1'), argumentsDelta: '{}' };

/** Mount a tracker over a chunk list, the way an adapter feeds one stream. */
function track(chunks: readonly StreamChunk[], options: EmptyTurnOptions = {}): EmptyTurnTracker {
  const tracker = new EmptyTurnTracker(options);
  for (const chunk of chunks) tracker.observe(chunk);
  return tracker;
}

/** Rewrite or pass through one finish, as the adapter would at the end of its stream. */
function decide(chunks: readonly StreamChunk[], reason: FinishReason = STOP): FinishReason {
  return track(chunks).resolve(reason);
}

/** The only shape a rewrite may take. */
function assertEmptyTurn(reason: FinishReason, label: string): void {
  assert.equal(reason.kind, 'error', `${label}: becomes an error`);
  if (reason.kind !== 'error') return;
  assert.equal(reason.failure.code, OPENDESIGN_EOT, `${label}: EOT recovery owns this failure`);
  assert.equal(reason.failure.message, EMPTY_TURN_MESSAGE, `${label}: the failure explains itself`);
}

/** Everything else must arrive untouched, by identity. */
function assertPassthrough(resolved: FinishReason, original: FinishReason, label: string): void {
  assert.equal(resolved, original, `${label}: the reason object is returned unchanged`);
}

const RESIDUE_CASES: readonly (readonly [string, readonly StreamChunk[]])[] = [
  ['DSML close tags as a whole block', [textBlock('  </｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>')]],
  ['DSML close tag as a delta', [delta('｜｜DSML｜｜ calls>')]],
  ['a tag truncated mid-markup', [textBlock('</｜｜DSML｜｜')]],
  ['an empty thinking pair', [textBlock('\n<thinking> </thinking>\n')]],
  ['REA tool-call opener', [textBlock('<rea:tool_calls>')]],
  ['REA tool-call pair', [delta('<rea:'), delta('tool_calls>'), delta('</rea:tool_calls>')]],
  ['REA tool call with argument text', [textBlock('<rea:tool_calls><rea:tool name="read"><rea:parameter name="path">README.md</rea:parameter></rea:tool></rea:tool_calls>')]],
  ['incomplete REA tool call with argument text', [textBlock('<rea:tool_calls><rea:tool name="read"><rea:parameter name="path">README.md')]],
  ['DSML tool call with argument text', [textBlock('<｜｜DSML｜｜calls><｜｜DSML｜｜invoke>arguments</｜｜DSML｜｜invoke></｜｜DSML｜｜calls>')]],
  ['an empty presentation tag', [textBlock('<返璞归真></返璞归真>')]],
  ['whitespace only', [textBlock('   \n\t  ')]],
  ['markup plus punctuation', [textBlock('  </thinking> | ')]],
  ['deltas that only ever carried markup', [delta('</｜｜DSML｜｜ calls>'), delta('  ')]],
];

test('stripProtocolResidue removes known protocol tokens only', () => {
  assert.equal(stripProtocolResidue('  </｜｜DSML｜｜ calls>'), '');
  assert.equal(stripProtocolResidue('｜｜DSML｜｜ calls>'), '');
  assert.equal(stripProtocolResidue('\n<thinking> </thinking>\n'), '');
  assert.equal(stripProtocolResidue('</｜｜DSML｜｜'), '', 'a truncated tag leaves only punctuation');
  assert.equal(stripProtocolResidue('   '), '');
  assert.equal(stripProtocolResidue('结论如下。\n<thinking> </thinking>'), '结论如下。', 'real prose survives');
  assert.equal(stripProtocolResidue('任务已完成。<rea:tool_calls></rea:tool_calls>'), '任务已完成。');
  assert.equal(stripProtocolResidue('<rea:analysis>正文</rea:analysis>'), '<rea:analysis>正文</rea:analysis>');
  assert.equal(stripProtocolResidue('说明：<rea:tool_calls><rea:tool name="read">args</rea:tool></rea:tool_calls>'), '说明：');
  assert.notEqual(stripProtocolResidue('```xml\n<rea:tool_calls><rea:tool name="read">args</rea:tool></rea:tool_calls>\n```'), '');
  assert.equal(stripProtocolResidue('｜｜DSML｜｜ 是工具标记格式'), '｜｜DSML｜｜ 是工具标记格式');
  assert.equal(stripProtocolResidue('好的'), '好的');
  assert.equal(stripProtocolResidue('?'), '?');
});

test('isResidueOnly treats absent and blank channels as nothing', () => {
  assert.equal(isResidueOnly(undefined), true);
  assert.equal(isResidueOnly(''), true);
  assert.equal(isResidueOnly('  \n\t '), true);
  assert.equal(isResidueOnly('</thinking>'), true);
  assert.equal(isResidueOnly('好的'), false);
  assert.equal(isResidueOnly('?'), false);
});

test('markup-only stops become retryable failures', async (t) => {
  for (const [label, chunks] of RESIDUE_CASES) {
    await t.test(label, () => {
      const tracker = track(chunks);
      assert.equal(tracker.inspect().markupOnly, true, `${label}: recognized as residue only`);
      assertEmptyTurn(tracker.resolve(STOP), label);
    });
  }
});

test('a stop with no channel content at all is an empty turn', () => {
  assertEmptyTurn(decide([]), 'no chunks');
  assertEmptyTurn(decide([delta('  ')]), 'blank delta');
});

test('pending-action prose never becomes a protocol request failure', () => {
  for (const text of [
    '让我核对项目配置的完整情况。',
    '好的，我来看看这个文件。',
    '先读一下配置。',
    '我需要检查项目配置。',
    '让我核对根目录。｜｜DSML｜｜ calls>',
    '让我核对根目录。<rea:tool_calls><rea:tool name="read"><rea:parameter name="path">README.md</rea:parameter></rea:tool></rea:tool_calls>',
    "I'll check the configuration.",
    'Let me inspect the files.',
    'Now let me check X...',
    '模型已通过测试。现在核对依赖状态，确认相关配置是否已同步。',
    '本轮检查已通过。现在查看当前目录的配置。',
    '已更新构建。设置与接口已同步。现在核验发布与配置。',
  ]) {
    const tracker = track([textBlock(text)]);
    assert.equal(tracker.inspect().markupOnly, false);
    assertPassthrough(tracker.resolve(STOP), STOP, 'the Agent checkpoint owns task completion');
    assertPassthrough(track([textBlock(text), toolStart]).resolve(STOP), STOP, 'tool-call protects a preamble');
    assertPassthrough(track([textBlock(text)], { enabled: false }).resolve(STOP), STOP, 'switch off');
    assertPassthrough(track([textBlock(text)]).resolve(MAX_TOKENS), MAX_TOKENS, 'max-tokens is not a stop');
  }
});

test('answers, completed actions and multi-sentence text keep their protocol finish', () => {
  for (const text of [
    '好的', '?', '这是一个正常的回答，包含标点。',
    '我先查看了日志。', '我先检查一下，结果是正常。', '让我核对一下。结果正常。',
    '我会检查什么？', '可以通过检查配置解决此问题。',
    '｜｜DSML｜｜ 是工具标记格式', 'Let me check. The result is correct.',
    'The configuration is correct.', '我先检查以下内容：配置正确。',
    '检查通过。现在查看了日志，发现配置正常。', '检查通过。现在系统可以正常启动。',
  ]) {
    assertPassthrough(decide([textBlock(text)]), STOP, text);
  }
});

test('pre-delivery prose is preserved for structured Agent review instead of re-requested', () => {
  for (const text of [
    '端到端验证已通过。提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。',
    '端到端验证已通过。提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。<rea:tool_calls></rea:tool_calls>',
    '**端到端验证已通过。提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。**',
    '端到端验证已通过。\n提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。',
    '构建已通过。发布前再核对产物和版本。',
    '测试已通过。交付前再检查配置是否正常。',
    '准备工作已完成。合并之前再验证测试是否通过。',
    '最后再检查一遍：没有真实凭据。',
    '最后再核对测试结果。',
    '现在核对依赖是否正常。',
    '本轮检查已通过。接下来确认构建是否通过。',
  ]) {
    for (const chunks of [[textBlock(text)], [delta(text.slice(0, 12)), delta(text.slice(12))]]) {
      assertPassthrough(decide(chunks), STOP, text);
      assertPassthrough(track([...chunks, toolStart]).resolve(STOP), STOP, 'a real tool protects the attempt');
      assertPassthrough(track(chunks, { enabled: false }).resolve(STOP), STOP, 'disabled monitor');
      assertPassthrough(track(chunks).resolve(MAX_TOKENS), MAX_TOKENS, 'truncation');
    }
  }
});

test('completed checks, user instructions and delivered explanations remain successful prose', () => {
  for (const text of [
    '端到端验证已通过。提交前已确认：没有二进制文件被误纳入提交，也没有真实凭据。',
    '端到端验证已通过。提交前再确认了一遍：没有二进制文件被误纳入提交，也没有真实凭据。',
    '端到端验证已通过。提交前再确认一遍的结果是：没有二进制文件被误纳入提交，也没有真实凭据。',
    '发布前再核对的结果显示版本正确。',
    '提交前请再确认一遍：没有真实凭据。',
    '你可以在提交前再确认一遍：没有真实凭据。',
    '建议提交前再确认一遍。',
    '端到端验证已通过。提交前再确认一遍吗？',
    '提交前再确认一遍：没有真实凭据。结果已记录，检查完成。',
    '```text\n提交前再确认一遍：没有真实凭据。\n```',
    '操作说明：\n- 提交前再确认一遍：没有真实凭据。',
    '端到端验证已通过。没有二进制文件被误纳入提交，也没有真实凭据。',
    '检查通过。现在查看了日志，发现配置正常。',
  ]) {
    assertPassthrough(decide([textBlock(text)]), STOP, text);
  }
});

test('real replies are never touched', async (t) => {
  const cases: readonly (readonly [string, readonly StreamChunk[], FinishReason])[] = [
    ['a normal sentence', [textBlock('文件中的配置正确。')], STOP],
    ['a one-word answer', [textBlock('好的')], STOP],
    ['a single symbol', [textBlock('?')], STOP],
    ['a sentence with punctuation', [textBlock('这是一个正常的回答，包含标点。')], STOP],
    ['streamed prose', [delta('配置已'), delta('读取完成。')], STOP],
    ['prose beside leaked markup', [textBlock('结论如下。\n<thinking> </thinking>')], STOP],
    ['a tool call', [toolStart, toolEnd], STOP],
    ['a tool call with preamble text', [delta('先跑一下。'), toolStart, toolEnd], STOP],
    ['a token-limited reply', [textBlock('<thinking> </thinking>')], MAX_TOKENS],
    ['a markup-only reply behind an abort', [textBlock('</thinking>')], ABORTED],
    ['a markup-only reply behind an error', [textBlock('</thinking>')], FAILED],
  ];

  for (const [label, chunks, reason] of cases) {
    await t.test(label, () => {
      assertPassthrough(decide(chunks, reason), reason, label);
    });
  }
});

test('every tool-call shape protects the attempt', async (t) => {
  const shapes: readonly (readonly [string, readonly StreamChunk[]])[] = [
    ['block-start only', [delta('</thinking>'), toolStart]],
    ['block-end only', [textBlock('</thinking>'), toolEnd]],
    ['delta only', [delta('</thinking>'), toolDelta]],
  ];
  for (const [label, chunks] of shapes) {
    await t.test(label, () => {
      const tracker = track(chunks);
      assert.equal(tracker.sawToolCall, true, `${label}: the guard noticed`);
      assertPassthrough(tracker.resolve(STOP), STOP, label);
    });
  }
});

test('thinking after a real trace but with no visible answer is still an empty turn', () => {
  // Reference semantics, kept on purpose: the user got nothing they can read. The reasoning
  // length is reported so the cost of that retry is visible, but it does not rescue the turn.
  const tracker = track([reasoningDelta('用户想要重构配置加载，先列出三种方案再比较。')]);
  const evidence = tracker.inspect();
  assert.equal(evidence.markupOnly, true, 'visible text is empty');
  assert.ok(evidence.textLength === 0);
  assert.ok(evidence.reasoningLength > 0, 'the trace is measured, not ignored');
  assertEmptyTurn(tracker.resolve(STOP), 'reasoning without answer');
});

test('reasoning residue alone does not decide the turn, visible text does', () => {
  const residueReasoning = track([reasoningBlock('<thinking> </thinking>')]);
  assertEmptyTurn(residueReasoning.resolve(STOP), 'reasoning residue + empty text');

  const visibleAnswer = track([reasoningDelta('先想一下。'), textBlock('先想了一下，结论是 A。')]);
  assertPassthrough(visibleAnswer.resolve(STOP), STOP, 'reasoning + real visible text');
});

test('a protocol that sends both deltas and closed blocks is not double-counted', () => {
  const tracker = track([delta('结论'), textBlock('结论')]);
  assert.equal(tracker.inspect().textLength, 2, 'closed block is authoritative');
  assertPassthrough(tracker.resolve(STOP), STOP, 'deduplicated');
});

test('the monitor switch turns the rewrite off without touching Core behaviour', async (t) => {
  await t.test('default is on', () => {
    assert.equal(track([]).enabled, true);
    assertEmptyTurn(decide([textBlock('</thinking>')]), 'default on');
  });

  await t.test('off returns the original reason', () => {
    const chunks = [textBlock('</｜｜DSML｜｜ calls>')];
    const tracker = track(chunks, { enabled: false });
    assert.equal(tracker.enabled, false);
    assertPassthrough(tracker.resolve(STOP), STOP, 'monitor off');
    assert.equal(tracker.inspect().markupOnly, true, 'evidence is still available while off');
  });

  await t.test('off switches no other outcome', () => {
    const tracker = track([textBlock('正常的回答')], { enabled: false });
    assertPassthrough(tracker.resolve(STOP), STOP, 'off + real text');
  });
});

test('telemetry reports counts only and can never break the stream', async (t) => {
  await t.test('fires once per rewrite with log-safe evidence', () => {
    const seen: unknown[] = [];
    const tracker = track([reasoningDelta('想一下'), textBlock('\n<thinking> </thinking>\n')], {
      onEmptyTurn: (evidence) => seen.push(evidence),
    });
    assertEmptyTurn(tracker.resolve(STOP), 'rewrite');
    assert.equal(seen.length, 1, 'one report per rewrite');
    const evidence = seen[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(evidence).sort(), ['markupOnly', 'reasoningLength', 'sawToolCall', 'textLength']);
    assert.equal(typeof evidence.textLength, 'number', 'a length, not the text');
    assert.equal(JSON.stringify(evidence).includes('thinking'), false, 'no model output in the report');
  });

  await t.test('does not fire when the reason passes through', () => {
    const seen: unknown[] = [];
    const tracker = track([textBlock('好的')], { onEmptyTurn: (evidence) => seen.push(evidence) });
    assertPassthrough(tracker.resolve(STOP), STOP, 'real reply');
    assert.equal(seen.length, 0);
  });

  await t.test('a throwing hook does not change the outcome', () => {
    const tracker = track([textBlock('</thinking>')], {
      onEmptyTurn: () => {
        throw new Error('counter broke');
      },
    });
    assertEmptyTurn(tracker.resolve(STOP), 'throwing hook');
  });
});

test('isMarkupOnlyStop is the same decision without a stream', () => {
  assert.equal(isMarkupOnlyStop(STOP, { sawToolCall: false, text: '</thinking>' }), true);
  assert.equal(isMarkupOnlyStop(STOP, { sawToolCall: false }), true, 'absent text is empty');
  assert.equal(isMarkupOnlyStop(STOP, { sawToolCall: false, text: '好的' }), false);
  assert.equal(isMarkupOnlyStop(STOP, { sawToolCall: true, text: '' }), false);
  assert.equal(isMarkupOnlyStop(MAX_TOKENS, { sawToolCall: false, text: '' }), false);
});

test('concurrent attempts keep separate state', () => {
  const residue = track([delta('</｜｜DSML｜｜ calls>')]);
  const answer = track([delta('好的，收到。')]);
  const tool = track([toolStart]);

  assertEmptyTurn(residue.resolve(STOP), 'residue stream');
  assertPassthrough(answer.resolve(STOP), STOP, 'answer stream');
  assertPassthrough(tool.resolve(STOP), STOP, 'tool stream');
  assert.equal(residue.sawToolCall, false);
  assert.equal(tool.sawToolCall, true);
});

test('rewriting never mutates the reason it was given', () => {
  const original: FinishReason = { kind: 'stop' };
  const tracker = track([textBlock('</thinking>')]);
  assertEmptyTurn(tracker.resolve(original), 'rewrite');
  assert.deepEqual(original, { kind: 'stop' }, 'the caller keeps its object intact');
});
