/**
 * Shared configuration write coordinator.
 *
 * The settings page and the new-chat quick buttons write into the same Host namespace. Each
 * surface keeps its own pending overlay, so one surface's write can overwrite the value the other
 * surface just prepared. This module owns one coordinator per namespace form: every write is
 * serialized, every pending field is tracked, and both surfaces read the same pending snapshot.
 *
 * The coordinator talks to the Host configuration form only: it projects the value a caller
 * wants to save, hands the write to the form, and hands the value back to the form snapshot once
 * the write is done. A clear travels the same queue but asks the form to drop the field, because
 * an empty value and an unnamed field are different states for the Host.
 */
import type { ConfigForm, FormValues } from './client.js';

export interface ConfigWriteSnapshot {
  /** Fields with a queued or running write; consumers disable their controls for these fields. */
  pendingFields: readonly string[];
  /** Values of the pending writes, projected for the UI while a write runs. */
  pendingValues: Partial<FormValues>;
}

export interface ConfigWrites {
  /** Stable snapshot object, usable as a `useSyncExternalStore` source. */
  getSnapshot(): ConfigWriteSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Queue one field write.
   *
   * `baseValue` is the value the caller saw while rendering; it is the baseline for the
   * `modelSettings` diff. Returns false when the namespace is not writable, when the same field
   * already has a pending write, or when the Host rejects the write.
   */
  set(field: string, value: unknown, baseValue?: unknown): Promise<boolean>;
  /**
   * Queue one field clear.
   *
   * A cleared field goes back to being unnamed: the Host drops it from the profile instead of
   * storing an empty value. Returns false when the Host offers no clear path.
   */
  clear(field: string): Promise<boolean>;
  /** Stop the coordinator: queued writes never start and subscribers are released. */
  dispose(): void;
}

type Listener = () => void;

interface WriteTask {
  readonly field: string;
  readonly value: unknown;
  /** The caller-rendered value the field diff is measured against. */
  readonly baseline: unknown;
  /** Drop the field instead of writing a value. */
  readonly clear: boolean;
  resolve(accepted: boolean): void;
}

type SettingsMap = Record<string, Record<string, unknown>>;

interface FieldChange {
  readonly id: string;
  readonly field: string;
  readonly value: unknown;
  readonly remove: boolean;
}

const COORDINATORS = new WeakMap<ConfigForm, ConfigWrites>();

/** One coordinator per underlying form; the same form always yields the same instance. */
export function configWritesFor(form: ConfigForm): ConfigWrites {
  const existing = COORDINATORS.get(form);
  if (existing) return existing;
  const created = new ConfigWritesImpl(form);
  COORDINATORS.set(form, created);
  return created;
}

class ConfigWritesImpl implements ConfigWrites {
  private readonly form: ConfigForm;
  private readonly listeners = new Set<Listener>();
  /** Fields with a queued or running write, in call order. */
  private readonly inflight = new Map<string, WriteTask>();
  /** Values of the writes in flight, projected for the UI until the write is done. */
  private readonly overlay = new Map<string, unknown>();
  private readonly queue: WriteTask[] = [];
  private running = false;
  private disposed = false;
  private snapshot: ConfigWriteSnapshot = { pendingFields: [], pendingValues: {} };

  constructor(form: ConfigForm) {
    this.form = form;
  }

  getSnapshot(): ConfigWriteSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async set(field: string, value: unknown, baseValue?: unknown): Promise<boolean> {
    return this.enqueue(field, value, baseValue, false);
  }

  async clear(field: string): Promise<boolean> {
    return this.enqueue(field, undefined, undefined, true);
  }

  private async enqueue(field: string, value: unknown, baseValue: unknown, clear: boolean): Promise<boolean> {
    if (this.disposed) return false;
    const current = this.form.getSnapshot();
    if (!writableSnapshot(current)) return false;
    // The same field may only have one pending write; both surfaces rely on this refusal.
    if (this.inflight.has(field)) return false;
    const baseline = baseValue !== undefined ? baseValue : readField(current.value, field);
    const task: WriteTask = { field, value, baseline, clear, resolve: () => {} };
    const accepted = new Promise<boolean>((resolve) => { task.resolve = resolve; });
    this.inflight.set(field, task);
    // A clear has no value to project; the control shows the empty state the user chose.
    if (!clear) this.overlay.set(field, value);
    this.publish();
    this.queue.push(task);
    this.drain();
    return accepted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = this.queue.splice(0, this.queue.length);
    for (const task of queued) {
      // A queued write never starts after disposal.
      this.inflight.delete(task.field);
      this.overlay.delete(task.field);
      task.resolve(false);
    }
    this.listeners.clear();
    this.inflight.clear();
    this.overlay.clear();
    // The snapshot is refreshed without notifying: a disposed coordinator updates no UI.
    this.snapshot = { pendingFields: [], pendingValues: {} };
    COORDINATORS.delete(this.form);
  }

