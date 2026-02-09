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

function makePipeline(stages: Pipeline['spec']['stages']): Pipeline {
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

  // ── Failure policy tests ────────────────────────────────────────────

  it('abort strategy fails pipeline on stage error', async () => {
    const taskFn = vi.fn().mockRejectedValue(new Error('build broke'));
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([
      { name: 'build', agent: 'builder', onFailure: { strategy: 'abort' } },
      { name: 'test', agent: 'tester' },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('error');
    expect(pipeline.status?.phase).toBe('Failed');
    // Should not have reached the test stage
    expect(taskFn).toHaveBeenCalledTimes(1);
  });

  it('continue strategy proceeds past failed stage', async () => {
    let callCount = 0;
    const taskFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('lint failed');
      return Promise.resolve('done');
    });
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([
      { name: 'lint', agent: 'linter', onFailure: { strategy: 'continue' } },
      { name: 'test', agent: 'tester' },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('success');
    expect(pipeline.status?.phase).toBe('Succeeded');
    expect(pipeline.status?.conditions?.some((c) => c.type === 'StageFailed')).toBe(true);
    expect(taskFn).toHaveBeenCalledTimes(2);
  });

  it('retry strategy re-executes up to maxRetries', async () => {
    let callCount = 0;
    const taskFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) throw new Error('flaky');
      return Promise.resolve('done');
    });
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([
      { name: 'build', agent: 'builder', onFailure: { strategy: 'retry', maxRetries: 3 } },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('success');
    expect(pipeline.status?.stageAttempts?.build).toBe(3);
  });

  it('retry strategy fails after exhausting retries', async () => {
    const taskFn = vi.fn().mockRejectedValue(new Error('always fails'));
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([
      { name: 'build', agent: 'builder', onFailure: { strategy: 'retry', maxRetries: 2 } },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('error');
    expect(pipeline.status?.phase).toBe('Failed');
    expect(pipeline.status?.conditions?.some((c) => c.type === 'RetriesExhausted')).toBe(true);
  });

  it('pause strategy suspends pipeline', async () => {
    const taskFn = vi.fn().mockRejectedValue(new Error('need human'));
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([
      { name: 'deploy', agent: 'deployer', onFailure: { strategy: 'pause' } },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('requeue-after');
    expect(pipeline.status?.phase).toBe('Suspended');
  });

  it('approval blocks execution when pending', async () => {
    const taskFn = vi.fn().mockResolvedValue('done');
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
      isApproved: () => false,
    });

    const pipeline = makePipeline([
      {
        name: 'review',
        agent: 'reviewer',
        approval: { required: true, blocking: true, timeout: 'PT24H', onTimeout: 'abort' },
      },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('requeue-after');
    expect(pipeline.status?.phase).toBe('Suspended');
    expect(pipeline.status?.pendingApproval?.stage).toBe('review');
  });

  it('approval allows execution when satisfied', async () => {
    const taskFn = vi.fn().mockResolvedValue('done');
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
      isApproved: () => true,
    });

    const pipeline = makePipeline([
      {
        name: 'review',
        agent: 'reviewer',
        approval: { required: true, blocking: true },
      },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('success');
    expect(pipeline.status?.phase).toBe('Succeeded');
  });

  it('requeue result returned for suspended pipeline', async () => {
    const taskFn = vi.fn().mockRejectedValue(new Error('fail'));
    const reconciler = createPipelineReconciler({
      resolveAgent: (name) => makeAgent(name),
      taskFn,
    });

    const pipeline = makePipeline([
      { name: 'deploy', agent: 'deployer', onFailure: { strategy: 'pause' } },
    ]);

    const result = await reconciler(pipeline);
    expect(result.type).toBe('requeue-after');
    if (result.type === 'requeue-after') {
      expect(result.delayMs).toBe(30_000);
    }
  });
});
