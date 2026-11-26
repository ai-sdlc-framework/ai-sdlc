/**
 * Promotion verifier (RFC-0053 OQ-3). Code, not a model: re-runs a proof from the
 * closed vocabulary declared in the ontology. Agents never reach `canonical`.
 * Proof syntax: `<kind>:<value>` with kind in test-id | decision-id | path-exists |
 * allowlisted-command (value `<commandId>::<expected output substring>`).
 */
import { execFileSync } from 'node:child_process';
import type { KnowledgeConfig } from './config.js';
import { appendKnowledgeEvent } from './log.js';
import { AGENT_CONFIDENCE_CAP } from './entry.js';
import { openKnowledgeStore, type KnowledgeBackendSelection } from './knowledge-store.js';
import type { Ontology } from './ontology.js';

export const REOBSERVE_WEIGHT = 0.3;

export interface TestRunner {
  (file: string, name: string | undefined, cwd: string): boolean;
}
export interface CommandRunner {
  (argv: string[], cwd: string): string;
}

export interface VerifyContext {
  projectDir: string;
  ontology: Ontology;
  config: KnowledgeConfig;
  mainRef?: string;
  runTest?: TestRunner;
  runCommand?: CommandRunner;
}

export interface Verdict {
  ok: boolean;
  reason: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const defaultRunTest: TestRunner = (file, name, cwd) => {
  try {
    const args = ['exec', 'vitest', 'run', file, '--reporter=json'];
    if (name) args.push('-t', name);
    const out = execFileSync('pnpm', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const json = JSON.parse(out.slice(out.indexOf('{'))) as {
      numPassedTests?: number;
      numFailedTests?: number;
    };
    return (json.numPassedTests ?? 0) > 0 && (json.numFailedTests ?? 0) === 0;
  } catch {
    return false;
  }
};

const defaultRunCommand: CommandRunner = (argv, cwd) =>
  execFileSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const TEST_ID_RE = /^([A-Za-z0-9_./@-]+\.test\.[cm]?[jt]s)(?:::(.+))?$/;

function trackedPath(cwd: string, p: string): boolean {
  if (p === '' || p.startsWith('/') || p.split(/[\\/]/).includes('..')) return false;
  return git(cwd, ['ls-files', '--error-unmatch', '--', p]) !== null;
}

function verifyTestId(v: string, c: VerifyContext): Verdict {
  const m = TEST_ID_RE.exec(v);
  if (!m) return { ok: false, reason: `malformed test id '${v}'` };
  const [, file, name] = m;
  if (!trackedPath(c.projectDir, file)) {
    return { ok: false, reason: `test file '${file}' is not in the tracked tree` };
  }
  if (git(c.projectDir, ['status', '--porcelain', '--', file])?.trim()) {
    return { ok: false, reason: `test file '${file}' differs from the committed tree` };
  }
  const passed = (c.runTest ?? defaultRunTest)(file, name, c.projectDir);
  return passed
    ? { ok: true, reason: 'test passed' }
    : { ok: false, reason: `test '${v}' failed or matched no tests` };
}

function verifyDecisionId(v: string, c: VerifyContext): Verdict {
  if (!/^DEC-\d{4,}$/.test(v)) return { ok: false, reason: `malformed decision id '${v}'` };
  const refs = c.mainRef ? [c.mainRef] : ['origin/main', 'main'];
  for (const ref of refs) {
    const tree = git(c.projectDir, [
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      '--',
      '.ai-sdlc/_decisions',
    ]);
    if (tree?.split('\n').some((f) => f.includes(`__${v}__`))) {
      return { ok: true, reason: `${v} present on ${ref}` };
    }
  }
  return { ok: false, reason: `${v} not present on main` };
}

function verifyPath(v: string, c: VerifyContext): Verdict {
  return trackedPath(c.projectDir, v)
    ? { ok: true, reason: 'path is tracked' }
    : { ok: false, reason: `path '${v}' is not in the tracked tree` };
}

function verifyCommand(v: string, c: VerifyContext): Verdict {
  const i = v.indexOf('::');
  const id = i < 0 ? v : v.slice(0, i);
  const expected = i < 0 ? '' : v.slice(i + 2);
  const argv = Object.hasOwn(c.config.allowlistedCommands, id)
    ? c.config.allowlistedCommands[id]
    : undefined;
  if (!argv) return { ok: false, reason: `command '${id}' is not in the allowlist` };
  if (expected === '') return { ok: false, reason: 'command proof needs an expected output' };
  try {
    const out = (c.runCommand ?? defaultRunCommand)(argv, c.projectDir);
    return out.includes(expected)
      ? { ok: true, reason: 'output matched' }
      : { ok: false, reason: `output of '${id}' did not match` };
  } catch {
    return { ok: false, reason: `command '${id}' failed` };
  }
}

const VERIFIERS: Record<string, (v: string, c: VerifyContext) => Verdict> = {
  'test-id': verifyTestId,
  'decision-id': verifyDecisionId,
  'path-exists': verifyPath,
  'allowlisted-command': verifyCommand,
};

export function verifyProof(proof: string, c: VerifyContext): Verdict {
  const i = proof.indexOf(':');
  const kind = i < 0 ? '' : proof.slice(0, i);
  const value = i < 0 ? '' : proof.slice(i + 1);
  if (!c.ontology.proofKinds.includes(kind) || !Object.hasOwn(VERIFIERS, kind)) {
    return { ok: false, reason: `proof kind '${kind}' is outside the closed vocabulary` };
  }
  return VERIFIERS[kind](value, c);
}

const AUTHORITY_RANK: Record<string, number> = { inferred: 0, specialist: 1, canonical: 2 };

export type Role = 'agent' | 'human';

/** Who acts on an entry: the role authority rules read, and the audit principal. */
export interface Actor {
  by: Role;
  principal: string;
}

export interface PromoteResult extends Verdict {
  authority?: string;
}

export function promoteEntry(
  sel: KnowledgeBackendSelection,
  trackedRootAbs: string,
  id: string,
  opts: { to: 'specialist' | 'canonical'; proof?: string; by: Role; principal: string },
  c: VerifyContext,
): PromoteResult {
  const store = openKnowledgeStore({ ...sel, trackedRoot: trackedRootAbs });
  const entry = store.get(id, { scope: 'tracked' });
  if (!entry) return { ok: false, reason: `entry '${id}' not found` };
  const current = String(entry.fields.authority);
  if (opts.to === 'canonical') {
    if (opts.by !== 'human') {
      return {
        ok: false,
        reason: 'canonical requires a human; agent role refused',
        authority: current,
      };
    }
  } else {
    if (
      AUTHORITY_RANK[current] !== undefined &&
      AUTHORITY_RANK[current] >= AUTHORITY_RANK.specialist
    ) {
      return {
        ok: false,
        reason: `entry is already ${current}; specialist promotion never demotes`,
        authority: current,
      };
    }
    if (!opts.proof)
      return { ok: false, reason: 'promotion to specialist requires --proof', authority: current };
    const v = verifyProof(opts.proof, c);
    if (!v.ok) return { ...v, authority: current };
  }
  store.update(
    id,
    (f) => {
      f.authority = opts.to;
      if (opts.proof) f.proof = opts.proof;
      if (f.writtenBy === 'agent') f.writtenBy = 'framework-verifier';
    },
    { scope: 'tracked' },
  );
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'promoted',
    id,
    from: current,
    to: opts.to,
    proof: opts.proof,
    by: opts.by,
    principal: opts.principal,
  });
  return { ok: true, reason: `promoted to ${opts.to}`, authority: opts.to };
}

