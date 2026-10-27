// Gift-pool empty-turn guard: identify empty or incomplete action-oriented stops.
//
// A translating relay in front of the gift model can hand the model's native tool/thinking
// markup back as plain text and still finish with `stop`. The step then carries no tool call
// and no prose the user can use, yet `dsh-agent-loop` reads "no tool call" as "the turn is
// over". `consumeSse` has the sibling hole: its `!count` check only covers
// streams that opened zero blocks, and one residue block already makes `count === 1`.
//
// This module is the adapter-callable half of that guard, modelled on FYTXY/dsh-empty-turn-guard
// 0.4.0 (MIT) — see docs/empty-turn-evidence.md. It never edits model text, never injects a
// message and never replays work: the only action is rewriting an eligible `finish` reason into
// `{ kind: 'error', failure: { code: 'OPENDESIGN_EOT' } }`, which the scoped recovery handler
// returns to the host's request-error waterfall without replaying tools.
//
// The visible-text check includes a narrow heuristic for a prospective action statement,
// optionally after a concise progress update.
// It also detects empty text and known protocol residue. Reasoning alone does not rescue an empty
// answer. Real answers, tool steps and truncated (`max-tokens`) replies keep their finish semantics.
//
// A truly content-free stream is rejected whether or not the monitor is on; the adapter
// converts that parser failure to the scoped EOT code only when this monitor applies.
//
// Callers decide *where* it applies: pass `enabled: false` for paid routes so their failures keep
// their existing behaviour. Nothing here restarts, reconnects, or reroutes a provider.
import { type FinishReason, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { OPENDESIGN_EOT } from './eot-code.js';

/** Failure message a rewritten empty turn carries. */
export const EMPTY_TURN_MESSAGE = 'OpenDesign：模型未产生可用回答或有效工具调用';
export const INCOMPLETE_TURN_MESSAGE = 'OpenDesign：模型停在操作说明，未继续发起工具调用';

/**
 * Protocol residue a relay can leak into a text or reasoning channel: DeepSeek's private
 * `｜｜DSML｜｜` tool markers (U+FF5C fullwidth bars), reasoning tags, and the model-invented
 * `返璞归真` tag seen in the reference measurements.
 *
 * The second pattern covers the orphan form a streamed delta leaves behind when its leading `<`
 * never arrives (`｜｜DSML｜｜ calls>`). Only known protocol tokens are stripped: unknown markup is
 * content, so a reply that merely discusses a tag is never misread as empty.
 */
const RESIDUE_PATTERNS: readonly RegExp[] = [
  /<\s*rea:tool_calls\s*>[\s\S]*?(?:<\s*\/\s*rea:tool_calls\s*>|$)/giu,
  /<\s*rea:tool(?:\s+[^>]*)?>[\s\S]*?(?:<\s*\/\s*rea:tool\s*>|$)/giu,
  /<\s*rea:parameter(?:\s+[^>]*)?>[\s\S]*?(?:<\s*\/\s*rea:parameter\s*>|$)/giu,
  /<\s*｜｜DSML｜｜\s*calls(?:\s+[^>]*)?>[\s\S]*?(?:<\s*\/\s*｜｜DSML｜｜\s*calls\s*>|$)/gu,
  /<\s*\/?\s*｜｜DSML｜｜[^>]*>/gu,
  /｜｜DSML｜｜\s*(?:calls|invoke|parameter)(?:\s+[^>\n]*)?>/giu,
  /｜｜DSML｜｜(?:\s*(?:calls|invoke|parameter))?\s*$/giu,
  /<\s*\/?\s*thinking\s*>/giu,
  /<\s*\/?\s*rea:tool_calls\s*>/giu,
  /<\s*\/?\s*返璞归真\s*>/gu,
];

/** Punctuation a truncated tag decomposes into; on its own it still counts as nothing. */
const ONLY_MARKUP_PUNCTUATION = /^[\s<>/\\|｜=_-]*$/u;

/**
 * Remove protocol residue from one assembled channel.
 * @param text - concatenated text or reasoning content.
 * @returns the remainder, trimmed; empty when nothing survives but residue punctuation.
 */
export function stripProtocolResidue(text: string): string {
  let rest = text;
  for (const pattern of RESIDUE_PATTERNS) rest = rest.replace(pattern, '');
  rest = rest.trim();
  return ONLY_MARKUP_PUNCTUATION.test(rest) ? '' : rest;
}

/**
 * Decide whether one channel carries nothing a user could use.
 * @param text - channel content, `undefined` when the channel never opened.
 * @returns true for absent, blank, or residue-only content.
 */
export function isResidueOnly(text: string | undefined): boolean {
  return text === undefined || stripProtocolResidue(text) === '';
}

// Only a prospective action statement or a concise status followed by one is eligible.
const ACTION_PREAMBLE_ZH = /^(?:(?:好的?|明白|收到)[，,。]\s*)?(?:让我|我需要|我(?:先|再|将|会|来|要|这就|马上)|先|现在|接下来(?:我)?(?:将|会)?)(?:先|再|去|来|马上)?(?:看一看|看看|看下|查看|检查|核对|核验|核查|对照|比对|确认|验证|验收|测试|读取|读|打开|搜索|查找|定位|分析|排查|审查|检索|查询|运行|执行|修改|修复|调整|更新|编写|梳理|对比|比较)(?!了|过|到|出|完)[^，,。！？!?\n；;：:]{1,100}[。！!…]?$/u;
const ACTION_PREAMBLE_EN = /^(?:(?:okay|sure|now)[,.]?\s+)?(?:let me|i(?:'ll| will)|i(?:'m| am) going to)\s+(?:check|inspect|review|verify|read|open|search|find|locate|analy[sz]e|test|run|execute|edit|fix|update|compare)\s+[^.!?,;:\n]{1,100}(?:\.{1,3}|!|…)?$/iu;
const FOLLOWUP_ACTION_ZH = /^(?:现在|接下来|下一步|随后|接着)(?:我)?(?:先|再|将|会|准备|重新)?(?:看一看|看看|看下|查看|检查|核对|核验|核查|对照|比对|确认|验证|验收|测试|读取|读|打开|搜索|查找|定位|分析|排查|审查|检索|查询|运行|执行|修改|修复|调整|更新|编写|梳理|对比|比较)(?!了|过|到|出|完|结果)[^。！？!?\n；;：:]{1,100}[。！!…]?$/u;
const COMPLETED_ACTION_ZH = /(?:发现|结果(?:是|为|显示)|显示|得出|证明|确认了|已经完成|已完成|通过|没有问题|无误|正常)/u;

/** Recognize a short action promise, optionally after a concise progress update. */
export function isPendingActionTurn(text: string | undefined): boolean {
  if (text === undefined) return false;
  const content = stripProtocolResidue(text);
  if (ACTION_PREAMBLE_ZH.test(content) || ACTION_PREAMBLE_EN.test(content)) return true;
  if (content.length > 200 || /[\n`]/u.test(content)) return false;
  const sentences = content.split(/(?<=[。！？])\s*/u).filter(Boolean);
  if (sentences.length < 2 || sentences.length > 3) return false;
  const last = sentences.at(-1) ?? '';
  return FOLLOWUP_ACTION_ZH.test(last) && !COMPLETED_ACTION_ZH.test(last);
}

/** Stream facts one attempt produced, as the adapter accumulated them. */
export interface EmptyTurnInput {
  /** Whether any tool-call block was opened or streamed during this attempt. */
  readonly sawToolCall: boolean;
  /** Visible text content, `undefined` when the channel never opened. */
  readonly text?: string | undefined;
}

/** Evidence that is safe to log or count: flags and lengths, never model output. */
export interface EmptyTurnEvidence {
  readonly sawToolCall: boolean;
  /** Visible text length after nothing is stripped — the raw channel length. */
  readonly textLength: number;
  /** Reasoning length, for cost analysis only; it never rescues an empty visible answer. */
  readonly reasoningLength: number;
  /** True when the visible text channel is empty once protocol residue is removed. */
  readonly markupOnly: boolean;
  /** True for a narrowly recognized pending-action statement. */
  readonly pendingAction: boolean;
}

/**
 * Whether this finish is the empty turn the guard exists for.
 *
 * Deliberately reads the visible text channel only, matching the reference plugin: a reply whose
 * reasoning carried real thought but whose answer is empty still leaves the user with nothing, so
 * it is retried. `max-tokens` is excluded because a truncated answer is a real answer and already
 * surfaces as its own outcome.
 * @param reason - the finish reason reported by the adapter.
 * @param input - the attempt's accumulated stream facts.
 * @returns true only when the finish is `stop`, no tool call happened, and visible text is residue.
 */
export function isMarkupOnlyStop(reason: FinishReason, input: EmptyTurnInput): boolean {
  return reason.kind === 'stop'
    && !input.sawToolCall
    && isResidueOnly(input.text);
}

/** Options shared by {@link EmptyTurnTracker}. */
export interface EmptyTurnOptions {
  /**
   * Monitor switch, read per request by the caller. `false` makes every
   * {@link EmptyTurnTracker.resolve} a no-op, which is how a paid route keeps its untouched
   * behaviour. It never suppresses the protocol reader's own `count === 0` → `EMPTY_RESPONSE`
   * path, which stays in force either way.
   */
  readonly enabled?: boolean;
  /**
   * Optional telemetry hook, invoked once per rewrite with log-safe evidence.
   *
   * The callback receives counts only, so a counter can be incremented without model output
   * reaching a log file. Callers own the metric; nothing is retried or recorded here, and an
   * exception from the callback is swallowed so monitoring can never break a stream.
   */
  readonly onEmptyTurn?: ((evidence: EmptyTurnEvidence) => void) | undefined;
}

/**
 * Per-attempt accumulator for the empty-turn decision.
 *
 * One instance belongs to one stream: creating it per request keeps concurrent attempts from
 * sharing state, and it holds no timers, subscriptions, or references to hosts.
 */
export class EmptyTurnTracker {
  readonly #enabled: boolean;
  readonly #onEmptyTurn: ((evidence: EmptyTurnEvidence) => void) | undefined;
  #sawToolCall = false;
  /** Text seen as raw deltas (delta-only protocols). */
  #deltaText = '';
  /** Text seen in closed blocks (authoritative when present). */
  #blockText = '';
  /** Reasoning seen as raw deltas. */
  #deltaReasoning = '';
  /** Reasoning seen in closed blocks. */
  #blockReasoning = '';

  /** @param options - the monitor switch and optional telemetry hook; omitted switch means on. */
  constructor(options: EmptyTurnOptions = {}) {
    this.#enabled = options.enabled !== false;
    this.#onEmptyTurn = options.onEmptyTurn;
  }

  /** Whether this tracker may rewrite a finish at all. */
  get enabled(): boolean {
    return this.#enabled;
  }

  /** Whether any tool call reached the stream, which always protects the attempt. */
  get sawToolCall(): boolean {
    return this.#sawToolCall;
  }

  /**
   * Fold one stream chunk into the attempt.
   * @param chunk - any chunk the adapter yields; unknown kinds are ignored.
   */
  observe(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'tool-call-delta':
        this.#sawToolCall = true;
        return;
      case 'block-start':
        if (chunk.blockType === 'tool-call') this.#sawToolCall = true;
        return;
      case 'text-delta':
        if (typeof chunk.text === 'string') this.#deltaText += chunk.text;
        return;
      case 'reasoning-delta':
        if (typeof chunk.text === 'string') this.#deltaReasoning += chunk.text;
        return;
      case 'block-end': {
        const block = chunk.block;
        if (block.type === 'tool-call') this.#sawToolCall = true;
        else if (block.type === 'text' && typeof block.text === 'string') this.#blockText += block.text;
        else if (block.type === 'reasoning' && typeof block.text === 'string') this.#blockReasoning += block.text;
        return;
      }
      default:
        return;
    }
  }

  /**
   * What the attempt has produced so far, as log-safe counts.
   * @returns flags and channel lengths, never the text itself.
   */
  inspect(): EmptyTurnEvidence {
    const text = this.#text();
    const reasoning = this.#reasoning();
    return {
      sawToolCall: this.#sawToolCall,
      textLength: text.length,
      reasoningLength: reasoning.length,
      markupOnly: isResidueOnly(text),
      pendingAction: isPendingActionTurn(text),
    };
  }

  /**
  * Rewrite an eligible finish into the scoped EOT failure.
   *
   * The reason object is returned unchanged (same reference) whenever the monitor is off, the
   * finish is not `stop`, a tool call was observed, or the visible text is a substantive answer.
   * This method only decides and rewrites; scoped recovery runs at the host's request-error boundary.
   * @param reason - the finish reason the adapter is about to yield.
   * @returns a retryable `error` reason, or the given reason untouched.
   */
  resolve(reason: FinishReason): FinishReason {
    const text = this.#text();
    const markupOnly = isMarkupOnlyStop(reason, { sawToolCall: this.#sawToolCall, text });
    const pendingAction = reason.kind === 'stop' && !this.#sawToolCall && isPendingActionTurn(text);
    if (!this.#enabled || (!markupOnly && !pendingAction)) {
      return reason;
    }
    this.#notify();
    return { kind: 'error', failure: { code: OPENDESIGN_EOT, message: pendingAction ? INCOMPLETE_TURN_MESSAGE : EMPTY_TURN_MESSAGE } };
  }

  /** Report one rewrite to the telemetry hook; monitoring must never break the stream. */
  #notify(): void {
    try {
      this.#onEmptyTurn?.(this.inspect());
    } catch {
      // A counter or logger failure is not a model failure.
    }
  }

  /** Closed-block text wins over deltas, so a protocol that sends both is not double-counted. */
  #text(): string {
    return this.#blockText.length > 0 ? this.#blockText : this.#deltaText;
  }

  /** Same precedence rule for the reasoning channel. */
  #reasoning(): string {
    return this.#blockReasoning.length > 0 ? this.#blockReasoning : this.#deltaReasoning;
  }
}
