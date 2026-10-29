import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import { PAID_PROVIDER, PLAN_PROVIDER, type RuntimeConfig } from '../src/config.js';
import { FINISH_TURN_TOOL, TurnMonitor, installTurnMonitor, type MonitorAgent, type MonitorToolDefinition, type MonitorToolExecution } from '../src/turn-monitor.js';

const base: RuntimeConfig = { apiKeyEnv: 'FIXTURE', baseURL: 'https://fixture.invalid/v1', useDesktopCredential: false,
  emptyTurnGuard: true, turnCompletionReview: true, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 };
// Core rc.3 rejects constraint keywords outside this subset, including maxLength/minimum/maxItems.
// This mirrors the inspected published validator's admission vocabulary, not a full JSON Schema validator.
function assertCoreSchemaSubset(schema: Record<string, unknown>): void {
  const keywords = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
  for (const key of Object.keys(schema)) assert.ok(keywords.has(key), `Core rc.3 does not support ${key}`);
  if (schema.properties && typeof schema.properties === 'object') {
    for (const value of Object.values(schema.properties)) assertCoreSchemaSubset(value as Record<string, unknown>);
  }
  if (schema.items && typeof schema.items === 'object') assertCoreSchemaSubset(schema.items as Record<string, unknown>);
}
function fixture(overrides: Partial<RuntimeConfig> = {}) {
  let config = { ...base, ...overrides };
  let header = { config: { provider: PLAN_PROVIDER, model: 'deepseek-v4.1-flash' }, tools: [{ name: 'read', description: 'fixture', parameters: {} }] };
  const definitions = new Map<string, MonitorToolDefinition>();
  const messages: UserMessage[] = [];
  const events: { seq: number; type: string; data: Record<string, unknown> }[] = [];
  let goal: { phase: string; activation: string } | undefined;
  let jobs: { id: string; owner: string; status: string }[] = [];
  const children: MonitorAgent[] = [];
  let readFailure = false;
  const host = new Context();
  const ctx = new Proxy(host, { get(target, key, receiver) {
    if (key === 'get') return (name: string) => {
      if (name === 'tools') return { register: (definition: MonitorToolDefinition) => {
        assertCoreSchemaSubset(definition.parameters); assertCoreSchemaSubset(definition.output.schema);
        assert.equal(definitions.has(definition.name), false, 'a checkpoint registers only once');
        definitions.set(definition.name, definition);
        return () => { definitions.delete(definition.name); };
      } };
      if (name === 'goals') return { get: () => { if (readFailure) throw new Error('untrusted service failure'); return goal; } };
      if (name === 'jobs') return { list: () => jobs };
      if (name === 'agents') return { list: () => children, isOwnedBy: (_id: string, owner: MonitorAgent) => owner === agent };
      return Reflect.get(target, 'get', receiver).call(receiver, name);
    };
    return Reflect.get(target, key, receiver);
  } });
  const session = { id: 'fixture-session', requestHeader: () => header };
  const agent: MonitorAgent = { id: session.id, session, ctx, status: 'running',
    inbox: { nextStep: messages, nextTurn: [], remove(id: MessageId) {
      const index = messages.findIndex(message => message.id === id);
      if (index < 0) return false;
      messages.splice(index, 1); return true;
    } }, steer(message) { messages.push(message); } };
  const monitor = new TurnMonitor(ctx, () => config, () => Date.parse('2026-10-29T10:00:00Z'));
  const controller = new AbortController();
  const emit = (type: string, data: Record<string, unknown>) => {
    const event = { seq: events.length, type, data };
    events.push(event); monitor.observe(session, event); return event.seq;
  };
  emit('turn/start', { turn: 1 });
  const response = (text = '端到端验证已通过。提交前再确认一遍：没有二进制文件被误纳入提交，也没有真实凭据。', finish = 'stop') => {
    monitor.stream({ agent, frame: { type: 'start', turn: 1 } });
    monitor.stream({ agent, frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: finish } } } });
    emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text }], source: header.config } });
  };
  const stopping = () => monitor.stopping({ agent, turn: 1, signal: controller.signal });
  const consume = () => {
    const message = messages.shift(); assert.ok(message);
    emit('user/message', { ...message }); return message;
  };
  const business = (name = 'read', result = 'fixture result', success = true) => {
    const callId = `call-${events.length}`;
    emit('tool/call', { turn: 1, step: 1, callId, name, arguments: '{"path":"fixture.txt"}' });
    return emit('tool/result', { turn: 1, step: 1, message: { toolCallId: callId, isError: !success, content: [{ type: 'text', text: result }] } });
  };
  const declare = async (args: unknown, options: { root?: string; failedRoot?: boolean; blocked?: boolean } = {}) => {
    const definition = definitions.get(FINISH_TURN_TOOL); assert.ok(definition);
    response('收尾状态', 'tool-calls');
    const callId = `finish-${events.length}`;
    const rootCallId = options.root ?? callId;
    emit('tool/call', { turn: 1, step: 2, callId: rootCallId, name: options.root ? 'run_code' : FINISH_TURN_TOOL, arguments: JSON.stringify(args) });
    let concluded = false;
    const exec: MonitorToolExecution = { name: FINISH_TURN_TOOL, callId, rootCallId, agent, signal: controller.signal, concludeTurn() { concluded = true; } };
    const value = await definition.execute(args, exec);
    assert.equal(concluded, true);
    monitor.toolResult(exec, options.blocked ? { isError: true } : { isError: false, value, concludesTurn: true });
    emit('tool/result', { turn: 1, step: 2, message: { toolCallId: rootCallId, isError: options.failedRoot === true || options.blocked === true, content: definition.output.render(args, value) } });
    return { definition, exec, value };
  };
  return { host, ctx, agent, session, monitor, definitions, messages, events, controller, emit, response, stopping, consume, business, declare,
    setConfig(value: Partial<RuntimeConfig>) { config = { ...config, ...value }; },
    setHeader(value: typeof header) { header = value; }, setGoal(value: typeof goal) { goal = value; }, setJobs(value: typeof jobs) { jobs = value; }, children,
    failReads() { readFailure = true; } };
}

