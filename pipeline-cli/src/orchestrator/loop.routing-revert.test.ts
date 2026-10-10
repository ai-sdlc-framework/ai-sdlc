/**
 * The tick calls the optional routing revert adapter with the work and
 * artifacts directories and the tick's event emitter, and never lets it
 * disturb the tick.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from './events.js';
import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';

let artifactsDir: string;
beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'aisdlc-loop-revert-'));
});
afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

function adapters(extra: Partial<OrchestratorAdapters>): {
  adapters: OrchestratorAdapters;
  events: OrchestratorEvent[];
  warnings: string[];
} {
  const events: OrchestratorEvent[] = [];
  const warnings: string[] = [];
  return {
    events,
    warnings,
    adapters: {
      logger: {
        info: () => {},
        warn: (m) => void warnings.push(m),
        error: () => {},
        progress: () => {},
      },
      frontier: () => [],
      escalate: async () => {},
      emitEvent: (e) => void events.push(e),
      runId: 'run-1',
      parentBranchGuard: async () => {},
      artifactsDir,
      ...extra,
    },
  };
}

const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });

describe('runOrchestratorTick routing revert hook', () => {
  it('calls the adapter once per tick with the directories and a stamping emitter', async () => {
    const routingRevert = vi.fn(
      async (_ctx: unknown, emit: (e: Omit<OrchestratorEvent, 'ts'>) => void) => {
        emit({ type: 'ModelRoutingOverrideApplied', role: 'developer', taskClass: '*' });
      },
    );
    const { adapters: a, events } = adapters({ routingRevert });
    await runOrchestratorTick(config, a, 4);
    expect(routingRevert).toHaveBeenCalledTimes(1);
    expect(routingRevert.mock.calls[0]?.[0]).toEqual({ workDir: '/tmp', artifactsDir });
    expect(events.find((e) => e.type === 'ModelRoutingOverrideApplied')).toMatchObject({
      tick: 4,
      runId: 'run-1',
      role: 'developer',
    });
  });

  it('logs a warning for a rejecting adapter and still completes the tick', async () => {
    const {
      adapters: a,
      events,
      warnings,
    } = adapters({
      routingRevert: async () => {
        throw new Error('boom');
      },
    });
    await expect(runOrchestratorTick(config, a, 1)).resolves.toBeDefined();
    expect(warnings.some((w) => w.includes('routing revert failed: boom'))).toBe(true);
    expect(events.some((e) => e.type === 'OrchestratorTick')).toBe(true);
  });

  it('does nothing when no adapter is set', async () => {
    const { adapters: a, warnings } = adapters({});
    await runOrchestratorTick(config, a, 1);
    expect(warnings).toEqual([]);
  });
});
