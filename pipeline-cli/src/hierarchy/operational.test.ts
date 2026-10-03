import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOperational, OPERATIONAL_ACTIONS, parseOperational } from './operational.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'operational-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const yaml = (items: string[]) =>
  `spec:\n  governance:\n    allowForcePush: leaseOnOwnBranch\n    operational:\n${items
    .map((i) => `      - ${i}`)
    .join('\n')}\n`;

describe('parseOperational', () => {
  it('grants the listed actions', () => {
    expect([...parseOperational(yaml(['requeue', 'retrigger-ci']))].sort()).toEqual([
      'requeue',
      'retrigger-ci',
    ]);
  });

  it('drops unknown entries instead of granting them', () => {
    expect([...parseOperational(yaml(['requeue', 'merge-anything', 'push-to-main']))]).toEqual([
      'requeue',
    ]);
  });

  it('grants nothing for a missing, malformed or non-list value', () => {
    expect(parseOperational('spec: {}').size).toBe(0);
    expect(parseOperational('spec:\n  governance:\n    operational: requeue\n').size).toBe(0);
    expect(parseOperational('::: not yaml :::\n\t- [').size).toBe(0);
    expect(parseOperational('').size).toBe(0);
  });

  it('knows every action in the agent role schema', () => {
    expect(OPERATIONAL_ACTIONS).toEqual([
      'rebase-own-branch',
      'lease-push-own-branch',
      'retrigger-ci',
      'requeue',
      'file-subid-followups',
      'answer-operational-decisions',
      'clear-executor-context',
    ]);
  });
});

describe('loadOperational', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });

  function mainRepo(): string {
    const root = path.join(tmp, 'main');
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    git(
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    );
    mkdirSync(path.join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(path.join(root, '.ai-sdlc', 'agent-role.yaml'), yaml(['clear-executor-context']));
    return root;
  }

  it('reads the policy from the verified main checkout', () => {
    const root = mainRepo();
    expect([...loadOperational(root)]).toEqual(['clear-executor-context']);
  });

  it('reads the main checkout copy from a worktree, ignoring the worktree copy', () => {
    const root = mainRepo();
    const wt = path.join(root, '.worktrees', 'aisdlc-1');
    git(root, 'worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-1', wt);
    mkdirSync(path.join(wt, '.ai-sdlc'), { recursive: true });
    writeFileSync(path.join(wt, '.ai-sdlc', 'agent-role.yaml'), yaml(['requeue', 'retrigger-ci']));
    expect([...loadOperational(wt, wt)]).toEqual(['clear-executor-context']);
  });

  it('grants nothing when the project dir and cwd are different repositories', () => {
    const root = mainRepo();
    const other = path.join(tmp, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    expect(loadOperational(root, other).size).toBe(0);
  });

  it('grants nothing outside a git repository, with no file, or with an unreadable file', () => {
    expect(loadOperational(tmp).size).toBe(0);
    const root = mainRepo();
    rmSync(path.join(root, '.ai-sdlc', 'agent-role.yaml'));
    expect(loadOperational(root).size).toBe(0);
    mkdirSync(path.join(root, '.ai-sdlc', 'agent-role.yaml'));
    expect(loadOperational(root).size).toBe(0);
  });

  it('grants nothing when the git runner fails', () => {
    expect(loadOperational(tmp, tmp, () => null).size).toBe(0);
  });
});