test('a narrated pending check reaches a logged checkpoint and continues with specific work, without replay', async () => {
  const f = fixture();
  const firstEvidence = f.business('test', 'tests passed');
  f.response(); f.stopping();
  assert.equal(f.definitions.has(FINISH_TURN_TOOL), true);
  assert.equal(f.messages.length, 1);
  assert.match(JSON.stringify(f.consume().content), /tests|test/u);
  await f.declare({ status: 'continue', summary: '还需检查提交范围', evidence: [firstEvidence], nextAction: '检查当前差异中的文件类型和敏感字段' });
  f.stopping();
  assert.match(JSON.stringify(f.consume().content), /检查当前差异中的文件类型和敏感字段/u);
  const finalEvidence = f.business('inspect', 'inspection passed');
  await f.declare({ status: 'completed', summary: '验证和检查均已完成', evidence: [firstEvidence, finalEvidence] });
  f.stopping();
  assert.equal(f.monitor.status().last?.decision, 'completed');
  assert.equal(f.messages.length, 0);
  assert.equal(f.definitions.size, 0);
  assert.equal(f.events.filter(event => event.type === 'tool/call' && event.data.name === 'test').length, 1);
  assert.equal(f.monitor.status().continuations, 2);
  f.monitor.dispose();
});

test('ordinary answers and questions can finish explicitly without executing another business tool', async () => {
  for (const status of ['completed', 'waiting_user', 'blocked'] as const) {
    const f = fixture(); f.response('这是可直接使用的回答。'); f.stopping(); f.consume();
    await f.declare({ status, summary: status === 'waiting_user' ? '请选择要处理的分支' : '本轮结论', evidence: [] });
    f.stopping();
    assert.equal(f.messages.length, 0);
    assert.equal(f.monitor.status().last?.decision, status === 'waiting_user' ? 'waiting-user' : status);
    assert.equal(f.events.filter(event => event.type === 'tool/call' && event.data.name !== FINISH_TURN_TOOL).length, 0);
    f.monitor.dispose();
  }
});

