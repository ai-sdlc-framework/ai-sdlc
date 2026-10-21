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

import { DEFAULT_ROLE_MODELS } from './default-table.js';
import { loadRoutingTable, type LoadTableOptions } from './load-table.js';

/** Fallbacks for roles outside the spawner map, used when the table has no cell. */
const EXTRA_ROLE_MODELS: Readonly<Record<string, string>> = {
  'review-executor': 'haiku',
  planner: 'fable',
  'code-reviewer-codex': 'sonnet',
  'test-reviewer-codex': 'sonnet',
};

export interface RoutedModelOptions {
  workDir?: string;
  baseRef?: string;
  readBaseTable?: LoadTableOptions['readBaseTable'];
}

/** The model for `role`: the table's wildcard cell, else the built-in default. */
export function routedModel(role: string, opts: RoutedModelOptions = {}): string {
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
