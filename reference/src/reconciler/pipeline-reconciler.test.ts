import { describe, it, expect, vi } from 'vitest';
import { createPipelineReconciler } from './pipeline-reconciler.js';
import type { Pipeline, AgentRole } from '../core/types.js';

const API = 'ai-sdlc.io/v1alpha1' as const;

function makeAgent(name: string): AgentRole {
  return {
    apiVersion: API,
    kind: 'AgentRole',
    metadata: { name },
    spec: { role: name, goal: 'test', tools: ['code-editor'] },
  };
}

function makePipeline(stages: { name: string; agent?: string }[]): Pipeline {
  return {
    apiVersion: API,
    kind: 'Pipeline',
    metadata: { name: 'test-pipeline' },
    spec: {
      triggers: [{ event: 'push' }],
      providers: {},
      stages,
    },
    status: { phase: 'Pending' },
  };
}

describe('createPipelineReconciler', () => {
  it('succeeds with all stages completing', async () => {
    const taskFn = vi.fn().mockResolvedValue('done');
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([
      { name: 'build', agent: 'builder' },
      { name: 'test', agent: 'tester' },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('success');
    expect(pipeline.status?.phase).toBe('Succeeded');
    expect(taskFn).toHaveBeenCalledTimes(2);
  });

  it('fails when an agent is not found', async () => {
    const reconciler = createPipelineReconciler({
      resolveAgent: () => undefined,
      taskFn: vi.fn(),
    });

    const pipeline = makePipeline([{ name: 'build', agent: 'missing' }]);
    const result = await reconciler(pipeline);
    expect(result.type).toBe('error');
  });

  it('succeeds for pipeline with no agent stages', async () => {
    const reconciler = createPipelineReconciler({
      resolveAgent: () => undefined,
      taskFn: vi.fn(),
    });

    const pipeline = makePipeline([{ name: 'manual-review' }]);
    const result = await reconciler(pipeline);
    expect(result.type).toBe('success');
  });

  it('reports failure when a step throws', async () => {
    const taskFn = vi.fn().mockRejectedValue(new Error('Build failed'));
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([{ name: 'build', agent: 'builder' }]);
    const result = await reconciler(pipeline);
    expect(result.type).toBe('error');
    expect(pipeline.status?.phase).toBe('Failed');
  });

  it('succeeds for empty stages', async () => {
    const reconciler = createPipelineReconciler({
      resolveAgent: () => undefined,
      taskFn: vi.fn(),
    });

    const pipeline = makePipeline([]);
    const result = await reconciler(pipeline);
    expect(result.type).toBe('success');
  });

  it('passes execution options through', async () => {
    const taskFn = vi.fn().mockResolvedValue('done');
    const authorize = vi.fn().mockReturnValue({ allowed: true });
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
      executionOptions: { authorize },
    });

    const pipeline = makePipeline([{ name: 'build', agent: 'builder' }]);
    await reconciler(pipeline);
    expect(authorize).toHaveBeenCalled();
  });
});
