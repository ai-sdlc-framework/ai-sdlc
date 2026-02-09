import { describe, it, expect } from 'vitest';
import {
  createPipelineDiscovery,
  findMatchingAgent,
  resolveAgentForIssue,
  matchAgentBySkill,
} from './discovery.js';
import type { AgentRole } from '@ai-sdlc/reference';

function makeAgent(name: string, skills: { id: string; tags?: string[] }[] = []): AgentRole {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AgentRole',
    metadata: { name },
    spec: {
      role: `${name}-role`,
      goal: `Handle ${name} tasks`,
      tools: ['Edit', 'Read'],
      skills: skills.map((s) => ({ id: s.id, description: s.id, tags: s.tags })),
    },
  } as unknown as AgentRole;
}

describe('Agent discovery', () => {
  it('registers and resolves agents', () => {
    const discovery = createPipelineDiscovery();
    const agent = makeAgent('fixer');
    discovery.register(agent);
    expect(discovery.resolve('fixer')).toBeDefined();
    expect(discovery.resolve('fixer')!.metadata.name).toBe('fixer');
  });

  it('lists all registered agents', () => {
    const discovery = createPipelineDiscovery();
    discovery.register(makeAgent('a'));
    discovery.register(makeAgent('b'));
    expect(discovery.list()).toHaveLength(2);
  });

  it('filters agents by skill', () => {
    const discovery = createPipelineDiscovery();
    discovery.register(makeAgent('debugger', [{ id: 'debugging', tags: ['fix', 'bug'] }]));
    discovery.register(makeAgent('writer', [{ id: 'documentation', tags: ['docs'] }]));

    const results = discovery.list({ skill: 'debugging' });
    expect(results).toHaveLength(1);
    expect(results[0].metadata.name).toBe('debugger');
  });

  it('matches agents by skill ID', () => {
    const agent = makeAgent('coder', [{ id: 'implementation' }]);
    expect(matchAgentBySkill(agent, 'implementation')).toBe(true);
    expect(matchAgentBySkill(agent, 'unknown')).toBe(false);
  });

  it('matches agents by skill tags', () => {
    const agent = makeAgent('tester', [{ id: 'qa', tags: ['testing', 'unit-tests'] }]);
    expect(matchAgentBySkill(agent, 'testing')).toBe(true);
    expect(matchAgentBySkill(agent, 'unit-tests')).toBe(true);
  });

  it('findMatchingAgent returns the first match', () => {
    const discovery = createPipelineDiscovery();
    discovery.register(makeAgent('a', [{ id: 'debugging' }]));
    discovery.register(makeAgent('b', [{ id: 'debugging' }]));

    const match = findMatchingAgent(discovery, 'debugging');
    expect(match).toBeDefined();
    expect(match!.metadata.name).toBe('a');
  });

  it('resolveAgentForIssue routes by label', () => {
    const discovery = createPipelineDiscovery();
    discovery.register(makeAgent('debugger', [{ id: 'debugging' }]));
    discovery.register(makeAgent('writer', [{ id: 'documentation' }]));

    const agent = resolveAgentForIssue(discovery, ['bug']);
    expect(agent).toBeDefined();
    expect(agent!.metadata.name).toBe('debugger');
  });

  it('resolveAgentForIssue falls back to first available', () => {
    const discovery = createPipelineDiscovery();
    discovery.register(makeAgent('generic'));

    const agent = resolveAgentForIssue(discovery, ['unknown-label']);
    expect(agent).toBeDefined();
    expect(agent!.metadata.name).toBe('generic');
  });
});
