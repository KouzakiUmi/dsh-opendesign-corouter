import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, LlmError, type ContentBlock, type MessageId, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm';
import { PLAN_PROVIDER, type RuntimeConfig } from './config.js';
import { record } from './util.js';
import type { ReviewDecision, ReviewReason, TurnMonitorStatus } from './turn-monitor-status.js';

export const FINISH_TURN_TOOL = 'opendesign_finish_turn';
const MAX_EVIDENCE = 64;
const MAX_SUMMARY = 1200;
const MAX_NEXT_ACTION = 800;

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'opendesign-review': { kind: 'opendesign-review'; turn: number; checkpoint: number };
  }
}

/** Optional Core services are consumed structurally so provider-only compositions need no Agent dependencies. */
export interface MonitorSession {
  readonly id: string;
  requestHeader(): { config: { provider: string; model: string }; tools?: readonly ToolSchema[] } | undefined;
}
export interface MonitorAgent {
  readonly id: string;
  readonly session: MonitorSession;
  readonly ctx: Context;
  readonly status: string;
  readonly inbox: { readonly nextStep: readonly UserMessage[]; readonly nextTurn: readonly UserMessage[]; remove(id: MessageId): boolean };
  steer(message: UserMessage): void;
}
export interface MonitorToolExecution {
  readonly name: string;
  readonly callId: string;
  readonly rootCallId?: string;
  readonly agent?: MonitorAgent;
  readonly signal: AbortSignal;
  concludeTurn(): void;
}
export interface MonitorToolDefinition extends ToolSchema {
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): ContentBlock[] };
  execute(args: unknown, exec: MonitorToolExecution): Promise<unknown>;
}
interface ToolService { register(definition: MonitorToolDefinition): () => void }
interface AgentRegistry { list(): readonly MonitorAgent[]; isOwnedBy(id: string, owner: MonitorAgent): boolean }
interface HostServices {
  get(name: 'tools'): ToolService | undefined;
  get(name: 'agents'): AgentRegistry | undefined;
  get(name: 'goals'): { get(agent: MonitorAgent): { phase: string; activation: string } | undefined } | undefined;
  get(name: 'jobs'): { list(owner: string): readonly { id: string; owner?: string; status: string }[] } | undefined;
}
interface LogEvent { seq: number; type: string; data: unknown }
interface StreamFrame { type: string; turn?: number; chunk?: { type: string; reason?: { kind: string } } }
interface MonitorEvents {
  on(name: 'session/event', callback: (session: MonitorSession, event: LogEvent) => void): () => boolean;
  on(name: 'agent/assistant-stream', callback: (payload: { agent: MonitorAgent; frame: StreamFrame }) => void): () => boolean;
  on(name: 'agent/turn-stopping', callback: (payload: { agent: MonitorAgent; turn: number; signal: AbortSignal }) => void): () => boolean;
  on(name: 'tools/result', callback: (exec: MonitorToolExecution, result: { isError: boolean; value?: unknown; concludesTurn?: true }) => void): () => boolean;
  on(name: 'agent/disposed', callback: (payload: { agent: MonitorAgent }) => void): () => boolean;
}
type OutcomeStatus = 'completed' | 'waiting_user' | 'waiting_work' | 'blocked' | 'continue';
interface Outcome { status: OutcomeStatus; summary: string; evidence: number[]; nextAction?: string }
interface Evidence { seq: number; name: string; success: boolean; fingerprint: string }
interface TurnState {
  turn: number;
  assistantSeq: number;
  checkedSeq: number;
  finish: string | undefined;
  interrupted: boolean;
  truncated: boolean;
  assistantMonitored: boolean;
  agent: MonitorAgent | undefined;
  removeTool: (() => void) | undefined;
  steering: MessageId | undefined;
  continuations: number;
  stagnant: number;
  progress: number;
  reviewedProgress: number;
  settled: boolean;
  outcome: Outcome | undefined;
  nativeConcluded: boolean;
  calls: Map<string, { name: string; arguments: string }>;
  evidence: Map<number, Evidence>;
  fingerprints: Set<string>;
  pending: Map<string, Outcome>;
  nativeEndings: Set<string>;
}
const OUTCOMES: readonly OutcomeStatus[] = ['completed', 'waiting_user', 'waiting_work', 'blocked', 'continue'];
const outcomeSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'summary', 'evidence'],
  properties: {
    status: { type: 'string', enum: OUTCOMES },
    summary: { type: 'string', description: '非空收尾说明，最多1200字符。' },
    evidence: { type: 'array', items: { type: 'integer' }, description: '最多16个非负工具结果序号。' },
    nextAction: { type: 'string', description: '继续执行时必填，最多800字符。' },
  },
};

