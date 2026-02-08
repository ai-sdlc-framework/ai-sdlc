/**
 * Agent discovery service.
 * In-memory registry for discovering and resolving agent roles.
 */

import type { AgentRole, Skill } from '../core/types.js';

export interface AgentFilter {
  role?: string;
  skill?: string;
  tool?: string;
}

export interface AgentDiscovery {
  /** Register an agent role for discovery. */
  register(agent: AgentRole): void;
  /** Resolve an agent by name. */
  resolve(name: string): AgentRole | undefined;
  /** List agents matching an optional filter. */
  list(filter?: AgentFilter): AgentRole[];
  /** Discover an agent from an A2A endpoint (stub — returns undefined). */
  discover(endpoint: string): Promise<AgentRole | undefined>;
}

/**
 * Match an agent's skills against a skill query.
 * Searches skill IDs and tags.
 */
export function matchAgentBySkill(agent: AgentRole, skillQuery: string): boolean {
  const skills = agent.spec.skills ?? [];
  const query = skillQuery.toLowerCase();

  return skills.some((skill: Skill) => {
    if (skill.id.toLowerCase().includes(query)) return true;
    if (skill.tags?.some((tag) => tag.toLowerCase().includes(query))) return true;
    return false;
  });
}

/**
 * Create an in-memory agent discovery service.
 */
export function createAgentDiscovery(): AgentDiscovery {
  const agents = new Map<string, AgentRole>();

  return {
    register(agent: AgentRole): void {
      agents.set(agent.metadata.name, agent);
    },

    resolve(name: string): AgentRole | undefined {
      return agents.get(name);
    },

    list(filter?: AgentFilter): AgentRole[] {
      let result = Array.from(agents.values());

      if (filter?.role) {
        const role = filter.role.toLowerCase();
        result = result.filter((a) => a.spec.role.toLowerCase().includes(role));
      }

      if (filter?.skill) {
        const skill = filter.skill;
        result = result.filter((a) => matchAgentBySkill(a, skill));
      }

      if (filter?.tool) {
        const tool = filter.tool.toLowerCase();
        result = result.filter((a) => a.spec.tools.some((t) => t.toLowerCase().includes(tool)));
      }

      return result;
    },

    async discover(_endpoint: string): Promise<AgentRole | undefined> {
      // Stub: A2A discovery not implemented — returns undefined
      return undefined;
    },
  };
}
