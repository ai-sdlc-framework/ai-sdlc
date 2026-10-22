/**
 * Hermetic tests for scripts/check-pr-governance.mjs (AISDLC-764).
 * Real temp git repos; no network.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkChangelog,
  checkReviewers,
  checkScopeCreep,
  envelopeReviewerNames,
  extractTaskIds,
  isChangelogPath,
  isReleasePleasePr,
  isReviewOrAuditTask,
  parseTaskMeta,
  run,
  satisfiedReviewerSet,
} from './check-pr-governance.mjs';
import { computePatchIdForVerifier } from '../pipeline-cli/attestation-core/verify-core.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-pr-governance.mjs');
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const gitIn = (cwd) => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(' ')} failed`);
  return r.stdout;
};

function mkRepo() {
  const d = mkdtempSync(join(tmpdir(), 'pr-gov-'));
  dirs.push(d);
  const git = gitIn(d);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(d, 'README.md'), 'x\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  git(['checkout', '-qb', 'feat']);
  const commit = (files, subject) => {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(d, p)), { recursive: true });
      writeFileSync(join(d, p), c);
    }
    git(['add', '-A']);
    git(['commit', '-qm', subject]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  return { d, git, base, commit };
}

const task = (title, labels = []) =>
  `---\nid: AISDLC-5\ntitle: >-\n  ${title}\nlabels:\n${labels.map((l) => `  - ${l}`).join('\n') || '  []'}\n---\nbody\n`;

describe('pure helpers', () => {
  it('detects changelog paths', () => {
    assert.ok(isChangelogPath('CHANGELOG.md'));
    assert.ok(isChangelogPath('pipeline-cli/CHANGELOG.md'));
    assert.ok(!isChangelogPath('docs/CHANGELOG-notes.md'));
  });
  it('extracts task ids from subjects', () => {
    assert.deepEqual(
      [...extractTaskIds(['feat: x (AISDLC-12)', 'fix (AISDLC-3.4)', 'no id'])],
      ['AISDLC-12', 'AISDLC-3.4'],
    );
  });
  it('parses titles and labels and classifies review/audit tasks', () => {
    const m = parseTaskMeta(task('Audit the thing', ['audit']));
    assert.equal(m.title, 'Audit the thing');
    assert.deepEqual(m.labels, ['audit']);
    assert.ok(isReviewOrAuditTask(m));
    assert.ok(isReviewOrAuditTask({ title: 'Review RFC state', labels: [] }));
    assert.ok(!isReviewOrAuditTask({ title: 'Reviewer follow-up: fix', labels: [] }));
    assert.ok(!isReviewOrAuditTask({ title: 'Add a feature', labels: ['governance'] }));
    assert.deepEqual(parseTaskMeta('no frontmatter'), { title: '', labels: [] });
  });
  it('classifies reviewer sets', () => {
    assert.equal(
      satisfiedReviewerSet(['code-reviewer', 'test-reviewer', 'security-reviewer']),
      'three',
    );
    assert.equal(
      satisfiedReviewerSet(['code-reviewer-codex', 'test-reviewer-codex', 'security-reviewer']),
      'three',
    );
    assert.equal(satisfiedReviewerSet(['correctness-reviewer', 'security-reviewer']), 'merged');
    assert.equal(satisfiedReviewerSet(['code-reviewer', 'security-reviewer']), null);
    assert.equal(satisfiedReviewerSet([]), null);
  });
  it('reads reviewer names from v6 leaves and legacy predicates', () => {
    assert.deepEqual(
      envelopeReviewerNames(JSON.stringify({ transcriptLeaves: [{ reviewerName: 'a' }] })),
      ['a'],
    );
    const payload = Buffer.from(
      JSON.stringify({ predicate: { reviewers: [{ agentId: 'b' }] } }),
    ).toString('base64');
    assert.deepEqual(envelopeReviewerNames(JSON.stringify({ payload })), ['b']);
    assert.deepEqual(envelopeReviewerNames('{}'), []);
  });
});

describe('changelog check', () => {
  it('fails a feature branch that edits a CHANGELOG, passes a release-please branch and clean diffs', () => {
    const { git, base, commit } = mkRepo();
    const head = commit({ 'pipeline-cli/CHANGELOG.md': '# c\n', 'a.txt': 'a' }, 'feat: x');
    assert.equal(checkChangelog({ base, head, branch: 'ai-sdlc/x', git }).length, 1);
    const rp = { base, head, branch: 'release-please--branches--main', git };
    assert.deepEqual(checkChangelog({ ...rp, headRepo: 'o/r', baseRepo: 'o/r' }), []);
    const clean = mkRepo();
    const h2 = clean.commit({ 'a.txt': 'a' }, 'feat: y');
    assert.deepEqual(
      checkChangelog({ base: clean.base, head: h2, branch: 'b', git: clean.git }),
      [],
    );
  });
  it('does not trust the branch name alone: fork spoof, non-main release branch, missing repos', () => {
    const { git, base, commit } = mkRepo();
    const head = commit({ 'CHANGELOG.md': 'x' }, 'feat: x');
    const rp = { base, head, branch: 'release-please--branches--main', git };
    assert.equal(checkChangelog({ ...rp, headRepo: 'evil/r', baseRepo: 'o/r' }).length, 1);
    assert.equal(checkChangelog(rp).length, 1);
    assert.equal(
      checkChangelog({
        ...rp,
        branch: 'release-please--branches--other',
        headRepo: 'o/r',
        baseRepo: 'o/r',
      }).length,
      1,
    );
    assert.equal(isReleasePleasePr({ ...rp, headRepo: 'o/r', baseRepo: 'o/r' }), true);
    assert.equal(isReleasePleasePr({ ...rp, headRepo: 'evil/r', baseRepo: 'o/r' }), false);
  });
  it('catches a CHANGELOG added by rename', () => {
    const { git, base, commit, d } = mkRepo();
    commit({ 'old.md': 'same content here\n'.repeat(5) }, 'chore: seed');
    const mid = git(['rev-parse', 'HEAD']).trim();
    git(['mv', 'old.md', 'CHANGELOG.md']);
    git(['commit', '-qm', 'rename']);
    const head = git(['rev-parse', 'HEAD']).trim();
    assert.ok(d);
    assert.equal(checkChangelog({ base: mid, head, branch: 'b', git }).length, 1);
    assert.ok(base);
  });
  it('fails closed on a git error', () => {
    const { git } = mkRepo();
    assert.match(
      checkChangelog({ base: 'nope', head: 'nope', branch: 'b', git })[0],
      /cannot diff/,
    );
  });
});

describe('scope-creep check', () => {
  it('fails a review task PR that adds a backlog/tasks file', () => {
    const { git, commit } = mkRepo();
    commit(
      { 'backlog/tasks/aisdlc-5 - review the rfcs.md': task('Review the RFCs') },
      'chore: file review task',
    );
    const filed = git(['rev-parse', 'HEAD']).trim();
    const head = commit(
      { 'backlog/tasks/aisdlc-9 - follow up.md': task('Follow up') },
      'docs: review output (AISDLC-5)',
    );
    const f = checkScopeCreep({ base: filed, head, branch: 'ai-sdlc/aisdlc-5', title: '', git });
    assert.equal(f.length, 1);
    assert.match(f[0], /AISDLC-5 is a review\/audit task/);
  });
  it('passes when the review task PR adds no task file, or a non-review task adds one', () => {
    const r = mkRepo();
    r.commit({ 'backlog/tasks/aisdlc-5 - review the rfcs.md': task('Review the RFCs') }, 'x');
    const mid = r.git(['rev-parse', 'HEAD']).trim();
    const head = r.commit({ 'docs/out.md': 'review' }, 'docs: out (AISDLC-5)');
    assert.deepEqual(checkScopeCreep({ base: mid, head, branch: '', title: '', git: r.git }), []);
    const n = mkRepo();
    n.commit({ 'backlog/tasks/aisdlc-6 - build it.md': task('Build it') }, 'x');
    const h = n.commit(
      { 'backlog/tasks/aisdlc-7 - more.md': task('More') },
      'feat: build (AISDLC-6)',
    );
    assert.deepEqual(
      checkScopeCreep({ base: n.base, head: h, branch: '', title: '', git: n.git }),
      [],
    );
  });
  it('allows a PR that files the review task itself', () => {
    const { git, base, commit } = mkRepo();
    const head = commit(
      { 'backlog/tasks/aisdlc-5 - audit it.md': task('Audit it', ['audit']) },
      'chore: file (AISDLC-5)',
    );
    assert.deepEqual(checkScopeCreep({ base, head, branch: '', title: '', git }), []);
  });
  it('fails closed on a git error', () => {
    const { git } = mkRepo();
    assert.match(
      checkScopeCreep({ base: 'nope', head: 'nope', branch: '', title: '', git })[0],
      /git failed/,
    );
  });
});

describe('reviewers check', () => {
  const envelope = (names) =>
    JSON.stringify({
      schemaVersion: 'v6',
      transcriptLeaves: names.map((reviewerName) => ({ reviewerName })),
    });
  function codePr(names, { byPatchId = true } = {}) {
    const r = mkRepo();
    const code = r.commit({ 'src/a.ts': 'export const a = 1;\n' }, 'feat: code');
    if (names) {
      const patchId = computePatchIdForVerifier(r.base, code, r.d);
      const file = byPatchId ? `${patchId}.v6.dsse.json` : `${code}.v6.dsse.json`;
      r.commit({ [`.ai-sdlc/attestations/${file}`]: envelope(names) }, 'chore: sign');
    }
    const head = r.git(['rev-parse', 'HEAD']).trim();
    return { ...r, head };
  }
  it('passes the full three-reviewer set and the merged set', () => {
    const a = codePr(['code-reviewer', 'test-reviewer', 'security-reviewer']);
    assert.deepEqual(checkReviewers({ base: a.base, head: a.head, repoRoot: a.d, git: a.git }), []);
    const b = codePr(['correctness-reviewer', 'security-reviewer']);
    assert.deepEqual(checkReviewers({ base: b.base, head: b.head, repoRoot: b.d, git: b.git }), []);
  });
  it('fails a code PR missing a reviewer verdict', () => {
    const a = codePr(['code-reviewer', 'security-reviewer']);
    const f = checkReviewers({ base: a.base, head: a.head, repoRoot: a.d, git: a.git });
    assert.equal(f.length, 1);
    assert.match(f[0], /code-reviewer, security-reviewer/);
  });
  it('fails a code PR with no envelope, and an unreadable envelope', () => {
    const a = codePr(null);
    assert.match(
      checkReviewers({ base: a.base, head: a.head, repoRoot: a.d, git: a.git })[0],
      /no attestation envelope/,
    );
    const r = mkRepo();
    const code = r.commit({ 'src/a.ts': 'x\n' }, 'feat');
    const patchId = computePatchIdForVerifier(r.base, code, r.d);
    r.commit({ [`.ai-sdlc/attestations/${patchId}.v6.dsse.json`]: 'not json' }, 'chore');
    const head = r.git(['rev-parse', 'HEAD']).trim();
    assert.match(
      checkReviewers({ base: r.base, head, repoRoot: r.d, git: r.git })[0],
      /not a readable envelope/,
    );
  });
  it('skips docs-only PRs and explicit skips, and falls back to an envelope the PR adds', () => {
    const a = codePr(null);
    assert.deepEqual(
      checkReviewers({ base: a.base, head: a.head, repoRoot: a.d, git: a.git, docsOnly: true }),
      [],
    );
    assert.deepEqual(
      checkReviewers({ base: a.base, head: a.head, repoRoot: a.d, git: a.git, recordsOnly: true }),
      [],
    );
    assert.deepEqual(
      checkReviewers({ base: a.base, head: a.head, repoRoot: a.d, git: a.git, skip: true }),
      [],
    );
    const b = codePr(null);
    const code = b.head;
    b.commit(
      {
        [`.ai-sdlc/attestations/${code}.v6.dsse.json`]: envelope([
          'correctness-reviewer',
          'security-reviewer',
        ]),
      },
      'chore',
    );
    const head = b.git(['rev-parse', 'HEAD']).trim();
    assert.deepEqual(checkReviewers({ base: b.base, head, repoRoot: b.d, git: b.git }), []);
  });
  it('fails closed when the merge-base cannot be computed', () => {
    const a = codePr(null);
    assert.match(
      checkReviewers({ base: 'nope', head: a.head, repoRoot: a.d, git: a.git })[0],
      /merge-base/,
    );
  });
});

describe('run() and CLI', () => {
  const quiet = () => {
    const out = { log: [], error: [] };
    return { out, log: { log: (m) => out.log.push(m), error: (m) => out.error.push(m) } };
  };
  it('exits 2 on bad usage, 1 when base/head are missing, 1 on a violation, 0 when clean', () => {
    const { git, base, commit, d } = mkRepo();
    const head = commit({ 'CHANGELOG.md': 'x' }, 'feat: x');
    let q = quiet();
    assert.equal(run(['bogus'], { git, log: q.log }), 2);
    assert.equal(run(['changelog', 'stray'], { git, log: q.log }), 2);
    assert.equal(run(['changelog'], { git, log: q.log }), 1);
    q = quiet();
    assert.equal(
      run(['changelog', '--base', base, '--head', head, '--branch', 'f'], { git, log: q.log }),
      1,
    );
    assert.match(q.out.error[0], /::error::/);
    q = quiet();
    assert.equal(
      run(
        [
          'all',
          '--base',
          base,
          '--head',
          head,
          '--branch',
          'release-please--branches--main',
          '--head-repo',
          'o/r',
          '--base-repo',
          'o/r',
          '--docs-only',
          'false',
        ],
        { git, repoRoot: d, log: q.log },
      ),
      0,
    );
    // a fork spoofing the release branch is not exempt from changelog or reviewers
    q = quiet();
    assert.equal(
      run(
        ['changelog', '--base', base, '--head', head, '--branch', 'release-please--branches--main'],
        { git, log: q.log },
      ),
      1,
    );
    const cli = spawnSync(
      'node',
      [SCRIPT, 'changelog', '--base', base, '--head', head, '--branch', 'f'],
      { cwd: d, encoding: 'utf-8' },
    );
    assert.equal(cli.status, 1);
  });
  it('still runs (and fails) when invoked through a symlinked directory', () => {
    const { base, commit, d } = mkRepo();
    const head = commit({ 'CHANGELOG.md': 'x' }, 'feat: x');
    const link = join(mkdtempSync(join(tmpdir(), 'pr-gov-link-')), 'scripts');
    dirs.push(dirname(link));
    symlinkSync(dirname(SCRIPT), link);
    const cli = spawnSync(
      'node',
      [join(link, 'check-pr-governance.mjs'), 'changelog', '--base', base, '--head', head],
      { cwd: d, encoding: 'utf-8' },
    );
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  });
});
