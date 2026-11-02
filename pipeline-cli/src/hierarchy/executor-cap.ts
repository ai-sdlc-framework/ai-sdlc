/**
 * The ephemeral-executor spawn cap (RFC-0059, AISDLC-1076): `min(executors.max, board ceiling, pacer allowance, load headroom)`.
 *
 * `executors.max` comes from the environment (`AI_SDLC_EXECUTORS_MAX`), else `<board>/config.json`
 * `{ "executors": { "max": N } }`, else {@link DEFAULT_EXECUTORS_MAX}. The pacer allowance reads the
 * weekly pace of AISDLC-1072: over the line means 0, inside the hysteresis band (neither clearly
 * ahead nor clearly behind) means 1, clearly behind the line means no limit.
 */

import { existsSync, readFileSync } from 'node:fs';

import { budgetStatus, type BudgetStatus } from './budget.js';
import { MIN_AVAILABLE_BYTES } from './preflight.js';
import { readScaleCeiling } from './scale.js';
import { configPath } from './thresholds.js';
import type { ResourceSnapshot } from './types.js';

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
  /** The runtime board ceiling (AISDLC-1083); undefined when none is set. */
  ceiling?: number;
  allowance: number;
  /** Total executors the machine load leaves room for; Infinity when it was not measured. */
  headroom: number;
  cap: number;
  /** The input that set the cap (the first of the four holding the minimum). */
  winner: 'executors.max' | 'board ceiling' | 'pacer allowance' | 'load headroom';
}

/**
 * `min(max, ceiling, allowance, headroom)`, never below one while the pacer allowance and the
 * load headroom are above zero.
 */
export function computeCap(
  max: number,
  allowance: number,
  ceiling: number = Number.POSITIVE_INFINITY,
  headroom: number = Number.POSITIVE_INFINITY,
): number {
  if (allowance <= 0 || headroom <= 0) return 0;
  return Math.max(1, Math.min(max, ceiling, allowance, headroom));
}

/**
 * Executors the machine has room for in total: 0 at saturation (memory under 4 GiB, or the
 * one-minute load average at or above the core count), else the running count plus the cores
 * not yet loaded. Infinity without a snapshot.
 */
export function loadHeadroom(snapshot: ResourceSnapshot | undefined, live: number): number {
  if (!snapshot) return Number.POSITIVE_INFINITY;
  if (snapshot.availableBytes !== null && snapshot.availableBytes < MIN_AVAILABLE_BYTES) return 0;
  const free = Math.floor(snapshot.cpus - snapshot.loadAvg1);
  return free <= 0 ? 0 : live + free;
}

export interface CapInputs {
  /** Machine snapshot for the load headroom; absent means no load limit. */
  resources?: ResourceSnapshot;
  /** Live dynamic executors, which the load headroom counts. */
  live?: number;
}

export function executorCap(
  boardDir: string,
  nowMs: number,
  env: Record<string, string | undefined> = {},
  budget?: BudgetStatus,
  inputs: CapInputs = {},
): ExecutorCap {
  const max = resolveExecutorsMax(boardDir, env);
  const ceiling = readScaleCeiling(boardDir)?.max;
  let b = budget;
  if (!b) {
    try {
      b = budgetStatus(boardDir, nowMs);
    } catch {
      /* unreadable usage: no pacer limit */
    }
  }
  const allowance = pacerAllowance(b);
  const headroom = loadHeadroom(inputs.resources, inputs.live ?? 0);
  const cap = computeCap(max, allowance, ceiling, headroom);
  const named: [ExecutorCap['winner'], number][] = [
    ['executors.max', max],
    ['board ceiling', ceiling ?? Number.POSITIVE_INFINITY],
    ['pacer allowance', allowance],
    ['load headroom', headroom],
  ];
  const winner = (named.find(([, v]) => v <= 0) ?? named.find(([, v]) => v <= cap) ?? named[0])[0];
  return { max, ...(ceiling === undefined ? {} : { ceiling }), allowance, headroom, cap, winner };
}

/** The `EXECUTOR CAP` line of `status`: the cap, all four inputs and the winner. */
export function formatExecutorCap(c: ExecutorCap): string {
  const show = (n: number): string => (Number.isFinite(n) ? String(n) : 'unlimited');
  return `EXECUTOR CAP ${c.cap} (executors.max ${c.max}, board ceiling ${c.ceiling ?? 'none'}, pacer allowance ${show(c.allowance)}, load headroom ${show(c.headroom)}; limited by ${c.winner})`;
}
