/**
 * The tick calls the optional weekly routing proposal adapter with the work and
 * artifacts directories, and never lets it disturb the tick.
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
  artifactsDir = mkdtempSync(join(tmpdir(), 'aisdlc-loop-routing-'));
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

describe('runOrchestratorTick routing proposal hook', () => {
  it('calls the adapter once per tick with the work and artifacts directories', async () => {
    const routingProposal = vi.fn(async () => undefined);
    const { adapters: a } = adapters({ routingProposal });
    await runOrchestratorTick(config, a, 1);
    expect(routingProposal).toHaveBeenCalledTimes(1);
    expect(routingProposal).toHaveBeenCalledWith({ workDir: '/tmp', artifactsDir });
  });

  it('defaults the artifacts directory to <workDir>/.ai-sdlc/artifacts, like the scorecard and replay', async () => {
    const saved = process.env.ARTIFACTS_DIR;
    delete process.env.ARTIFACTS_DIR;
    try {
      const routingProposal = vi.fn(async () => undefined);
      const { adapters: a } = adapters({ routingProposal, artifactsDir: undefined });
      const cfg = defaultOrchestratorConfig({
        workDir: artifactsDir,
        maxConcurrent: 1,
        maxTicks: 1,
      });
      await runOrchestratorTick(cfg, a, 1);
      expect(routingProposal).toHaveBeenCalledWith({
        workDir: artifactsDir,
        artifactsDir: join(artifactsDir, '.ai-sdlc', 'artifacts'),
      });
    } finally {
      if (saved === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = saved;
    }
  });

  it('logs a warning for a rejecting proposal and still completes the tick', async () => {
    const {
      adapters: a,
      events,
      warnings,
    } = adapters({
      routingProposal: async () => {
        throw new Error('catalog locked');
      },
    });
    await expect(runOrchestratorTick(config, a, 1)).resolves.toBeDefined();
    expect(events.some((e) => e.type === 'OrchestratorTick')).toBe(true);
    expect(warnings.join('\n')).toContain('routing proposal failed: catalog locked');
  });

  it('logs a non-Error rejection', async () => {
    const { adapters: a, warnings } = adapters({
      routingProposal: () => Promise.reject('plain'),
    });
    await runOrchestratorTick(config, a, 1);
    expect(warnings.join('\n')).toContain('routing proposal failed: plain');
  });

  it('does nothing when no adapter is set', async () => {
    const { adapters: a, warnings } = adapters({});
    await runOrchestratorTick(config, a, 1);
    expect(warnings).toEqual([]);
  });
});
