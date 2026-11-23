/**
 * Planner-session model fallback (AISDLC-1364). When the account has hit a model limit and the
 * operator (or a tool) recorded a `model-unavailable` marker, the planner session starts on the
 * next weaker model in the `strength` order of `.ai-sdlc/model-routing.yaml`. An explicit
 * `--planner-model` always wins. Nothing here reads or sets `ANTHROPIC_API_KEY`, and it never
 * chooses usage-credit billing: it only names a different `--model` for the same subscription.
 *
 * @module hierarchy/model-fallback
 */

import {
  applyFallback,
  formatFallbackLine,
  resolveRoutedModel,
  type RoutedModelOptions,
} from '../routing/role-model.js';
import { readActiveMarkers } from '../routing/model-unavailable.js';
import type { HierarchyDeps } from './types.js';

/** The routing role of the long-lived planner session. */
export const PLANNER_SESSION_ROLE = 'planner-session';

type FallbackDeps = Pick<HierarchyDeps, 'boardDir' | 'cwd' | 'now' | 'readRoutingTable'>;

function routing(deps: FallbackDeps, opts: RoutedModelOptions): RoutedModelOptions {
  return {
    workDir: deps.cwd,
    unavailable: readActiveMarkers(deps.boardDir, deps.now()),
    now: deps.now(),
    ...(deps.readRoutingTable ? { readBaseTable: deps.readRoutingTable } : {}),
    ...opts,
  };
}

/** Planner model for `up`: an explicit flag wins, else the session cell with fallback applied. */
export function resolvePlannerModel(
  explicit: string | undefined,
  deps: FallbackDeps,
  opts: RoutedModelOptions = {},
): { model: string; line?: string } {
  if (explicit !== undefined) return { model: explicit };
  const res = resolveRoutedModel(PLANNER_SESSION_ROLE, routing(deps, opts));
  const line = formatFallbackLine(res);
  return { model: res.model, ...(line ? { line } : {}) };
}

/** The model a restart of `role` launches: the recorded model, stepped down while it is marked. */
export function restartModel(
  role: string,
  recorded: string,
  deps: FallbackDeps,
  opts: RoutedModelOptions = {},
): { model: string; line?: string } {
  if (role !== 'planner') return { model: recorded };
  const applied = applyFallback(PLANNER_SESSION_ROLE, recorded, routing(deps, opts));
  if (!applied.fallback) return { model: recorded };
  return {
    model: applied.model,
    line: formatFallbackLine({
      role: PLANNER_SESSION_ROLE,
      configured: recorded,
      ...applied,
    }) as string,
  };
}

/** The status line while the planner session's fallback is active; undefined otherwise. */
export function plannerFallbackLine(
  deps: FallbackDeps,
  opts: RoutedModelOptions = {},
): string | undefined {
  try {
    return formatFallbackLine(resolveRoutedModel(PLANNER_SESSION_ROLE, routing(deps, opts)));
  } catch {
    return undefined;
  }
}
