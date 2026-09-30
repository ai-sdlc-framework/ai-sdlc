/**
 * Tests for scripts/check-followups.mjs and scripts/check-followups-on-push.sh.
 * Run with: node --test scripts/check-followups.test.mjs
 *
 * Needs a built pipeline-cli (the rule lives there); the suite builds it when
 * the compiled rule is missing.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CHECK = join(__dirname, 'check-followups.mjs');
const RULE_DIST = join(REPO_ROOT, 'pipeline-cli', 'dist', 'backlog', 'followup-rule.js');
const PRE_PUSH = join(REPO_ROOT, '.husky', 'pre-push');
const ZEROS = '0'.repeat(40);

function env(extra = {}) {
  const e = { ...process.env };
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'AI_SDLC_BYPASS_ALL_GATES',
    'AI_SDLC_SKIP_FOLLOWUP_GATE',
  ]) {
    delete e[k];
  }
  return { ...e, ...extra };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf-8' });

const task = (followup) =>
  `---\nid: AISDLC-1\nstatus: Done\n---\n\n## Final Summary\n\nShipped.\n${followup}`;

const PROSE = '\n### Follow-up\n- The orchestrator should inject the adapter\n';

function run(args, cwd, extra = {}) {
  return spawnSync('node', [CHECK, ...args], { cwd, env: env(extra), encoding: 'utf-8' });
}

before(() => {
  if (!existsSync(RULE_DIST)) {
    execFileSync('pnpm', ['--filter', '@ai-sdlc/pipeline-cli', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }
});

describe('check-followups.mjs --task', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'followup-task-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const put = (name, body) => {
    writeFileSync(join(dir, name), body);
    return name;
  };

  it('passes for (none), cited ids, and a missing section', () => {
    for (const [n, f] of [
      ['none.md', '\n### Follow-up\n(none)\n'],
      ['cited.md', '\n### Follow-up\n- Wire it (AISDLC-70)\n- Also #12\n'],
      ['absent.md', ''],
    ]) {
      const r = run(['--task', put(n, task(f))], dir);
      assert.equal(r.status, 0, r.stderr);
    }
  });

  it('fails on prose, quoting the item and the accepted forms', () => {
    const r = run(['--task', put('prose.md', task(PROSE))], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /prose\.md/);
    assert.match(r.stderr, /"The orchestrator should inject the adapter"/);
    assert.match(r.stderr, /\(none\)/);
    assert.match(r.stderr, /declined:/);
  });

  it('accepts declined: with a reason, rejects it without', () => {
    const ok = run(
      ['--task', put('d1.md', task('\n### Follow-up\n- declined: not worth the churn\n'))],
      dir,
    );
    assert.equal(ok.status, 0, ok.stderr);
    const bad = run(['--task', put('d2.md', task('\n### Follow-up\n- declined:\n'))], dir);
    assert.equal(bad.status, 1);
  });

  it('honours task_prefix from backlog/config.yml', () => {
    mkdirSync(join(dir, 'backlog'), { recursive: true });
    writeFileSync(join(dir, 'backlog', 'config.yml'), "task_prefix: 'PROJ'\n");
    const r = run(['--task', put('p.md', task('\n### Follow-up\n- do it (PROJ-3)\n'))], dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it('fails closed on a missing file and on bad usage', () => {
    assert.equal(run(['--task', 'nope.md'], dir).status, 1);
    assert.equal(run([], dir).status, 2);
    assert.equal(run(['--bogus'], dir).status, 2);
  });
});

describe('range mode and pre-push hook', () => {
  let repo;
  let base;
  let tip;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'followup-range-'));
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(repo, 'pipeline-cli'));
    mkdirSync(join(repo, 'backlog', 'completed'), { recursive: true });
    // Reuse the real scripts and built rule without copying them.
    for (const f of ['check-followups.mjs', 'check-followups-on-push.sh']) {
      execFileSync('ln', ['-s', join(__dirname, f), join(repo, 'scripts', f)]);
    }
    execFileSync('ln', [
      '-s',
      join(REPO_ROOT, 'pipeline-cli', 'dist'),
      join(repo, 'pipeline-cli', 'dist'),
    ]);
    // A completed task from before the gate, with a prose follow-up.
    writeFileSync(join(repo, 'backlog', 'completed', 'old.md'), task(PROSE));
    writeFileSync(join(repo, '.gitignore'), 'scripts/\npipeline-cli/\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'base'], repo);
    base = git(['rev-parse', 'HEAD'], repo).trim();
    writeFileSync(join(repo, 'backlog', 'completed', 'new.md'), task(PROSE));
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'complete'], repo);
    tip = git(['rev-parse', 'HEAD'], repo).trim();
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('reports only files added or modified inside the range', () => {
    const r = run(['--staged', '--push-range', `${base}..${tip}`], repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /new\.md/);
    assert.doesNotMatch(r.stderr, /old\.md/);
  });

  it('does not report a prose task outside the range', () => {
    const r = run(['--staged', '--push-range', `${tip}..${tip}`], repo);
    assert.equal(r.status, 0, r.stderr);
  });

  const hook = (extra = {}, stdin = `refs/heads/x ${tip} refs/heads/x ${base}\n`) =>
    spawnSync('bash', [join(repo, 'scripts', 'check-followups-on-push.sh')], {
      cwd: repo,
      env: env(extra),
      input: stdin,
      encoding: 'utf-8',
    });

  it('the hook blocks a push adding a completed task with a prose follow-up', () => {
    const r = hook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /new\.md/);
  });

  it('passes with AI_SDLC_SKIP_FOLLOWUP_GATE=1 and with the master bypass', () => {
    assert.equal(hook({ AI_SDLC_SKIP_FOLLOWUP_GATE: '1' }).status, 0);
    assert.equal(hook({ AI_SDLC_BYPASS_ALL_GATES: '1' }).status, 0);
  });

  it('passes for deletions and empty stdin', () => {
    assert.equal(hook({}, `(delete) ${ZEROS} refs/heads/x ${base}\n`).status, 0);
    assert.equal(hook({}, '').status, 0);
  });

  it('fails closed when the check script errors', () => {
    const r = hook(
      {},
      `refs/heads/x ${tip} refs/heads/x deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n`,
    );
    assert.equal(r.status, 1);
  });

  it('is wired into .husky/pre-push after the DoR gate and before the fixups orchestrator', () => {
    const text = readFileSync(PRE_PUSH, 'utf-8');
    const dor = text.indexOf('./scripts/check-dor-gate.sh');
    const fu = text.indexOf('./scripts/check-followups-on-push.sh');
    const fix = text.indexOf('./scripts/pre-push-fixups.sh');
    assert.ok(dor !== -1 && fu > dor && fix > fu);
    assert.match(text, /AI_SDLC_SKIP_FOLLOWUP_GATE/);
  });
});
