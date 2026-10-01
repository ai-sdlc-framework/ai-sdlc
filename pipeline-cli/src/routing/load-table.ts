/**
 * Load the repository routing table from the BASE ref only.
 *
 * `.ai-sdlc/model-routing.yaml` is read with `git show <baseRef>:<path>`,
 * never from the working tree. A pull request therefore cannot route its own
 * review or development to a different model by editing the table in its own
 * diff; the change has to land on the base branch first. Mirrors
 * `steps/reviewer-set.ts`.
 *
 * Every failure (no file, bad YAML, schema violation, candidates on the
 * security reviewer, a model missing from `strength`) falls back to the
 * built-in default table, so a broken table can never silently change which
 * model runs a role.
 *
 * @module routing/load-table
 */

import { execFileSync } from 'node:child_process';
import { validateModelRouting } from '@ai-sdlc/reference';
import yaml from 'js-yaml';
import { DEFAULT_ROLE_MODELS, SECURITY_REVIEWER_ROLE, type RoutingTable } from './default-table.js';

export const MODEL_ROUTING_PATH = '.ai-sdlc/model-routing.yaml';

/** Read the table text as committed on `baseRef`. Returns null on any failure. */
export function readRoutingTableFromBaseRef(workDir: string, baseRef: string): string | null {
  try {
    return execFileSync('git', ['show', `${baseRef}:${MODEL_ROUTING_PATH}`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * A security-reviewer cell may never be weaker than the built-in default
 * security model. When that model appears in `strength` the cell must be at
 * or above it; otherwise the cell must be the strongest model in the list.
 */
function securityCellTooWeak(strength: string[], model: string): boolean {
  const floor = strength.indexOf(DEFAULT_ROLE_MODELS[SECURITY_REVIEWER_ROLE]);
  const required = floor >= 0 ? floor : strength.length - 1;
  return strength.indexOf(model) < required;
}

export type ParseTableResult = { ok: true; table: RoutingTable } | { ok: false; reason: string };

/** Parse and validate table text. Pure; exported for tests. */
export function parseRoutingTable(text: string): ParseTableResult {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return { ok: false, reason: 'invalid-yaml' };
  }
  const result = validateModelRouting(doc);
  if (!result.valid) return { ok: false, reason: 'schema-invalid' };

  const spec = (doc as { spec: Record<string, unknown> }).spec;
  const strength = spec.strength as string[];
  const cells = spec.cells as RoutingTable['cells'];
  const known = new Set(strength);

  for (const [role, byClass] of Object.entries(cells)) {
    for (const cell of Object.values(byClass)) {
      if (!known.has(cell.model)) return { ok: false, reason: 'model-not-in-strength' };
      if (role === SECURITY_REVIEWER_ROLE && securityCellTooWeak(strength, cell.model)) {
        return { ok: false, reason: 'security-reviewer-weaker-than-default' };
      }
      if (cell.candidates) {
        if (role === SECURITY_REVIEWER_ROLE) {
          return { ok: false, reason: 'security-reviewer-candidates' };
        }
        for (const c of cell.candidates) {
          if (!known.has(c)) return { ok: false, reason: 'model-not-in-strength' };
        }
      }
    }
  }

  return {
    ok: true,
    table: {
      strength,
      exploreShare: typeof spec.exploreShare === 'number' ? spec.exploreShare : 0,
      salt: typeof spec.salt === 'string' ? spec.salt : '',
      cells,
    },
  };
}

export interface LoadTableOptions {
  workDir: string;
  /** Defaults to `origin/main`. */
  baseRef?: string;
  /** Test injection. Must return null (never throw) when the file is absent. */
  readBaseTable?: (workDir: string, baseRef: string) => string | null;
}

export type LoadTableResult =
  | { source: 'repo'; table: RoutingTable }
  | { source: 'default'; reason: string };

/** Load the repo table, or report why the built-in default applies. */
export function loadRoutingTable(opts: LoadTableOptions): LoadTableResult {
  const read = opts.readBaseTable ?? readRoutingTableFromBaseRef;
  let raw: string | null;
  try {
    raw = read(opts.workDir, opts.baseRef ?? 'origin/main');
  } catch {
    raw = null;
  }
  if (raw === null || raw.trim() === '') return { source: 'default', reason: 'no-table' };
  const parsed = parseRoutingTable(raw);
  if (!parsed.ok) return { source: 'default', reason: parsed.reason };
  return { source: 'repo', table: parsed.table };
}