test('missing declarations have a no-progress fuse even when each final sentence changes', () => {
  const f = fixture({ turnReviewMaxContinuations: 10, turnReviewNoProgressLimit: 2 });
  for (let index = 0; index < 3; index++) {
    f.response(`我将继续执行第 ${index} 个检查。`); f.stopping();
    if (index < 2) f.consume();
  }
  assert.equal(f.monitor.status().continuations, 2);
  assert.equal(f.monitor.status().last?.reason, 'no-progress');
  assert.equal(f.definitions.size, 0); f.monitor.dispose();
});

test('the per-turn continuation budget is not reset by repeated successful tools', () => {
  const f = fixture({ turnReviewMaxContinuations: 2 });
  for (let index = 0; index < 3; index++) {
    f.business('read', `fresh result ${index}`); f.response(); f.stopping();
    if (index < 2) f.consume();
  }
  assert.equal(f.monitor.status().last?.reason, 'continuation-limit');
  assert.equal(f.monitor.status().continuations, 2); f.monitor.dispose();
});

test('the same tool arguments and output do not count as new progress', () => {
  const f = fixture({ turnReviewMaxContinuations: 10, turnReviewNoProgressLimit: 1 });
  f.business(); f.response(); f.stopping(); f.consume();
  f.business(); f.response(); f.stopping();
  assert.equal(f.monitor.status().last?.reason, 'no-progress'); f.monitor.dispose();
});

test('invalid, failed and absent completion evidence cannot claim tool work completed', async () => {
  const f = fixture(); const failure = f.business('test', 'failed', false);
  f.response(); f.stopping(); f.consume();
  for (const evidence of [[], [failure], [99999]]) {
    await assert.rejects(f.declare({ status: 'completed', summary: '全部完成', evidence }), /成功|引用/u);
  }
  for (const args of [{ status: 'continue', summary: '继续', evidence: [] }, { status: 'completed', summary: 'x', evidence: [], secret: 'not allowed' }]) {
    await assert.rejects(f.declare(args), /状态|动作/u);
  }
  assert.equal(f.monitor.status().last?.decision, 'continued'); f.monitor.dispose();
});

test('a declaration is accepted only after its successful durable outer tool result', async () => {
  for (const failedRoot of [false, true]) {
    const f = fixture({ turnReviewNoProgressLimit: 5 }); f.response(); f.stopping(); f.consume();
    await f.declare({ status: 'completed', summary: '回答完成', evidence: [] }, { root: 'outer-ptc', failedRoot });
    f.stopping();
    assert.equal(f.monitor.status().last?.decision, failedRoot ? 'continued' : 'completed');
    f.monitor.dispose();
  }
  const f = fixture(); f.response(); f.stopping(); f.consume();
  await f.declare({ status: 'completed', summary: '回答完成', evidence: [] }, { blocked: true });
  f.stopping(); assert.equal(f.monitor.status().last?.decision, 'continued'); f.monitor.dispose();
});

test('background jobs and progressing descendants wait without re-starting them', () => {
  for (const source of ['jobs', 'children'] as const) {
    const f = fixture();
    if (source === 'jobs') f.setJobs([{ id: 'job', owner: f.session.id, status: 'running' }]);
    else f.children.push({ ...f.agent, id: 'child' });
    f.response(); f.stopping();
    assert.equal(f.monitor.status().last?.decision, 'waiting-work');
    assert.equal(f.messages.length, 0); assert.equal(f.definitions.size, 0); f.monitor.dispose();
  }
  const f = fixture(); f.setJobs([{ id: 'foreign', owner: 'another-session', status: 'running' }]);
  f.response(); f.stopping(); assert.equal(f.messages.length, 1); f.monitor.dispose();
});

