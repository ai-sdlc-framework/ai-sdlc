/**
 * Growth of the committed attestation envelopes and transcript leaves (AISDLC-968).
 *
 * Both directories are committed by design and never pruned, so their size is a measured
 * ceiling in `docs/operations/tooling-limitations.md`. `cli-hierarchy status` prints it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CommandRunner } from './types.js';

export const GROWTH_DIRS = ['.ai-sdlc/attestations', '.ai-sdlc/transcript-leaves'] as const;
/** File count at which a pruning or archival RFC is opened (see the register row). */
export const GROWTH_FLOOR_FILES = 10_000;

export interface AttestationGrowth {
  files: number;
  bytes: number;
  /** Files added in the last 7 days; absent when git cannot say. */
  addedLastWeek?: number;
}

function walk(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = walk(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (e.isFile()) {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

/** Count and size of both directories under `cwd`; weekly growth from `git log`. */
export function attestationGrowth(cwd: string, run: CommandRunner): AttestationGrowth {
  let files = 0;
  let bytes = 0;
  for (const d of GROWTH_DIRS) {
    const abs = path.join(cwd, d);
    if (!existsSync(abs)) continue;
    const w = walk(abs);
    files += w.files;
    bytes += w.bytes;
  }
  const out: AttestationGrowth = { files, bytes };
  try {
    const r = run(
      'git',
      [
        'log',
        '--since=7 days ago',
        '--diff-filter=A',
        '--name-only',
        '--format=',
        '--',
        ...GROWTH_DIRS,
      ],
      { cwd },
    );
    if (r?.status === 0) {
      out.addedLastWeek = new Set(r.stdout.split('\n').filter((l) => l.trim())).size;
    }
  } catch {
    /* git missing: omit the weekly figure */
  }
  return out;
}

export function formatAttestationGrowth(g: AttestationGrowth): string {
  const mb = (g.bytes / 1_048_576).toFixed(1);
  const week = g.addedLastWeek === undefined ? 'unknown' : `${g.addedLastWeek}`;
  return `attestation and leaf files: ${g.files} (${mb} MB), added last 7 days: ${week}; floor ${GROWTH_FLOOR_FILES} files`;
}
