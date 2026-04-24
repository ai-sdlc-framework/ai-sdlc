#!/usr/bin/env node
/**
 * sa-calibrate — Phase 3 weight auto-calibration (RFC-0008 §B.8).
 *
 * Usage:
 *   sa-calibrate [--window-days N] [--shift-size N] [--dry-run]
 *
 * Prints a diff of current vs. proposed weights before persisting.
 * With `--dry-run`, no write to `sa_phase_weights` occurs.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import {
  DEFAULT_CONFIG_DIR_NAME,
  SAFeedbackStore,
  StateStore,
  resolveRepoRoot,
} from '@ai-sdlc/orchestrator';
import { autoCalibratePhaseWeights, renderCalibrationDiff } from '@ai-sdlc/orchestrator';

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
function hasFlag(argv: string[], flag: string): boolean {
  return argv.indexOf(flag) !== -1;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const windowDays = getArg(argv, '--window-days');
  const shiftSize = getArg(argv, '--shift-size');
  const dryRun = hasFlag(argv, '--dry-run');

  const workDir = await resolveRepoRoot();
  const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const store = StateStore.open(join(configDir, 'state.db'));
  try {
    const feedback = new SAFeedbackStore(store);

    // Dry-run: use an in-memory shadow store so we compute without writing.
    const targetStore = dryRun ? shadowFromRealStore(store) : store;
    const result = await autoCalibratePhaseWeights({
      feedback,
      stateStore: targetStore,
      windowDays: windowDays ? Number(windowDays) : undefined,
      shiftSize: shiftSize ? Number(shiftSize) : undefined,
    });
    console.log(renderCalibrationDiff(result));
    if (dryRun) {
      console.log('\n(--dry-run — no write to sa_phase_weights)');
    }
  } finally {
    store.close();
  }
}

/**
 * Build an in-memory StateStore seeded with the current sa_phase_weights
 * rows so a dry-run reports the correct `previous` weights without
 * persisting the computed diff.
 */
function shadowFromRealStore(real: StateStore): StateStore {
  const shadow = StateStore.open(':memory:');
  for (const dim of ['SA-1', 'SA-2'] as const) {
    const existing = real.getSaPhaseWeights(dim);
    if (existing) {
      shadow.upsertSaPhaseWeights({
        dimension: dim,
        wStructural: existing.wStructural,
        wLlm: existing.wLlm,
      });
    }
  }
  return shadow;
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('cli-sa-calibrate.js') ||
    process.argv[1].endsWith('cli-sa-calibrate.ts'));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

// Re-export helpers for in-process test coverage.
export { main as _main, shadowFromRealStore as _shadowFromRealStore };
