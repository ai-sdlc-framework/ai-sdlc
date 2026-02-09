/**
 * Agent discovery module — integrates A2A agent discovery
 * and skill-based routing into the dogfood pipeline.
 */

import {
  createAgentDiscovery,
  matchAgentBySkill,
  type AgentDiscovery,
  type AgentRole,
} from '@ai-sdlc/reference';

/**
 * Create a pipeline-scoped agent discovery service.
 */
export function createPipelineDiscovery(): AgentDiscovery {
  return createAgentDiscovery();
}

/**
 * Find the best matching agent for a given skill query.
 * Returns the first agent whose skills match.
 */
export function findMatchingAgent(
  discovery: AgentDiscovery,
  skillQuery: string,
): AgentRole | undefined {
  const agents = discovery.list({ skill: skillQuery });
  return agents[0];
}

/**
 * Route an issue to the most appropriate agent based on issue labels.
 * Maps common labels to skill queries.
 */
export function resolveAgentForIssue(
  discovery: AgentDiscovery,
  labels: string[],
): AgentRole | undefined {
  const labelToSkill: Record<string, string> = {
    bug: 'debugging',
    feature: 'implementation',
    docs: 'documentation',
    test: 'testing',
    refactor: 'refactoring',
    security: 'security-analysis',
    performance: 'optimization',
  };

  for (const label of labels) {
    const skill = labelToSkill[label.toLowerCase()];
    if (skill) {
      const agent = findMatchingAgent(discovery, skill);
      if (agent) return agent;
    }
  }

  // Fallback to first available agent
  const all = discovery.list();
  return all[0];
}

export { matchAgentBySkill };