  private drain(): void {
    if (this.running) return;
    this.running = true;
    void this.runQueue();
  }

  private async runQueue(): Promise<void> {
    try {
      while (!this.disposed) {
        const task = this.queue.shift();
        if (!task) break;
        const accepted = await this.execute(task);
        this.finish(task, accepted);
      }
    } finally {
      this.running = false;
      if (!this.disposed && this.queue.length > 0) this.drain();
    }
  }

  private async execute(task: WriteTask): Promise<boolean> {
    if (this.disposed) return false;
    const current = this.form.getSnapshot();
    if (!writableSnapshot(current)) return false;
    if (task.clear) {
      const unset = this.form.unset;
      if (unset === undefined) return false;
      try {
        return (await unset.call(this.form, task.field)) === true;
      } catch {
        return false;
      }
    }
    let payload = task.value;
    if (task.field === 'modelSettings') {
      // Rebase the caller's field-level diff onto the map the Host holds right now, so a
      // concurrent external update to another model or another setting survives.
      const rebased = rebaseModelSettings(task.baseline, task.value, readField(current.value, 'modelSettings'));
      payload = rebased;
      if (!this.disposed) {
        this.overlay.set(task.field, rebased);
        this.publish();
      }
    }
    try {
      const accepted = await this.form.set(task.field, payload);
      return accepted === true;
    } catch {
      return false;
    }
  }

  private finish(task: WriteTask, accepted: boolean): void {
    this.inflight.delete(task.field);
    // The write is over: the form snapshot is authoritative again, so the projected value is
    // dropped. A rejected write therefore rolls back to the Host value and stays retryable.
    this.overlay.delete(task.field);
    // A disposed coordinator must not update the UI after the fact.
    if (!this.disposed) this.publish();
    task.resolve(accepted);
  }

  private publish(): void {
    this.snapshot = {
      pendingFields: [...this.inflight.keys()],
      pendingValues: buildValues(this.overlay),
    };
    for (const listener of [...this.listeners]) listener();
  }
}

function writableSnapshot(snapshot: { status: string; value: FormValues | undefined; writable: boolean }): boolean {
  return snapshot.status === 'ready' && snapshot.value !== undefined && snapshot.writable;
}

function readField(values: FormValues | undefined, field: string): unknown {
  if (!values) return undefined;
  return (values as unknown as Record<string, unknown>)[field];
}

function buildValues(overlay: ReadonlyMap<string, unknown>): Partial<FormValues> {
  return Object.fromEntries(overlay) as unknown as Partial<FormValues>;
}

/** One model's settings as a plain field map; non-object entries are ignored. */
function toSettingsMap(value: unknown): SettingsMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: SettingsMap = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(entry as Record<string, unknown>)) fields[key] = field;
    out[id] = fields;
  }
  return out;
}

/** The caller's field-level change: per model id, per setting field. */
function diffModelSettings(base: SettingsMap, next: SettingsMap): FieldChange[] {
  const changes: FieldChange[] = [];
  const ids = new Set([...Object.keys(base), ...Object.keys(next)]);
  for (const id of ids) {
    const baseEntry = base[id] ?? {};
    const nextEntry = next[id] ?? {};
    const fields = new Set([...Object.keys(baseEntry), ...Object.keys(nextEntry)]);
    for (const field of fields) {
      const had = Object.prototype.hasOwnProperty.call(baseEntry, field);
      const has = Object.prototype.hasOwnProperty.call(nextEntry, field);
      if (had && has) {
        if (sameValue(baseEntry[field], nextEntry[field])) continue;
        changes.push({ id, field, value: nextEntry[field], remove: false });
      } else if (had) {
        changes.push({ id, field, value: undefined, remove: true });
      } else {
        changes.push({ id, field, value: nextEntry[field], remove: false });
      }
    }
  }
  return changes;
}

/** Apply the diff onto the Host's current map: changed fields only, never a whole-map overwrite. */
function applyModelSettings(latest: SettingsMap, changes: readonly FieldChange[]): SettingsMap {
  const out: SettingsMap = {};
  for (const [id, entry] of Object.entries(latest)) out[id] = { ...entry };
  for (const change of changes) {
    const entry = out[change.id] ?? {};
    if (change.remove || change.value === undefined) delete entry[change.field];
    else entry[change.field] = change.value;
    out[change.id] = entry;
  }
  for (const id of Object.keys(out)) {
    if (Object.keys(out[id] ?? {}).length === 0) delete out[id];
  }
  return out;
}

function rebaseModelSettings(baseline: unknown, desired: unknown, latest: unknown): SettingsMap {
  const changes = diffModelSettings(toSettingsMap(baseline), toSettingsMap(desired));
  return applyModelSettings(toSettingsMap(latest), changes);
}

/** Structural comparison for plain configuration values. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightEntries = Object.entries(right as Record<string, unknown>);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!sameValue(value, (right as Record<string, unknown>)[key])) return false;
  }
  return true;
}
