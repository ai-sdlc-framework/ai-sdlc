/**
 * Tests for `scripts/check-skip-ci-marker.sh` — AISDLC-88.
 *
 * The script is invoked from `.husky/pre-push` (operator-wired) and
 * rejects pushes that contain GitHub Actions' five magic CI-skip
 * tokens in any commit body, EXCEPT the AISDLC-87 CI-side attestor's
 * documented chore commit.
 *
 * We exercise it against synthetic git repos with various commit
 * shapes so a future change to the script's grep semantics or the
 * bot-author exemption can't silently regress.
 *
 * Run with: node --test scripts/check-skip-ci-marker.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-skip-ci-marker.sh');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  // Don't inherit a previous override.
  delete env.AI_SDLC_SKIP_MARKER_GATE;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd, extraEnv = {}) {
  return execFileSync('git', args, { cwd, env: cleanEnv(extraEnv), encoding: 'utf-8' });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-skipci-check-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'human@example.com'], root);
  git(['config', 'user.name', 'Human Dev'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Initial commit so HEAD exists.
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  return root;
}

/**
 * Run the script with stdin = the given pre-push tuples (one per line).
 * If `tuples` is null, simulate a TTY (no real push) so the script falls
 * back to scanning HEAD.
 */
function runCheck(cwd, tuples = null, extraEnv = {}) {
  const opts = { cwd, env: cleanEnv(extraEnv), encoding: 'utf-8' };
  if (tuples === null) {
    // Pass an empty stdin via /dev/null. Without `input` the spawned
    // process inherits a real pipe, which `[ -t 0 ]` reads as
    // not-a-tty — for the manual-invocation test we WANT not-a-tty
    // semantics with empty stdin too (the script falls back to
    // scanning HEAD when stdin is empty regardless of TTY).
    opts.input = '';
  } else {
    opts.input = tuples.map((t) => t.join(' ')).join('\n') + '\n';
  }
  return spawnSync('bash', [SCRIPT], opts);
}

const ZERO = '0000000000000000000000000000000000000000';

