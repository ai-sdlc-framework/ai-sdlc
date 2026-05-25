/**
 * Tests for `scripts/auto-rebase-stale-prs.mjs` — AISDLC-420.
 *
 * Strategy: hermetic mock-binary injection via AI_SDLC_REBASE_GH_BIN and
 * AI_SDLC_REBASE_GIT_BIN env vars. Each test writes a tiny POSIX shell
 * script that emulates the subset of `gh` / `git` calls the script makes,
 * then invokes the real script with those binaries on PATH-shim.
 *
 * The 8 cases listed in AC #2:
 *   (a) empty open PRs (no-op)
 *   (b) single clean rebase
 *   (c) single conflicting rebase
 *   (d) mixed batch (one clean, one conflict)
 *   (e) fork PR skipped
 *   (f) draft PR skipped
 *   (g) git user unset -> refuses (exit 2)
 *   (h) temp worktree cleanup on failure path (fetch error)
 *
 * Run with: node --test scripts/auto-rebase-stale-prs.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'auto-rebase-stale-prs.mjs');

/**
 * Write a mock `gh` script that switches on its first argument and returns
 * the configured response for each subcommand. The script also appends every
 * invocation to <root>/gh-calls.log so tests can assert on call sequence.
 *
 * @param {string} root      Temp directory where the mock + log live.
 * @param {object} responses Map of mock responses:
 *   - version: { stdout, stderr, exit } — for `gh --version`
 *   - repoView: { stdout, stderr, exit } — for `gh repo view --json ...`
 *   - prList:   { stdout, stderr, exit } — for `gh pr list ...`
 *   - prComment: { exit }                — for `gh pr comment ...`
 *   - prEdit:    { exit }                — for `gh pr edit ... --add-label ...`
 */
function writeMockGh(root, responses) {
  const path = join(root, 'gh-mock.sh');
  const r = {
    version: { stdout: 'gh version 2.0.0 (mock)\n', stderr: '', exit: 0 },
    repoView: {
      stdout: JSON.stringify({ nameWithOwner: 'org/repo', owner: { login: 'org' } }) + '\n',
      stderr: '',
      exit: 0,
    },
    prList: { stdout: '[]\n', stderr: '', exit: 0 },
    prComment: { exit: 0 },
    prEdit: { exit: 0 },
    ...responses,
  };
  const script = `#!/bin/sh
# Mock gh CLI for auto-rebase-stale-prs tests.
echo "gh $*" >> "${root}/gh-calls.log"
case "$1" in
  --version)
    printf '%s' '${r.version.stdout.replace(/'/g, "'\\''")}'
    >&2 printf '%s' '${r.version.stderr.replace(/'/g, "'\\''")}'
    exit ${r.version.exit}
    ;;
  repo)
    if [ "$2" = "view" ]; then
      printf '%s' '${r.repoView.stdout.replace(/'/g, "'\\''")}'
      >&2 printf '%s' '${r.repoView.stderr.replace(/'/g, "'\\''")}'
      exit ${r.repoView.exit}
    fi
    ;;
  pr)
    case "$2" in
      list)
        printf '%s' '${r.prList.stdout.replace(/'/g, "'\\''")}'
        >&2 printf '%s' '${r.prList.stderr.replace(/'/g, "'\\''")}'
        exit ${r.prList.exit}
        ;;
      comment)
        exit ${r.prComment.exit}
        ;;
      edit)
        exit ${r.prEdit.exit}
        ;;
    esac
    ;;
esac
echo "mock-gh: unhandled args: $*" >&2
exit 99
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Write a mock `git` script. The mock dispatches by first subcommand and
 * supports a "behavior" object that drives the rebase-loop's per-PR outcome.
 *
 * @param {string} root Temp directory.
 * @param {object} cfg
 *   - configEmail: string|null  — what `git config user.email` returns ("" -> empty, exits 1)
 *   - configName:  string|null
 *   - rebaseBranches: Record<string, 'clean'|'conflict'>  — outcome per branch name
 *   - fetchFailBranches: string[]                          — branches whose `git fetch origin <b>` exits non-zero
 *   - conflictFiles: string[]                              — files reported by `git diff --diff-filter=U`
 */
function writeMockGit(root, cfg) {
  const path = join(root, 'git-mock.sh');
  const conflictFiles = (cfg.conflictFiles ?? []).join('\n');
  const rebaseBranches = JSON.stringify(cfg.rebaseBranches ?? {});
  const fetchFails = (cfg.fetchFailBranches ?? []).join('|');
  const email = cfg.configEmail ?? 'github-actions[bot]@users.noreply.github.com';
  const name = cfg.configName ?? 'github-actions[bot]';

  // Use a small shell program. The "rebase per-branch outcome" is driven by
  // checking which branch's worktree we're in (we store the branch name in
  // a sentinel file at worktree-add time).
  const script = `#!/bin/sh
echo "git $*" >> "${root}/git-calls.log"
EMAIL='${email.replace(/'/g, "'\\''")}'
NAME='${name.replace(/'/g, "'\\''")}'
REBASE_MAP='${rebaseBranches.replace(/'/g, "'\\''")}'
FETCH_FAILS='${fetchFails.replace(/'/g, "'\\''")}'
CONFLICT_FILES='${conflictFiles.replace(/'/g, "'\\''")}'

