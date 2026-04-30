/**
 * Tests for `scripts/check-backlog-ascii.sh` — AISDLC-92.
 *
 * The script is invoked from `.husky/pre-commit` (operator-wired) and
 * rejects any commit that adds or renames a backlog `.md` file with
 * non-ASCII characters in its filename.
 *
 * We exercise it against a synthetic git repo with various staged
 * states so a future change to the script's grep semantics can't
 * silently regress.
 *
 * Run with: node --test scripts/check-backlog-ascii.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-backlog-ascii.sh');

function cleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-ascii-check-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Mirror the real layout — script greps `backlog/{tasks,completed}/*.md`.
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
  // Initial commit so HEAD exists (diff --cached needs an index against HEAD).
  writeFileSync(join(root, '.gitkeep'), '');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  // Make the script reachable from the test repo via a `scripts/` symlink-ish
  // copy. We just call SCRIPT with cwd=root, which is what husky does.
  return root;
}

function runCheck(cwd) {
  // The script lives in this repo (not the temp repo), so we invoke it
  // by absolute path with cwd=temp. Husky does the same shape:
  // `cd $repo_root && ./scripts/check-backlog-ascii.sh`.
  return spawnSync('bash', [SCRIPT], { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

describe('check-backlog-ascii.sh (AISDLC-92)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 when nothing is staged', () => {
    const r = runCheck(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('exits 0 when only ASCII backlog filenames are staged', () => {
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-99 - ascii-only-title.md'),
      '# task\nstatus: To Do\n',
    );
    git(['add', 'backlog/tasks/aisdlc-99 - ascii-only-title.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('exits 1 when an em-dash is in a staged backlog filename', () => {
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-99 - title-with-—-em-dash.md'),
      '# task\n',
    );
    git(['add', 'backlog/tasks/aisdlc-99 - title-with-—-em-dash.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 1, `expected 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /ASCII-only \(AISDLC-92\)/);
    assert.match(r.stderr, /em-dash/); // proves the offending path is shown
  });

  it('exits 1 when a rightwards-arrow is in a staged backlog filename', () => {
    writeFileSync(
      join(root, 'backlog', 'completed', 'aisdlc-99 - lookahead-→-notification.md'),
      '# task\n',
    );
    git(['add', 'backlog/completed/aisdlc-99 - lookahead-→-notification.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ASCII-only/);
    assert.match(r.stderr, /lookahead/);
  });

  it('exits 1 on RENAME (R) into a unicode filename, not just additions', () => {
    // First commit an ASCII file; then `git mv` it to a unicode name.
    writeFileSync(join(root, 'backlog', 'tasks', 'aisdlc-99 - ascii-only.md'), '# task\n');
    git(['add', 'backlog/tasks/aisdlc-99 - ascii-only.md'], root);
    git(['commit', '-q', '-m', 'add ascii task'], root);
    git(
      ['mv', 'backlog/tasks/aisdlc-99 - ascii-only.md', 'backlog/tasks/aisdlc-99 - now-with-—.md'],
      root,
    );
    const r = runCheck(root);
    assert.equal(r.status, 1, `expected 1 on rename, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /now-with/);
  });

  it('does NOT block when an UNTRACKED unicode-named file is in the worktree', () => {
    // The hook only scans STAGED diffs, so an unstaged file in the worktree
    // (e.g. a draft titles file an editor created) must not block commits.
    writeFileSync(join(root, 'backlog', 'tasks', 'aisdlc-99 - draft-—-not-staged.md'), '# draft\n');
    // Stage something else (an ascii file) so there's a real commit shape.
    writeFileSync(join(root, 'backlog', 'tasks', 'aisdlc-100 - ascii.md'), '# t\n');
    git(['add', 'backlog/tasks/aisdlc-100 - ascii.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('does NOT block when a previously-committed unicode file is unchanged', () => {
    // Backfill scenario: legacy unicode files already in `backlog/completed/`
    // must not trigger the hook on unrelated commits. We commit a unicode
    // file straight to the index (bypassing the hook itself in this test
    // — we're testing the script, not the husky wiring), then stage an
    // unrelated ASCII change and confirm the script ignores the legacy.
    writeFileSync(
      join(root, 'backlog', 'completed', 'aisdlc-15 - legacy-—-unicode.md'),
      '# legacy\n',
    );
    git(['add', 'backlog/completed/aisdlc-15 - legacy-—-unicode.md'], root);
    git(['commit', '-q', '-m', 'land legacy'], root);
    // Unrelated ascii change on top.
    writeFileSync(join(root, 'README.md'), 'unrelated\n');
    git(['add', 'README.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });
});
