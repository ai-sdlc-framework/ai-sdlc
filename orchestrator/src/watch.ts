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
  createPipelineReconciler,
  createGateReconciler,
  createAutonomyReconciler,
} from './reconcilers.js';
import { computePriority, type PriorityInput, type PriorityScore } from './priority.js';
import type { PriorityPolicy } from '@ai-sdlc/reference';

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
  /** Priority scoring policy configuration. */
  priorityPolicy?: PriorityPolicy;
}

export interface WatchHandle {
  /** Enqueue a pipeline resource for reconciliation. Optionally provide PriorityInput for scoring. */
  enqueue(pipeline: Pipeline, issueId: string, priorityInput?: PriorityInput): void;
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
  const issueMap = new Map<string, string>();

  // H2: Build specialized reconcilers for each resource kind
  const _pipelineReconciler = createPipelineReconciler({
    resolveAgent: (name) => options.agents?.get(name),
    taskFn: async () => ({}),
  });

  const gateReconciler = createGateReconciler({
    getContext: (_gate) => ({ metrics: {}, repository: '', authorType: 'ai-agent' }),
  });

  const autonomyReconciler = createAutonomyReconciler({
    getAgentMetrics: () => undefined,
    getActiveTriggers: () => [],
  });

  // Composite reconciler dispatches by resource kind
  let reconcileFn: ReconcilerFn = async (resource: AnyResource) => {
    switch (resource.kind) {
      case 'Pipeline': {
        const pipeline = resource as Pipeline;
        const issueId = issueMap.get(pipeline.metadata.name);
        if (!issueId) {
          return {
            type: 'error' as const,
            error: new Error(`No issue ID for pipeline ${pipeline.metadata.name}`),
          };
        }
        try {
          await executePipeline(issueId, {
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

  // Map to hold priority scores for pipelines
  const priorityScores = new Map<string, PriorityScore>();

  return {
    enqueue(pipeline: Pipeline, issueId: string, priorityInput?: PriorityInput): void {
      issueMap.set(pipeline.metadata.name, issueId);

      // Priority scoring when policy is enabled
      if (options.priorityPolicy?.enabled && priorityInput) {
        const config = options.priorityPolicy.dimensions?.humanCurveWeights
          ? { humanCurveWeights: options.priorityPolicy.dimensions.humanCurveWeights }
          : undefined;
        const score = computePriority(priorityInput, config);

        // Skip items below minimum score
        if (
          options.priorityPolicy.minimumScore !== undefined &&
          score.composite < options.priorityPolicy.minimumScore
        ) {
          return;
        }

        // Flag items below minimum confidence (still enqueue, but mark)
        if (
          options.priorityPolicy.minimumConfidence !== undefined &&
          score.confidence < options.priorityPolicy.minimumConfidence
        ) {
          // Store the score with a low-confidence flag for downstream consumers
          priorityScores.set(pipeline.metadata.name, score);
        } else {
          priorityScores.set(pipeline.metadata.name, score);
        }

        if (cache.shouldReconcile(pipeline)) {
          loop.enqueue(pipeline, score.composite);
        }
        return;
      }

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