test('an existing unfinished Goal owns continuation, including paused and blocked states', () => {
  for (const phase of ['active', 'paused', 'blocked']) {
    const f = fixture(); f.setGoal({ phase, activation: 'armed' }); f.response(); f.stopping();
    assert.equal(f.monitor.status().last?.reason, 'goal-owned'); assert.equal(f.messages.length, 0); f.monitor.dispose();
  }
});

test('cancellation, truncation, failure and native concluding tools preserve host stop semantics', () => {
  for (const reason of ['max-tokens', 'error', 'aborted']) {
    const f = fixture(); f.response('部分内容', reason); f.stopping();
    assert.equal(f.messages.length, 0); assert.equal(f.definitions.size, 0); f.monitor.dispose();
  }
  const f = fixture(); f.response(); f.controller.abort(); f.stopping();
  assert.equal(f.messages.length, 0); f.monitor.dispose();
  const native = fixture(); native.response('等待用户', 'tool-calls');
  native.monitor.toolResult({ name: 'ask', callId: 'ask-1', agent: native.agent, signal: native.controller.signal, concludeTurn() {} }, { isError: false, concludesTurn: true });
  native.emit('tool/result', { turn: 1, message: { toolCallId: 'ask-1', content: [] } });
  native.stopping(); assert.equal(native.messages.length, 0); native.monitor.dispose();
  const truncated = fixture(); truncated.response('截断内容', 'max-tokens');
  truncated.response('后续回答', 'stop'); truncated.stopping();
  assert.equal(truncated.messages.length, 0); assert.equal(truncated.monitor.status().last?.reason, 'truncated'); truncated.monitor.dispose();
});

test('disabled, other-model and tool-less calls cannot register a completion tool', () => {
  for (const mode of ['disabled', 'model', 'provider', 'tools'] as const) {
    const f = fixture();
    if (mode === 'disabled') f.setConfig({ emptyTurnGuard: false });
    else f.setHeader({ config: { provider: mode === 'provider' ? 'other' : PLAN_PROVIDER, model: mode === 'model' ? 'other' : 'deepseek-v4.1-flash' }, tools: mode === 'tools' ? [] : [{ name: 'read', description: '', parameters: {} }] });
    f.response(); f.stopping(); assert.equal(f.messages.length, 0); assert.equal(f.definitions.size, 0); f.monitor.dispose();
  }
});

test('the completion handshake stays off until its own switch is enabled', () => {
  const off = fixture({ turnCompletionReview: false }); off.response(); off.stopping();
  assert.equal(off.messages.length, 0); assert.equal(off.definitions.size, 0);
  assert.equal(off.monitor.status().checks, 0); assert.equal(off.monitor.status().continuations, 0);
  off.monitor.dispose();
  // Enabling it mid-turn is honoured from the next stop; disabling it releases the owned scope.
  const g = fixture({ turnCompletionReview: false }); g.response(); g.stopping();
  g.setConfig({ turnCompletionReview: true }); g.response(); g.stopping();
  assert.equal(g.messages.length, 1); assert.ok(g.definitions.get(FINISH_TURN_TOOL));
  g.setConfig({ turnCompletionReview: false }); g.monitor.configurationChanged();
  assert.equal(g.definitions.size, 0); assert.equal(g.monitor.status().last?.reason, 'disabled');
  g.monitor.dispose();
});

test('monitoring never widens beyond this plugin plan provider’s deepseek-v4.1-flash', () => {
  const foreign = [
    { provider: PAID_PROVIDER, model: 'deepseek-v4.1-flash' },
    { provider: 'openai', model: 'deepseek-v4.1-flash' },
    { provider: PLAN_PROVIDER, model: 'deepseek-v4-pro' },
    { provider: PLAN_PROVIDER, model: 'gpt-6-astra' },
  ] as const;
  for (const config of foreign) {
    const f = fixture();
    f.setHeader({ config, tools: [{ name: 'read', description: '', parameters: {} }] });
    f.response(); f.stopping();
    assert.equal(f.messages.length, 0, `${config.provider}/${config.model} must not be reviewed`);
    assert.equal(f.definitions.size, 0);
    assert.equal(f.monitor.status().checks, 0);
    f.monitor.dispose();
  }
});

