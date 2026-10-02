/**
 * Staged-review limits, read from the BASE ref only.
 *
 * `.ai-sdlc/review-config.yaml` is read with `git show <baseRef>:<path>`, never
 * from the working tree: a pull request must not widen the command allowlist or
 * relax the limits it is reviewed under. Any missing or malformed value falls
 * back to the documented default for that field, and a malformed allowlist
 * falls back to the default allowlist, never to something broader.
 *
 * Config shape:
 *
 *   staged:
 *     executorCommandAllowlist: ['pnpm test', 'pnpm lint', 'pnpm typecheck']
 *     riskThreshold: 0.5        # 0..1, hunks at or above are high risk
 *     maxProbes: 40             # 1..200
 *     maxTargetBytes: 32000     # total serialized probe-target size
 *     evidenceBudgetBytes: 200000   # total evidence the executors may return
 *
 * @module review-plan/config
 */

import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import type { PlanLimits } from './types.js';

export const REVIEW_CONFIG_PATH = '.ai-sdlc/review-config.yaml';

export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = [
  'pnpm test',
  'pnpm lint',
  'pnpm typecheck',
];
export const DEFAULT_RISK_THRESHOLD = 0.5;
export const DEFAULT_MAX_PROBES = 40;
export const DEFAULT_MAX_TARGET_BYTES = 32_000;
export const DEFAULT_EVIDENCE_BUDGET_BYTES = 200_000;

const HARD_MAX_PROBES = 200;
const MAX_ALLOWLIST_ENTRIES = 20;
const MAX_COMMAND_LENGTH = 200;
const MAX_CONFIG_BYTES = 256 * 1024;

/** Characters a command may contain: no shell metacharacters, quotes, or separators. */
const SAFE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._:@/=-]*( [A-Za-z0-9._:@/=-]+)*$/;

export function isSafeCommandString(command: string): boolean {
  return command.length <= MAX_COMMAND_LENGTH && SAFE_COMMAND.test(command);
}

export interface StagedReviewConfig {
  commandAllowlist: string[];
  riskThreshold: number;
  maxProbes: number;
  maxTargetBytes: number;
  evidenceBudgetBytes: number;
}

export function defaultStagedReviewConfig(): StagedReviewConfig {
  return {
    commandAllowlist: [...DEFAULT_COMMAND_ALLOWLIST],
    riskThreshold: DEFAULT_RISK_THRESHOLD,
    maxProbes: DEFAULT_MAX_PROBES,
    maxTargetBytes: DEFAULT_MAX_TARGET_BYTES,
    evidenceBudgetBytes: DEFAULT_EVIDENCE_BUDGET_BYTES,
  };
}

/** Read the config text as committed on `baseRef`. Returns null on any failure. */
export function readStagedConfigFromBaseRef(workDir: string, baseRef: string): string | null {
  if (!baseRef || baseRef.startsWith('-') || /[\s\0]/.test(baseRef)) return null;
  try {
    return execFileSync('git', ['show', `${baseRef}:${REVIEW_CONFIG_PATH}`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_CONFIG_BYTES,
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

function intInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** Parse config text. Pure; never throws. Invalid fields take their default. */
export function parseStagedReviewConfig(text: string | null): StagedReviewConfig {
  const config = defaultStagedReviewConfig();
  if (!text || text.length > MAX_CONFIG_BYTES) return config;
  let doc: unknown;
  try {
    doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch {
    return config;
  }
  if (typeof doc !== 'object' || doc === null) return config;
  const staged = (doc as Record<string, unknown>).staged;
  if (typeof staged !== 'object' || staged === null || Array.isArray(staged)) return config;
  const s = staged as Record<string, unknown>;

  const list = s.executorCommandAllowlist;
  if (
    Array.isArray(list) &&
    list.length <= MAX_ALLOWLIST_ENTRIES &&
    list.every((e) => typeof e === 'string' && isSafeCommandString(e))
  ) {
    config.commandAllowlist = [...new Set(list as string[])];
  }
  if (typeof s.riskThreshold === 'number' && s.riskThreshold >= 0 && s.riskThreshold <= 1) {
    config.riskThreshold = s.riskThreshold;
  }
  config.maxProbes = intInRange(s.maxProbes, 1, HARD_MAX_PROBES, DEFAULT_MAX_PROBES);
  config.maxTargetBytes = intInRange(s.maxTargetBytes, 1, 1_000_000, DEFAULT_MAX_TARGET_BYTES);
  config.evidenceBudgetBytes = intInRange(
    s.evidenceBudgetBytes,
    1,
    10_000_000,
    DEFAULT_EVIDENCE_BUDGET_BYTES,
  );
  return config;
}

export interface LoadStagedConfigOpts {
  workDir?: string;
  /** Defaults to `origin/main`. */
  baseRef?: string;
  /** Test injection. Must return null, never throw, on failure. */
  readBaseConfig?: (workDir: string, baseRef: string) => string | null;
}

export function loadStagedReviewConfig(opts: LoadStagedConfigOpts = {}): StagedReviewConfig {
  const read = opts.readBaseConfig ?? readStagedConfigFromBaseRef;
  let text: string | null;
  try {
    text = read(opts.workDir ?? process.cwd(), opts.baseRef ?? 'origin/main');
  } catch {
    text = null;
  }
  return parseStagedReviewConfig(text);
}

export function toPlanLimits(config: StagedReviewConfig, repoRoot?: string): PlanLimits {
  return {
    riskThreshold: config.riskThreshold,
    maxProbes: config.maxProbes,
    maxTargetBytes: config.maxTargetBytes,
    commandAllowlist: config.commandAllowlist,
    ...(repoRoot ? { repoRoot } : {}),
  };
}
