/**
 * The ephemeral-executor spawn cap (RFC-0059, AISDLC-1076): `min(executors.max, pacer allowance)`.
 *
 * `executors.max` comes from the environment (`AI_SDLC_EXECUTORS_MAX`), else `<board>/config.json`
 * `{ "executors": { "max": N } }`, else {@link DEFAULT_EXECUTORS_MAX}. The pacer allowance reads the
 * weekly pace of AISDLC-1072: over the line means 0, inside the hysteresis band (neither clearly
 * ahead nor clearly behind) means 1, clearly behind the line means no limit.
 */

import { existsSync, readFileSync } from 'node:fs';

import { budgetStatus, type BudgetStatus } from './budget.js';
import { configPath } from './thresholds.js';

export const DEFAULT_EXECUTORS_MAX = 3;

/** The configured ceiling: env, then config file, then the default. */
export function resolveExecutorsMax(
  boardDir: string,
  env: Record<string, string | undefined> = {},
): number {
  const fromEnv = Number(env.AI_SDLC_EXECUTORS_MAX);
  if (env.AI_SDLC_EXECUTORS_MAX !== undefined && Number.isInteger(fromEnv) && fromEnv > 0)
    return fromEnv;
  try {
    if (existsSync(configPath(boardDir))) {
      const doc = JSON.parse(readFileSync(configPath(boardDir), 'utf-8')) as {
        executors?: { max?: unknown };
      };
      const m = doc.executors?.max;
      if (typeof m === 'number' && Number.isInteger(m) && m > 0) return m;
    }
  } catch {
    /* malformed config: default */
  }
  return DEFAULT_EXECUTORS_MAX;
}

/** Executors the pacer allows: 0 over the line, 1 inside the band, Infinity when clearly behind. */
export function pacerAllowance(budget: BudgetStatus | undefined): number {
  if (!budget || budget.overridden) return Number.POSITIVE_INFINITY;
  const paces = [budget.sevenDay, budget.fiveHour].filter((p) => p !== undefined);
  if (paces.some((p) => p.ahead > p.margin)) return 0;
  if (paces.some((p) => p.ahead >= -p.margin)) return 1;
  return Number.POSITIVE_INFINITY;
}

export interface ExecutorCap {
  max: number;
  allowance: number;
  cap: number;
}

/** `min(max, allowance)`, never below one while the allowance is above zero. */
export function computeCap(max: number, allowance: number): number {
  if (allowance <= 0) return 0;
  return Math.max(1, Math.min(max, allowance));
}

export function executorCap(
  boardDir: string,
  nowMs: number,
  env: Record<string, string | undefined> = {},
  budget?: BudgetStatus,
): ExecutorCap {
  const max = resolveExecutorsMax(boardDir, env);
  let b = budget;
  if (!b) {
    try {
      b = budgetStatus(boardDir, nowMs);
    } catch {
      /* unreadable usage: no pacer limit */
    }
  }
  const allowance = pacerAllowance(b);
  return { max, allowance, cap: computeCap(max, allowance) };
}

/** The `EXECUTOR CAP` line of `status`. */
export function formatExecutorCap(c: ExecutorCap): string {
  const allow = Number.isFinite(c.allowance) ? String(c.allowance) : 'unlimited';
  return `EXECUTOR CAP ${c.cap} (executors.max ${c.max}, pacer allowance ${allow})`;
}