test('checkpoint identity, human steering and a new turn prevent stale continuation', () => {
  const f = fixture(); f.response(); f.stopping(); f.stopping();
  assert.equal(f.messages.length, 1); assert.equal(f.monitor.status().checks, 1);
  f.consume(); f.emit('user/message', { id: 'new-human-message', role: 'user', source: { kind: 'user' }, content: [] });
  f.response(); f.stopping(); assert.equal(f.messages.length, 0); assert.equal(f.definitions.size, 0);
  f.emit('turn/start', { turn: 2 }); f.monitor.dispose();
});

test('raw user-message context refreshes do not supersede an admitted review', async () => {
  const f = fixture(); f.response(); f.stopping(); f.consume();
  f.emit('user/message', { id: 'runtime-refresh', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'fixture runtime' }] });
  f.emit('user/message', { id: 'background-notice', role: 'user', source: { kind: 'job-notification' }, content: [{ type: 'text', text: 'fixture notice' }] });
  await f.declare({ status: 'completed', summary: '回答完成', evidence: [] });
  f.stopping(); assert.equal(f.monitor.status().last?.decision, 'completed');
  assert.equal(f.definitions.size, 0); f.monitor.dispose();
});

test('an admitted raw human message cancels only the older unclaimed review input', () => {
  const f = fixture(); f.response(); f.stopping();
  assert.equal(f.messages.length, 1);
  f.emit('user/message', { id: 'human-override', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '换一个任务' }] });
  assert.equal(f.messages.length, 0); assert.equal(f.definitions.size, 0);
  assert.equal(f.monitor.status().last?.reason, 'superseded'); f.monitor.dispose();
});

test('disable, disposal and turn end remove both owned tools and unclaimed steering', async () => {
  for (const ending of ['disable', 'dispose', 'turn-end', 'agent-disposed'] as const) {
    const f = fixture(); f.response(); f.stopping();
    const tool = f.definitions.get(FINISH_TURN_TOOL); assert.ok(tool);
    if (ending === 'disable') { f.setConfig({ emptyTurnGuard: false }); f.monitor.configurationChanged(); }
    else if (ending === 'dispose') f.monitor.dispose();
    else if (ending === 'turn-end') f.emit('turn/end', { turn: 1 });
    else f.monitor.disposedAgent({ agent: f.agent });
    assert.equal(f.definitions.size, 0); assert.equal(f.messages.length, 0);
    await assert.rejects(tool.execute({ status: 'completed', summary: 'stale', evidence: [] }, { name: FINISH_TURN_TOOL, callId: 'stale', agent: f.agent, signal: f.controller.signal, concludeTurn() { assert.fail('stale cannot conclude'); } }), /没有可提交/u);
    f.monitor.dispose();
  }
});

test('unreadable optional state is visible and never interpreted as a clean bill of health', () => {
  const f = fixture(); f.failReads(); f.response(); f.stopping();
  assert.equal(f.monitor.status().last?.decision, 'unverified');
  assert.equal(f.messages.length, 0); assert.equal(JSON.stringify(f.monitor.status()).includes('untrusted'), false); f.monitor.dispose();
});

test('agents sharing one monitor retain separate scopes and disposal removes both registrations', () => {
  const first = fixture(); const second = fixture(); second.monitor.dispose();
  first.response(); first.stopping();
  first.monitor.observe(second.session, { seq: 0, type: 'turn/start', data: { turn: 1 } });
  first.monitor.stream({ agent: second.agent, frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } } });
  first.monitor.observe(second.session, { seq: 1, type: 'assistant/message', data: { turn: 1, message: { source: { provider: PLAN_PROVIDER, model: 'deepseek-v4.1-flash' } } } });
  first.monitor.stopping({ agent: second.agent, turn: 1, signal: second.controller.signal });
  assert.equal(first.definitions.size, 1); assert.equal(second.definitions.size, 1);
  assert.equal(first.monitor.status().continuations, 2);
  first.monitor.dispose();
  assert.equal(first.definitions.size, 0); assert.equal(second.definitions.size, 0);
  assert.equal(first.messages.length, 0); assert.equal(second.messages.length, 0);
});

