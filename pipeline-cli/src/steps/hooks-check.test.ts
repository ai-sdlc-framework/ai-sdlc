import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultHooksCheckFs,
  ensureWorktreeHooks,
  formatNodeRequirement,
  HOOKS_FIX_COMMAND,
  readRequiredNodeRange,
  resolveHooksDir,
} from './hooks-check.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';

let root: string;
let main: string;
let wt: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ai-sdlc-hooks-check-'));
  main = join(root, 'main');
  wt = join(root, 'wt');
  mkdirSync(main, { recursive: true });
  mkdirSync(wt, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const HOOKS_REL = '.husky/_';

function writeHook(checkout: string, mode = 0o755): string {
  const dir = join(checkout, HOOKS_REL);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'pre-push');
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, mode);
  return file;
}

/** git answers `rev-parse --git-path hooks` with the relative core.hooksPath, as husky sets it. */
function gitRunner(): FakeRunner {
  return new FakeRunner().on(
    (cmd, args) => cmd === 'git' && args[2] === 'rev-parse' && args[3] === '--git-path',
    ok(`${HOOKS_REL}\n`),
  );
}

const pnpmCalls = (fake: FakeRunner) =>
  fake.calls.filter((c) => c.command === 'pnpm').map((c) => c.args.join(' '));

describe('ensureWorktreeHooks', () => {
  it('runs prepare once and passes when the hooks directory appears', async () => {
    writeHook(main);
    mkdirSync(join(wt, 'node_modules'));
    const fake = gitRunner().on(
      (cmd, args) => cmd === 'pnpm' && args.join(' ') === 'run prepare',
      () => {
        writeHook(wt);
        return ok();
      },
    );
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
    });
    expect(r.status).toBe('repaired');
    expect(r.prepareRuns).toBe(1);
    expect(pnpmCalls(fake)).toEqual(['run prepare']);
    expect(fake.calls.find((c) => c.command === 'pnpm')?.opts?.cwd).toBe(wt);
  });

  it('fails naming the directory and the command when prepare does not produce it', async () => {
    writeHook(main);
    mkdirSync(join(wt, 'node_modules'));
    const fake = gitRunner();
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
    });
    expect(r.status).toBe('missing');
    expect(r.prepareRuns).toBe(1);
    expect(r.message).toContain(join(wt, HOOKS_REL));
    expect(r.message).toContain(`cd ${wt} && ${HOOKS_FIX_COMMAND}`);
  });

  it('reports the failing prepare output', async () => {
    writeHook(main);
    mkdirSync(join(wt, 'node_modules'));
    const fake = gitRunner().on(
      (cmd, args) => cmd === 'pnpm' && args[0] === 'run',
      fail('husky: command not found', 127),
    );
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
    });
    expect(r.status).toBe('missing');
    expect(r.message).toContain('husky: command not found');
  });

  it('passes with no failure and no prepare run when the repository has no pre-push hook', async () => {
    const fake = gitRunner();
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
    });
    expect(r.status).toBe('not-expected');
    expect(r.prepareRuns).toBe(0);
    expect(pnpmCalls(fake)).toEqual([]);
  });

  it('does not expect a pre-push hook that is not executable', async () => {
    writeHook(main, 0o644);
    const fake = gitRunner();
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
    });
    expect(r.status).toBe('not-expected');
    expect(pnpmCalls(fake)).toEqual([]);
  });

  it('passes without running anything when the worktree already has its hook', async () => {
    writeHook(main);
    writeHook(wt);
    const fake = gitRunner();
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
    });
    expect(r.status).toBe('present');
    expect(pnpmCalls(fake)).toEqual([]);
  });

  it('with no node_modules fails at once with the install-and-prepare command and runs nothing', async () => {
    writeHook(main);
    writeFileSync(join(main, 'package.json'), JSON.stringify({ engines: { node: '>=22.22.1' } }));
    const fake = gitRunner();
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
      activeNodeVersion: 'v22.19.0',
    });
    expect(r.status).toBe('missing');
    expect(r.prepareRuns).toBe(0);
    expect(r.message).toContain(join(wt, HOOKS_REL));
    expect(r.message).toContain('pnpm install --frozen-lockfile && pnpm run prepare');
    expect(r.message).toContain('>=22.22.1');
    expect(r.message).toContain('v22.19.0');
    expect(fake.calls.filter((c) => c.command !== 'git')).toEqual([]);
  });

  it('never runs an install, in any branch', async () => {
    writeHook(main);
    const bare = gitRunner();
    await ensureWorktreeHooks({ runner: bare.toRunner(), workDir: main, worktreePath: wt });
    mkdirSync(join(wt, 'node_modules'));
    const withModules = gitRunner();
    await ensureWorktreeHooks({ runner: withModules.toRunner(), workDir: main, worktreePath: wt });
    for (const fake of [bare, withModules]) {
      expect(pnpmCalls(fake).some((c) => c.startsWith('install'))).toBe(false);
    }
  });

  it('names Node minimum, active version and the fix command when prepare leaves it missing', async () => {
    writeHook(main);
    writeFileSync(join(main, 'package.json'), JSON.stringify({ engines: { node: '>=22.22.1' } }));
    mkdirSync(join(wt, 'node_modules'));
    const r = await ensureWorktreeHooks({
      runner: gitRunner().toRunner(),
      workDir: main,
      worktreePath: wt,
      activeNodeVersion: 'v22.19.0',
    });
    expect(r.message).toContain(HOOKS_FIX_COMMAND);
    expect(r.message).toContain('>=22.22.1');
    expect(r.message).toContain('v22.19.0');
  });

  it('fails when git cannot resolve the worktree hooks directory', async () => {
    writeHook(main);
    mkdirSync(join(wt, 'node_modules'));
    const fake = new FakeRunner().on(
      (cmd, args) => cmd === 'git' && args[1] === wt,
      fail('fatal: not a git repository', 128),
    );
    fake.on((cmd, args) => cmd === 'git' && args[1] === main, ok(`${HOOKS_REL}\n`));
    const r = await ensureWorktreeHooks({
      runner: fake.toRunner(),
      workDir: main,
      worktreePath: wt,
    });
    expect(r.status).toBe('missing');
    expect(r.message).toContain('git could not resolve it');
  });
});

