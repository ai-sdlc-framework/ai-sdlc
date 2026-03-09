/**
 * Orchestrator plugin lifecycle tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  OrchestratorPlugin,
  PluginContext,
  BeforeRunEvent,
  AfterRunEvent,
  RunErrorEvent,
} from './plugin.js';
import type { PipelineResult } from './execute.js';

// Mock executePipeline to avoid real adapter/runner setup
vi.mock('./execute.js', () => ({
  executePipeline: vi.fn(),
}));

// Mock loadConfig since status() uses it
vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => ({ version: '0.1.0', pipeline: {} })),
  loadConfigAsync: vi.fn(),
}));

import { executePipeline } from './execute.js';
import { Orchestrator } from './orchestrator.js';

const mockExecute = vi.mocked(executePipeline);

function makeResult(overrides?: Partial<PipelineResult>): PipelineResult {
  return {
    prUrl: 'https://github.com/org/repo/pull/1',
    filesChanged: ['src/index.ts'],
    promotionEligible: true,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

describe('Orchestrator plugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(makeResult());
  });

  it('initialize() is called with context during construction', async () => {
    const initFn = vi.fn<AnyFn>();
    const plugin: OrchestratorPlugin = { name: 'test', initialize: initFn };
    const orch = new Orchestrator({ plugins: [plugin] });

    // run() awaits _pluginsInitialized, so trigger it
    await orch.run('1');

    expect(initFn).toHaveBeenCalledOnce();
    const ctx = initFn.mock.calls[0][0] as PluginContext;
    expect(ctx).toHaveProperty('log');
    // No statePath => no store/trackers
    expect(ctx.store).toBeUndefined();
    expect(ctx.costTracker).toBeUndefined();
    expect(ctx.autonomyTracker).toBeUndefined();

    await orch.close();
  });

  it('beforeRun() is called before pipeline execution', async () => {
    const callOrder: string[] = [];
    const beforeFn = vi.fn<AnyFn>(() => {
      callOrder.push('beforeRun');
    });
    const plugin: OrchestratorPlugin = { name: 'test', beforeRun: beforeFn };
    mockExecute.mockImplementation(async () => {
      callOrder.push('execute');
      return makeResult();
    });

    const orch = new Orchestrator({ plugins: [plugin] });
    await orch.run('42');

    expect(beforeFn).toHaveBeenCalledOnce();
    const event = beforeFn.mock.calls[0][0] as BeforeRunEvent;
    expect(event.issueId).toBe('42');
    expect(event.runId).toMatch(/^run-/);
    expect(event.startedAt).toBeTruthy();

    expect(callOrder).toEqual(['beforeRun', 'execute']);
    await orch.close();
  });

  it('afterRun() is called on success with result and duration', async () => {
    const afterFn = vi.fn<AnyFn>();
    const plugin: OrchestratorPlugin = { name: 'test', afterRun: afterFn };
    const result = makeResult();
    mockExecute.mockResolvedValue(result);

    const orch = new Orchestrator({ plugins: [plugin] });
    await orch.run('10');

    expect(afterFn).toHaveBeenCalledOnce();
    const event = afterFn.mock.calls[0][0] as AfterRunEvent;
    expect(event.issueId).toBe('10');
    expect(event.result).toBe(result);
    expect(typeof event.durationMs).toBe('number');
    expect(event.durationMs).toBeGreaterThanOrEqual(0);

    await orch.close();
  });

  it('onError() is called on failure with error and duration', async () => {
    const errorFn = vi.fn<AnyFn>();
    const afterFn = vi.fn<AnyFn>();
    const plugin: OrchestratorPlugin = { name: 'test', onError: errorFn, afterRun: afterFn };
    const boom = new Error('pipeline failed');
    mockExecute.mockRejectedValue(boom);

    const orch = new Orchestrator({ plugins: [plugin] });
    await expect(orch.run('7')).rejects.toThrow('pipeline failed');

    expect(errorFn).toHaveBeenCalledOnce();
    const event = errorFn.mock.calls[0][0] as RunErrorEvent;
    expect(event.issueId).toBe('7');
    expect(event.error).toBe(boom);
    expect(typeof event.durationMs).toBe('number');

    // afterRun should NOT be called on failure
    expect(afterFn).not.toHaveBeenCalled();

    await orch.close();
  });

  it('shutdown() is called on close()', async () => {
    const shutdownFn = vi.fn();
    const plugin: OrchestratorPlugin = { name: 'test', shutdown: shutdownFn };
    const orch = new Orchestrator({ plugins: [plugin] });
    await orch.close();

    expect(shutdownFn).toHaveBeenCalledOnce();
  });

  it('plugin throwing in beforeRun() aborts the run', async () => {
    const plugin: OrchestratorPlugin = {
      name: 'blocker',
      beforeRun: vi.fn(() => {
        throw new Error('blocked by policy');
      }),
    };

    const orch = new Orchestrator({ plugins: [plugin] });
    await expect(orch.run('1')).rejects.toThrow('blocked by policy');

    // executePipeline should never be called
    expect(mockExecute).not.toHaveBeenCalled();

    await orch.close();
  });

  it('multiple plugins are called in registration order', async () => {
    const order: string[] = [];
    const pluginA: OrchestratorPlugin = {
      name: 'plugin-a',
      beforeRun: vi.fn(() => {
        order.push('a');
      }),
    };
    const pluginB: OrchestratorPlugin = {
      name: 'plugin-b',
      beforeRun: vi.fn(() => {
        order.push('b');
      }),
    };

    const orch = new Orchestrator({ plugins: [pluginA, pluginB] });
    await orch.run('1');

    expect(order).toEqual(['a', 'b']);
    await orch.close();
  });

  it('missing hooks are safely skipped', async () => {
    // Plugin with only a name — no hooks implemented
    const minimal: OrchestratorPlugin = { name: 'minimal' };

    const orch = new Orchestrator({ plugins: [minimal] });
    // Should not throw
    const result = await orch.run('1');
    expect(result).toEqual(makeResult());
    await orch.close();
  });
});