test('a steer failure after inbox insertion rolls back only the monitor input', () => {
  const f = fixture();
  f.agent.steer = message => { f.messages.push(message); throw new Error('fixture wake failure'); };
  f.response(); f.stopping();
  assert.equal(f.messages.length, 0); assert.equal(f.definitions.size, 0);
  assert.equal(f.monitor.status().continuations, 0);
  assert.equal(f.monitor.status().last?.decision, 'unverified'); f.monitor.dispose();
});

test('stopping jobs remain active and waiting declarations cannot invent background work', async () => {
  const stopping = fixture(); stopping.setJobs([{ id: 'job', owner: stopping.session.id, status: 'stopping' }]);
  stopping.response(); stopping.stopping(); assert.equal(stopping.monitor.status().last?.decision, 'waiting-work'); stopping.monitor.dispose();
  const absent = fixture(); absent.response(); absent.stopping(); absent.consume();
  await assert.rejects(absent.declare({ status: 'waiting_work', summary: '等后台', evidence: [] }), /未找到/u);
  absent.monitor.dispose();
});

test('installation is effect-owned and provider-only compositions do not require Agent services', async () => {
  const ctx = new Context(); let monitor: TurnMonitor | undefined;
  const fiber = await ctx.plugin(scope => { monitor = installTurnMonitor(scope, () => base); });
  assert.equal(monitor?.status().available, false);
  monitor?.requestRetried(); assert.equal(monitor?.status().requestRetries, 1);
  await fiber.dispose(); assert.equal(monitor?.status().available, false);
});

test('real Cordis service lookup binds a temporary registration to the calling Agent context', async () => {
  const ownerKey = Symbol('fixture-agent-scope');
  class ScopeAwareTools extends Service {
    readonly owners = new Map<string, Map<string, MonitorToolDefinition>>();
    constructor(ctx: Context) { super(ctx, 'tools'); }
    register(definition: MonitorToolDefinition): () => void {
      const owner: unknown = Reflect.get(this.ctx, ownerKey);
      assert.equal(typeof owner, 'string', 'ctx.get must retain the Agent calling context');
      const key = String(owner);
      const entries = this.owners.get(key) ?? new Map<string, MonitorToolDefinition>();
      this.owners.set(key, entries);
      const dispose = this.ctx.effect(() => {
        assertCoreSchemaSubset(definition.output.schema);
        entries.set(definition.name, definition);
        return () => { entries.delete(definition.name); };
      });
      return () => { dispose(); };
    }
  }
  const root = new Context();
  const tools = await root.plugin(ScopeAwareTools);
  let scoped: Context | undefined;
  const owner = await root.plugin(scope => { scoped = scope.extend({ [ownerKey]: 'agent-one' }); });
  assert.ok(scoped);
  const f = fixture(); f.response();
  const agent = { ...f.agent, ctx: scoped };
  const monitor = new TurnMonitor(root, () => base);
  try {
    for (const event of f.events) monitor.observe(f.session, event);
    monitor.stream({ agent, frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } } });
    monitor.stopping({ agent, turn: 1, signal: f.controller.signal });
    const registry = root.get('tools') as ScopeAwareTools;
    assert.equal(registry.owners.size, 1);
    assert.equal(registry.owners.get('agent-one')?.has(FINISH_TURN_TOOL), true);
    assert.equal(registry.owners.has('global'), false);
    monitor.dispose();
    assert.equal(registry.owners.get('agent-one')?.size, 0);
  } finally { monitor.dispose(); f.monitor.dispose(); await owner.dispose(); await tools.dispose(); }
});