function parseOutcome(value: unknown): Outcome {
  if (!record(value) || Object.keys(value).some(key => !['status', 'summary', 'evidence', 'nextAction'].includes(key))
    || !OUTCOMES.includes(value.status as OutcomeStatus)
    || typeof value.summary !== 'string' || value.summary.trim().length === 0 || value.summary.length > MAX_SUMMARY
    || !Array.isArray(value.evidence) || value.evidence.length > 16
    || value.evidence.some(item => !Number.isSafeInteger(item) || item < 0)
    || (value.nextAction !== undefined && (typeof value.nextAction !== 'string' || value.nextAction.trim().length === 0 || value.nextAction.length > MAX_NEXT_ACTION))) {
    throw new LlmError('收尾状态或证据引用无效', 'INVALID_REQUEST');
  }
  if (value.status === 'continue' && value.nextAction === undefined) throw new LlmError('继续执行时需要说明尚未完成的动作', 'INVALID_REQUEST');
  return { status: value.status as OutcomeStatus, summary: value.summary, evidence: [...new Set(value.evidence as number[])],
    ...(typeof value.nextAction === 'string' ? { nextAction: value.nextAction } : {}) };
}

function fresh(turn: number): TurnState {
  return { turn, assistantSeq: -1, checkedSeq: -1, finish: undefined, interrupted: false, truncated: false, assistantMonitored: false, agent: undefined,
    removeTool: undefined, steering: undefined, continuations: 0, stagnant: 0, progress: 0, reviewedProgress: 0,
    settled: false, outcome: undefined, nativeConcluded: false, calls: new Map(), evidence: new Map(), fingerprints: new Set(), pending: new Map(), nativeEndings: new Set() };
}
function services(ctx: Context): HostServices { return ctx as unknown as HostServices; }
function monitored(session: MonitorSession): boolean {
  const header = session.requestHeader();
  return header?.config.provider === PLAN_PROVIDER && header.config.model === 'deepseek-v4.1-flash' && Boolean(header.tools?.length);
}

/** Per-turn completion handshake. It never executes, retries, or replays a business tool. */
export class TurnMonitor {
  readonly #states = new WeakMap<MonitorSession, TurnState>();
  readonly #active = new Set<TurnState>();
  #disposed = false;
  #checks = 0;
  #continuations = 0;
  #requestRetries = 0;
  #last: TurnMonitorStatus['last'];
  constructor(readonly ctx: Context, readonly config: () => RuntimeConfig, readonly now: () => number = Date.now) {}

