/**
 * Promotion verifier (RFC-0053 OQ-3). Code, not a model: re-runs a proof from the
 * closed vocabulary declared in the ontology. Agents never reach `canonical`.
 * Proof syntax: `<kind>:<value>` with kind in test-id | decision-id | path-exists |
 * allowlisted-command (value `<commandId>::<expected output substring>`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from '../util/yaml.js';
import type { KnowledgeConfig } from './config.js';
import { appendKnowledgeEvent } from './log.js';
import { AGENT_CONFIDENCE_CAP, parseEntryFile } from './entry.js';
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

function findEntryFile(dir: string, id: string): string | null {
  if (!existsSync(dir)) return null;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      const r = findEntryFile(full, id);
      if (r) return r;
    } else if (d.name.endsWith('.md')) {
      const parsed = parseEntryFile(readFileSync(full, 'utf-8'));
      if ('fields' in parsed && parsed.fields.id === id) return full;
    }
  }
  return null;
}

function rewrite(
  file: string,
  edit: (f: Record<string, unknown>) => void,
): Record<string, unknown> {
  const parsed = parseEntryFile(readFileSync(file, 'utf-8'));
  if (!('fields' in parsed)) throw new Error(`${file}: ${parsed.error}`);
  const before = { ...parsed.fields };
  edit(parsed.fields);
  writeFileSync(file, `---\n${dump(parsed.fields)}---\n${parsed.body}`);
  return before;
}

export type Role = 'agent' | 'human';

export interface PromoteResult extends Verdict {
  authority?: string;
}

export function promoteEntry(
  trackedRootAbs: string,
  id: string,
  opts: { to: 'specialist' | 'canonical'; proof?: string; by: Role },
  c: VerifyContext,
): PromoteResult {
  const file = findEntryFile(trackedRootAbs, id);
  if (!file) return { ok: false, reason: `entry '${id}' not found` };
  const current = String(
    (parseEntryFile(readFileSync(file, 'utf-8')) as { fields: Record<string, unknown> }).fields
      .authority,
  );
  if (opts.to === 'canonical') {
    if (opts.by !== 'human') {
      return {
        ok: false,
        reason: 'canonical requires a human; agent role refused',
        authority: current,
      };
    }
  } else {
    if (!opts.proof)
      return { ok: false, reason: 'promotion to specialist requires --proof', authority: current };
    const v = verifyProof(opts.proof, c);
    if (!v.ok) return { ...v, authority: current };
  }
  rewrite(file, (f) => {
    f.authority = opts.to;
    if (opts.proof) f.proof = opts.proof;
    if (f.writtenBy === 'agent') f.writtenBy = 'framework-verifier';
  });
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'promoted',
    id,
    from: current,
    to: opts.to,
    proof: opts.proof,
    by: opts.by,
  });
  return { ok: true, reason: `promoted to ${opts.to}`, authority: opts.to };
}

/** Move confidence 30 percent toward the observed value; authority never changes. */
export function reobserveEntry(
  trackedRootAbs: string,
  id: string,
  observedConfidence: number,
  observedDate?: string,
): number | null {
  const file = findEntryFile(trackedRootAbs, id);
  if (!file) return null;
  let next = 0;
  const before = rewrite(file, (f) => {
    const old = Number(f.confidence);
    next = Math.round((old + REOBSERVE_WEIGHT * (observedConfidence - old)) * 1e6) / 1e6;
    if (f.writtenBy === 'agent') next = Math.min(next, AGENT_CONFIDENCE_CAP);
    f.confidence = next;
    if (observedDate) f.observed = observedDate;
  });
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'reobserved',
    id,
    detail: `confidence ${String(before.confidence)} -> ${next}`,
  });
  return next;
}

/** Refutation drops the entry back to `inferred` and logs why. */
export function refuteEntry(trackedRootAbs: string, id: string, reason: string, by: Role): boolean {
  const file = findEntryFile(trackedRootAbs, id);
  if (!file) return false;
  const before = rewrite(file, (f) => {
    f.authority = 'inferred';
  });
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'refuted',
    id,
    from: String(before.authority),
    to: 'inferred',
    by,
    detail: reason,
  });
  return true;
}
