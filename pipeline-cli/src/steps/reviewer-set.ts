/**
 * Reviewer set resolver (AISDLC-617).
 *
 * Resolves whether a run should fan out the DEFAULT three reviewers
 * (code-reviewer, test-reviewer, security-reviewer) or the OPT-IN merged
 * two-reviewer set (correctness-reviewer, security-reviewer).
 *
 * ## Default is unchanged
 *
 * `resolveReviewerSetMode()` returns `'three'` unless EITHER:
 *   - the `AI_SDLC_REVIEWER_SET` env var is explicitly `'code-test-merged'`, OR
 *   - `<workDir>/.ai-sdlc/review-config.yaml` exists and sets
 *     `reviewerSet: code-test-merged`
 *
 * This task (AISDLC-617) does NOT flip the default — it only wires the
 * opt-in path so the merged reviewer can be A/B'd against the AISDLC-616
 * findings ledger before any permanent default change.
 *
 * Parsing intentionally avoids pulling in `js-yaml` for a single flat
 * field — mirrors the line-based reader in `pipeline-cli/src/dor/dor-config.ts`.
 *
 * @module steps/reviewer-set
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewerType } from '../types.js';

export type ReviewerSetMode = 'three' | 'code-test-merged';

/** The default three-reviewer set — UNCHANGED by AISDLC-617. */
export const THREE_REVIEWER_SET: readonly ReviewerType[] = [
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
] as const;

/** The opt-in merged two-reviewer set (AISDLC-617). Security stays separate. */
export const CODE_TEST_MERGED_REVIEWER_SET: readonly ReviewerType[] = [
  'correctness-reviewer',
  'security-reviewer',
] as const;

export interface ResolveReviewerSetOpts {
  /** Project root. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override env for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the effective `ReviewerSetMode`. Precedence (first match wins):
 *
 *   1. `AI_SDLC_REVIEWER_SET` env var (`'three'` | `'code-test-merged'`) —
 *      makes the flag A/B-able per-invocation without touching config files.
 *   2. `.ai-sdlc/review-config.yaml`'s `reviewerSet:` field.
 *   3. Default: `'three'`.
 */
export function resolveReviewerSetMode(opts: ResolveReviewerSetOpts = {}): ReviewerSetMode {
  const env = opts.env ?? process.env;
  const envValue = env.AI_SDLC_REVIEWER_SET;
  if (envValue === 'code-test-merged' || envValue === 'three') return envValue;

  const workDir = opts.workDir ?? process.cwd();
  const configPath = join(workDir, '.ai-sdlc', 'review-config.yaml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const mode = parseReviewerSetModeYaml(raw);
      if (mode) return mode;
    } catch {
      // Fall through to the default — a malformed config must never block
      // the pipeline; it just doesn't opt in.
    }
  }

  return 'three';
}

/**
 * Parse a `reviewerSet:` scalar field out of a review-config YAML string.
 * Public so tests can drive the parser without touching the filesystem.
 * Returns `null` when no valid field is found (caller falls back to default).
 */
export function parseReviewerSetModeYaml(yaml: string): ReviewerSetMode | null {
  const match = yaml.match(/^\s*reviewerSet:\s*['"]?(three|code-test-merged)['"]?\s*$/m);
  if (!match) return null;
  return match[1] as ReviewerSetMode;
}

/** Resolve the reviewer set mode straight to the concrete `ReviewerType[]`. */
export function resolveReviewerSet(opts: ResolveReviewerSetOpts = {}): ReviewerType[] {
  const mode = resolveReviewerSetMode(opts);
  return mode === 'code-test-merged' ? [...CODE_TEST_MERGED_REVIEWER_SET] : [...THREE_REVIEWER_SET];
}