case "$1" in
  config)
    if [ "$2" = "user.email" ]; then
      if [ -z "$EMAIL" ]; then exit 1; fi
      echo "$EMAIL"; exit 0
    fi
    if [ "$2" = "user.name" ]; then
      if [ -z "$NAME" ]; then exit 1; fi
      echo "$NAME"; exit 0
    fi
    exit 0
    ;;
  fetch)
    # "$2" = origin, "$3" = branch
    BR="$3"
    case "|$FETCH_FAILS|" in
      *"|$BR|"*)
        echo "fatal: couldn't find remote ref $BR" >&2
        exit 128
        ;;
    esac
    exit 0
    ;;
  worktree)
    if [ "$2" = "add" ]; then
      # "git worktree add --detach <tmpDir> origin/<branch>"
      TMPDIR_ARG="$4"
      ORIGIN_REF="$5"
      BR="\${ORIGIN_REF#origin/}"
      mkdir -p "$TMPDIR_ARG"
      echo "$BR" > "$TMPDIR_ARG/.branch"
      exit 0
    fi
    if [ "$2" = "remove" ]; then
      # "git worktree remove --force <tmpDir>"
      TMPDIR_ARG="$4"
      rm -rf "$TMPDIR_ARG" 2>/dev/null || true
      exit 0
    fi
    exit 0
    ;;
  rebase)
    if [ "$2" = "--abort" ]; then exit 0; fi
    # Plain "git rebase origin/main" — we run it inside the temp worktree
    # (the script sets cwd to tmpDir). Read .branch sentinel to decide outcome.
    if [ -f .branch ]; then
      BR=$(cat .branch)
      # Cheap JSON lookup: grep the key pattern in REBASE_MAP.
      case "$REBASE_MAP" in
        *"\\"$BR\\":\\"clean\\""*)
          exit 0
          ;;
        *"\\"$BR\\":\\"conflict\\""*)
          echo "CONFLICT (content): conflict on $BR" >&2
          exit 1
          ;;
      esac
    fi
    exit 0
    ;;
  diff)
    # "git diff --name-only --diff-filter=U" — emit conflict files (in tmpDir).
    if [ -n "$CONFLICT_FILES" ]; then
      printf '%s\\n' "$CONFLICT_FILES"
    fi
    exit 0
    ;;
  push)
    # "git push --force-with-lease origin HEAD:<branch>"
    exit 0
    ;;
esac
echo "mock-git: unhandled args: $*" >&2
exit 99
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function setupTmp() {
  return mkdtempSync(join(tmpdir(), 'ai-sdlc-auto-rebase-test-'));
}

