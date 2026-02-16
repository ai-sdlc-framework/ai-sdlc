/**
 * Agent orchestration integration — wraps multi-agent orchestration patterns,
 * execution engine, and handoff validation for pipeline stages.
 */

import {
  sequential,
  parallel,
  hybrid,
  hierarchical,
  swarm,
  router,
  collaborative,
  executeOrchestration,
  validateHandoff,
  validateHandoffContract,
  simpleSchemaValidate,
  type OrchestrationPattern,
  type OrchestrationPlan,
  type OrchestrationStep,
  type OrchestrationResult,
  type StepResult,
  type TaskFn,
  type ExecutionOptions,
  type AgentRole,
} from '@ai-sdlc/reference';

/**
 * Create an orchestration plan appropriate for the given agent count and pattern.
 */
export function createPipelineOrchestration(
  agents: AgentRole[],
  pattern: OrchestrationPattern = 'sequential',
): OrchestrationPlan {
  switch (pattern) {
    case 'sequential':
      return sequential(agents);
    case 'parallel':
      return parallel(agents);
    case 'hybrid':
      return hybrid(agents[0], agents.slice(1));
    case 'hierarchical':
      return hierarchical(agents[0], agents.slice(1));
    case 'swarm':
      return swarm(agents);
    default:
      return sequential(agents);
  }
}

/**
 * Execute an orchestration plan with a task function for each agent.
 */
export async function executePipelineOrchestration(
  plan: OrchestrationPlan,
  agents: AgentRole[],
  taskFn: TaskFn,
  options?: ExecutionOptions,
): Promise<OrchestrationResult> {
  const agentMap = new Map<string, AgentRole>();
  for (const agent of agents) {
    agentMap.set(agent.metadata.name, agent);
  }
  return executeOrchestration(plan, agentMap, taskFn, options);
}

/**
 * Validate that all handoff targets in an agent's handoff declarations exist.
 */
export function validatePipelineHandoffs(agents: AgentRole[]): string[] {
  const errors: string[] = [];
  const agentNames = new Set(agents.map((a) => a.metadata.name));

  for (const agent of agents) {
    if (!agent.spec.handoffs) continue;
    for (const handoff of agent.spec.handoffs) {
      if (!agentNames.has(handoff.target)) {
        errors.push(
          `Agent "${agent.metadata.name}" has handoff to unknown target "${handoff.target}"`,
        );
      }
    }
  }
  return errors;
}

export {
  sequential,
  parallel,
  hybrid,
  hierarchical,
  swarm,
  router,
  collaborative,
  executeOrchestration,
  validateHandoff,
  validateHandoffContract,
  simpleSchemaValidate,
};

export type {
  OrchestrationPattern,
  OrchestrationPlan,
  OrchestrationStep,
  OrchestrationResult,
  StepResult,
  TaskFn,
  ExecutionOptions,
};
