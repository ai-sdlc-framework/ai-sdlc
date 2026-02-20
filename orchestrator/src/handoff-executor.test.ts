import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandoffExecutor } from './handoff-executor.js';
import type { AgentRole, StepResult, Handoff } from '@ai-sdlc/reference';
import type { StateStore } from './state/store.js';

function makeAgent(name: string, handoffs?: AgentRole['spec']['handoffs']): AgentRole {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AgentRole',
    metadata: { name },
    spec: {
      role: 'developer',
      goal: `Agent ${name} goal`,
      tools: ['read', 'write'],
      skills: [],
      constraints: {
        maxFilesPerChange: 10,
        requireTests: true,
        blockedPaths: [],
      },
      handoffs: handoffs ?? [],
    },
  } as AgentRole;
}

function makeStepResult(output: unknown, agent = 'agent-a'): StepResult {
  return {
    agent,
    state: 'completed',
    output,
  } as StepResult;
}

describe('HandoffExecutor', () => {
  let mockStore: {
    saveHandoffEvent: ReturnType<typeof vi.fn>;
    getHandoffEvents: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockStore = {
      saveHandoffEvent: vi.fn(),
      getHandoffEvents: vi.fn().mockReturnValue([]),
    };
  });

  describe('executeHandoff', () => {
    it('succeeds when handoff contract is satisfied', () => {
      const from = makeAgent('agent-a', [
        {
          target: 'agent-b',
          trigger: 'on-complete',
          contract: { requiredFields: ['summary'], schema: '' },
        } satisfies Handoff,
      ]);
      const to = makeAgent('agent-b');
      const step = makeStepResult({ summary: 'All good' });

      const executor = new HandoffExecutor({
        stateStore: mockStore as unknown as StateStore,
        runId: 'test-run-1',
      });
      const result = executor.executeHandoff(from, to, step);

      expect(result.success).toBe(true);
      expect(result.payload).toBeDefined();
      expect(result.payload!.fromAgent).toBe('agent-a');
      expect(result.payload!.toAgent).toBe('agent-b');
      expect(result.payload!.data).toEqual({ summary: 'All good' });
    });

    it('fails when required fields are missing', () => {
      const from = makeAgent('agent-a', [
        {
          target: 'agent-b',
          trigger: 'on-complete',
          contract: { requiredFields: ['summary', 'details'], schema: '' },
        } satisfies Handoff,
      ]);
      const to = makeAgent('agent-b');
      const step = makeStepResult({ summary: 'partial' });

      const executor = new HandoffExecutor({ stateStore: mockStore as unknown as StateStore });
      const result = executor.executeHandoff(from, to, step);

      expect(result.success).toBe(false);
      expect(result.error).toContain('details');
      expect(result.validationError).toBeDefined();
    });

    it('fails when no handoff declaration exists', () => {
      const from = makeAgent('agent-a'); // no handoffs
      const to = makeAgent('agent-b');
      const step = makeStepResult({ data: 1 });

      const executor = new HandoffExecutor({ stateStore: mockStore as unknown as StateStore });
      const result = executor.executeHandoff(from, to, step);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No handoff declaration');
    });

    it('records audit event on success', () => {
      const from = makeAgent('agent-a', [
        {
          target: 'agent-b',
          trigger: 'on-complete',
          contract: { requiredFields: [], schema: '' },
        } satisfies Handoff,
      ]);
      const to = makeAgent('agent-b');
      const step = makeStepResult({ result: 'ok' });

      const executor = new HandoffExecutor({
        stateStore: mockStore as unknown as StateStore,
        runId: 'audit-run',
      });
      executor.executeHandoff(from, to, step);

      expect(mockStore.saveHandoffEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'audit-run',
          fromAgent: 'agent-a',
          toAgent: 'agent-b',
          validationResult: 'valid',
        }),
      );
    });

    it('records audit event on failure', () => {
      const from = makeAgent('agent-a');
      const to = makeAgent('agent-b');
      const step = makeStepResult({});

      const executor = new HandoffExecutor({ stateStore: mockStore as unknown as StateStore });
      executor.executeHandoff(from, to, step);

      expect(mockStore.saveHandoffEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          validationResult: 'invalid',
          errorMessage: expect.any(String),
        }),
      );
    });

    it('handles null step output', () => {
      const from = makeAgent('agent-a', [
        {
          target: 'agent-b',
          trigger: 'on-complete',
          contract: { requiredFields: [], schema: '' },
        } satisfies Handoff,
      ]);
      const to = makeAgent('agent-b');
      const step = makeStepResult(null);

      const executor = new HandoffExecutor({ stateStore: mockStore as unknown as StateStore });
      const result = executor.executeHandoff(from, to, step);
      expect(result.success).toBe(true);
    });

    it('works without state store', () => {
      const from = makeAgent('agent-a', [
        {
          target: 'agent-b',
          trigger: 'on-complete',
          contract: { requiredFields: [], schema: '' },
        } satisfies Handoff,
      ]);
      const to = makeAgent('agent-b');
      const step = makeStepResult({ ok: true });

      const executor = new HandoffExecutor(); // no store
      const result = executor.executeHandoff(from, to, step);
      expect(result.success).toBe(true);
    });
  });

  describe('executeChain', () => {
    it('chains handoffs through multiple agents', () => {
      const agents = [
        makeAgent('a', [
          {
            target: 'b',
            trigger: 'on-complete',
            contract: { requiredFields: [], schema: '' },
          } as Handoff,
        ]),
        makeAgent('b', [
          {
            target: 'c',
            trigger: 'on-complete',
            contract: { requiredFields: [], schema: '' },
          } as Handoff,
        ]),
        makeAgent('c'),
      ];
      const steps = [makeStepResult({ stage: 1 }, 'a'), makeStepResult({ stage: 2 }, 'b')];

      const executor = new HandoffExecutor({ stateStore: mockStore as unknown as StateStore });
      const results = executor.executeChain(agents, steps);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('stops chain on first failure', () => {
      const agents = [
        makeAgent('a'), // no handoff to b
        makeAgent('b', [
          {
            target: 'c',
            trigger: 'on-complete',
            contract: { requiredFields: [], schema: '' },
          } as Handoff,
        ]),
        makeAgent('c'),
      ];
      const steps = [makeStepResult({ stage: 1 }, 'a'), makeStepResult({ stage: 2 }, 'b')];

      const executor = new HandoffExecutor({ stateStore: mockStore as unknown as StateStore });
      const results = executor.executeChain(agents, steps);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });

    it('handles missing step result', () => {
      const agents = [makeAgent('a'), makeAgent('b')];

      const executor = new HandoffExecutor({ stateStore: mockStore as unknown as StateStore });
      const results = executor.executeChain(agents, []);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('No step result');
    });
  });

  describe('validatePayload', () => {
    it('validates payload against schema', () => {
      const executor = new HandoffExecutor();
      const result = executor.validatePayload(
        { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        { name: 'hello' },
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports schema validation errors', () => {
      const executor = new HandoffExecutor();
      const result = executor.validatePayload({ type: 'object', required: ['name'] }, {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('getHandoffEvents', () => {
    it('returns events from state store', () => {
      const events = [
        { id: 1, runId: 'r1', fromAgent: 'a', toAgent: 'b', validationResult: 'valid' },
      ];
      mockStore.getHandoffEvents.mockReturnValue(events);

      const executor = new HandoffExecutor({
        stateStore: mockStore as unknown as StateStore,
        runId: 'r1',
      });
      const result = executor.getHandoffEvents();

      expect(result).toEqual(events);
      expect(mockStore.getHandoffEvents).toHaveBeenCalledWith('r1');
    });

    it('returns empty array without state store', () => {
      const executor = new HandoffExecutor();
      expect(executor.getHandoffEvents()).toEqual([]);
    });
  });
});
