import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadOperational,
  loadOperationalPolicy,
  OPERATIONAL_ACTIONS,
  parseOperational,
  parseOperationalPolicy,
} from './operational.js';

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

  it('grants mark-ready-after-codeql when listed and drops a misspelling (AISDLC-736)', () => {
    expect([
      ...parseOperational(yaml(['mark-ready-after-codeql', 'mark-ready-after-codeqls'])),
    ]).toEqual(['mark-ready-after-codeql']);
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
      'mark-ready-after-codeql',
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

describe('parseOperationalPolicy', () => {
  const doc = (governance: string) => `spec:\n  governance:\n${governance}`;

  it('reads the force-push mode and the protected branch list', () => {
    const p = parseOperationalPolicy(
      doc(
        '    allowForcePush: leaseOnOwnBranch\n    protectedBranches:\n      - "ai-sdlc/*"\n      - staging\n    operational:\n      - requeue\n',
      ),
    );
    expect(p.forcePushMode).toBe('leaseOnOwnBranch');
    expect(p.protectedBranches).toEqual(['ai-sdlc/*', 'staging']);
    expect([...p.operational]).toEqual(['requeue']);
  });

  it('treats true as the lease mode and everything else as never', () => {
    expect(parseOperationalPolicy(doc('    allowForcePush: true\n')).forcePushMode).toBe(
      'leaseOnOwnBranch',
    );
    for (const v of ['never', 'false', 'always', '"leaseOnAnyBranch"', '1']) {
      expect(parseOperationalPolicy(doc(`    allowForcePush: ${v}\n`)).forcePushMode, v).toBe(
        'never',
      );
    }
    // AISDLC-710: UNSET is the leaseOnOwnBranch default (an explicit setting always wins).
    expect(parseOperationalPolicy(doc('    operational:\n      - requeue\n')).forcePushMode).toBe(
      'leaseOnOwnBranch',
    );
    // A present-but-empty value (YAML null) is malformed, not unset.
    expect(parseOperationalPolicy(doc('    allowForcePush:\n')).forcePushMode).toBe('never');
  });

  it('drops protected branch entries that are not well-formed names', () => {
    const p = parseOperationalPolicy(
      doc(
        '    protectedBranches:\n      - ok/*\n      - "bad name"\n      - "x;y"\n      - 5\n      - "*"\n',
      ),
    );
    expect(p.protectedBranches).toEqual(['ok/*']);
  });

  it('denies everything for malformed or empty input', () => {
    for (const text of ['::: not yaml :::\n\t- [']) {
      const p = parseOperationalPolicy(text);
      expect(p.forcePushMode).toBe('never');
      expect(p.operational.size).toBe(0);
      expect(p.protectedBranches).toEqual([]);
    }
  });

  it('grants nothing operational for empty input, but force-push is the lease default (AISDLC-710)', () => {
    for (const text of ['', 'spec: {}']) {
      const p = parseOperationalPolicy(text);
      expect(p.forcePushMode).toBe('leaseOnOwnBranch');
      expect(p.operational.size).toBe(0);
      expect(p.protectedBranches).toEqual([]);
    }
  });
});

describe('loadOperationalPolicy', () => {
  it('denies everything outside a verified checkout', () => {
    const p = loadOperationalPolicy(tmp, tmp, () => null);
    expect(p).toEqual({ operational: new Set(), forcePushMode: 'never', protectedBranches: [] });
  });
});
