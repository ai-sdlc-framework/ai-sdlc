/**
 * Integrity seal for a staged review's run state.
 *
 * The run directory is plain files the later phases re-read. The model-driven stages
 * (planner, synthesizer) read developer-controlled text, so nothing in that directory may
 * be trusted just because it is there. Each phase therefore prints a SHA-256 seal over the
 * control files it has produced, the coordinator carries the seal in its own variables,
 * and the next phase recomputes it from disk and refuses to run on a mismatch. The caller
 * answers a mismatch by falling back to the existing reviewer set.
 *
 * @module review-staged/seal
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_FILES } from './run-store.js';

export type SealStage = 'prepare' | 'plan' | 'execute';

const PREPARE_FILES = [
  RUN_FILES.task,
  RUN_FILES.config,
  RUN_FILES.riskMap,
  RUN_FILES.baseline,
  RUN_FILES.fallbackPlan,
];
const PLAN_FILES = [...PREPARE_FILES, RUN_FILES.plan];
const EXECUTE_FILES = [...PLAN_FILES, RUN_FILES.evidence, RUN_FILES.executeLeaves];

const FILES: Record<SealStage, readonly string[]> = {
  prepare: PREPARE_FILES,
  plan: PLAN_FILES,
  execute: EXECUTE_FILES,
};

/** Thrown when the run state does not match the seal the coordinator carried. */
export class StagedIntegrityError extends Error {
  readonly reason = 'integrity-check-failed';
  constructor(detail: string) {
    super(detail);
    this.name = 'StagedIntegrityError';
  }
}

/** SHA-256 over the names and bytes of the files sealed at `stage`. */
export async function computeSeal(runDir: string, stage: SealStage): Promise<string> {
  const h = createHash('sha256');
  for (const file of FILES[stage]) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(runDir, file));
    } catch {
      throw new StagedIntegrityError(`run state file ${file} is missing`);
    }
    h.update(`${file}\0${bytes.length}\0`);
    h.update(bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

/** Throw unless `seal` matches the files on disk. A missing seal fails closed. */
export async function assertSeal(
  runDir: string,
  stage: SealStage,
  seal: string | undefined,
): Promise<void> {
  if (!seal) throw new StagedIntegrityError(`no ${stage} seal was supplied`);
  const actual = await computeSeal(runDir, stage);
  if (actual !== seal) {
    throw new StagedIntegrityError(
      `the run state no longer matches its ${stage} seal; it was changed after it was written`,
    );
  }
}
