/**
 * AISDLC-546 — hermetic tests: a local bare repo is `origin`; `gh` is injected (no network).
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  resolveEventLogPath,
} from './event-log.js';
import {
  assertDecisionIdFree,
  DECISIONS_SYNC_BRANCH,
  defaultRunner,
  nextDecisionIdDurable,
  persistDecisionLog,
  type GitRunner,
} from './remote-persist.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

let root: string;
let origin: string;
let parent: string;
const ghCalls: string[][] = [];
let openPrUrl = '';
let savedTrust: Record<string, string | undefined>;
const restore = (k: string, v: string | undefined): void => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
const runner: GitRunner = (cmd, args, opts) => {
  if (cmd === 'gh') {
    ghCalls.push(args);
    return args[1] === 'list'
      ? { status: 0, stdout: openPrUrl, stderr: '' }
      : { status: 0, stdout: 'https://example.invalid/pull/1\n', stderr: '' };
  }
  return defaultRunner(cmd, args, opts);
};

function addDec(workDir: string, id: string): void {
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId: id,
      source: 'ad-hoc',
      scope: 't',
      summary: `s ${id}`,
      reversible: true,
      options: [{ id: 'a', description: 'a' }],
    }),
    { workDir },
  );
}

beforeEach(() => {
  ghCalls.length = 0;
  openPrUrl = '';
  delete process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST;
  savedTrust = {
    u: process.env.AI_SDLC_UNTRUSTED_RUN,
    g: process.env.GITHUB_ACTIONS,
    i: process.env.AI_SDLC_INTERNAL_RUN,
  };
  delete process.env.AI_SDLC_UNTRUSTED_RUN;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.AI_SDLC_INTERNAL_RUN;
  root = mkdtempSync(join(tmpdir(), 'dec-persist-'));
  origin = join(root, 'origin.git');
  parent = join(root, 'parent');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, parent);
  git(parent, 'config', 'user.email', 't@t.invalid');
  git(parent, 'config', 'user.name', 't');
  mkdirSync(join(parent, '.ai-sdlc', '_decisions'), { recursive: true });
  writeFileSync(join(parent, 'README.md'), 'x');
  git(parent, 'add', '.');
  git(parent, 'commit', '-m', 'init');
  git(parent, 'push', '-u', 'origin', 'HEAD:main');
});
afterEach(() => {
  restore('AI_SDLC_UNTRUSTED_RUN', savedTrust.u);
  restore('GITHUB_ACTIONS', savedTrust.g);
  restore('AI_SDLC_INTERNAL_RUN', savedTrust.i);
  rmSync(root, { recursive: true, force: true });
});

describe('persistDecisionLog (AISDLC-546)', () => {
  it('add -> parent hard reset -> decision survives on origin and number is not reused', () => {
    addDec(parent, 'DEC-0001');
    const r = persistDecisionLog({ workDir: parent, runner });
    expect(r.persisted).toBe(true);
    expect(r.prUrl).toBe('https://example.invalid/pull/1');
    // working tree / index untouched
    expect(git(parent, 'status', '--porcelain')).toContain('.ai-sdlc/');

    // Simulate check-orchestrator-state.sh: wipe the un-synced local append.
    rmSync(resolveEventLogPath(parent), { force: true });
    expect(
      git(parent, 'show', `origin/${DECISIONS_SYNC_BRANCH}:.ai-sdlc/_decisions/events.jsonl`),
    ).toContain('DEC-0001');

    expect(nextDecisionIdDurable({ workDir: parent, runner })).toBe('DEC-0002');
    expect(() => assertDecisionIdFree('DEC-0001', { workDir: parent, runner })).toThrow(
      /refusing to reuse/,
    );
    expect(() => assertDecisionIdFree('DEC-0002', { workDir: parent, runner })).not.toThrow();
  });

  it('accumulates across adds (union, no drops)', () => {
    addDec(parent, 'DEC-0001');
    persistDecisionLog({ workDir: parent, runner });
    addDec(parent, 'DEC-0002');
    persistDecisionLog({ workDir: parent, runner });
    const remote = git(
      parent,
      'show',
      `origin/${DECISIONS_SYNC_BRANCH}:.ai-sdlc/_decisions/events.jsonl`,
    );
    expect(remote).toContain('DEC-0001');
    expect(remote).toContain('DEC-0002');
  });

  it('reuses the open sync PR instead of creating another', () => {
    openPrUrl = 'https://example.invalid/pull/77\n';
    addDec(parent, 'DEC-0001');
    const r = persistDecisionLog({ workDir: parent, runner });
    expect(r.prUrl).toBe('https://example.invalid/pull/77');
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'create')).toBe(false);
  });

  it('answer-style append lands on the sync branch', () => {
    addDec(parent, 'DEC-0001');
    persistDecisionLog({ workDir: parent, runner });
    appendDecisionEvent(
      makeOperatorAnsweredEvent({ decisionId: 'DEC-0001', chosenOptionId: 'a', by: 'op@test' }),
      { workDir: parent },
    );
    expect(persistDecisionLog({ workDir: parent, runner }).persisted).toBe(true);
    const remote = git(
      parent,
      'show',
      `origin/${DECISIONS_SYNC_BRANCH}:.ai-sdlc/_decisions/events.jsonl`,
    );
    expect(remote).toContain('operator-answered');
  });

  it('recovers after the sync PR merged and its branch was deleted on origin', () => {
    addDec(parent, 'DEC-0001');
    expect(persistDecisionLog({ workDir: parent, runner }).persisted).toBe(true);
    // Merge: fast-forward main to the sync branch, then delete the remote sync branch.
    git(parent, 'push', 'origin', `origin/${DECISIONS_SYNC_BRANCH}:refs/heads/main`);
    // Delete inside the bare repo so the parent's tracking ref is NOT pruned (stale).
    git(origin, 'update-ref', '-d', `refs/heads/${DECISIONS_SYNC_BRANCH}`);
    // Stale tracking ref still present locally (no --prune).
    expect(git(parent, 'rev-parse', '--verify', `origin/${DECISIONS_SYNC_BRANCH}`)).toBeTruthy();

    addDec(parent, 'DEC-0002');
    const r = persistDecisionLog({ workDir: parent, runner });
    expect(r.persisted).toBe(true);
    const remote = git(
      parent,
      'show',
      `origin/${DECISIONS_SYNC_BRANCH}:.ai-sdlc/_decisions/events.jsonl`,
    );
    expect(remote).toContain('DEC-0001');
    expect(remote).toContain('DEC-0002');
  });

  it('numbering takes max of origin/main and local ledgers', () => {
    addDec(parent, 'DEC-0005');
    git(parent, 'add', '-f', '.ai-sdlc/_decisions/events.jsonl');
    git(parent, 'commit', '-m', 'ledger');
    git(parent, 'push', 'origin', 'HEAD:main');
    rmSync(resolveEventLogPath(parent), { force: true });
    expect(nextDecisionIdDurable({ workDir: parent, runner })).toBe('DEC-0006');
  });

  it('degrades gracefully with no git repo, no remote, or when disabled', () => {
    const warns: string[] = [];
    const plain = mkdtempSync(join(tmpdir(), 'dec-plain-'));
    addDec(plain, 'DEC-0001');
    expect(persistDecisionLog({ workDir: plain, runner }).persisted).toBe(false);
    expect(nextDecisionIdDurable({ workDir: plain, runner })).toBe('DEC-0002');
    rmSync(plain, { recursive: true, force: true });

    addDec(parent, 'DEC-0001');
    git(parent, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const r = persistDecisionLog({ workDir: parent, runner, warn: (m) => warns.push(m) });
    expect(r.persisted).toBe(false);
    expect(warns.join('')).toMatch(/WARN/);
    expect(readFileSync(resolveEventLogPath(parent), 'utf8')).toContain('DEC-0001');

    const r2 = persistDecisionLog({
      workDir: parent,
      runner,
      env: { ...process.env, AI_SDLC_DECISIONS_NO_REMOTE_PERSIST: '1' },
    });
    expect(r2).toEqual({ persisted: false, reason: 'disabled' });
  });

  it('untrusted run (process env) does not push; local append retained', () => {
    addDec(parent, 'DEC-0001');
    process.env.AI_SDLC_UNTRUSTED_RUN = '1';
    const warns: string[] = [];
    // a caller-supplied env must not be able to downgrade the signal
    const r = persistDecisionLog({
      workDir: parent,
      runner,
      env: { ...process.env, AI_SDLC_UNTRUSTED_RUN: '0' },
      warn: (m) => warns.push(m),
    });
    expect(r).toEqual({ persisted: false, reason: 'untrusted run' });
    expect(warns.join('')).toMatch(/untrusted/);
    expect(git(origin, 'branch', '--list', DECISIONS_SYNC_BRANCH)).toBe('');
    expect(readFileSync(resolveEventLogPath(parent), 'utf8')).toContain('DEC-0001');
  });

  it('drops invalid ledger lines before the union merge', () => {
    addDec(parent, 'DEC-0001');
    appendFileSync(resolveEventLogPath(parent), 'not json\n{"type":"bogus"}\n');
    const warns: string[] = [];
    expect(
      persistDecisionLog({ workDir: parent, runner, warn: (m) => warns.push(m) }).persisted,
    ).toBe(true);
    const remote = git(
      parent,
      'show',
      `origin/${DECISIONS_SYNC_BRANCH}:.ai-sdlc/_decisions/events.jsonl`,
    );
    expect(remote).toContain('DEC-0001');
    expect(remote).not.toContain('not json');
    expect(remote).not.toContain('bogus');
    expect(warns.filter((w) => /invalid ledger line/.test(w))).toHaveLength(2);
  });
});
