/**
 * Reconciler watch mode — wraps executePipeline in a continuous reconciliation loop.
 *
 * Uses ReconcilerLoop + createResourceCache from the reference implementation
 * for level-triggered, idempotent reconciliation with backoff.
 */

import {
  ReconcilerLoop,
  createResourceCache,
  type ReconcilerConfig,
  type ReconcileResult,
  type Pipeline,
} from '@ai-sdlc/reference';
import { executePipeline, type ExecuteOptions } from './execute.js';

export interface WatchOptions {
  /** Override the reconciler config (poll interval, concurrency, backoff). */
  reconcilerConfig?: Partial<ReconcilerConfig>;
  /** Pipeline execution options passed through to executePipeline. */
  executeOptions?: Omit<ExecuteOptions, 'configDir' | 'workDir'>;
  /** Callback invoked when a pipeline reconciliation completes. */
  onReconcile?: (pipelineName: string, result: ReconcileResult) => void;
}

export interface WatchHandle {
  /** Enqueue a pipeline resource for reconciliation. */
  enqueue(pipeline: Pipeline, issueNumber: number): void;
  /** Stop the reconciliation loop. */
  stop(): void;
  /** Number of items in the queue. */
  readonly queueSize: number;
  /** Number of actively reconciling items. */
  readonly activeCount: number;
}

/**
 * Start a reconciler watch loop that continuously processes pipeline resources.
 */
export function startWatch(options: WatchOptions = {}): WatchHandle {
  const cache = createResourceCache();
  const issueMap = new Map<string, number>();

  const loop = new ReconcilerLoop(async (resource) => {
    const pipeline = resource as Pipeline;
    const issueNumber = issueMap.get(pipeline.metadata.name);
    if (!issueNumber) {
      return {
        type: 'error' as const,
        error: new Error(`No issue number for pipeline ${pipeline.metadata.name}`),
      };
    }

    try {
      await executePipeline(issueNumber, {
        ...options.executeOptions,
      });
      const result: ReconcileResult = { type: 'success' as const };
      options.onReconcile?.(pipeline.metadata.name, result);
      return result;
    } catch (err) {
      const result: ReconcileResult = {
        type: 'error' as const,
        error: err instanceof Error ? err : new Error(String(err)),
      };
      options.onReconcile?.(pipeline.metadata.name, result);
      return result;
    }
  }, options.reconcilerConfig);

  loop.start();

  return {
    enqueue(pipeline: Pipeline, issueNumber: number): void {
      issueMap.set(pipeline.metadata.name, issueNumber);
      if (cache.shouldReconcile(pipeline)) {
        loop.enqueue(pipeline);
      }
    },

    stop(): void {
      loop.stop();
    },

    get queueSize(): number {
      return loop.queueSize;
    },

    get activeCount(): number {
      return loop.activeCount;
    },
  };
}
