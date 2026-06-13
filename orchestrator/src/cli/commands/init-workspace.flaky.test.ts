/*
 * Flaky variant of the init-workspace git-remote fallback test.
 *
 * Extracted from init-workspace.test.ts because runInit(['--skip-mcp', '--yes'])
 * spawns child processes that time out on CI under heavy CPU load (observed 2+x,
 * AISDLC-368). This file is excluded from the default vitest run via the
 * "**\/*.flaky.test.ts" exclude pattern in vitest.config.ts and is instead
 * exercised by the nightly .github/workflows/flaky-tests.yml workflow.
 *
 * First flaked: 2026-05-09 (AISDLC-368 emergency hotfix)
 * Convention: docs/operations/flaky-tests.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Initialize `dir` as a real git repo (with no remote) so detectGitRemote
 * sees a valid `.git/` and reports the no-remote fallback path. We write the
 * minimal layout directly instead of spawning `git init` because under heavy
 * parallel CPU contention `git init --quiet` was observed to exit 0 without
 * producing `.git/config`, breaking tests deterministically.
 */
function initBareRepo(dir: string): void {
  const gitDir = join(dir, '.git');
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true });
  mkdirSync(join(gitDir, 'objects', 'pack'), { recursive: true });
  writeFileSync(
    join(gitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n',
  );
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  if (!existsSync(join(gitDir, 'config'))) {
    throw new Error(`initBareRepo: failed to write .git/config in ${dir}`);
  }
  if (!existsSync(join(gitDir, 'HEAD'))) {
    throw new Error(`initBareRepo: failed to write .git/HEAD in ${dir}`);
  }
}

let tmpDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let prevCeiling: string | undefined;
let prevGitDir: string | undefined;
let prevGitWorkTree: string | undefined;
let prevGitCommonDir: string | undefined;
let prevGitIndexFile: string | undefined;
let consoleSpy: {
  mock: { calls: unknown[][] };
  mockRestore(): void;
  mockImplementation(...args: unknown[]): unknown;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'init-ws-flaky-'));
  prevCwd = process.cwd();
  prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
  prevGitDir = process.env.GIT_DIR;
  delete process.env.GIT_DIR;
  prevGitWorkTree = process.env.GIT_WORK_TREE;
  delete process.env.GIT_WORK_TREE;
  prevGitCommonDir = process.env.GIT_COMMON_DIR;
  delete process.env.GIT_COMMON_DIR;
  prevGitIndexFile = process.env.GIT_INDEX_FILE;
  delete process.env.GIT_INDEX_FILE;
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  if (prevGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = prevGitDir;
  if (prevGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
  else process.env.GIT_WORK_TREE = prevGitWorkTree;
  if (prevGitCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
  else process.env.GIT_COMMON_DIR = prevGitCommonDir;
  if (prevGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
  else process.env.GIT_INDEX_FILE = prevGitIndexFile;
  rmSync(tmpDir, { recursive: true, force: true });
  consoleSpy.mockRestore();
  process.exitCode = undefined;
  vi.resetModules();
});

async function runInit(argv: string[], projectDir: string = tmpDir): Promise<void> {
  vi.resetModules();
  process.chdir(projectDir);
  const { initCommand } = await import('./init.js');
  initCommand.setOptionValue('dryRun', undefined);
  initCommand.setOptionValue('role', undefined);
  initCommand.setOptionValue('cursor', undefined);
  initCommand.setOptionValue('skipMcp', undefined);
  initCommand.setOptionValue('yes', undefined);
  initCommand.setOptionValue('withDor', undefined);
  initCommand.setOptionValue('withAttestation', undefined);
  initCommand.setOptionValue('withClassifier', undefined);
  initCommand.setOptionValue('withBranchProtection', undefined);
  initCommand.setOptionValue('withWorkflows', undefined);
  initCommand.setOptionValue('add', undefined);
  initCommand.setOptionValue('workspace', undefined);
  initCommand.setOptionValue('force', undefined);
  await initCommand.parseAsync(argv, { from: 'user' });
}

describe('init — single-repo (AISDLC-78 git-remote fallback) [FLAKY]', () => {
  it('falls back to your-org placeholder when git origin is missing', async () => {
    // Mark the project dir as a git repo (so detectWorkspace() sees a
    // single-repo project) but DO NOT configure an `origin` remote so
    // detectGitRemote returns the FALLBACK.
    initBareRepo(tmpDir);
    await runInit(['--skip-mcp', '--yes']);

    const pipeline = readFileSync(join(tmpDir, '.ai-sdlc', 'pipeline.yaml'), 'utf-8');
    expect(pipeline).toContain('org: your-org');

    // Operator-visible message: AISDLC-78 made the fallback explicit so
    // a fresh-init user knows why the org wasn't substituted.
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('No git origin remote detected');
    expect(out).toContain("'your-org' placeholder");
  });
});
