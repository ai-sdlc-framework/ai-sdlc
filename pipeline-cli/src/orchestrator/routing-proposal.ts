/**
 * Weekly model routing proposal for the orchestrator tick (RFC-0050 B5).
 *
 * Runs `route propose` at most once per ISO calendar week (UTC). The week is
 * recorded when an attempt starts, so a failing run is not retried on every
 * tick. Never throws: a failure here must not disturb the tick.
 *
 * @module orchestrator/routing-proposal
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDecisionCatalogEnabled } from '../decisions/index.js';
import { runRoutePropose, type ProposeResult, type RouteDeps } from '../usage/route-commands.js';

/** Where the last-attempted week is kept, relative to the artifacts directory. */
export const ROUTING_PROPOSAL_STATE_RELATIVE = join('_routing', 'proposal-state.json');

export interface WeeklyRoutingProposalOptions {
  workDir: string;
  artifactsDir: string;
  now?: () => Date;
  /** Replaces the propose run (tests). */
  run?: (deps: RouteDeps) => Promise<ProposeResult>;
  /** Extra collaborators for the propose run (tests). */
  deps?: Partial<RouteDeps>;
  /** Warning sink; defaults to a no-op. */
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** ISO 8601 week label for a UTC instant, for example `2026-W40`. */
export function isoWeekOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function readLastWeek(path: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { lastWeek?: unknown };
    return typeof raw.lastWeek === 'string' ? raw.lastWeek : undefined;
  } catch {
    return undefined;
  }
}

/** Run the proposal unless one was already attempted this week. */
export async function runWeeklyRoutingProposal(
  opts: WeeklyRoutingProposalOptions,
): Promise<ProposeResult | 'skipped' | 'error'> {
  try {
    if (!isDecisionCatalogEnabled(opts.env ?? process.env)) return 'skipped';
    const now = (opts.now ?? ((): Date => new Date()))();
    const week = isoWeekOf(now);
    const statePath = join(opts.artifactsDir, ROUTING_PROPOSAL_STATE_RELATIVE);
    if (readLastWeek(statePath) === week) return 'skipped';
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ lastWeek: week, at: now.toISOString() })}\n`);
    const deps: RouteDeps = {
      repoRoot: opts.workDir,
      workDir: opts.workDir,
      artifactsDir: opts.artifactsDir,
      now: () => now,
      ...opts.deps,
    };
    return await (opts.run ?? ((d) => runRoutePropose(d)))(deps);
  } catch (err) {
    try {
      opts.warn?.(
        `[orchestrator] weekly routing proposal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {
      // Reporting a failure must not itself fail the tick.
    }
    return 'error';
  }
}
