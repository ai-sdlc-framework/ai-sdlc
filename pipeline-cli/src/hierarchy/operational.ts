/**
 * The dispatch role's operational authority list.
 *
 * `spec.governance.operational` in `.ai-sdlc/agent-role.yaml` names the actions
 * the dispatch session may take on its own. The closed set mirrors the agent
 * role schema; an unknown entry is dropped, never granted. The policy is read from
 * the verified main checkout, never from a worktree copy. A missing file, a parse
 * failure, a missing key or a checkout that does not verify grants nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';

import { runGit, trustedPolicyRoot, type GitRunner } from './trusted-root.js';

/** Closed set of grantable operational actions (matches the agent role schema). */
export const OPERATIONAL_ACTIONS = [
  'rebase-own-branch',
  'lease-push-own-branch',
  'retrigger-ci',
  'requeue',
  'file-subid-followups',
  'answer-operational-decisions',
  'clear-executor-context',
] as const;

/** One operational action. */
export type OperationalAction = (typeof OPERATIONAL_ACTIONS)[number];

/** Parse the granted actions out of agent-role.yaml text. Unknown or malformed input grants nothing. */
export function parseOperational(yamlText: string): Set<OperationalAction> {
  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch {
    return new Set();
  }
  const spec = (doc as { spec?: { governance?: { operational?: unknown } } } | null)?.spec;
  const list = spec?.governance?.operational;
  if (!Array.isArray(list)) return new Set();
  const granted = new Set<OperationalAction>();
  for (const entry of list) {
    if ((OPERATIONAL_ACTIONS as readonly unknown[]).includes(entry)) {
      granted.add(entry as OperationalAction);
    }
  }
  return granted;
}

/**
 * Read the granted actions from `<mainRoot>/.ai-sdlc/agent-role.yaml`, where
 * `mainRoot` is the verified main checkout of the repository both `projectDir`
 * and `cwd` belong to. A checkout that does not verify, or an unreadable file,
 * grants nothing.
 */
export function loadOperational(
  projectDir: string,
  cwd: string = projectDir,
  run: GitRunner = runGit,
): Set<OperationalAction> {
  try {
    const root = trustedPolicyRoot(projectDir, cwd, run);
    if (!root) return new Set();
    const file = path.join(root, '.ai-sdlc', 'agent-role.yaml');
    if (!existsSync(file)) return new Set();
    return parseOperational(readFileSync(file, 'utf-8'));
  } catch {
    return new Set();
  }
}
