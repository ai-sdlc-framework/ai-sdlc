import { describe, it, expect, vi } from 'vitest';
import { executeOrchestration, validateHandoff } from './executor.js';
import type { TaskFn } from './executor.js';
import { sequential, parallel, hybrid, hierarchical, swarm } from './orchestration.js';
import type { AgentRole } from '../core/types.js';
import { API_VERSION } from '../core/types.js';

function makeAgent(name: string, overrides: Partial<AgentRole['spec']> = {}): AgentRole {
  return {
    apiVersion: API_VERSION,
    kind: 'AgentRole',
    metadata: { name },
    spec: {
      role: name,
      goal: `Goal of ${name}`,
      tools: ['tool-a'],
      ...overrides,
    },
  };
}

function agentMap(...agents: AgentRole[]): Map<string, AgentRole> {
  return new Map(agents.map((a) => [a.metadata.name, a]));
}

describe('executeOrchestration()', () => {
  describe('sequential', () => {
    it('executes steps in order', async () => {
      const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
      const plan = sequential(agents);
      const order: string[] = [];
      const taskFn: TaskFn = async (agent) => {
        order.push(agent.metadata.name);
        return `${agent.metadata.name}-result`;
      };

      const result = await executeOrchestration(plan, agentMap(...agents), taskFn);
      expect(result.success).toBe(true);
      expect(order).toEqual(['a', 'b', 'c']);
    });

    it('passes output from one step to next', async () => {
      const agents = [makeAgent('a'), makeAgent('b')];
      const plan = sequential(agents);
      const taskFn: TaskFn = async (agent, input) => {
        if (agent.metadata.name === 'a') return 42;
        return `received-${input}`;
      };

      const result = await executeOrchestration(plan, agentMap(...agents), taskFn);
      expect(result.stepResults[1].output).toBe('received-42');
    });

    it('propagates failure to dependent steps', async () => {
      const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
      const plan = sequential(agents);
      const taskFn: TaskFn = async (agent) => {
        if (agent.metadata.name === 'a') throw new Error('boom');
        return 'ok';
      };

      const result = await executeOrchestration(plan, agentMap(...agents), taskFn);
      expect(result.success).toBe(false);
      expect(result.stepResults[0].state).toBe('failed');
      expect(result.stepResults[0].error).toBe('boom');
      expect(result.stepResults[1].state).toBe('failed');
      expect(result.stepResults[1].error).toBe('Dependency failed');
      expect(result.stepResults[2].state).toBe('failed');
    });
  });

  describe('parallel', () => {
    it('runs all agents concurrently', async () => {
      const agents = [makeAgent('x'), makeAgent('y'), makeAgent('z')];
      const plan = parallel(agents);
      const started: string[] = [];
      const taskFn: TaskFn = async (agent) => {
        started.push(agent.metadata.name);
        return `${agent.metadata.name}-done`;
      };

      const result = await executeOrchestration(plan, agentMap(...agents), taskFn);
      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(3);
      expect(result.stepResults.every((r) => r.state === 'completed')).toBe(true);
    });

    it('one failure does not block others', async () => {
      const agents = [makeAgent('x'), makeAgent('y')];
      const plan = parallel(agents);
      const taskFn: TaskFn = async (agent) => {
        if (agent.metadata.name === 'x') throw new Error('fail');
        return 'ok';
      };

      const result = await executeOrchestration(plan, agentMap(...agents), taskFn);
      expect(result.success).toBe(false);
      expect(result.stepResults.find((r) => r.agent === 'x')?.state).toBe('failed');
      expect(result.stepResults.find((r) => r.agent === 'y')?.state).toBe('completed');
    });
  });

  describe('hybrid', () => {
    it('runs dispatcher first, then specialists', async () => {
      const dispatch = makeAgent('dispatcher');
      const specs = [makeAgent('spec-a'), makeAgent('spec-b')];
      const plan = hybrid(dispatch, specs);
      const order: string[] = [];
      const taskFn: TaskFn = async (agent) => {
        order.push(agent.metadata.name);
        return 'done';
      };

      const result = await executeOrchestration(plan, agentMap(dispatch, ...specs), taskFn);
      expect(result.success).toBe(true);
      expect(order[0]).toBe('dispatcher');
      expect(order.slice(1).sort()).toEqual(['spec-a', 'spec-b']);
    });

    it('dispatcher failure prevents specialists from running', async () => {
      const dispatch = makeAgent('dispatcher');
      const specs = [makeAgent('spec-a')];
      const plan = hybrid(dispatch, specs);
      const taskFn: TaskFn = async (agent) => {
        if (agent.metadata.name === 'dispatcher') throw new Error('down');
        return 'ok';
      };

      const result = await executeOrchestration(plan, agentMap(dispatch, ...specs), taskFn);
      expect(result.success).toBe(false);
      expect(result.stepResults.find((r) => r.agent === 'spec-a')?.state).toBe('failed');
    });
  });

  describe('hierarchical', () => {
    it('runs manager then workers', async () => {
      const mgr = makeAgent('manager');
      const workers = [makeAgent('w1'), makeAgent('w2')];
      const plan = hierarchical(mgr, workers);
      const order: string[] = [];
      const taskFn: TaskFn = async (agent) => {
        order.push(agent.metadata.name);
        return 'done';
      };

      const result = await executeOrchestration(plan, agentMap(mgr, ...workers), taskFn);
      expect(result.success).toBe(true);
      expect(order[0]).toBe('manager');
    });
  });

  describe('swarm', () => {
    it('respects handoff-derived dependencies', async () => {
      const a = makeAgent('writer', {
        handoffs: [{ target: 'reviewer', trigger: 'code-complete' }],
      });
      const b = makeAgent('reviewer');
      const plan = swarm([a, b]);
      const order: string[] = [];
      const taskFn: TaskFn = async (agent) => {
        order.push(agent.metadata.name);
        return 'ok';
      };

      const result = await executeOrchestration(plan, agentMap(a, b), taskFn);
      expect(result.success).toBe(true);
      expect(order).toEqual(['writer', 'reviewer']);
    });
  });

  describe('edge cases', () => {
    it('handles empty plan', async () => {
      const plan = { pattern: 'sequential' as const, steps: [] };
      const taskFn: TaskFn = vi.fn();
      const result = await executeOrchestration(plan, new Map(), taskFn);
      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(0);
    });

    it('fails gracefully when agent not found', async () => {
      const plan = { pattern: 'sequential' as const, steps: [{ agent: 'ghost' }] };
      const taskFn: TaskFn = vi.fn();
      const result = await executeOrchestration(plan, new Map(), taskFn);
      expect(result.success).toBe(false);
      expect(result.stepResults[0].error).toContain('not found');
    });

    it('handles single agent plan', async () => {
      const agent = makeAgent('solo');
      const plan = sequential([agent]);
      const taskFn: TaskFn = async () => 'result';
      const result = await executeOrchestration(plan, agentMap(agent), taskFn);
      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(1);
    });
  });
});

