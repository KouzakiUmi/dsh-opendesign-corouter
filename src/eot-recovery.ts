import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';
import { PLAN_PROVIDER } from './config.js';
import { OPENDESIGN_EOT } from './eot-code.js';

const POLICY_KEY = 'opendesign-eot-unbounded-v1';
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

type RecoveryAction = { kind: 'retry' } | undefined;
interface RetrySession {
  append(type: 'llm/retry' | 'llm/retry-started', data: Record<string, unknown>): unknown;
}
export interface RecoveryPayload {
  agent: { session: RetrySession };
  turn: number;
  step: number;
  provider: string;
  failure: LlmFailure;
  signal: AbortSignal;
}
type RecoveryNext = () => Promise<RecoveryAction>;
type RecoveryListener = (payload: RecoveryPayload, next: RecoveryNext) => Promise<RecoveryAction>;
/** Narrow structural contract of the host's documented agent/request-error event. */
interface RecoveryEvents {
  on(name: 'agent/request-error', listener: RecoveryListener, options?: { prepend?: boolean }): () => boolean;
}
interface RetryState { turn: number; step: number; retryId: string; retry: number }

function cancellableDelay(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, delay);
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Own only the plugin-specific EOT failure; other errors continue down the host waterfall. */
export class EotRecovery {
  readonly #lifetime = new AbortController();
  readonly #states = new WeakMap<object, RetryState>();
  readonly #active = new Set<Promise<RecoveryAction>>();
  constructor(readonly enabled: () => boolean, readonly wait = cancellableDelay, readonly onRetry?: () => void) {}

  readonly handle: RecoveryListener = (payload, next) => {
    if (payload.provider !== PLAN_PROVIDER || payload.failure.code !== OPENDESIGN_EOT || !this.enabled()) return next();
    if (payload.signal.aborted || this.#lifetime.signal.aborted) return Promise.resolve(undefined);
    const operation = this.#recover(payload);
    const tracked = operation.finally(() => this.#active.delete(tracked));
    this.#active.add(tracked);
    return tracked;
  };

  async #recover({ agent, turn, step, provider, failure, signal }: RecoveryPayload): Promise<RecoveryAction> {
    const fused = AbortSignal.any([signal, this.#lifetime.signal]);
    if (fused.aborted) return;
    const previous = this.#states.get(agent);
    const state = previous?.turn === turn && previous.step === step
      ? { ...previous, retry: previous.retry + 1 }
      : { turn, step, retryId: randomUUID(), retry: 1 };
    this.#states.set(agent, state);
    const delayMs = Math.min(INITIAL_DELAY_MS * 2 ** Math.min(state.retry - 1, 8), MAX_DELAY_MS);
    // The host understands the same durable events emitted by dsh-llm-retry.
    agent.session.append('llm/retry', { retryId: state.retryId, turn, step, provider, mode: 'always', policyKey: POLICY_KEY, retry: state.retry, delayMs, failure });
    if (!await this.wait(delayMs, fused) || fused.aborted || !this.enabled()) return;
    agent.session.append('llm/retry-started', { retryId: state.retryId, turn, step, retry: state.retry });
    try { this.onRetry?.(); } catch { /* Telemetry cannot change an admitted retry. */ }
    return { kind: 'retry' };
  }

  async dispose(): Promise<void> {
    this.#lifetime.abort(new Error('EOT recovery disposed'));
    await Promise.allSettled([...this.#active]);
  }
}

/** Register against the host's documented scoped recovery waterfall. */
export function installEotRecovery(ctx: Context, enabled: () => boolean, onRetry?: () => void): void {
  const recovery = new EotRecovery(enabled, cancellableDelay, onRetry);
  // dsh-agent is an optional host service, not an installation requirement for provider-only use.
  const events = ctx as unknown as RecoveryEvents;
  const remove = events.on('agent/request-error', recovery.handle, { prepend: true });
  ctx.effect(() => async () => { remove(); await recovery.dispose(); });
}
