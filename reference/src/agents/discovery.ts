/**
 * Agent discovery service.
 * In-memory registry with A2A agent card discovery (PRD Section 13).
 */

import type { AgentRole, Skill } from '../core/types.js';

export interface AgentFilter {
  role?: string;
  skill?: string;
  tool?: string;
}

export interface A2AAgentCard {
  name: string;
  description?: string;
  url: string;
  skills?: Array<{ id: string; description?: string; tags?: string[] }>;
  tools?: string[];
}

export interface AgentCardFetcher {
  fetch(url: string): Promise<A2AAgentCard | null>;
}

export interface AgentDiscovery {
  /** Register an agent role for discovery. */
  register(agent: AgentRole): void;
  /** Resolve an agent by name. */
  resolve(name: string): AgentRole | undefined;
  /** List agents matching an optional filter. */
  list(filter?: AgentFilter): AgentRole[];
  /** Discover an agent from an A2A endpoint. */
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
 * Normalize an endpoint URL: remove trailing slash.
 */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Convert an A2AAgentCard to a partial AgentRole for registration.
 */
function agentCardToRole(card: A2AAgentCard): AgentRole {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AgentRole',
    metadata: {
      name: card.name,
      labels: { 'ai-sdlc.io/discovered': 'true' },
      annotations: { 'ai-sdlc.io/discovery-url': card.url },
    },
    spec: {
      role: card.description ?? card.name,
      goal: card.description ?? card.name,
      tools: card.tools ?? [],
      skills:
        card.skills?.map((s) => ({
          id: s.id,
          description: s.description ?? s.id,
          tags: s.tags,
        })) ?? [],
      handoffs: [],
    },
  } as unknown as AgentRole;
}

/**
 * Create a stub agent card fetcher backed by a static map.
 * Useful for testing without network access.
 */
export function createStubAgentCardFetcher(cards: Map<string, A2AAgentCard>): AgentCardFetcher {
  return {
    async fetch(url: string): Promise<A2AAgentCard | null> {
      const normalized = normalizeEndpoint(url);
      const wellKnown = `${normalized}/.well-known/agent.json`;
      // Try well-known URL first, then normalized, then original
      const card = cards.get(wellKnown) ?? cards.get(normalized) ?? cards.get(url);
      return card ?? null;
    },
  };
}

/**
 * Create an HTTP-based agent card fetcher using global fetch.
 */
export function createHttpAgentCardFetcher(): AgentCardFetcher {
  return {
    async fetch(url: string): Promise<A2AAgentCard | null> {
      try {
        const normalized = normalizeEndpoint(url);
        const response = await globalThis.fetch(`${normalized}/.well-known/agent.json`);
        if (!response.ok) return null;
        return (await response.json()) as A2AAgentCard;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Create an in-memory agent discovery service with optional A2A fetcher.
 */
export function createAgentDiscovery(options?: { fetcher?: AgentCardFetcher }): AgentDiscovery {
  const agents = new Map<string, AgentRole>();
  const fetcher = options?.fetcher;

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

    async discover(endpoint: string): Promise<AgentRole | undefined> {
      if (!fetcher) return undefined;

      const card = await fetcher.fetch(endpoint);
      if (!card) return undefined;

      const role = agentCardToRole(card);
      agents.set(role.metadata.name, role);
      return role;
    },
  };
}
