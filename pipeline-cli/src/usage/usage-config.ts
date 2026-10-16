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
import * as yaml from '../util/yaml.js';
import type { TokenClass } from './units.js';

export type BudgetRole = 'planner' | 'operator-dispatch' | 'executor';

export interface RoleBudget {
  /** Context size of one call above which a session of the role is over budget. */
  contextBudgetTokens: number;
  /** Model calls since the last clear above which a session of the role is over budget. */
  turnBudget: number;
}

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
  /** Estimated tokens above which a tool result draws a notice in main-session roles. */
  outputNoticeTokens: number;
  /** Context and turn budgets per hierarchy role. */
  roles: Record<BudgetRole, RoleBudget>;
  source: 'machine' | 'base-ref' | 'defaults';
  warnings: string[];
}

export const MACHINE_CONFIG_FILE = 'usage-config.yaml';
export const BASE_CONFIG_PATH = '.ai-sdlc/usage-config.yaml';
export const DEFAULT_ALLOTMENT_TOLERANCE = 0.25;
export const DEFAULT_MODEL_MIX_SIMILARITY = 0.8;
export const DEFAULT_SCORECARD_MIN_TASKS = 30;
/** Mirrored by `ai-sdlc-plugin/hooks/lib/large-output-notice.js`, which cannot import this package. */
export const DEFAULT_OUTPUT_NOTICE_TOKENS = 8000;

/**
 * LOCKSTEP: `DEFAULT_ROLE_BUDGETS` in `ai-sdlc-plugin/hooks/lib/context-budget.js`
 * holds the same numbers; `context-budget-lockstep.test.ts` asserts they agree.
 */
export const DEFAULT_ROLE_BUDGETS: Readonly<Record<BudgetRole, RoleBudget>> = {
  planner: { contextBudgetTokens: 150_000, turnBudget: 300 },
  'operator-dispatch': { contextBudgetTokens: 100_000, turnBudget: 200 },
  executor: { contextBudgetTokens: 120_000, turnBudget: 150 },
};

export const BUDGET_ROLES = Object.keys(DEFAULT_ROLE_BUDGETS) as BudgetRole[];

export const DEFAULT_WINDOWS: readonly WindowSpec[] = [
  { name: 'session', lengthHours: 5, mode: 'first-use' },
  { name: 'weekly', lengthHours: 168, mode: 'trailing' },
];

/**
 * The role a session name denotes: the name is the role, or starts with the role
 * and a separator (`executor-aisdlc-12`). Same rule as `roleFromName` in
 * `ai-sdlc-plugin/hooks/lib/context-budget.js`.
 */
export function roleFromSessionName(name: string | undefined): BudgetRole | undefined {
  if (!name) return undefined;
  const lower = name.trim().toLowerCase();
  return BUDGET_ROLES.find(
    (r) => lower === r || lower.startsWith(`${r}-`) || lower.startsWith(`${r}.`),
  );
}

function cloneRoleBudgets(): Record<BudgetRole, RoleBudget> {
  return {
    planner: { ...DEFAULT_ROLE_BUDGETS.planner },
    'operator-dispatch': { ...DEFAULT_ROLE_BUDGETS['operator-dispatch'] },
    executor: { ...DEFAULT_ROLE_BUDGETS.executor },
  };
}

export function defaultUsageConfig(warnings: string[] = []): ResolvedUsageConfig {
  return {
    windows: DEFAULT_WINDOWS.map((w) => ({ ...w })),
    weights: { tokenClasses: {}, modelFamilies: {} },
    allotmentTolerance: DEFAULT_ALLOTMENT_TOLERANCE,
    modelMixSimilarity: DEFAULT_MODEL_MIX_SIMILARITY,
    scorecardMinTasks: DEFAULT_SCORECARD_MIN_TASKS,
    outputNoticeTokens: DEFAULT_OUTPUT_NOTICE_TOKENS,
    roles: cloneRoleBudgets(),
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
  output?: { noticeTokens?: number };
  roles?: Partial<Record<BudgetRole, Partial<RoleBudget>>>;
}

function resolveRoleBudgets(raw: RawSpec['roles']): Record<BudgetRole, RoleBudget> {
  const roles = cloneRoleBudgets();
  for (const role of BUDGET_ROLES) {
    const set = raw?.[role];
    if (set?.contextBudgetTokens !== undefined)
      roles[role].contextBudgetTokens = set.contextBudgetTokens;
    if (set?.turnBudget !== undefined) roles[role].turnBudget = set.turnBudget;
  }
  return roles;
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
    outputNoticeTokens: spec.output?.noticeTokens ?? base.outputNoticeTokens,
    roles: resolveRoleBudgets(spec.roles),
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
