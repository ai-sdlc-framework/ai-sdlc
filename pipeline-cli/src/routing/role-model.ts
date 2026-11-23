/**
 * `routedModel` - the single role-to-model lookup (AISDLC-982).
 *
 * Reads the wildcard cell of `.ai-sdlc/model-routing.yaml` on the base ref and
 * falls back to the built-in default for the role when the table is absent,
 * invalid or has no cell for it. Used by the reviewer harness, the review-plan
 * executor and the hierarchy launch, so changing a role's model is one yaml edit.
 *
 * @module routing/role-model
 */

import {
  builtInDefaultTable,
  DEFAULT_ROLE_MODELS,
  SECURITY_REVIEWER_ROLE,
  type LaunchProfile,
} from './default-table.js';
import { loadRoutingTable, securityFloorIndex, type LoadTableOptions } from './load-table.js';
import { markerActive, type ModelMarker } from './model-unavailable.js';

/** Fallbacks for roles outside the spawner map, used when the table has no cell. */
const EXTRA_ROLE_MODELS: Readonly<Record<string, string>> = {
  'review-executor': 'haiku',
  // The planner command runs one turn; the long-lived planner session is its own cell.
  planner: 'opus',
  'planner-session': 'fable',
  'code-reviewer-codex': 'sonnet',
  'test-reviewer-codex': 'sonnet',
};

export interface RoutedModelOptions {
  workDir?: string;
  baseRef?: string;
  readBaseTable?: LoadTableOptions['readBaseTable'];
  /** Models the account cannot use now (AISDLC-1364); markers past `until` are ignored. */
  unavailable?: readonly ModelMarker[];
  /** Clock for the marker expiry check; markers are ignored when it is absent. */
  now?: Date;
}

/** A fallback taken because the configured model is marked unavailable. */
export interface ModelFallback {
  from: string;
  to: string;
  reason: string;
  until: string;
}

export interface ModelResolution {
  role: string;
  /** The model the table (or built-in default) names for the role. */
  configured: string;
  /** The model to launch: `configured`, or the fallback. */
  model: string;
  fallback?: ModelFallback;
}

/** The strength order of the repo table on the base ref, else the built-in default's. */
export function routingStrength(opts: RoutedModelOptions = {}): readonly string[] {
  const loaded = loadRoutingTable({
    workDir: opts.workDir ?? process.cwd(),
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(opts.readBaseTable ? { readBaseTable: opts.readBaseTable } : {}),
  });
  return loaded.source === 'repo' ? loaded.table.strength : builtInDefaultTable().strength;
}

/**
 * Move `model` down the `strength` order past every active marker. The security reviewer never
 * goes below the opus floor. Returns `model` unchanged when it is not marked (or not in
 * `strength`). @throws when no allowed model remains for `role`.
 */
export function applyFallback(
  role: string,
  model: string,
  opts: RoutedModelOptions = {},
): { model: string; fallback?: ModelFallback } {
  const { now } = opts;
  const active = now ? (opts.unavailable ?? []).filter((m) => markerActive(m, now)) : [];
  const hit = active.find((m) => m.model === model);
  if (!hit) return { model };
  const strength = routingStrength(opts);
  const start = strength.indexOf(model);
  if (start < 0) return { model };
  const floor =
    role === SECURITY_REVIEWER_ROLE ? Math.max(0, securityFloorIndex([...strength])) : 0;
  for (let i = start - 1; i >= floor; i--) {
    const candidate = strength[i] as string;
    if (!active.some((m) => m.model === candidate)) {
      return {
        model: candidate,
        fallback: { from: model, to: candidate, reason: hit.reason, until: hit.until },
      };
    }
  }
  throw new Error(
    `no allowed fallback for role "${role}": model "${model}" is unavailable until ${hit.until} (${hit.reason}) and the strength order in .ai-sdlc/model-routing.yaml has no usable model${role === SECURITY_REVIEWER_ROLE ? ' at or above the security floor' : ''} below it`,
  );
}

/** The model for `role` with any fallback applied, and what changed. */
export function resolveRoutedModel(role: string, opts: RoutedModelOptions = {}): ModelResolution {
  const configured = configuredModel(role, opts);
  const applied = applyFallback(role, configured, opts);
  return { role, configured, ...applied };
}

/** One line naming the role, both models, the reason and the reset time. */
export function formatFallbackLine(res: ModelResolution): string | undefined {
  if (!res.fallback) return undefined;
  const f = res.fallback;
  return `model fallback: ${res.role} runs ${f.to} instead of ${f.from} (${f.reason}); ${f.from} resets ${f.until}`;
}

/** The model for `role`: the table's wildcard cell, else the built-in default; fallback applied. */
export function routedModel(role: string, opts: RoutedModelOptions = {}): string {
  return resolveRoutedModel(role, opts).model;
}

function configuredModel(role: string, opts: RoutedModelOptions): string {
  const loaded = loadRoutingTable({
    workDir: opts.workDir ?? process.cwd(),
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(opts.readBaseTable ? { readBaseTable: opts.readBaseTable } : {}),
  });
  if (loaded.source === 'repo') {
    const cell = loaded.table.cells[role]?.['*'];
    if (cell) return cell.model;
  }
  const model = DEFAULT_ROLE_MODELS[role] ?? EXTRA_ROLE_MODELS[role];
  if (!model) throw new Error(`no model routing cell or default for role "${role}"`);
  return model;
}

/** Where the reviewer harness choice came from. */
export type HarnessSource = 'env' | 'yaml' | 'default';

export interface ReviewerHarnessSetting {
  harness: 'codex' | 'claude';
  source: HarnessSource;
}

/**
 * The reviewer harness default (AISDLC-1003): the `AI_SDLC_REVIEWER_HARNESS`
 * value when set (per-run override), else the table's `harness:` key, else
 * `codex`. Any set env value other than `claude` means `codex`.
 */
export function resolveReviewerHarnessSetting(
  envValue: string | undefined,
  opts: RoutedModelOptions = {},
): ReviewerHarnessSetting {
  if (envValue !== undefined && envValue !== '') {
    return { harness: envValue.toLowerCase() === 'claude' ? 'claude' : 'codex', source: 'env' };
  }
  const loaded = loadRoutingTable({
    workDir: opts.workDir ?? process.cwd(),
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(opts.readBaseTable ? { readBaseTable: opts.readBaseTable } : {}),
  });
  if (loaded.source === 'repo' && loaded.table.harness) {
    return { harness: loaded.table.harness, source: 'yaml' };
  }
  return { harness: 'codex', source: 'default' };
}

/**
 * The launch profile named `name` (the hierarchy role) in the `launch:` block of the
 * routing table on the base ref (AISDLC-1151), or undefined when the table has none.
 */
export function routedLaunchProfile(
  name: string,
  opts: RoutedModelOptions = {},
): LaunchProfile | undefined {
  const loaded = loadRoutingTable({
    workDir: opts.workDir ?? process.cwd(),
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(opts.readBaseTable ? { readBaseTable: opts.readBaseTable } : {}),
  });
  return loaded.source === 'repo' ? loaded.table.launch?.[name] : undefined;
}