/** Move confidence 30 percent toward the observed value; authority never changes. */
export function reobserveEntry(
  sel: KnowledgeBackendSelection,
  trackedRootAbs: string,
  id: string,
  observedConfidence: number,
  actor: Actor,
  observedDate?: string,
): number | null {
  let next = 0;
  const before = openKnowledgeStore({ ...sel, trackedRoot: trackedRootAbs }).update(id, (f) => {
    const old = Number(f.confidence);
    next = Math.round((old + REOBSERVE_WEIGHT * (observedConfidence - old)) * 1e6) / 1e6;
    if (f.writtenBy === 'agent') next = Math.min(next, AGENT_CONFIDENCE_CAP);
    f.confidence = next;
    if (observedDate) f.observed = observedDate;
  });
  if (!before) return null;
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'reobserved',
    id,
    by: actor.by,
    principal: actor.principal,
    detail: `confidence ${String(before.confidence)} -> ${next}`,
  });
  return next;
}

/** Refutation drops the entry back to `inferred` and logs why. */
export function refuteEntry(
  sel: KnowledgeBackendSelection,
  trackedRootAbs: string,
  id: string,
  reason: string,
  actor: Actor,
): boolean {
  const before = openKnowledgeStore({ ...sel, trackedRoot: trackedRootAbs }).update(id, (f) => {
    f.authority = 'inferred';
  });
  if (!before) return false;
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'refuted',
    id,
    from: String(before.authority),
    to: 'inferred',
    by: actor.by,
    principal: actor.principal,
    detail: reason,
  });
  return true;
}
