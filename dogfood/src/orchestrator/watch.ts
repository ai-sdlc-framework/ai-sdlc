/**
 * Reconciler watch mode — wraps executePipeline in a continuous reconciliation loop.
 *
 * Uses ReconcilerLoop + createResourceCache from the reference implementation
 * for level-triggered, idempotent reconciliation with backoff.
 */

import {
  ReconcilerLoop,
  createResourceCache,
  instrumentReconciler,
  type ReconcilerConfig,
  type ReconcileResult,
  type ReconcilerFn,
  type Pipeline,
  type QualityGate,
  type AutonomyPolicy,
  type AnyResource,
  type AgentRole,
  type MetricStore,
} from '@ai-sdlc/reference';
import { executePipeline, type ExecuteOptions } from './execute.js';
import {
  createDogfoodPipelineReconciler,
  createDogfoodGateReconciler,
  createDogfoodAutonomyReconciler,
} from './reconcilers.js';

export interface WatchOptions {
  /** Override the reconciler config (poll interval, concurrency, backoff). */
  reconcilerConfig?: Partial<ReconcilerConfig>;
  /** Pipeline execution options passed through to executePipeline. */
  executeOptions?: Omit<ExecuteOptions, 'configDir' | 'workDir'>;
  /** Callback invoked when a pipeline reconciliation completes. */
  onReconcile?: (pipelineName: string, result: ReconcileResult) => void;
  /** Optional metric store to instrument reconciliation cycles. */
  metricStore?: MetricStore;
  /** Optional agent roles for pipeline reconciler agent resolution. */
  agents?: Map<string, AgentRole>;
  /** Optional quality gates for gate reconciler evaluation context. */
  qualityGates?: QualityGate[];
  /** Optional autonomy policies for autonomy reconciler evaluation. */
  autonomyPolicies?: AutonomyPolicy[];
}

export interface WatchHandle {
  /** Enqueue a pipeline resource for reconciliation. */
  enqueue(pipeline: Pipeline, issueNumber: number): void;
  /** Enqueue a quality gate resource for reconciliation. */
  enqueueGate(gate: QualityGate): void;
  /** Enqueue an autonomy policy resource for reconciliation. */
  enqueueAutonomy(policy: AutonomyPolicy): void;
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

  // H2: Build specialized reconcilers for each resource kind
  const _pipelineReconciler = createDogfoodPipelineReconciler({
    resolveAgent: (name) => options.agents?.get(name),
    taskFn: async () => ({}),
  });

  const gateReconciler = createDogfoodGateReconciler({
    getContext: (_gate) => ({ metrics: {}, repository: '', authorType: 'ai-agent' }),
  });

  const autonomyReconciler = createDogfoodAutonomyReconciler({
    getAgentMetrics: () => undefined,
    getActiveTriggers: () => [],
  });

  // Composite reconciler dispatches by resource kind
  let reconcileFn: ReconcilerFn = async (resource: AnyResource) => {
    switch (resource.kind) {
      case 'Pipeline': {
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
      }
      case 'QualityGate':
        return gateReconciler(resource as QualityGate);
      case 'AutonomyPolicy':
        return autonomyReconciler(resource as AutonomyPolicy);
      default:
        return { type: 'success' as const };
    }
  };

  // Wrap with instrumentation if metric store is provided
  if (options.metricStore) {
    reconcileFn = instrumentReconciler(reconcileFn, { metricStore: options.metricStore });
  }

  const loop = new ReconcilerLoop(reconcileFn, options.reconcilerConfig);

  loop.start();

  return {
    enqueue(pipeline: Pipeline, issueNumber: number): void {
      issueMap.set(pipeline.metadata.name, issueNumber);
      if (cache.shouldReconcile(pipeline)) {
        loop.enqueue(pipeline);
      }
    },

    enqueueGate(gate: QualityGate): void {
      if (cache.shouldReconcile(gate)) {
        loop.enqueue(gate);
      }
    },

    enqueueAutonomy(policy: AutonomyPolicy): void {
      if (cache.shouldReconcile(policy)) {
        loop.enqueue(policy);
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
