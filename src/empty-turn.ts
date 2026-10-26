// Gift-pool empty-turn guard: turn a "markup-only stop" into a retryable EMPTY_RESPONSE.
//
// A translating relay in front of the gift model can hand the model's native tool/thinking
// markup back as plain text and still finish with `stop`. The step then carries no tool call
// and no prose the user can use, yet `dsh-agent-loop` reads "no tool call" as "the turn is
// over". `consumeSse` has the sibling hole: its `!count` check (src/stream.ts:160) only covers
// streams that opened zero blocks, and one residue block already makes `count === 1`.
//
// This module is the adapter-callable half of that guard, modelled on FYTXY/dsh-empty-turn-guard
// 0.4.0 (MIT) — see docs/empty-turn-evidence.md. It never edits model text, never injects a
// message and never replays work: the only action is rewriting an eligible `finish` reason into
// `{ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } }`, which the provider's existing retry
// policy already treats as safe to repeat.
//
// The decision is the reference plugin's original semantics: visible text only.
// Three conditions must hold together — the finish is `stop`, no tool call was observed, and the
// visible text channel is empty once protocol residue is removed. Whether the reasoning channel
// carried a real train of thought does not rescue the turn: a model that thinks and then answers
// with nothing is exactly the empty turn this guard exists for, so it is retried too. A real
// answer, a partial answer, a tool step, or a truncated (`max-tokens`) reply still passes through
// untouched, because the first two either leave visible content or open a tool call.
//
// The switch is a *monitor* switch: `enabled: false` only turns this rewrite off. The adapter's
// own `count === 0` → `EMPTY_RESPONSE` path is Core behaviour and must stay outside it, so a truly
// content-free stream is rejected whether or not the monitor is on.
//
// Callers decide *where* it applies: pass `enabled: false` for paid routes so their failures keep
// their existing behaviour. Nothing here restarts, reconnects, or reroutes a provider.
import { EMPTY_RESPONSE_CODE, type FinishReason, type StreamChunk } from '@deepseek-ai/dsh-llm';

/** Failure message a rewritten empty turn carries. */
export const EMPTY_TURN_MESSAGE = 'OpenDesign：模型回复只剩协议标记，未产生可用内容';

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
  /<\s*\/?\s*｜｜DSML｜｜[^>]*>/gu,
  /｜｜DSML｜｜[^\n<>]*>?/gu,
  /<\s*\/?\s*thinking\s*>/giu,
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
   * behaviour. It never suppresses the adapter's own `count === 0` → `EMPTY_RESPONSE` path:
   * that is Core behaviour and stays in force either way.
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
    };
  }

  /**
   * Rewrite an eligible finish into the provider-neutral empty-response failure.
   *
   * The reason object is returned unchanged (same reference) whenever the monitor is off, the
   * finish is not `stop`, a tool call was observed, or the visible text carries usable content.
   * This method only decides and rewrites: the retry itself belongs to the host's provider policy.
   * @param reason - the finish reason the adapter is about to yield.
   * @returns a retryable `error` reason, or the given reason untouched.
   */
  resolve(reason: FinishReason): FinishReason {
    if (!this.#enabled || !isMarkupOnlyStop(reason, { sawToolCall: this.#sawToolCall, text: this.#text() })) {
      return reason;
    }
    this.#notify();
    return { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE, message: EMPTY_TURN_MESSAGE } };
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