describe('resolveHooksDir', () => {
  it('resolves a relative answer against the checkout and keeps an absolute one', async () => {
    const rel = new FakeRunner().on(/rev-parse/, ok('.husky/_\n'));
    expect(await resolveHooksDir(rel.toRunner(), main)).toBe(join(main, '.husky', '_'));
    expect(rel.calls[0].args).toEqual(['-C', main, 'rev-parse', '--git-path', 'hooks']);
    const abs = new FakeRunner().on(/rev-parse/, ok('/elsewhere/hooks\n'));
    expect(await resolveHooksDir(abs.toRunner(), main)).toBe('/elsewhere/hooks');
  });

  it('returns null when git fails or prints nothing', async () => {
    expect(
      await resolveHooksDir(new FakeRunner().on(/rev-parse/, fail('x', 128)).toRunner(), main),
    ).toBe(null);
    expect(await resolveHooksDir(new FakeRunner().toRunner(), main)).toBe(null);
  });
});

describe('Node requirement helpers', () => {
  it('names the active Node version', () => {
    const m = formatNodeRequirement({ activeNodeVersion: 'v22.19.0', requiredRange: '>=22.22.1' });
    expect(m).toContain('Active Node: v22.19.0');
  });

  it('names the required range', () => {
    const m = formatNodeRequirement({ activeNodeVersion: 'v22.19.0', requiredRange: '>=22.22.1' });
    expect(m).toContain('Required:    >=22.22.1');
  });

  it('names the fix command', () => {
    const m = formatNodeRequirement({ activeNodeVersion: 'v22.19.0', requiredRange: '>=22.22.1' });
    expect(m).toContain('nvm install && nvm use');
  });

  it('points at package.json when the range is unknown', () => {
    const m = formatNodeRequirement({ activeNodeVersion: 'v20.0.0', requiredRange: null });
    expect(m).toContain('engines.node');
  });

  it('reads engines.node from package.json and tolerates absent or malformed files', () => {
    writeFileSync(join(main, 'package.json'), JSON.stringify({ engines: { node: ' >=22.22.1 ' } }));
    expect(readRequiredNodeRange(main, defaultHooksCheckFs)).toBe('>=22.22.1');
    expect(readRequiredNodeRange(wt, defaultHooksCheckFs)).toBe(null);
    writeFileSync(join(wt, 'package.json'), '{not json');
    expect(readRequiredNodeRange(wt, defaultHooksCheckFs)).toBe(null);
  });
});
