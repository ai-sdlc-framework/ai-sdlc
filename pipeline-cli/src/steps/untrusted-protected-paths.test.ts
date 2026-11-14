import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultRunner } from '../runtime/exec.js';
import {
  findProtectedPathChanges,
  isUntrustedProtectedPath,
  UNTRUSTED_PROTECTED_PATHS,
} from './untrusted-protected-paths.js';

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const put = (rel: string, body = 'x\n'): void => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), body);
};
const commit = (msg = 'c'): void => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
};
const check = (): Promise<string[]> =>
  findProtectedPathChanges({ worktreePath: repo, baseRef: 'base', runner: defaultRunner });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'untrusted-paths-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  put('.ai-sdlc/agent-role.yaml', 'a\n');
  put('.github/workflows/ci.yml', 'a\n');
  put('src/a.ts', 'a\n');
  commit('base');
  git('tag', 'base');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('findProtectedPathChanges (AISDLC-1275)', () => {
  it('passes a branch that touches only ordinary files', async () => {
    put('src/b.ts');
    commit();
    expect(await check()).toEqual([]);
  });

  it('refuses the variable bypass shape once committed', async () => {
    execFileSync('bash', ['-c', 'd=.ai; echo x > "${d}-sdlc/agent-role.yaml"'], { cwd: repo });
    commit();
    expect(await check()).toEqual(['.ai-sdlc/agent-role.yaml']);
  });

  it('refuses the glob bypass shape once committed', async () => {
    put('evil.yml', 'evil\n');
    execFileSync('bash', ['-c', 'cp evil.yml .ai-sd*/agent-role.yaml'], { cwd: repo });
    commit();
    expect(await check()).toEqual(['.ai-sdlc/agent-role.yaml']);
  });

  it('refuses the script-file bypass shape once committed', async () => {
    put('x.sh', 'mkdir -p .husky && echo x > .husky/pre-push\n');
    execFileSync('bash', ['x.sh'], { cwd: repo });
    commit();
    expect(await check()).toEqual(['.husky/pre-push']);
  });

  it('refuses a protected change committed then restored in the working tree', async () => {
    put('.ai-sdlc/agent-role.yaml', 'evil\n');
    commit('evil');
    git('checkout', 'base', '--', '.ai-sdlc/agent-role.yaml');
    expect(await check()).toEqual(['.ai-sdlc/agent-role.yaml']);
  });

  it('matches protected segments case-insensitively', () => {
    expect(isUntrustedProtectedPath('.AI-SDLC/x.yaml')).toBe(true);
    expect(isUntrustedProtectedPath('.GitHub/Workflows/ci.yml')).toBe(true);
  });

  it('refuses a rename out of a protected directory', async () => {
    git('mv', '.github/workflows/ci.yml', 'src/ci.yml');
    commit();
    expect(await check()).toEqual(['.github/workflows/ci.yml']);
  });

  it('refuses a rename into a protected directory', async () => {
    git('mv', 'src/a.ts', '.claude-a.ts');
    mkdirSync(join(repo, '.claude'));
    git('mv', '.claude-a.ts', '.claude/a.ts');
    commit();
    expect(await check()).toEqual(['.claude/a.ts']);
  });

  it('refuses a mode change', async () => {
    chmodSync(join(repo, '.ai-sdlc/agent-role.yaml'), 0o755);
    commit();
    expect(await check()).toEqual(['.ai-sdlc/agent-role.yaml']);
  });

  it('refuses a deletion', async () => {
    git('rm', '-q', '.github/workflows/ci.yml');
    commit();
    expect(await check()).toEqual(['.github/workflows/ci.yml']);
  });

  it('refuses an uncommitted edit, a staged add and an untracked file', async () => {
    put('.ai-sdlc/agent-role.yaml', 'changed\n');
    put('ai-sdlc-plugin/hooks/h.js');
    git('add', 'ai-sdlc-plugin/hooks/h.js');
    put('.husky/new');
    expect(await check()).toEqual([
      '.ai-sdlc/agent-role.yaml',
      '.husky/new',
      'ai-sdlc-plugin/hooks/h.js',
    ]);
  });

  it('throws when git fails (fail closed)', async () => {
    await expect(
      findProtectedPathChanges({ worktreePath: repo, baseRef: 'nope', runner: defaultRunner }),
    ).rejects.toThrow(/git log failed/);
  });
});

describe('protected list parity with the hook', () => {
  it('matches UNTRUSTED_PROTECTED in enforce-blocked-actions.js', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../ai-sdlc-plugin/hooks/enforce-blocked-actions.js'),
      'utf8',
    );
    const block = /const UNTRUSTED_PROTECTED = \[([\s\S]*?)\n\];/.exec(src);
    expect(block).not.toBeNull();
    const hook = [...block![1].matchAll(/^\s*\[([^\]]*)\],?\s*$/gm)].map((m) =>
      [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]),
    );
    expect(UNTRUSTED_PROTECTED_PATHS.map((s) => [...s])).toEqual(hook);
  });

  it('matches by segment sequence', () => {
    expect(isUntrustedProtectedPath('a/.github/workflows/x.yml')).toBe(true);
    expect(isUntrustedProtectedPath('.github/other.yml')).toBe(false);
    expect(isUntrustedProtectedPath('.ai-sdlcx/y')).toBe(false);
  });
});