describe('check-skip-ci-marker.sh (AISDLC-88)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 when stdin is empty and HEAD is clean', () => {
    const r = runCheck(root, null);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('exits 0 when the pushed range contains only clean commit messages', () => {
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(['add', 'a.txt'], root);
    git(['commit', '-q', '-m', 'feat: clean commit message'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  for (const token of ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]']) {
    it(`exits 1 when a non-bot commit body contains ${token}`, () => {
      writeFileSync(join(root, 'b.txt'), 'b\n');
      git(['add', 'b.txt'], root);
      git(['commit', '-q', '-m', `feat: thing\n\nbody mentions ${token} oops`], root);
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const base = git(['rev-parse', 'HEAD~1'], root).trim();
      const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
      assert.equal(r.status, 1, `expected 1 for ${token}, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /CI-skip magic token/);
      // Must surface the actual offending token so the operator knows what to fix.
      assert.ok(
        r.stderr.toLowerCase().includes(token.toLowerCase()),
        `stderr should include the offending token ${token}; got: ${r.stderr}`,
      );
    });
  }

  it('matches case-insensitively (GitHub matches case-insensitively)', () => {
    writeFileSync(join(root, 'c.txt'), 'c\n');
    git(['add', 'c.txt'], root);
    git(['commit', '-q', '-m', 'feat: thing\n\n[SKIP CI] uppercase'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(r.status, 1, `expected 1 on uppercase, got ${r.status}: ${r.stderr}`);
  });

  it('exempts the AISDLC-87 bot-authored chore commit (legacy github-actions[bot] identity)', () => {
    writeFileSync(join(root, 'd.txt'), 'd\n');
    git(['add', 'd.txt'], root);
    git(['commit', '-q', '-m', 'chore(ci): sign review attestation [skip ci]'], root, {
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    });
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(r.status, 0, `expected 0 for bot exemption, got ${r.status}: ${r.stderr}`);
  });

  it('exempts the AISDLC-87 bot-authored chore commit (production ai-sdlc-ci-attestor[bot] identity)', () => {
    // This is the identity actually configured in
    // `.github/workflows/ai-sdlc-review.yml` (the `git config user.name`
    // and `git config user.email` block on the CI-side attestor step).
    // The earlier test used the legacy `github-actions[bot]` identity
    // which is kept in the allowlist as a fallback; this test locks in
    // the production identity so a future allowlist refactor cannot
    // silently regress the exemption.
    writeFileSync(join(root, 'd2.txt'), 'd2\n');
    git(['add', 'd2.txt'], root);
    git(['commit', '-q', '-m', 'chore(ci): sign review attestation [skip ci]'], root, {
      GIT_AUTHOR_NAME: 'ai-sdlc-ci-attestor[bot]',
      GIT_AUTHOR_EMAIL: 'ci-attestor@ai-sdlc.local',
      GIT_COMMITTER_NAME: 'ai-sdlc-ci-attestor[bot]',
      GIT_COMMITTER_EMAIL: 'ci-attestor@ai-sdlc.local',
    });
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(
      r.status,
      0,
      `expected 0 for production-identity bot exemption, got ${r.status}: ${r.stderr}`,
    );
  });

  it('does NOT exempt a non-bot author who copied the chore-commit subject line', () => {
    // Defense against an attacker (or a confused dev) writing the same subject
    // line under a human author identity to silently disable CI on a real PR.
    writeFileSync(join(root, 'e.txt'), 'e\n');
    git(['add', 'e.txt'], root);
    git(
      ['commit', '-q', '-m', 'chore(ci): sign review attestation [skip ci]'],
      root,
      // Default human author from setupRepo() — NOT github-actions[bot].
    );
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(
      r.status,
      1,
      `expected 1 for non-bot copying chore-subject, got ${r.status}: ${r.stderr}`,
    );
  });

  it('does NOT exempt a bot author with a different subject line', () => {
    // The other half of defense-in-depth: the bot identity alone is not enough.
    // Both the author AND the subject prefix must match the documented exception.
    writeFileSync(join(root, 'f.txt'), 'f\n');
    git(['add', 'f.txt'], root);
    git(['commit', '-q', '-m', 'feat: bot doing something else [skip ci]'], root, {
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    });
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(r.status, 1, `expected 1 for bot+wrong-subject, got ${r.status}: ${r.stderr}`);
  });

  it('DOES block backtick-wrapped tokens — backticks do not defeat GH Actions parser (AISDLC-88 design decision)', () => {
    // Important: GitHub Actions matches the LITERAL substring `[skip ci]`
    // (case-insensitive). Surrounding backticks do NOT change that —
    // `` `[skip ci]` `` still contains the substring `[skip ci]`. So the
    // gate must reject backtick-wrapped tokens too. The documented
    // human-readable evasion is paren-quoted form (e.g. `(skip ci marker)`)
    // which the gate accepts because it lacks the literal bracketed form.
    writeFileSync(join(root, 'g.txt'), 'g\n');
    git(['add', 'g.txt'], root);
    git(
      [
        'commit',
        '-q',
        '-m',
        'docs: explain CI tokens\n\nWe avoid `[skip ci]` because it disables workflows.',
      ],
      root,
    );
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(
      r.status,
      1,
      `expected 1 for backtick-wrapped tokens (still match GH parser), got ${r.status}: ${r.stderr}`,
    );
  });

  it('does NOT block paren-quoted form (the documented evasion: "(skip ci marker)")', () => {
    // The recommended way to MENTION the tokens in commit bodies (e.g.
    // explanatory paragraphs) is the paren-quoted form, which lacks the
    // literal bracketed substring GitHub Actions parses. The script
    // accepts these.
    writeFileSync(join(root, 'g2.txt'), 'g2\n');
    git(['add', 'g2.txt'], root);
    git(
      [
        'commit',
        '-q',
        '-m',
        'docs: explain CI tokens\n\nWe avoid the (skip ci marker) and (ci skip marker) tokens.',
      ],
      root,
    );
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(r.status, 0, `expected 0 for paren-quoted form, got ${r.status}: ${r.stderr}`);
  });

  it('respects AI_SDLC_SKIP_MARKER_GATE=1 override', () => {
    writeFileSync(join(root, 'h.txt'), 'h\n');
    git(['add', 'h.txt'], root);
    git(['commit', '-q', '-m', 'feat: thing\n\n[skip ci] for some reason'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~1'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]], {
      AI_SDLC_SKIP_MARKER_GATE: '1',
    });
    assert.equal(r.status, 0, `expected 0 with override, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /skipped \(AI_SDLC_SKIP_MARKER_GATE=1\)/);
  });

  it('skips deleted-branch tuples (local_sha all zeros)', () => {
    // git push --delete sends `local_sha = 0000...`. The script must not
    // try to walk a non-existent commit.
    const remoteSha = git(['rev-parse', 'HEAD'], root).trim();
    const r = runCheck(root, [['refs/heads/main', ZERO, 'refs/heads/main', remoteSha]]);
    assert.equal(r.status, 0, `expected 0 for branch deletion, got ${r.status}: ${r.stderr}`);
  });

  it('handles new-branch push (remote_sha all zeros) without scanning unrelated history', () => {
    // New branch push: remote_sha is 000...; the script should scan only
    // commits not yet on any remote ref. Without remotes configured, the
    // walk will scan everything reachable — that's fine for this test as
    // long as no commit carries a token.
    writeFileSync(join(root, 'i.txt'), 'i\n');
    git(['add', 'i.txt'], root);
    git(['commit', '-q', '-m', 'feat: clean'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const r = runCheck(root, [['refs/heads/feature', head, 'refs/heads/feature', ZERO]]);
    assert.equal(r.status, 0, `expected 0 for clean new-branch push, got ${r.status}: ${r.stderr}`);
  });

  it('flags multiple offending commits in a single push (does not short-circuit)', () => {
    writeFileSync(join(root, 'j.txt'), 'j\n');
    git(['add', 'j.txt'], root);
    git(['commit', '-q', '-m', 'feat: bad one\n\n[skip ci]'], root);
    writeFileSync(join(root, 'k.txt'), 'k\n');
    git(['add', 'k.txt'], root);
    git(['commit', '-q', '-m', 'feat: bad two\n\n[ci skip]'], root);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const base = git(['rev-parse', 'HEAD~2'], root).trim();
    const r = runCheck(root, [['refs/heads/main', head, 'refs/heads/main', base]]);
    assert.equal(r.status, 1, `expected 1, got ${r.status}: ${r.stderr}`);
    // Both offenders should appear in the report.
    assert.match(r.stderr, /bad one/);
    assert.match(r.stderr, /bad two/);
  });
});
