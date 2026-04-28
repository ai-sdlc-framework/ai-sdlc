/**
 * Real-fs integration tests for `detectCrossRepoWrites`.
 *
 * Lives in its own file so it doesn't inherit git-utils.test.ts's
 * `vi.mock('node:child_process')` — these tests need to spawn real `git`
 * processes against real temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectCrossRepoWrites } from './git-utils.js';
import { cleanGitEnv } from '../runtime/git-env.js';

const execFileAsync = promisify(execFile);

// cleanGitEnv() prevents leaked GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
// from binding these temp-repo commands to a parent worktree's git context
// (the AISDLC-68 → AISDLC-72 surface story).
async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: cleanGitEnv() });
}

async function makeRepo(dir: string): Promise<void> {
  await mkdir(dir);
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 't@t.com');
  await git(dir, 'config', 'user.name', 't');
  await writeFile(join(dir, 'README.md'), '# init\n');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-q', '-m', 'init');
}

describe('detectCrossRepoWrites — real fs integration', () => {
  let parent: string;

  beforeEach(async () => {
    // Resolve symlinks (macOS /var → /private/var) so paths match what the
    // function returns after its own realpath/resolve calls.
    parent = await realpath(await mkdtemp(join(tmpdir(), 'cross-repo-real-')));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('detects dirty sibling repo and returns the modified file list', async () => {
    const workRepo = join(parent, 'main-repo');
    const sister = join(parent, 'sister-repo');
    await makeRepo(workRepo);
    await makeRepo(sister);

    // Dirty the sister.
    await writeFile(join(sister, 'README.md'), '# changed\n');
    await writeFile(join(sister, 'newfile.md'), 'new\n');

    const writes = await detectCrossRepoWrites(workRepo);

    expect(writes).toHaveLength(1);
    expect(writes[0].repoPath).toBe(sister);
    expect(writes[0].files.sort()).toEqual(['README.md', 'newfile.md']);
  });

  it('returns [] when sibling repos exist but are clean', async () => {
    const workRepo = join(parent, 'main-repo');
    const sister = join(parent, 'sister-repo');
    await makeRepo(workRepo);
    await makeRepo(sister);

    const writes = await detectCrossRepoWrites(workRepo);
    expect(writes).toEqual([]);
  });

  it('skips non-git sibling directories silently', async () => {
    const workRepo = join(parent, 'main-repo');
    const notARepo = join(parent, 'just-a-folder');
    await makeRepo(workRepo);
    await mkdir(notARepo);
    await writeFile(join(notARepo, 'random.txt'), 'not tracked anywhere\n');

    const writes = await detectCrossRepoWrites(workRepo);
    expect(writes).toEqual([]);
  });

  it('reports each dirty sibling separately when there are multiple', async () => {
    const workRepo = join(parent, 'main-repo');
    const sisterA = join(parent, 'sister-a');
    const sisterB = join(parent, 'sister-b');
    await makeRepo(workRepo);
    await makeRepo(sisterA);
    await makeRepo(sisterB);

    await writeFile(join(sisterA, 'a.md'), 'a\n');
    await writeFile(join(sisterB, 'b.md'), 'b\n');

    const writes = await detectCrossRepoWrites(workRepo);
    expect(writes.map((w) => w.repoPath).sort()).toEqual([sisterA, sisterB].sort());
    for (const w of writes) {
      expect(w.files.length).toBeGreaterThan(0);
    }
  });
});
