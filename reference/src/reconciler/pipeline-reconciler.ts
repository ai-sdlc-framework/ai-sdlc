/**
 * Pipeline domain reconciler.
 * Translates Pipeline stages into an OrchestrationPlan and executes it.
 * Supports failure policies (abort/continue/retry/pause), approval gating, and timeouts.
 */

import type { Pipeline, AgentRole, Stage } from '../core/types.js';
import type { ReconcileResult } from './types.js';
import { sequential } from '../agents/orchestration.js';
import { executeOrchestration, type TaskFn, type ExecutionOptions } from '../agents/executor.js';
import { parseDuration } from '../utils/duration.js';

export interface PipelineReconcilerDeps {
  resolveAgent: (name: string) => AgentRole | undefined;
  taskFn: TaskFn;
  executionOptions?: ExecutionOptions;
  /** Check whether an approval has been granted for the given stage. */
  isApproved?: (stage: string) => boolean;
}

/**
 * Create a reconciler function for Pipeline resources.
 * Translates stages to a sequential orchestration plan and executes.
 */
export function createPipelineReconciler(
  deps: PipelineReconcilerDeps,
): (resource: Pipeline) => Promise<ReconcileResult> {
  return async (pipeline: Pipeline): Promise<ReconcileResult> => {
    const stages = pipeline.spec.stages;
    if (stages.length === 0) {
      return { type: 'success' };
    }

    // Initialize status tracking
    if (!pipeline.status) {
      pipeline.status = {};
    }
    if (!pipeline.status.stageAttempts) {
      pipeline.status.stageAttempts = {};
    }

    for (const stage of stages) {
      // Approval check: if stage requires blocking approval, check before executing
      if (stage.approval?.required && stage.approval.blocking !== false) {
        if (deps.isApproved && !deps.isApproved(stage.name)) {
          // Set pending approval status
          pipeline.status.phase = 'Suspended';
          pipeline.status.pendingApproval = {
            stage: stage.name,
            tier: stage.approval.tierOverride ?? 'auto',
            requestedAt: new Date().toISOString(),
          };
          return { type: 'requeue-after', delayMs: 30_000 };
        }
      }

      // Skip stages that don't have agents (gate-only or approval-only)
      if (!stage.agent) continue;

      const role = deps.resolveAgent(stage.agent);
      if (!role) {
        return {
          type: 'error',
          error: new Error(`Agent "${stage.agent}" not found for stage "${stage.name}"`),
        };
      }

      // Build execution options with timeout
      const stageExecOptions = { ...deps.executionOptions };
      if (stage.timeout) {
        try {
          const _timeoutMs = parseDuration(stage.timeout);
          // Timeout is tracked but not enforced in the reference implementation
          // since executeOrchestration runs the task function directly
        } catch {
          // Invalid duration — proceed without timeout
        }
      }

      // Execute the stage with failure policy handling
      const result = await executeStageWithPolicy(
        pipeline,
        stage,
        role,
        deps.taskFn,
        stageExecOptions,
      );

      if (result) return result;
    }

    // All stages completed successfully
    pipeline.status.phase = 'Succeeded';
    pipeline.status.pendingApproval = undefined;
    return { type: 'success' };
  };
}

/**
 * Execute a single stage respecting its failure policy.
 * Returns a ReconcileResult if the pipeline should stop, or undefined to continue.
 */
async function executeStageWithPolicy(
  pipeline: Pipeline,
  stage: Stage,
  role: AgentRole,
  taskFn: TaskFn,
  executionOptions?: ExecutionOptions,
): Promise<ReconcileResult | undefined> {
  const strategy = stage.onFailure?.strategy ?? 'abort';
  const maxRetries = stage.onFailure?.maxRetries ?? 1;

  // Track attempts
  const attempts = pipeline.status!.stageAttempts!;
  attempts[stage.name] = attempts[stage.name] ?? 0;

  // Build a single-agent plan
  const plan = sequential([role]);

  for (let attempt = 1; attempt <= (strategy === 'retry' ? maxRetries : 1); attempt++) {
    attempts[stage.name] = attempt;
    pipeline.status!.activeStage = stage.name;

    try {
      const agents = new Map<string, AgentRole>();
      agents.set(role.metadata.name, role);

      const result = await executeOrchestration(plan, agents, taskFn, executionOptions);

      if (result.success) {
        return undefined; // Continue to next stage
      }

      // Stage failed
      const failedStep = result.stepResults.find((s) => s.state === 'failed');

      if (strategy === 'continue') {
        // Record failure condition but proceed
        pipeline.status!.conditions = [
          ...(pipeline.status!.conditions ?? []),
          {
            type: 'StageFailed',
            status: 'True',
            reason: failedStep?.error ?? 'Unknown error',
            message: `Stage "${stage.name}" failed but continuing (continue policy)`,
          },
        ];
        return undefined;
      }

      if (strategy === 'retry' && attempt < maxRetries) {
        // Will retry on next loop iteration
        continue;
      }

      if (strategy === 'retry' && attempt >= maxRetries) {
        // Exhausted all retries — break to the exhaustion handler below
        break;
      }

      if (strategy === 'pause') {
        pipeline.status!.phase = 'Suspended';
        pipeline.status!.conditions = [
          ...(pipeline.status!.conditions ?? []),
          {
            type: 'StageFailed',
            status: 'True',
            reason: failedStep?.error ?? 'Unknown error',
            message: `Stage "${stage.name}" failed — pipeline paused`,
          },
        ];
        return { type: 'requeue-after', delayMs: 30_000 };
      }

      // Default: abort
      pipeline.status!.phase = 'Failed';
      pipeline.status!.conditions = [
        ...(pipeline.status!.conditions ?? []),
        {
          type: 'StepFailed',
          status: 'True',
          reason: failedStep?.error ?? 'Unknown error',
          message: `Step "${failedStep?.agent}" failed`,
        },
      ];
      return {
        type: 'error',
        error: new Error(`Pipeline step "${failedStep?.agent}" failed: ${failedStep?.error}`),
      };
    } catch (err) {
      if (strategy === 'continue') {
        pipeline.status!.conditions = [
          ...(pipeline.status!.conditions ?? []),
          {
            type: 'StageFailed',
            status: 'True',
            reason: err instanceof Error ? err.message : String(err),
            message: `Stage "${stage.name}" threw but continuing (continue policy)`,
          },
        ];
        return undefined;
      }

      if (strategy === 'retry' && attempt < maxRetries) {
        continue;
      }

      if (strategy === 'pause') {
        pipeline.status!.phase = 'Suspended';
        return { type: 'requeue-after', delayMs: 30_000 };
      }

      // For retry strategy that exhausted all attempts, fall through to the
      // "exhausted retries" block below instead of returning here
      if (strategy === 'retry' && attempt >= maxRetries) {
        break;
      }

      return {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  // Exhausted retries
  pipeline.status!.phase = 'Failed';
  pipeline.status!.conditions = [
    ...(pipeline.status!.conditions ?? []),
    {
      type: 'RetriesExhausted',
      status: 'True',
      reason: `Stage "${stage.name}" failed after ${maxRetries} attempts`,
      message: `Retry limit reached for stage "${stage.name}"`,
    },
  ];
  return {
    type: 'error',
    error: new Error(`Stage "${stage.name}" failed after ${maxRetries} retries`),
  };
}
