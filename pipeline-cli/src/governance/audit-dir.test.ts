import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditGovernanceDir, resolveMainCheckout } from './audit-dir.js';

const saved = process.env.ARTIFACTS_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.ARTIFACTS_DIR;
  else process.env.ARTIFACTS_DIR = saved;
});

describe('audit directory (AISDLC-1010)', () => {
  it('a linked worktree resolves to the main checkout, not the worktree', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'audit-dir-')));
    try {
      const main = join(base, 'main');
      mkdirSync(main);
      const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
      git(main, 'init', '-q');
      git(
        main,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      );
      const wt = join(base, 'wt');
      git(main, 'worktree', 'add', '-q', '-b', 'b', wt);
      delete process.env.ARTIFACTS_DIR;
      expect(resolveMainCheckout(wt)).toBe(main);
      expect(auditGovernanceDir(undefined, wt)).toBe(join(main, 'artifacts', '_governance'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('falls back to cwd outside a git repository', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'audit-nogit-')));
    try {
      expect(resolveMainCheckout(d)).toBe(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('$ARTIFACTS_DIR overrides the location', () => {
    process.env.ARTIFACTS_DIR = '/x/arts';
    expect(auditGovernanceDir()).toBe(join('/x/arts', '_governance'));
  });
});
