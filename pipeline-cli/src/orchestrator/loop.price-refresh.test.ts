/**
 * The tick calls the optional daily price refresh adapter, hands it the tick's
 * event emitter, and never lets it disturb the tick.
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
  artifactsDir = mkdtempSync(join(tmpdir(), 'aisdlc-loop-price-'));
});
afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

function adapters(extra: Partial<OrchestratorAdapters>): {
  adapters: OrchestratorAdapters;
  events: OrchestratorEvent[];
} {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    adapters: {
      logger: { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} },
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

describe('runOrchestratorTick price refresh hook', () => {
  it('passes the tick emitter so ModelPriceChanged is stamped with tick and runId', async () => {
    const priceRefresh = vi.fn(async (emit: (e: Omit<OrchestratorEvent, 'ts'>) => void) => {
      emit({
        type: 'ModelPriceChanged',
        model: 'm',
        tokenClass: 'input',
        oldPrice: 1,
        newPrice: 2,
      });
    });
    const { adapters: a, events } = adapters({ priceRefresh });
    await runOrchestratorTick(config, a, 3);
    expect(priceRefresh).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'ModelPriceChanged')).toMatchObject({
      tick: 3,
      runId: 'run-1',
      model: 'm',
    });
  });

  it('swallows a rejecting refresh and still completes the tick', async () => {
    const { adapters: a, events } = adapters({
      priceRefresh: async () => {
        throw new Error('network');
      },
    });
    await expect(runOrchestratorTick(config, a, 1)).resolves.toBeDefined();
    expect(events.some((e) => e.type === 'OrchestratorTick')).toBe(true);
  });

  it('does nothing when no refresh adapter is set', async () => {
    const { adapters: a, events } = adapters({});
    await runOrchestratorTick(config, a, 1);
    expect(events.some((e) => e.type === 'ModelPriceChanged')).toBe(false);
  });
});
