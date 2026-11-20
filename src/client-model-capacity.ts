/**
 * Cached capacity rows for the chat-side context control.
 *
 * The control needs one number per model — the catalog's known reference window — and the
 * only place that number is published is this plugin's `status` RPC. Reading it from the
 * control meant one remote round trip per mount and one more for every model-directory
 * publish, with the control disabled until each read settled. One shared, cached read keeps
 * the control local: a cached row renders immediately, at most one read runs per refresh
 * window, and a stale row keeps answering when a read fails.
 *
 * Browser module: no Node API, no configuration store, no credential.
 */
import type { RpcCaller } from './client.js';
import type { Status, StatusModel } from './remote.js';

/** How long one read keeps answering without another remote call. */
export const MODEL_ROWS_TTL_MS = 5 * 60_000;

let rows = new Map<string, StatusModel>();
let loadedAt = 0;
let inflight: Promise<void> | undefined;

/** The last observed row for one exact model, or undefined before any read. */
export function cachedModelRow(modelId: string): StatusModel | undefined {
  return rows.get(modelId);
}

/** Whether the cached rows are newer than the refresh window. */
export function modelRowsFresh(now = Date.now()): boolean {
  return loadedAt !== 0 && now - loadedAt < MODEL_ROWS_TTL_MS;
}

/** How many rows the last read published; used by tests and diagnostics. */
export function cachedModelRowCount(): number {
  return rows.size;
}

/** Forget every cached row. */
export function resetModelCapacity(): void {
  rows = new Map();
  loadedAt = 0;
  inflight = undefined;
}

/**
 * Refresh the cached rows, sharing one in-flight read and skipping a fresh cache.
 *
 * Never rejects: a failed read keeps the previous rows, because a stale capacity is still a
 * better answer than a control that never enables.
 *
 * @param caller - the plugin's own Remote caller.
 * @param options.force - read again even when the cache is fresh (explicit retry).
 * @returns settlement of the shared read.
 */
export function ensureModelRows(caller: RpcCaller, options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && modelRowsFresh()) return Promise.resolve();
  if (inflight) return inflight;
  const run = (async () => {
    let status: Status;
    try { status = await caller<Status>('status'); } catch { return; }
    const next = new Map<string, StatusModel>();
    for (const model of status.models) next.set(model.id, model);
    rows = next;
    loadedAt = Date.now();
  })();
  inflight = run;
  void run.finally(() => { if (inflight === run) inflight = undefined; });
  return run;
}
