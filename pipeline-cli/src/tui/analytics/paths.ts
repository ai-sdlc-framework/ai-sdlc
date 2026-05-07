/**
 * Path helpers for the operator-throughput analytics artifacts
 * (RFC-0023 §10 / AISDLC-178.6).
 *
 * Three append-only JSONL streams under `$ARTIFACTS_DIR/_operator/`:
 *   - decisions.jsonl    — Needs Clarification → other-status transitions
 *   - pr-decisions.jsonl — operator PR review actions (merge / dismiss / comment)
 *   - interactions.jsonl — TUI navigation events (default ON, opt-OUT via env)
 *
 * Files are NOT date-rotated (operator-decision volume is low — a single
 * operator's lifetime decision log fits comfortably in one file).
 */

import { join } from 'node:path';

import { resolveArtifactsDir } from '../sources/types.js';

/** Directory holding all `_operator/*.jsonl` streams. */
export function operatorDirPath(artifactsDir?: string): string {
  return join(resolveArtifactsDir({ artifactsDir }), '_operator');
}

export function decisionsPath(artifactsDir?: string): string {
  return join(operatorDirPath(artifactsDir), 'decisions.jsonl');
}

export function prDecisionsPath(artifactsDir?: string): string {
  return join(operatorDirPath(artifactsDir), 'pr-decisions.jsonl');
}

export function interactionsPath(artifactsDir?: string): string {
  return join(operatorDirPath(artifactsDir), 'interactions.jsonl');
}