function runScript(env, extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

function parseJsonStdout(stdout) {
  // The script writes the JSON summary on stdout, possibly preceded by nothing
  // (we route all logs to stderr). Parse the entire stdout.
  return JSON.parse(stdout.trim());
}

describe('auto-rebase-stale-prs.mjs (AISDLC-420)', () => {
  let root;

  beforeEach(() => {
    root = setupTmp();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── (a) empty open PRs ─────────────────────────────────────────────────────

  it('(a) empty open PR list → no-op, exits 0 with empty rebased/conflicted', () => {
    const gh = writeMockGh(root, { prList: { stdout: '[]\n', stderr: '', exit: 0 } });
    const git = writeMockGit(root, {});
    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(
      r.status,
      0,
      `expected 0, got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`,
    );
    const summary = parseJsonStdout(r.stdout);
    assert.deepEqual(summary.rebased, []);
    assert.deepEqual(summary.conflicted, []);
    assert.deepEqual(summary.skipped, []);
  });

  // ── (b) single clean rebase ────────────────────────────────────────────────

  it('(b) single same-repo non-draft DIRTY PR → clean rebase → push + comment', () => {
    const prList = [
      {
        number: 101,
        headRefName: 'feat/clean',
        isDraft: false,
        headRepositoryOwner: { login: 'org' },
        mergeStateStatus: 'DIRTY',
      },
    ];
    const gh = writeMockGh(root, {
      prList: { stdout: JSON.stringify(prList), stderr: '', exit: 0 },
    });
    const git = writeMockGit(root, { rebaseBranches: { 'feat/clean': 'clean' } });
    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(
      r.status,
      0,
      `expected 0, got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`,
    );
    const summary = parseJsonStdout(r.stdout);
    assert.equal(summary.rebased.length, 1);
    assert.equal(summary.rebased[0].pr, 101);
    assert.equal(summary.rebased[0].branch, 'feat/clean');
    assert.equal(summary.rebased[0].status, 'clean');
    assert.equal(summary.conflicted.length, 0);

    // Assert that the gh CLI was invoked to post a comment.
    const ghCalls = readFileIfExists(join(root, 'gh-calls.log'));
    assert.match(ghCalls, /pr comment 101/, 'expected `gh pr comment 101 ...` call');

    // Assert that the git CLI was invoked to push --force-with-lease.
    const gitCalls = readFileIfExists(join(root, 'git-calls.log'));
    assert.match(gitCalls, /push --force-with-lease origin HEAD:feat\/clean/);
  });

  // ── (c) single conflicting rebase ──────────────────────────────────────────

  it('(c) single conflicting rebase → abort + comment + add label', () => {
    const prList = [
      {
        number: 202,
        headRefName: 'feat/conflict',
        isDraft: false,
        headRepositoryOwner: { login: 'org' },
        mergeStateStatus: 'DIRTY',
      },
    ];
    const gh = writeMockGh(root, {
      prList: { stdout: JSON.stringify(prList), stderr: '', exit: 0 },
    });
    const git = writeMockGit(root, {
      rebaseBranches: { 'feat/conflict': 'conflict' },
      conflictFiles: ['pipeline-cli/src/foo.ts', 'pipeline-cli/src/bar.ts'],
    });
    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(
      r.status,
      0,
      `expected 0, got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`,
    );
    const summary = parseJsonStdout(r.stdout);
    assert.equal(summary.conflicted.length, 1);
    assert.equal(summary.conflicted[0].pr, 202);
    assert.deepEqual(summary.conflicted[0].files.sort(), [
      'pipeline-cli/src/bar.ts',
      'pipeline-cli/src/foo.ts',
    ]);
    assert.equal(summary.rebased.length, 0);

    // Assert comment + label calls happened.
    const ghCalls = readFileIfExists(join(root, 'gh-calls.log'));
    assert.match(ghCalls, /pr comment 202/);
    assert.match(ghCalls, /pr edit 202 .*--add-label needs-manual-rebase/);

    // Assert that `git rebase --abort` was executed.
    const gitCalls = readFileIfExists(join(root, 'git-calls.log'));
    assert.match(gitCalls, /rebase --abort/);
  });

  // ── (d) mixed batch ────────────────────────────────────────────────────────

  it('(d) mixed batch (clean + conflict + behind) → both outcomes processed', () => {
    const prList = [
      {
        number: 301,
        headRefName: 'feat/a',
        isDraft: false,
        headRepositoryOwner: { login: 'org' },
        mergeStateStatus: 'DIRTY',
      },
      {
        number: 302,
        headRefName: 'feat/b',
        isDraft: false,
        headRepositoryOwner: { login: 'org' },
        mergeStateStatus: 'BEHIND',
      },
      {
        number: 303,
        headRefName: 'feat/c',
        isDraft: false,
        headRepositoryOwner: { login: 'org' },
        mergeStateStatus: 'DIRTY',
      },
    ];
    const gh = writeMockGh(root, {
      prList: { stdout: JSON.stringify(prList), stderr: '', exit: 0 },
    });
    const git = writeMockGit(root, {
      rebaseBranches: { 'feat/a': 'clean', 'feat/b': 'clean', 'feat/c': 'conflict' },
      conflictFiles: ['pnpm-lock.yaml'],
    });
    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(
      r.status,
      0,
      `expected 0, got ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`,
    );
    const summary = parseJsonStdout(r.stdout);
    assert.equal(summary.rebased.length, 2, `expected 2 rebased: ${JSON.stringify(summary)}`);
    assert.equal(summary.conflicted.length, 1);
    const rebasedPrs = summary.rebased.map((r) => r.pr).sort();
    assert.deepEqual(rebasedPrs, [301, 302]);
    assert.equal(summary.conflicted[0].pr, 303);
  });

  // ── (e) fork PR skipped ────────────────────────────────────────────────────

  it('(e) fork PR (different owner) → skipped, no rebase attempt', () => {
    const prList = [
      {
        number: 401,
        headRefName: 'contrib/feat',
        isDraft: false,
        headRepositoryOwner: { login: 'external-fork-owner' },
        mergeStateStatus: 'DIRTY',
      },
    ];
    const gh = writeMockGh(root, {
      prList: { stdout: JSON.stringify(prList), stderr: '', exit: 0 },
    });
    const git = writeMockGit(root, {});
    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(r.status, 0);
    const summary = parseJsonStdout(r.stdout);
    assert.equal(summary.rebased.length, 0);
    assert.equal(summary.conflicted.length, 0);
    assert.equal(summary.skipped.length, 1);
    assert.equal(summary.skipped[0].pr, 401);
    assert.match(summary.skipped[0].reason, /fork/);
  });

  // ── (f) draft PR skipped ───────────────────────────────────────────────────

  it('(f) draft PR → skipped, no rebase attempt', () => {
    const prList = [
      {
        number: 501,
        headRefName: 'feat/draft',
        isDraft: true,
        headRepositoryOwner: { login: 'org' },
        mergeStateStatus: 'DIRTY',
      },
    ];
    const gh = writeMockGh(root, {
      prList: { stdout: JSON.stringify(prList), stderr: '', exit: 0 },
    });
    const git = writeMockGit(root, {});
    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(r.status, 0);
    const summary = parseJsonStdout(r.stdout);
    assert.equal(summary.skipped.length, 1);
    assert.equal(summary.skipped[0].pr, 501);
    assert.equal(summary.skipped[0].reason, 'draft');
  });

  // ── (g) git user unset → refuses ───────────────────────────────────────────

  it('(g) git user.email unset → pre-flight refuses with exit 2', () => {
    const gh = writeMockGh(root, {});
    const git = writeMockGit(root, { configEmail: '' });
    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(r.status, 2, `expected 2 (refuse), got ${r.status}\nSTDERR: ${r.stderr}`);
    assert.match(r.stderr, /user\.email is unset/);
  });

  // ── (h) temp worktree cleanup on failure path (fetch error) ────────────────

  it('(h) fetch error → fetchErrors populated, no leaked temp worktrees', () => {
    const prList = [
      {
        number: 601,
        headRefName: 'feat/unreachable',
        isDraft: false,
        headRepositoryOwner: { login: 'org' },
        mergeStateStatus: 'DIRTY',
      },
    ];
    const gh = writeMockGh(root, {
      prList: { stdout: JSON.stringify(prList), stderr: '', exit: 0 },
    });
    const git = writeMockGit(root, { fetchFailBranches: ['feat/unreachable'] });

    // Take a snapshot of $TMPDIR contents before the run; cleanup MUST leave
    // no aisdlc-rebase-* directories behind.
    const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('aisdlc-rebase-'));

    const r = runScript({
      AI_SDLC_REBASE_GH_BIN: gh,
      AI_SDLC_REBASE_GIT_BIN: git,
      AI_SDLC_REBASE_REPO: 'org/repo',
      AI_SDLC_REBASE_OWNER: 'org',
    });

    assert.equal(r.status, 0, `expected 0, got ${r.status}\nSTDERR: ${r.stderr}`);
    const summary = parseJsonStdout(r.stdout);
    assert.equal(summary.fetchErrors.length, 1);
    assert.equal(summary.fetchErrors[0].pr, 601);
    assert.equal(summary.rebased.length, 0);

    const tmpAfter = readdirSync(tmpdir()).filter((n) => n.startsWith('aisdlc-rebase-'));
    const leaked = tmpAfter.filter((n) => !tmpBefore.includes(n));
    assert.deepEqual(leaked, [], `temp worktrees leaked: ${leaked.join(', ')}`);
  });
});

// ── helper ───────────────────────────────────────────────────────────────────

function readFileIfExists(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}
