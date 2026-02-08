import { describe, it, expect } from 'vitest';
import { createAgentDiscovery, matchAgentBySkill } from './discovery.js';
import type { AgentRole } from '../core/types.js';

function makeAgent(name: string, overrides?: Partial<AgentRole['spec']>): AgentRole {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AgentRole',
    metadata: { name },
    spec: {
      role: overrides?.role ?? name,
      goal: 'test',
      tools: overrides?.tools ?? ['code-gen'],
      skills: overrides?.skills,
      handoffs: overrides?.handoffs,
    },
  };
}

describe('createAgentDiscovery', () => {
  it('registers and resolves agents', () => {
    const discovery = createAgentDiscovery();
    const agent = makeAgent('coder');
    discovery.register(agent);
    expect(discovery.resolve('coder')).toEqual(agent);
  });

  it('returns undefined for unknown agents', () => {
    const discovery = createAgentDiscovery();
    expect(discovery.resolve('missing')).toBeUndefined();
  });

  it('lists all agents', () => {
    const discovery = createAgentDiscovery();
    discovery.register(makeAgent('coder'));
    discovery.register(makeAgent('reviewer'));
    expect(discovery.list()).toHaveLength(2);
  });

  it('filters by role', () => {
    const discovery = createAgentDiscovery();
    discovery.register(makeAgent('code-coder', { role: 'coder' }));
    discovery.register(makeAgent('code-reviewer', { role: 'reviewer' }));
    const coders = discovery.list({ role: 'coder' });
    expect(coders).toHaveLength(1);
    expect(coders[0].metadata.name).toBe('code-coder');
  });

  it('filters by skill', () => {
    const discovery = createAgentDiscovery();
    discovery.register(
      makeAgent('ts-expert', {
        skills: [{ id: 'typescript', description: 'TS', tags: ['frontend', 'backend'] }],
      }),
    );
    discovery.register(
      makeAgent('py-expert', {
        skills: [{ id: 'python', description: 'Py', tags: ['ml', 'backend'] }],
      }),
    );
    const tsAgents = discovery.list({ skill: 'typescript' });
    expect(tsAgents).toHaveLength(1);
    expect(tsAgents[0].metadata.name).toBe('ts-expert');
  });

  it('filters by tool', () => {
    const discovery = createAgentDiscovery();
    discovery.register(makeAgent('a', { tools: ['git', 'npm'] }));
    discovery.register(makeAgent('b', { tools: ['docker', 'kubectl'] }));
    const gitAgents = discovery.list({ tool: 'git' });
    expect(gitAgents).toHaveLength(1);
    expect(gitAgents[0].metadata.name).toBe('a');
  });

  it('combines multiple filters', () => {
    const discovery = createAgentDiscovery();
    discovery.register(
      makeAgent('full-stack', {
        role: 'developer',
        tools: ['git', 'npm'],
        skills: [{ id: 'react', description: 'React', tags: ['frontend'] }],
      }),
    );
    discovery.register(
      makeAgent('devops', {
        role: 'operator',
        tools: ['git', 'docker'],
        skills: [{ id: 'kubernetes', description: 'K8s', tags: ['infra'] }],
      }),
    );
    const result = discovery.list({ role: 'developer', tool: 'git' });
    expect(result).toHaveLength(1);
    expect(result[0].metadata.name).toBe('full-stack');
  });

  it('discover returns undefined (stub)', async () => {
    const discovery = createAgentDiscovery();
    const result = await discovery.discover('https://agent.example.com');
    expect(result).toBeUndefined();
  });
});

describe('matchAgentBySkill', () => {
  it('matches by skill ID', () => {
    const agent = makeAgent('a', {
      skills: [{ id: 'typescript', description: 'TS' }],
    });
    expect(matchAgentBySkill(agent, 'typescript')).toBe(true);
  });

  it('matches by skill tag', () => {
    const agent = makeAgent('a', {
      skills: [{ id: 'react', description: 'React', tags: ['frontend', 'ui'] }],
    });
    expect(matchAgentBySkill(agent, 'frontend')).toBe(true);
  });

  it('returns false when no skills match', () => {
    const agent = makeAgent('a', {
      skills: [{ id: 'python', description: 'Py' }],
    });
    expect(matchAgentBySkill(agent, 'java')).toBe(false);
  });

  it('returns false when agent has no skills', () => {
    const agent = makeAgent('a');
    expect(matchAgentBySkill(agent, 'anything')).toBe(false);
  });

  it('is case-insensitive', () => {
    const agent = makeAgent('a', {
      skills: [{ id: 'TypeScript', description: 'TS' }],
    });
    expect(matchAgentBySkill(agent, 'typescript')).toBe(true);
  });
});