describe('validateHandoff()', () => {
  it('returns null for valid handoff without contract', () => {
    const from = makeAgent('a', {
      handoffs: [{ target: 'b', trigger: 'done' }],
    });
    const to = makeAgent('b');
    expect(validateHandoff(from, to, {})).toBeNull();
  });

  it('returns null for valid handoff with all required fields', () => {
    const from = makeAgent('a', {
      handoffs: [
        {
          target: 'b',
          trigger: 'done',
          contract: { schema: 'handoff.json', requiredFields: ['summary', 'files'] },
        },
      ],
    });
    const to = makeAgent('b');
    expect(validateHandoff(from, to, { summary: 'test', files: ['a.ts'] })).toBeNull();
  });

  it('returns error when no handoff declaration exists', () => {
    const from = makeAgent('a');
    const to = makeAgent('b');
    const err = validateHandoff(from, to, {});
    expect(err).not.toBeNull();
    expect(err!.message).toContain('No handoff declaration');
  });

  it('returns error when required fields are missing', () => {
    const from = makeAgent('a', {
      handoffs: [
        {
          target: 'b',
          trigger: 'done',
          contract: { schema: 'handoff.json', requiredFields: ['summary', 'files'] },
        },
      ],
    });
    const to = makeAgent('b');
    const err = validateHandoff(from, to, { summary: 'test' });
    expect(err).not.toBeNull();
    expect(err!.message).toContain('files');
  });

  it('returns error when handoff targets wrong agent', () => {
    const from = makeAgent('a', {
      handoffs: [{ target: 'c', trigger: 'done' }],
    });
    const to = makeAgent('b');
    const err = validateHandoff(from, to, {});
    expect(err).not.toBeNull();
  });
});
