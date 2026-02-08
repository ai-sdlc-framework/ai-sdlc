/**
 * Pipeline domain reconciler.
 * Translates Pipeline stages into an OrchestrationPlan and executes it.
 */

import type { Pipeline, AgentRole } from '../core/types.js';
import type { ReconcileResult } from './types.js';
import { sequential } from '../agents/orchestration.js';
import { executeOrchestration, type TaskFn, type ExecutionOptions } from '../agents/executor.js';

export interface PipelineReconcilerDeps {
  resolveAgent: (name: string) => AgentRole | undefined;
  taskFn: TaskFn;
  executionOptions?: ExecutionOptions;
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

    // Resolve agents for stages that have agent assignments
    const agents = new Map<string, AgentRole>();
    const agentRoles: AgentRole[] = [];

    for (const stage of stages) {
      if (!stage.agent) continue;
      const role = deps.resolveAgent(stage.agent);
      if (!role) {
        return {
          type: 'error',
          error: new Error(`Agent "${stage.agent}" not found for stage "${stage.name}"`),
        };
      }
      agents.set(stage.agent, role);
      agentRoles.push(role);
    }

    if (agentRoles.length === 0) {
      return { type: 'success' };
    }

    // Build sequential plan from stages
    const plan = sequential(agentRoles);

    try {
      const result = await executeOrchestration(plan, agents, deps.taskFn, deps.executionOptions);

      if (result.success) {
        // Update status if mutable
        if (pipeline.status) {
          pipeline.status.phase = 'Succeeded';
        }
        return { type: 'success' };
      }

      const failedStep = result.stepResults.find((s) => s.state === 'failed');
      if (pipeline.status) {
        pipeline.status.phase = 'Failed';
        pipeline.status.conditions = [
          {
            type: 'StepFailed',
            status: 'True',
            reason: failedStep?.error ?? 'Unknown error',
            message: `Step "${failedStep?.agent}" failed`,
          },
        ];
      }
      return {
        type: 'error',
        error: new Error(`Pipeline step "${failedStep?.agent}" failed: ${failedStep?.error}`),
      };
    } catch (err) {
      return {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  };
}
