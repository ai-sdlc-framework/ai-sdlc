/**
 * Usage config loader (RFC-0050 A4).
 *
 * Precedence, first match wins:
 *   1. `usage-config.yaml` in the machine-level usage directory.
 *   2. `.ai-sdlc/usage-config.yaml` as committed on the base ref (default
 *      `origin/main`), read with `git show` and never from the working tree, so
 *      a branch cannot change its own report settings.
 *   3. The documented defaults.
 *
 * A file that fails schema validation is skipped with a warning and the next
 * source is tried; a bad config never stops a report.
 *
 * @module usage/usage-config
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveUsageDir, validateUsageConfig, type UsageStoreOptions } from '@ai-sdlc/reference';
import yaml from 'js-yaml';
import type { TokenClass } from './units.js';

export type WindowMode = 'first-use' | 'fixed' | 'trailing';

export interface WindowSpec {
  name: string;
  lengthHours: number;
  mode: WindowMode;
  /** ISO instant; present for mode `fixed`. */
  anchor?: string;
}

export interface ConfiguredWeights {
  tokenClasses: Partial<Record<TokenClass, number>>;
  modelFamilies: Record<string, number>;
}

export interface ResolvedUsageConfig {
  planName?: string;
  monthlyPriceUsd?: number;
  windows: WindowSpec[];
  weights: ConfiguredWeights;
  /** Relative change in implied allotment that counts as a suspected change. */
  allotmentTolerance: number;
  /** Minimum model-mix overlap for two snapshots to be compared. */
  modelMixSimilarity: number;
  /** Tasks a scorecard cell needs before it stops being labelled insufficient. */
  scorecardMinTasks: number;
  source: 'machine' | 'base-ref' | 'defaults';
  warnings: string[];
}

export const MACHINE_CONFIG_FILE = 'usage-config.yaml';
export const BASE_CONFIG_PATH = '.ai-sdlc/usage-config.yaml';
export const DEFAULT_ALLOTMENT_TOLERANCE = 0.25;
export const DEFAULT_MODEL_MIX_SIMILARITY = 0.8;
export const DEFAULT_SCORECARD_MIN_TASKS = 30;

export const DEFAULT_WINDOWS: readonly WindowSpec[] = [
  { name: 'session', lengthHours: 5, mode: 'first-use' },
  { name: 'weekly', lengthHours: 168, mode: 'trailing' },
];

export function defaultUsageConfig(warnings: string[] = []): ResolvedUsageConfig {
  return {
    windows: DEFAULT_WINDOWS.map((w) => ({ ...w })),
    weights: { tokenClasses: {}, modelFamilies: {} },
    allotmentTolerance: DEFAULT_ALLOTMENT_TOLERANCE,
    modelMixSimilarity: DEFAULT_MODEL_MIX_SIMILARITY,
    scorecardMinTasks: DEFAULT_SCORECARD_MIN_TASKS,
    source: 'defaults',
    warnings,
  };
}

export interface LoadUsageConfigOptions extends UsageStoreOptions {
  /** Repository root for the base-ref read. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Base ref. Defaults to `origin/main`. */
  baseRef?: string;
  /** Test seam for the base-ref read; must return null (never throw) when absent. */
  readBaseConfig?: (workDir: string, baseRef: string) => string | null;
}

/** `.ai-sdlc/usage-config.yaml` as committed on `baseRef`, or null on any failure. */
export function readUsageConfigFromBaseRef(workDir: string, baseRef: string): string | null {
  try {
    return execFileSync('git', ['show', `${baseRef}:${BASE_CONFIG_PATH}`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

interface RawSpec {
  plan?: { name?: string; monthlyPriceUsd?: number };
  windows?: Array<{ name: string; lengthHours: number; mode?: WindowMode; anchor?: string }>;
  weights?: {
    tokenClasses?: Partial<Record<TokenClass, number>>;
    modelFamilies?: Record<string, number>;
  };
  allotmentTolerance?: number;
  modelMixSimilarity?: number;
  scorecardMinTasks?: number;
}

/** Parse and validate one config document. Returns an error string on failure. */
export function parseUsageConfig(
  text: string,
  source: 'machine' | 'base-ref',
): ResolvedUsageConfig | string {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return 'not valid YAML';
  }
  const result = validateUsageConfig<{ spec: RawSpec }>(doc);
  if (!result.valid) {
    const first = result.errors?.[0];
    return first ? `${first.path || '/'}: ${first.message}` : 'failed schema validation';
  }
  const spec = (doc as { spec: RawSpec }).spec;
  const windows: WindowSpec[] | undefined = spec.windows?.map((w) => {
    const mode: WindowMode = w.mode ?? (w.anchor ? 'fixed' : 'trailing');
    return {
      name: w.name,
      lengthHours: w.lengthHours,
      mode,
      ...(w.anchor ? { anchor: w.anchor } : {}),
    };
  });
  const badFixed = windows?.find((w) => w.mode === 'fixed' && !w.anchor);
  if (badFixed) return `window ${badFixed.name}: mode fixed needs an anchor`;
  const base = defaultUsageConfig();
  return {
    ...(spec.plan?.name ? { planName: spec.plan.name } : {}),
    ...(spec.plan?.monthlyPriceUsd !== undefined
      ? { monthlyPriceUsd: spec.plan.monthlyPriceUsd }
      : {}),
    windows: windows ?? base.windows,
    weights: {
      tokenClasses: { ...(spec.weights?.tokenClasses ?? {}) },
      modelFamilies: { ...(spec.weights?.modelFamilies ?? {}) },
    },
    allotmentTolerance: spec.allotmentTolerance ?? base.allotmentTolerance,
    modelMixSimilarity: spec.modelMixSimilarity ?? base.modelMixSimilarity,
    scorecardMinTasks: spec.scorecardMinTasks ?? base.scorecardMinTasks,
    source,
    warnings: [],
  };
}

/** Load the effective usage config. Never throws. */
export function loadUsageConfig(opts: LoadUsageConfigOptions = {}): ResolvedUsageConfig {
  const warnings: string[] = [];
  try {
    const machine = join(resolveUsageDir(opts), MACHINE_CONFIG_FILE);
    if (existsSync(machine)) {
      const parsed = parseUsageConfig(readFileSync(machine, 'utf-8'), 'machine');
      if (typeof parsed !== 'string') return parsed;
      warnings.push(`Ignored the machine-level usage config: ${parsed}.`);
    }
  } catch {
    warnings.push('Ignored the machine-level usage config: it could not be read.');
  }
  const read = opts.readBaseConfig ?? readUsageConfigFromBaseRef;
  const text = read(opts.workDir ?? process.cwd(), opts.baseRef ?? 'origin/main');
  if (text !== null) {
    const parsed = parseUsageConfig(text, 'base-ref');
    if (typeof parsed !== 'string') return { ...parsed, warnings };
    warnings.push(`Ignored ${BASE_CONFIG_PATH} on the base ref: ${parsed}.`);
  }
  return defaultUsageConfig(warnings);
}
