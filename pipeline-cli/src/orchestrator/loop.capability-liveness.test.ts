/**
 * The tick calls the optional capability liveness adapter and never lets it, or a
 * Decision-filing failure, stop it from dispatching (RFC-0049 section 9.3).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityStateRow } from '@ai-sdlc/reference';
import type { OrchestratorEvent } from './events.js';
import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import { runCapabilityLiveness } from './capability-liveness.js';
import { listDecisions } from '../decisions/index.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-loop-capability-'));
});
afterEach(() => {
  removeFixtureDir(dir);
});

function build(extra: Partial<OrchestratorAdapters>) {
  const events: OrchestratorEvent[] = [];
  const warnings: string[] = [];
  const adapters: OrchestratorAdapters = {
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
    artifactsDir: dir,
    ...extra,
  };
  return { adapters, events, warnings };
}

const degradedRow: CapabilityStateRow = {
  id: 'dor.stage-b',
  status: 'degraded',
  counts: { live: 0, shadow: 0, degraded: 3 },
  unregistered: false,
};

describe('runOrchestratorTick capability liveness hook', () => {
  it('files a Decision for a degraded required capability and still completes the tick', async () => {
    const config = defaultOrchestratorConfig({ workDir: dir, maxConcurrent: 1, maxTicks: 1 });
    const { adapters, events } = build({
      capabilityLiveness: (ctx, emit) =>
        runCapabilityLiveness({
          ...ctx,
          emit,
          readRequired: () => ['dor.stage-b'],
          readState: () => [degradedRow],
        }),
    });
    await runOrchestratorTick(config, adapters, 2);
    expect(events.find((e) => e.type === 'CapabilityDegraded')).toMatchObject({
      tick: 2,
      capabilityId: 'dor.stage-b',
    });
    expect(listDecisions({ workDir: dir }).decisions).toHaveLength(1);
    expect(events.some((e) => e.type === 'OrchestratorTick')).toBe(true);
  });

  it('dispatches normally when Decision filing throws', async () => {
    const config = defaultOrchestratorConfig({ workDir: dir, maxConcurrent: 1, maxTicks: 1 });
    const frontier = vi.fn(() => []);
    const { adapters, events, warnings } = build({
      frontier,
      capabilityLiveness: () => {
        throw new Error('decision log unwritable');
      },
    });
    await expect(runOrchestratorTick(config, adapters, 1)).resolves.toBeDefined();
    expect(frontier).toHaveBeenCalled();
    expect(warnings.some((w) => w.includes('capability liveness failed'))).toBe(true);
    expect(events.some((e) => e.type === 'OrchestratorTick')).toBe(true);
  });

  it('does nothing when no adapter is set', async () => {
    const config = defaultOrchestratorConfig({ workDir: dir, maxConcurrent: 1, maxTicks: 1 });
    const { adapters, events } = build({});
    await runOrchestratorTick(config, adapters, 1);
    expect(events.some((e) => e.type === 'CapabilityDegraded')).toBe(false);
  });
});
