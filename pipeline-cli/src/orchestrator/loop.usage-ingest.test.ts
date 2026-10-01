import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'loop-usage-'));
  vi.stubEnv('AI_SDLC_SWEEP_DISABLED', '1');
  vi.stubEnv('AI_SDLC_AUTONOMOUS_ORCHESTRATOR', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workDir, { recursive: true, force: true });
});

function adapters(extra: Partial<OrchestratorAdapters>): OrchestratorAdapters {
  return {
    frontier: () => [],
    parentBranchGuard: async () => {},
    artifactsDir: join(workDir, 'artifacts'),
    logger: { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} },
    ...extra,
  };
}

describe('orchestrator tick usage ingestion', () => {
  it('triggers ingestion once at tick start', async () => {
    const usageIngest = vi.fn();
    await runOrchestratorTick(defaultOrchestratorConfig({ workDir }), adapters({ usageIngest }), 1);
    expect(usageIngest).toHaveBeenCalledTimes(1);
  });

  it('swallows an ingestion trigger that throws', async () => {
    const usageIngest = vi.fn(() => {
      throw new Error('cannot launch');
    });
    const tick = await runOrchestratorTick(
      defaultOrchestratorConfig({ workDir }),
      adapters({ usageIngest }),
      1,
    );
    expect(usageIngest).toHaveBeenCalled();
    expect(tick).toBeDefined();
  });
});
