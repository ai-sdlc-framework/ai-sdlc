/**
 * Agent orchestration patterns from spec/agents.md.
 *
 * Five orchestration patterns for multi-agent collaboration:
 * 1. Sequential — agents execute in order
 * 2. Parallel — agents execute concurrently
 * 3. Router — single agent dispatches to specialists
 * 4. Hierarchical — manager delegates to workers
 * 5. Collaborative — agents negotiate via handoffs
 */

import type { AgentRole } from '../core/types.js';

export type OrchestrationPattern =
  | 'sequential'
  | 'parallel'
  | 'router'
  | 'hierarchical'
  | 'collaborative';

export interface OrchestrationStep {
  agent: string;
  dependsOn?: string[];
}

export interface OrchestrationPlan {
  pattern: OrchestrationPattern;
  steps: OrchestrationStep[];
}

/**
 * Build a sequential orchestration plan from an ordered list of agents.
 */
export function sequential(agents: AgentRole[]): OrchestrationPlan {
  const steps: OrchestrationStep[] = agents.map((agent, i) => ({
    agent: agent.metadata.name,
    dependsOn: i > 0 ? [agents[i - 1].metadata.name] : undefined,
  }));
  return { pattern: 'sequential', steps };
}

/**
 * Build a parallel orchestration plan where all agents run concurrently.
 */
export function parallel(agents: AgentRole[]): OrchestrationPlan {
  const steps: OrchestrationStep[] = agents.map((agent) => ({
    agent: agent.metadata.name,
  }));
  return { pattern: 'parallel', steps };
}

/**
 * Build a router orchestration plan with a dispatcher and specialists.
 */
export function router(dispatcher: AgentRole, specialists: AgentRole[]): OrchestrationPlan {
  const steps: OrchestrationStep[] = [
    { agent: dispatcher.metadata.name },
    ...specialists.map((s) => ({
      agent: s.metadata.name,
      dependsOn: [dispatcher.metadata.name],
    })),
  ];
  return { pattern: 'router', steps };
}

/**
 * Build a hierarchical orchestration plan with a manager and workers.
 */
export function hierarchical(manager: AgentRole, workers: AgentRole[]): OrchestrationPlan {
  const steps: OrchestrationStep[] = [
    { agent: manager.metadata.name },
    ...workers.map((w) => ({
      agent: w.metadata.name,
      dependsOn: [manager.metadata.name],
    })),
  ];
  return { pattern: 'hierarchical', steps };
}

/**
 * Build a collaborative orchestration plan from agents that reference
 * each other via handoff declarations.
 */
export function collaborative(agents: AgentRole[]): OrchestrationPlan {
  const steps: OrchestrationStep[] = agents.map((agent) => {
    const dependsOn = agents
      .filter((other) => other.spec.handoffs?.some((h) => h.target === agent.metadata.name))
      .map((other) => other.metadata.name);
    return {
      agent: agent.metadata.name,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    };
  });
  return { pattern: 'collaborative', steps };
}
