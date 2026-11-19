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

import { load } from '../util/yaml.js';

import type { ForcePushMode } from './lease-policy.js';
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
  'mark-ready-after-codeql',
  'land-eligible-prs',
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

/** The dispatch role's policy as read from the verified main checkout. */
export interface OperationalPolicy {
  operational: Set<OperationalAction>;
  /** `allowForcePush`; unset, `true` or `leaseOnOwnBranch` is `leaseOnOwnBranch`, anything else is `never`. */
  forcePushMode: ForcePushMode;
  /** Extra protected branch names; malformed entries are dropped (never a relaxation of the defaults). */
  protectedBranches: string[];
  /** `governance.openTaskPrsReady: true` opens task PRs ready instead of draft (AISDLC-896); default false. */
  openTaskPrsReady: boolean;
  /** `governance.allowMerge`; only `onGreenClean` opens merging, anything else (or unset) is `never` (AISDLC-1351). */
  allowMerge: 'never' | 'onGreenClean';
  /** `governance.mergeAuthors`: logins whose PRs the board may land; non-strings are dropped. */
  mergeAuthors: string[];
}

/** The three reasons a board never merges, one line each, each naming the key to change. */
export function mergeOffLines(policy: {
  allowMerge?: string;
  mergeAuthors?: readonly string[];
  operational: Iterable<string>;
}): string[] {
  const file = '.ai-sdlc/agent-role.yaml';
  const lines: string[] = [];
  if (policy.allowMerge !== 'onGreenClean') {
    lines.push(
      `merge off: allowMerge is not onGreenClean in ${file}; set spec.governance.allowMerge: onGreenClean to let the board merge`,
    );
  }
  if ((policy.mergeAuthors ?? []).length === 0) {
    lines.push(
      `merge off: mergeAuthors is empty in ${file}; list the logins whose PRs the board may land under spec.governance.mergeAuthors`,
    );
  }
  if (![...policy.operational].includes('land-eligible-prs')) {
    lines.push(
      `merge off: operational lacks land-eligible-prs in ${file}; add land-eligible-prs to spec.governance.operational`,
    );
  }
  return lines;
}

const DENY_ALL: () => OperationalPolicy = () => ({
  operational: new Set(),
  forcePushMode: 'never',
  protectedBranches: [],
  openTaskPrsReady: false,
  allowMerge: 'never',
  mergeAuthors: [],
});

/** Parse the whole dispatch policy out of agent-role.yaml text. Unknown or malformed input grants nothing. */
export function parseOperationalPolicy(yamlText: string): OperationalPolicy {
  const policy = DENY_ALL();
  policy.operational = parseOperational(yamlText);
  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch {
    return DENY_ALL();
  }
  type Governance = {
    allowForcePush?: unknown;
    protectedBranches?: unknown;
    openTaskPrsReady?: unknown;
    allowMerge?: unknown;
    mergeAuthors?: unknown;
    preset?: unknown;
  };
  const gov = (doc as { spec?: { governance?: Governance } } | null)?.spec?.governance;
  const mode = gov?.allowForcePush;
  // AISDLC-710: unset (undefined) is the `leaseOnOwnBranch` default, matching the hook's
  // governance-resolver. An explicit `never`/`false` or any malformed value stays `never`.
  if (mode === undefined || mode === true || mode === 'leaseOnOwnBranch') {
    policy.forcePushMode = 'leaseOnOwnBranch';
  } else if (mode === 'lease') {
    policy.forcePushMode = 'lease';
  }
  policy.openTaskPrsReady = gov?.openTaskPrsReady === true;
  if (gov?.preset === 'operator-trusted') policy.allowMerge = 'onGreenClean';
  if (gov?.allowMerge === 'never' || gov?.allowMerge === 'onGreenClean') {
    policy.allowMerge = gov.allowMerge;
  }
  if (Array.isArray(gov?.mergeAuthors)) {
    policy.mergeAuthors = (gov.mergeAuthors as unknown[]).filter(
      (a): a is string => typeof a === 'string' && a.trim() !== '',
    );
  }
  const listed = gov?.protectedBranches;
  if (Array.isArray(listed)) {
    policy.protectedBranches = (listed as unknown[]).filter(
      (b): b is string => typeof b === 'string' && /^[A-Za-z0-9._/-]+\*?$/.test(b),
    );
  }
  return policy;
}

/**
 * Read the dispatch policy from `<mainRoot>/.ai-sdlc/agent-role.yaml`, where
 * `mainRoot` is the verified main checkout of the repository both `projectDir`
 * and `cwd` belong to. A checkout that does not verify, or an unreadable file,
 * grants nothing and leaves force pushes at `never`.
 */
export function loadOperationalPolicy(
  projectDir: string,
  cwd: string = projectDir,
  run: GitRunner = runGit,
): OperationalPolicy {
  try {
    const root = trustedPolicyRoot(projectDir, cwd, run);
    if (!root) return DENY_ALL();
    const file = path.join(root, '.ai-sdlc', 'agent-role.yaml');
    if (!existsSync(file)) return DENY_ALL();
    return parseOperationalPolicy(readFileSync(file, 'utf-8'));
  } catch {
    return DENY_ALL();
  }
}

/**
 * Read the granted actions from the verified main checkout's policy. A checkout
 * that does not verify, or an unreadable file, grants nothing.
 */
export function loadOperational(
  projectDir: string,
  cwd: string = projectDir,
  run: GitRunner = runGit,
): Set<OperationalAction> {
  return loadOperationalPolicy(projectDir, cwd, run).operational;
}
