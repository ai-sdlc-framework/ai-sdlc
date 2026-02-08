/**
 * Metrics instrumentation wrappers.
 * Wraps existing functions to record metrics to both MetricStore and OTel.
 * Uses the wrapper pattern — callers opt-in, zero breaking changes.
 */

import type { Meter } from '@opentelemetry/api';
import type { MetricStore } from './types.js';
import type { QualityGate } from '../core/types.js';
import type { EvaluationContext, EnforcementResult } from '../policy/enforcement.js';
import type { AgentRole } from '../core/types.js';
import type { OrchestrationPlan } from '../agents/orchestration.js';
import type { OrchestrationResult, TaskFn, ExecutionOptions } from '../agents/executor.js';
import type { AnyResource } from '../core/types.js';
import type { ReconcilerFn, ReconcileResult } from '../reconciler/types.js';
import { METRIC_NAMES } from '../telemetry/semantic-conventions.js';

export interface InstrumentationConfig {
  metricStore: MetricStore;
  meter?: Meter;
}

/**
 * Wrap the `enforce()` function to record gate pass/fail counts.
 */
export function instrumentEnforcement(
  enforceFn: (qualityGate: QualityGate, ctx: EvaluationContext) => EnforcementResult,
  config: InstrumentationConfig,
): (qualityGate: QualityGate, ctx: EvaluationContext) => EnforcementResult {
  const passCounter = config.meter?.createCounter(METRIC_NAMES.GATE_PASS_TOTAL, {
    description: 'Count of gate evaluations that passed',
  });
  const failCounter = config.meter?.createCounter(METRIC_NAMES.GATE_FAIL_TOTAL, {
    description: 'Count of gate evaluations that failed',
  });

  return (qualityGate: QualityGate, ctx: EvaluationContext): EnforcementResult => {
    const result = enforceFn(qualityGate, ctx);

    for (const gateResult of result.results) {
      const labels = { gate: gateResult.gate, enforcement: gateResult.enforcement };
      if (gateResult.verdict === 'pass' || gateResult.verdict === 'override') {
        config.metricStore.record({
          metric: METRIC_NAMES.GATE_PASS_TOTAL,
          value: 1,
          labels,
        });
        passCounter?.add(1, labels);
      } else {
        config.metricStore.record({
          metric: METRIC_NAMES.GATE_FAIL_TOTAL,
          value: 1,
          labels,
        });
        failCounter?.add(1, labels);
      }
    }

    return result;
  };
}

/**
 * Wrap `executeOrchestration()` to record task duration and success/failure counts.
 */
export function instrumentExecutor(
  executeFn: (
    plan: OrchestrationPlan,
    agents: Map<string, AgentRole>,
    taskFn: TaskFn,
    options?: ExecutionOptions,
  ) => Promise<OrchestrationResult>,
  config: InstrumentationConfig,
): (
  plan: OrchestrationPlan,
  agents: Map<string, AgentRole>,
  taskFn: TaskFn,
  options?: ExecutionOptions,
) => Promise<OrchestrationResult> {
  const durationHistogram = config.meter?.createHistogram(METRIC_NAMES.TASK_DURATION_MS, {
    description: 'Duration of task execution in milliseconds',
    unit: 'ms',
  });
  const successCounter = config.meter?.createCounter(METRIC_NAMES.TASK_SUCCESS_TOTAL, {
    description: 'Count of successful task completions',
  });
  const failureCounter = config.meter?.createCounter(METRIC_NAMES.TASK_FAILURE_TOTAL, {
    description: 'Count of failed task completions',
  });

  return async (
    plan: OrchestrationPlan,
    agents: Map<string, AgentRole>,
    taskFn: TaskFn,
    options?: ExecutionOptions,
  ): Promise<OrchestrationResult> => {
    const start = Date.now();
    const result = await executeFn(plan, agents, taskFn, options);
    const durationMs = Date.now() - start;

    const labels = { pipeline: plan.pattern };

    config.metricStore.record({
      metric: METRIC_NAMES.TASK_DURATION_MS,
      value: durationMs,
      labels,
    });
    durationHistogram?.record(durationMs, labels);

    for (const step of result.stepResults) {
      const stepLabels = { ...labels, agent: step.agent };
      if (step.state === 'completed') {
        config.metricStore.record({
          metric: METRIC_NAMES.TASK_SUCCESS_TOTAL,
          value: 1,
          labels: stepLabels,
        });
        successCounter?.add(1, stepLabels);
      } else if (step.state === 'failed') {
        config.metricStore.record({
          metric: METRIC_NAMES.TASK_FAILURE_TOTAL,
          value: 1,
          labels: stepLabels,
        });
        failureCounter?.add(1, stepLabels);
      }
    }

    return result;
  };
}

/**
 * Wrap a reconciler function to record cycle duration and result counts.
 */
export function instrumentReconciler(
  reconcileFn: ReconcilerFn,
  config: InstrumentationConfig,
): ReconcilerFn {
  const durationHistogram = config.meter?.createHistogram(METRIC_NAMES.RECONCILIATION_DURATION_MS, {
    description: 'Duration of reconciliation cycles in milliseconds',
    unit: 'ms',
  });

  return async (resource: AnyResource): Promise<ReconcileResult> => {
    const start = Date.now();
    const result = await reconcileFn(resource);
    const durationMs = Date.now() - start;

    const labels = {
      resource_kind: resource.kind,
      resource_name: resource.metadata.name,
      result: result.type,
    };

    config.metricStore.record({
      metric: METRIC_NAMES.RECONCILIATION_DURATION_MS,
      value: durationMs,
      labels,
    });
    durationHistogram?.record(durationMs, labels);

    return result;
  };
}

/**
 * Create callbacks for autonomy promotion/demotion metric recording.
 */
export function instrumentAutonomy(config: InstrumentationConfig): {
  onPromotion: (agent: string, fromLevel: number, toLevel: number) => void;
  onDemotion: (agent: string, fromLevel: number, toLevel: number) => void;
} {
  const promotionCounter = config.meter?.createCounter(METRIC_NAMES.PROMOTION_TOTAL, {
    description: 'Count of autonomy promotions',
  });
  const demotionCounter = config.meter?.createCounter(METRIC_NAMES.DEMOTION_TOTAL, {
    description: 'Count of autonomy demotions',
  });
  const levelGauge = config.meter?.createUpDownCounter(METRIC_NAMES.AUTONOMY_LEVEL, {
    description: 'Current autonomy level',
  });

  return {
    onPromotion(agent: string, _fromLevel: number, toLevel: number): void {
      const labels = { agent };
      config.metricStore.record({
        metric: METRIC_NAMES.PROMOTION_TOTAL,
        value: 1,
        labels,
      });
      config.metricStore.record({
        metric: METRIC_NAMES.AUTONOMY_LEVEL,
        value: toLevel,
        labels,
      });
      promotionCounter?.add(1, labels);
      levelGauge?.add(0, labels); // Touch the gauge for OTel
    },
    onDemotion(agent: string, _fromLevel: number, toLevel: number): void {
      const labels = { agent };
      config.metricStore.record({
        metric: METRIC_NAMES.DEMOTION_TOTAL,
        value: 1,
        labels,
      });
      config.metricStore.record({
        metric: METRIC_NAMES.AUTONOMY_LEVEL,
        value: toLevel,
        labels,
      });
      demotionCounter?.add(1, labels);
      levelGauge?.add(0, labels);
    },
  };
}
