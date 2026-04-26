/**
 * Bounded-concurrency worker pool per RFC-0010 §9. Accepts a stream of work items in
 * PPA-priority order, dispatches up to `maxConcurrent` simultaneously, and surfaces
 * structured admission/dispatch events.
 */

export interface WorkItem<T> {
  /** Unique id (typically issue id). */
  id: string;
  /** PPA composite score; higher = higher priority. */
  ppaScore: number;
  /** The actual work to perform when admitted. */
  payload: T;
}

export interface WorkerPoolDeps<T, R> {
  /** Number of in-flight items allowed at once. */
  maxConcurrent: number;
  /** Execute a single work item; called by the pool with concurrency-bounded parallelism. */
  execute: (item: WorkItem<T>) => Promise<R>;
  /** Optional admission gate; return false to defer the item back into the queue. */
  admit?: (item: WorkItem<T>) => Promise<boolean>;
  /** Optional structured event sink. */
  onEvent?: (event: WorkerPoolEvent<T>) => void;
}

export type WorkerPoolEvent<T> =
  | { type: 'queued'; item: WorkItem<T>; queueSize: number }
  | { type: 'admission-deferred'; item: WorkItem<T> }
  | { type: 'started'; item: WorkItem<T>; inFlight: number }
  | { type: 'completed'; item: WorkItem<T>; durationMs: number }
  | { type: 'failed'; item: WorkItem<T>; error: Error };

export interface WorkerPoolResult<T, R> {
  succeeded: Array<{ item: WorkItem<T>; result: R }>;
  failed: Array<{ item: WorkItem<T>; error: Error }>;
  deferred: Array<WorkItem<T>>;
}

/**
 * Process all items with bounded concurrency. Items are dispatched in PPA score order
 * (descending). Items that the admission gate rejects are returned in `deferred` for
 * the caller to requeue or escalate. Failed executions are returned in `failed`; the
 * pool does NOT auto-retry — that's the caller's responsibility (see RFC §9.4).
 */
export async function runWorkerPool<T, R>(
  items: WorkItem<T>[],
  deps: WorkerPoolDeps<T, R>,
): Promise<WorkerPoolResult<T, R>> {
  if (deps.maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be >= 1 (got ${deps.maxConcurrent})`);
  }

  const sorted = [...items].sort((a, b) => b.ppaScore - a.ppaScore);
  const result: WorkerPoolResult<T, R> = { succeeded: [], failed: [], deferred: [] };
  const onEvent = deps.onEvent ?? (() => {});

  for (const item of sorted) {
    onEvent({ type: 'queued', item, queueSize: sorted.length });
  }

  let inFlight = 0;
  const queue = [...sorted];

  // Spawn N workers that pull from the shared queue until empty.
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      inFlight++;
      try {
        if (deps.admit) {
          const admitted = await deps.admit(item);
          if (!admitted) {
            onEvent({ type: 'admission-deferred', item });
            result.deferred.push(item);
            continue;
          }
        }
        const start = Date.now();
        onEvent({ type: 'started', item, inFlight });
        const r = await deps.execute(item);
        onEvent({ type: 'completed', item, durationMs: Date.now() - start });
        result.succeeded.push({ item, result: r });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onEvent({ type: 'failed', item, error });
        result.failed.push({ item, error });
      } finally {
        inFlight--;
      }
    }
  };

  const workers = Array.from({ length: Math.min(deps.maxConcurrent, sorted.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return result;
}