  status(): TurnMonitorStatus {
    return { available: !this.#disposed && services(this.ctx).get('tools') !== undefined, checks: this.#checks,
      continuations: this.#continuations, requestRetries: this.#requestRetries,
      ...(this.#last ? { last: { ...this.#last } } : {}) };
  }
  requestRetried(): void { if (!this.#disposed) this.#requestRetries++; }
  #report(decision: ReviewDecision, reason: ReviewReason): void {
    this.#last = { at: new Date(this.now()).toISOString(), decision, reason };
  }
  /** The completion handshake is opt-in; the empty-turn guard stays the outer switch. */
  #reviewing(): boolean {
    const config = this.config();
    return config.emptyTurnGuard === true && config.turnCompletionReview === true;
  }
  #release(state: TurnState): void {
    const remove = state.removeTool;
    state.removeTool = undefined;
    try { remove?.(); }
    catch { this.#report('unverified', 'service-unavailable'); }
    if (state.steering && state.agent) {
      try { state.agent.inbox.remove(state.steering); }
      catch { this.#report('unverified', 'service-unavailable'); }
    }
    state.steering = undefined;
    state.pending.clear();
    this.#active.delete(state);
  }
  configurationChanged(): void {
    if (this.#reviewing()) return;
    for (const state of [...this.#active]) { state.settled = true; this.#release(state); }
    this.#report('skipped', 'disabled');
  }
  dispose(): void {
    this.#disposed = true;
    for (const state of [...this.#active]) this.#release(state);
  }

  readonly observe = (session: MonitorSession, event: LogEvent): void => {
    if (this.#disposed || !record(event.data)) return;
    const data = event.data;
    if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) {
      const previous = this.#states.get(session);
      if (previous) this.#release(previous);
      this.#states.set(session, fresh(data.turn as number));
      return;
    }
    const state = this.#states.get(session);
    if (!state) return;
    // Core commits a UserMessage directly, without the turn/message wrapper used by assistant events.
    if (event.type === 'user/message' && record(data.source)) {
      const source = data.source;
      if (source.kind === 'opendesign-review' && data.id === state.steering
        && source.turn === state.turn && source.checkpoint === state.checkedSeq) state.steering = undefined;
      else if (source.kind === 'user' && state.continuations > 0) {
        state.settled = true; this.#release(state); this.#report('skipped', 'superseded');
      }
      return;
    }
    if (data.turn !== state.turn) return;
    if (event.type === 'turn/end') { this.#release(state); this.#states.delete(session); return; }
    if (!this.config().emptyTurnGuard || !monitored(session)) { this.#release(state); return; }
    if (event.type === 'assistant/message' && record(data.message)) {
      state.assistantSeq = event.seq;
      state.interrupted = data.interrupted === true;
      const source = data.message.source;
      state.assistantMonitored = record(source) && source.provider === PLAN_PROVIDER && source.model === 'deepseek-v4.1-flash';
      return;
    }
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      if (state.calls.size >= MAX_EVIDENCE) state.calls.delete(state.calls.keys().next().value ?? '');
      state.calls.set(data.callId, { name: data.name, arguments: createHash('sha256').update(typeof data.arguments === 'string' ? data.arguments : '').digest('hex') });
      return;
    }
    if (event.type !== 'tool/result' || !record(data.message) || typeof data.message.toolCallId !== 'string') return;
    const callId = data.message.toolCallId;
    const pending = state.pending.get(callId);
    state.pending.delete(callId);
    if (pending && data.message.isError !== true) state.outcome = pending;
    if (state.nativeEndings.delete(callId) && data.message.isError !== true) state.nativeConcluded = true;
    const call = state.calls.get(callId);
    state.calls.delete(callId);
    if (!call || call.name === FINISH_TURN_TOOL || pending) return;
    const fingerprint = createHash('sha256').update(JSON.stringify([call.name, call.arguments, data.message.content, data.message.isError === true])).digest('hex');
    const success = data.message.isError !== true;
    if (success && !state.fingerprints.has(fingerprint)) {
      state.progress++;
      if (state.fingerprints.size >= MAX_EVIDENCE) state.fingerprints.delete(state.fingerprints.values().next().value ?? '');
      state.fingerprints.add(fingerprint);
    }
    if (state.evidence.size >= MAX_EVIDENCE) state.evidence.delete(state.evidence.keys().next().value ?? -1);
    state.evidence.set(event.seq, { seq: event.seq, name: call.name, success, fingerprint });
  };

  readonly stream = ({ agent, frame }: { agent: MonitorAgent; frame: StreamFrame }): void => {
    const state = this.#states.get(agent.session);
    if (!state || !this.config().emptyTurnGuard || !monitored(agent.session)) return;
    if (frame.type === 'start') { state.finish = undefined; state.outcome = undefined; state.nativeConcluded = false; }
    if (frame.type === 'chunk' && frame.chunk?.type === 'finish') {
      state.finish = frame.chunk.reason?.kind;
      state.truncated ||= state.finish === 'max-tokens';
    }
  };

  #goalOwns(agent: MonitorAgent): boolean {
    const goal = services(agent.ctx).get('goals')?.get(agent);
    return goal !== undefined && goal.phase !== 'complete';
  }
  #workRunning(agent: MonitorAgent): boolean {
    const host = services(agent.ctx);
    if (host.get('jobs')?.list(agent.session.id).some(job => job.owner === agent.session.id && (job.status === 'running' || job.status === 'stopping'))) return true;
    const registry = host.get('agents');
    if (!registry) return false;
    const pending = [agent];
    const visited = new Set<string>([agent.id]);
    const agents = registry.list();
    while (pending.length) {
      const parent = pending.pop();
      if (!parent) break;
      for (const child of agents) {
        if (visited.has(child.id) || !registry.isOwnedBy(child.id, parent)) continue;
        visited.add(child.id);
        if (child.status === 'running') return true;
        pending.push(child);
      }
    }
    return false;
  }

  #tool(state: TurnState): MonitorToolDefinition {
    return {
      name: FINISH_TURN_TOOL,
      description: '报告当前任务的收尾状态：完成、等待用户、等待后台工作、阻塞或仍需执行。完成时引用收尾核验中列出的成功工具结果序号；这不是执行工作或验收命令的工具。',
      parameters: outcomeSchema,
      output: { schema: outcomeSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        if (this.#disposed || !this.#reviewing() || state.settled || exec.agent !== state.agent
          || !state.removeTool || !exec.agent || this.#states.get(exec.agent.session) !== state || !monitored(exec.agent.session)) {
          throw new LlmError('当前没有可提交的收尾核验', 'INVALID_REQUEST');
        }
        const outcome = parseOutcome(args);
        if (outcome.evidence.some(seq => state.evidence.get(seq)?.success !== true)) throw new LlmError('证据必须引用本轮已成功的工具结果序号', 'INVALID_REQUEST');
        if (outcome.status === 'completed' && state.evidence.size > 0 && outcome.evidence.length === 0) {
          throw new LlmError('本轮包含工具执行；完成声明需要引用对应的成功结果，无法核实时请报告阻塞', 'INVALID_REQUEST');
        }
        const running = this.#workRunning(exec.agent);
        if (outcome.status === 'completed' && running) throw new LlmError('仍有后台工作在运行，请报告等待后台工作', 'INVALID_REQUEST');
        if (outcome.status === 'waiting_work' && !running) throw new LlmError('未找到本会话仍在运行的后台工作，请重新核对状态', 'INVALID_REQUEST');
        exec.signal.throwIfAborted();
        exec.concludeTurn();
        return outcome;
      },
    };
  }

  readonly toolResult = (exec: MonitorToolExecution, result: { isError: boolean; value?: unknown; concludesTurn?: true }): void => {
    if (!exec.agent || result.isError || result.concludesTurn !== true || exec.signal.aborted) return;
    const state = this.#states.get(exec.agent.session);
    if (!state || state.settled) return;
    const root = exec.rootCallId ?? exec.callId;
    if (exec.name !== FINISH_TURN_TOOL) {
      if (!state.pending.has(root)) state.nativeEndings.add(root);
      return;
    }
    if (state.agent !== exec.agent || !state.removeTool) return;
    try {
      const outcome = parseOutcome(result.value);
      if (outcome.evidence.some(seq => state.evidence.get(seq)?.success !== true)
        || outcome.status === 'completed' && state.evidence.size > 0 && outcome.evidence.length === 0) {
        this.#report('unverified', 'invalid-evidence'); return;
      }
      state.pending.set(root, outcome);
    } catch { /* A downstream policy may replace the canonical value; an invalid replacement is not a declaration. */ }
  };

  readonly stopping = ({ agent, turn, signal }: { agent: MonitorAgent; turn: number; signal: AbortSignal }): void => {
    const state = this.#states.get(agent.session);
    if (!state || state.turn !== turn || state.settled || state.assistantSeq < 0 || state.checkedSeq === state.assistantSeq) return;
    if (this.#disposed || !this.#reviewing() || !monitored(agent.session) || !state.assistantMonitored) { this.#release(state); return; }
    state.agent = agent;
    state.checkedSeq = state.assistantSeq;
    if (signal.aborted || state.interrupted) { this.#release(state); this.#report('skipped', 'cancelled'); return; }
    if (state.truncated || state.finish !== 'stop' && state.finish !== 'tool-calls') {
      this.#release(state); this.#report('skipped', state.truncated ? 'truncated' : 'request-failed'); return;
    }
    if (state.nativeConcluded) { state.settled = true; this.#release(state); this.#report('skipped', 'tool-concluded'); return; }
    // Fresh input belongs to its producer, not to an older completion checkpoint.
    if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) { this.#release(state); this.#report('skipped', 'superseded'); return; }
    this.#checks++;
    try {
      if (this.#goalOwns(agent)) { state.settled = true; this.#release(state); this.#report('skipped', 'goal-owned'); return; }
      if (this.#workRunning(agent)) { state.settled = true; this.#release(state); this.#report('waiting-work', 'work-running'); return; }
    } catch {
      state.settled = true; this.#release(state); this.#report('unverified', 'service-unavailable'); return;
    }
    const outcome = state.outcome;
    if (outcome && outcome.status !== 'continue') {
      const decision: ReviewDecision = outcome.status === 'completed' ? 'completed' : outcome.status === 'waiting_user' ? 'waiting-user'
        : outcome.status === 'waiting_work' ? 'waiting-work' : 'blocked';
      const reason: ReviewReason = outcome.status === 'completed' ? 'reported-complete' : outcome.status === 'waiting_user' ? 'needs-user'
        : outcome.status === 'waiting_work' ? 'work-running' : 'reported-blocked';
      state.settled = true; this.#release(state); this.#report(decision, reason); return;
    }
    const config = this.config();
    if (state.continuations > 0) state.stagnant = state.progress === state.reviewedProgress ? state.stagnant + 1 : 0;
    const limit = state.continuations >= (config.turnReviewMaxContinuations ?? 3) ? 'continuation-limit'
      : state.stagnant >= (config.turnReviewNoProgressLimit ?? 2) ? 'no-progress' : undefined;
    if (limit) { state.settled = true; this.#release(state); this.#report('limited', limit); return; }
    const tools = services(agent.ctx).get('tools');
    if (!tools) { state.settled = true; this.#report('unverified', 'service-unavailable'); return; }
    if (!state.removeTool) {
      try { state.removeTool = tools.register(this.#tool(state)); this.#active.add(state); }
      catch { state.settled = true; this.#report('unverified', 'service-unavailable'); return; }
    }
    const evidence = [...state.evidence.values()].slice(-16).map(item => ({ seq: item.seq, tool: item.name, success: item.success }));
    const nextAction = outcome?.status === 'continue' ? outcome.nextAction : undefined;
    const message = createUserMessage({ source: { kind: 'opendesign-review', turn, checkpoint: state.assistantSeq }, content: [{ type: 'text', text:
      `核对当前任务的收尾状态。刚才的回复和已执行工具均保留在历史中，不要重复已经成功的动作。${nextAction ? `尚未完成的动作：${JSON.stringify(nextAction)}。` : ''}\n`
      + `若仍有已确定的工作，请继续实际执行；若已经完成、需要用户决定、等待后台工作或遇到阻塞，请调用 ${FINISH_TURN_TOOL} 报告对应状态。完成时引用相关成功结果，不把计划或待检查事项当成已执行。普通文字回答可直接报告完成；需要用户补充时报告 waiting_user。\n`
      + `本轮最近的工具结果引用：${JSON.stringify(evidence)}。工具结果正文已在历史中，引用只说明结果确实存在，不替代对任务要求的核对。` }] });
    state.steering = message.id;
    try { agent.steer(message); }
    catch { state.settled = true; this.#release(state); this.#report('unverified', 'service-unavailable'); return; }
    state.continuations++;
    state.reviewedProgress = state.progress;
    this.#continuations++;
    this.#report('continued', nextAction ? 'pending-action' : 'missing-outcome');
  };

  readonly disposedAgent = ({ agent }: { agent: MonitorAgent }): void => {
    const state = this.#states.get(agent.session);
    if (state) this.#release(state);
    this.#states.delete(agent.session);
  };
}

export function installTurnMonitor(ctx: Context, config: () => RuntimeConfig): TurnMonitor {
  const monitor = new TurnMonitor(ctx, config);
  const events = ctx as unknown as MonitorEvents;
  events.on('session/event', monitor.observe);
  events.on('agent/assistant-stream', monitor.stream);
  events.on('agent/turn-stopping', monitor.stopping);
  events.on('tools/result', monitor.toolResult);
  events.on('agent/disposed', monitor.disposedAgent);
  ctx.on('loader/volatile-update', () => monitor.configurationChanged());
  ctx.effect(() => () => monitor.dispose());
  return monitor;
}
