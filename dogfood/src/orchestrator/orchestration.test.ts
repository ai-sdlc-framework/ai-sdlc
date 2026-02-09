import { describe, it, expect } from 'vitest';
import {
  createPipelineOrchestration,
  executePipelineOrchestration,
  validatePipelineHandoffs,
  sequential,
  parallel,
  hybrid,
  hierarchical,
  validateHandoff,
  simpleSchemaValidate,
} from './orchestration.js';
import type { AgentRole } from '@ai-sdlc/reference';

function makeAgent(name: string, handoffs?: { target: string; trigger: string }[]): AgentRole {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AgentRole',
    metadata: { name },
    spec: {
      role: 'worker',
      goal: 'do work',
      tools: ['Read'],
      handoffs,
    },
  };
}

describe('Agent orchestration', () => {
  const agents = [makeAgent('agent-a'), makeAgent('agent-b'), makeAgent('agent-c')];

  describe('createPipelineOrchestration()', () => {
    it('creates sequential plan by default', () => {
      const plan = createPipelineOrchestration(agents);
      expect(plan.pattern).toBe('sequential');
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[1].dependsOn).toEqual(['agent-a']);
    });

    it('creates parallel plan', () => {
      const plan = createPipelineOrchestration(agents, 'parallel');
      expect(plan.pattern).toBe('parallel');
      expect(plan.steps.every((s) => !s.dependsOn)).toBe(true);
    });

    it('creates hybrid plan', () => {
      const plan = createPipelineOrchestration(agents, 'hybrid');
      expect(plan.pattern).toBe('hybrid');
      expect(plan.steps[0].agent).toBe('agent-a');
      expect(plan.steps[1].dependsOn).toEqual(['agent-a']);
    });

    it('creates hierarchical plan', () => {
      const plan = createPipelineOrchestration(agents, 'hierarchical');
      expect(plan.pattern).toBe('hierarchical');
      expect(plan.steps[0].agent).toBe('agent-a');
    });

    it('creates swarm plan', () => {
      const swarmAgents = [
        makeAgent('a', [{ target: 'b', trigger: 'always' }]),
        makeAgent('b', [{ target: 'c', trigger: 'always' }]),
        makeAgent('c'),
      ];
      const plan = createPipelineOrchestration(swarmAgents, 'swarm');
      expect(plan.pattern).toBe('swarm');
    });
  });

  describe('executePipelineOrchestration()', () => {
    it('executes a sequential plan', async () => {
      const plan = sequential(agents.slice(0, 2));
      const results: string[] = [];
      const result = await executePipelineOrchestration(plan, agents.slice(0, 2), async (agent) => {
        results.push(agent.metadata.name);
        return `done-${agent.metadata.name}`;
      });
      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(2);
    });

    it('executes a parallel plan', async () => {
      const plan = parallel(agents.slice(0, 2));
      const result = await executePipelineOrchestration(plan, agents.slice(0, 2), async (agent) => {
        return `done-${agent.metadata.name}`;
      });
      expect(result.success).toBe(true);
    });
  });

  describe('validatePipelineHandoffs()', () => {
    it('returns no errors for valid handoffs', () => {
      const agentsWithHandoffs = [
        makeAgent('a', [{ target: 'b', trigger: 'always' }]),
        makeAgent('b'),
      ];
      const errors = validatePipelineHandoffs(agentsWithHandoffs);
      expect(errors).toHaveLength(0);
    });

    it('returns errors for missing handoff targets', () => {
      const agentsWithBadHandoffs = [
        makeAgent('a', [{ target: 'nonexistent', trigger: 'always' }]),
        makeAgent('b'),
      ];
      const errors = validatePipelineHandoffs(agentsWithBadHandoffs);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('nonexistent');
    });
  });

  describe('reference re-exports', () => {
    it('sequential builds ordered plan', () => {
      const plan = sequential(agents);
      expect(plan.steps[2].dependsOn).toEqual(['agent-b']);
    });

    it('hybrid builds dispatcher pattern', () => {
      const plan = hybrid(agents[0], agents.slice(1));
      expect(plan.steps[0].agent).toBe('agent-a');
    });

    it('hierarchical builds manager pattern', () => {
      const plan = hierarchical(agents[0], agents.slice(1));
      expect(plan.steps[0].agent).toBe('agent-a');
    });

    it('validateHandoff checks handoff structure', () => {
      const from = makeAgent('a', [{ target: 'b', trigger: 'always' }]);
      const to = makeAgent('b');
      const result = validateHandoff(from, to, {});
      // null means valid (no error)
      expect(result).toBeNull();
    });

    it('simpleSchemaValidate validates basic schemas', () => {
      const errors = simpleSchemaValidate({ required: ['name'] }, { name: 'test' });
      expect(Array.isArray(errors)).toBe(true);
      expect(errors).toHaveLength(0);
    });
  });
});
