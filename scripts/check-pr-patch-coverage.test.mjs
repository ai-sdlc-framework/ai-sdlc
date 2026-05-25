/**
 * Tests for `scripts/check-pr-patch-coverage.mjs` — AISDLC-376.
 *
 * The gate runs in CI on `pull_request` events to enforce ≥80% patch coverage
 * on the lines actually changed by the PR. These tests validate the four
 * acceptance-criteria edges:
 *
 *   1. Returns success when patch % ≥ 80.
 *   2. Returns failure when patch % < 80 with a clear per-file summary.
 *   3. Returns success when 0 changed code files (docs-only / config-only PR).
 *   4. Returns failure with a diagnostic when coverage data is missing.
 *
 * Strategy: build a real hermetic git repo + a `coverage/coverage-final.json`
 * fixture that mirrors vitest's istanbul/v8 schema, then exec the script
 * against it as a subprocess. Subprocess execution catches argv parsing and
 * process.exit code bugs that unit-level invocations would miss.
 *
 * Run with: node --test scripts/check-pr-patch-coverage.test.mjs
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-pr-patch-coverage.mjs');

// ── Fixture helpers ──────────────────────────────────────────────────────────

function initRepo() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ai-sdlc-patch-cov-')));
  const gitOpts = { cwd: tmp, encoding: 'utf-8' };
  execFileSync('git', ['init', '-q', '-b', 'main'], gitOpts);
  execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], gitOpts);
  return tmp;
}

function commitFile(repo, file, contents, message) {
  const full = join(repo, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  execFileSync('git', ['add', '--', file], { cwd: repo, encoding: 'utf-8' });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, encoding: 'utf-8' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
}

function writeWithoutCommit(repo, file, contents) {
  const full = join(repo, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * Build a coverage-final.json that maps statement IDs → line ranges and
 * statement IDs → hit counts. Caller passes a per-file shape:
 *   { 'pkg/src/foo.ts': { lines: { '1': 1, '2': 0, '3': 1 } } }
 * The helper translates each `<line>: <hit>` into a single-line statement
 * at that line number. That's the simplest possible projection of the
 * istanbul schema and matches what v8-to-istanbul emits for one-statement-
 * per-line code.
 */
function writeCoverageFile(repo, perFile) {
  const json = {};
  for (const [relPath, info] of Object.entries(perFile)) {
    const absPath = join(repo, relPath);
    const statementMap = {};
    const s = {};
    let id = 0;
    for (const [line, hits] of Object.entries(info.lines)) {
      statementMap[id] = {
        start: { line: Number(line), column: 0 },
        end: { line: Number(line), column: 80 },
      };
      s[id] = Number(hits);
      id++;
    }
    json[absPath] = {
      path: absPath,
      statementMap,
      s,
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
  }
  const covDir = join(repo, 'coverage');
  mkdirSync(covDir, { recursive: true });
  writeFileSync(join(covDir, 'coverage-final.json'), JSON.stringify(json));
}

function runGate(repo, { base, head, threshold = 80, json = false, extraArgs = [] } = {}) {
  const args = [
    SCRIPT,
    '--base',
    base,
    '--head',
    head,
    '--threshold',
    String(threshold),
    '--cwd',
    repo,
    '--coverage-root',
    repo,
    ...extraArgs,
  ];
  if (json) args.push('--json');
  return spawnSync('node', args, { encoding: 'utf-8' });
}

// ── AC 1: success when patch coverage ≥ threshold ───────────────────────────

describe('check-pr-patch-coverage — pass when ≥ threshold', () => {
  let repo;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('exits 0 when 90% of changed lines are covered', () => {
    // Base: a 5-line file with all hits.
    const base = commitFile(
      repo,
      'pkg/src/util.ts',
      ['export function a() {', '  return 1;', '}', '', ''].join('\n'),
      'init: util',
    );
    // Head: add 10 new lines, 9 of them covered.
    const updated = [
      'export function a() {',
      '  return 1;',
      '}',
      '',
      '',
      'export function b() {',
      '  const x = 1;',
      '  const y = 2;',
      '  const z = 3;',
      '  return x + y + z;',
      '}',
      'export function c() {',
      '  return 42;',
      '}',
      '', // uncovered new line ↓ (only one uncovered)
      'export const D = 99;',
    ].join('\n');
    const head = commitFile(repo, 'pkg/src/util.ts', updated, 'feat: add b/c/D');

    // Lines 6..15 are the new lines. Cover all except line 15 (D = 99).
    const lines = {};
    for (let ln = 6; ln <= 14; ln++) lines[ln] = 1;
    lines['15'] = 0;
    writeCoverageFile(repo, {
      'pkg/src/util.ts': { lines },
    });

    const r = runGate(repo, { base, head, threshold: 80 });
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /PASS/);
    assert.match(r.stdout, /pkg\/src\/util\.ts/);
  });

  it('exits 0 in JSON mode and emits a valid summary', () => {
    const base = commitFile(repo, 'pkg/src/x.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/x.ts',
      'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
      'add y/z',
    );
    writeCoverageFile(repo, {
      'pkg/src/x.ts': { lines: { 2: 1, 3: 1 } },
    });

    const r = runGate(repo, { base, head, json: true });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reason, 'pass');
    assert.equal(parsed.threshold, 80);
    assert.equal(parsed.coveredLines, 2);
    assert.equal(parsed.totalChangedLines, 2);
  });
});

// ── AC 2: failure when patch coverage < threshold ───────────────────────────

describe('check-pr-patch-coverage — fail when < threshold', () => {
  let repo;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('exits 1 when 20% of changed lines are covered and names the file', () => {
    const base = commitFile(repo, 'pkg/src/feat.ts', 'export const seed = 0;\n', 'init');
    // Add 5 new lines, only 1 covered.
    const head = commitFile(
      repo,
      'pkg/src/feat.ts',
      [
        'export const seed = 0;',
        'export function f1() { return 1; }', // line 2 — covered
        'export function f2() { return 2; }', // line 3 — uncovered
        'export function f3() { return 3; }', // line 4 — uncovered
        'export function f4() { return 4; }', // line 5 — uncovered
        'export function f5() { return 5; }', // line 6 — uncovered
      ].join('\n'),
      'feat: 5 funcs',
    );
    writeCoverageFile(repo, {
      'pkg/src/feat.ts': {
        lines: { 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 },
      },
    });

    const r = runGate(repo, { base, head, threshold: 80 });
    assert.equal(
      r.status,
      1,
      `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /FAIL/);
    assert.match(r.stdout, /pkg\/src\/feat\.ts/);
    assert.match(r.stdout, /20\.00%/);
  });

  it('JSON mode reports below-threshold and per-file breakdown', () => {
    const base = commitFile(repo, 'pkg/src/q.ts', 'export const a = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/q.ts',
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n',
      'add 4 lines',
    );
    writeCoverageFile(repo, {
      'pkg/src/q.ts': { lines: { 2: 0, 3: 0, 4: 0, 5: 0 } },
    });

    const r = runGate(repo, { base, head, threshold: 80, json: true });
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'below-threshold');
    assert.equal(parsed.coveredLines, 0);
    assert.equal(parsed.totalChangedLines, 4);
    assert.equal(parsed.patchPct, 0);
    assert.equal(parsed.perFile.length, 1);
    assert.equal(parsed.perFile[0].file, 'pkg/src/q.ts');
  });
});

// ── AC 3: success when 0 changed code files ─────────────────────────────────

describe('check-pr-patch-coverage — skip on 0 changed code files', () => {
  let repo;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('exits 0 with no-instrumentable-changes reason for docs-only PR', () => {
    const base = commitFile(repo, 'README.md', '# A\n', 'init');
    const head = commitFile(repo, 'docs/notes.md', '# Notes\n', 'docs: add notes');
    // No coverage file at all — should not fail because there are no code changes.
    const r = runGate(repo, { base, head, json: true });
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reason, 'no-instrumentable-changes');
  });

  it('exits 0 when only test files changed (test/.test.ts excluded from gate)', () => {
    const base = commitFile(repo, 'pkg/src/util.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/util.test.ts',
      "import { x } from './util.js';\ntest('x', () => { expect(x).toBe(1); });\n",
      'test: add util test',
    );
    const r = runGate(repo, { base, head, json: true });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.reason, 'no-instrumentable-changes');
  });

  it('exits 0 when only workflow files changed', () => {
    const base = commitFile(repo, '.github/workflows/ci.yml', 'name: CI\n', 'init');
    const head = commitFile(
      repo,
      '.github/workflows/ci.yml',
      'name: CI\non: push\n',
      'ci: add trigger',
    );
    const r = runGate(repo, { base, head, json: true });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.reason, 'no-instrumentable-changes');
  });

  it('exits 0 when only bin/*.mjs shim changed (AISDLC-403)', () => {
    // bin/*.mjs entrypoints are subprocess-tested; istanbul can't instrument
    // them. They must be excluded from the enforcement denominator, regardless
    // of whether coverage data exists for them.
    const base = commitFile(repo, 'README.md', '# x\n', 'init');
    const head = commitFile(
      repo,
      'pkg/bin/cli-foo.mjs',
      [
        '#!/usr/bin/env node',
        "import { run } from '../src/foo.js';",
        'run(process.argv.slice(2));',
      ].join('\n') + '\n',
      'feat: add cli-foo bin shim',
    );
    // No coverage file written — the gate must skip, not fail, for bin shims.
    const r = runGate(repo, { base, head, json: true });
    assert.equal(
      r.status,
      0,
      `expected exit 0 for bin shim, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.reason, 'no-instrumentable-changes');
    assert.deepEqual(parsed.changedCodeFiles, []);
  });

  it('exits 0 when only docs/examples/**.ts changed (AISDLC-428)', () => {
    // docs/examples/** are reference scaffolds for adopters (e.g. RFC-0036
    // BYO-translator examples). Exercised via copy-paste into adopter
    // projects, not via vitest instrumentation. Must be excluded from gate.
    const base = commitFile(repo, 'README.md', '# x\n', 'init');
    const head = commitFile(
      repo,
      'docs/examples/translators/example-adopter.ts',
      "export function translate() { return 'stub'; }\n",
      'docs: add adopter translator example',
    );
    // No coverage file written — the gate must skip, not fail.
    const r = runGate(repo, { base, head, json: true });
    assert.equal(
      r.status,
      0,
      `expected exit 0 for docs/examples, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.reason, 'no-instrumentable-changes');
    assert.deepEqual(parsed.changedCodeFiles, []);
  });
});

// ── AC 4: failure with diagnostic when coverage data missing ─────────────────

describe('check-pr-patch-coverage — missing coverage data', () => {
  let repo;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('exits 1 with diagnostic when coverage-final.json absent', () => {
    const base = commitFile(repo, 'pkg/src/x.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/x.ts',
      'export const x = 1;\nexport const y = 2;\n',
      'add y',
    );
    // Do NOT write coverage file.
    const r = runGate(repo, { base, head });
    assert.equal(
      r.status,
      1,
      `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /no coverage data found/);
    assert.match(r.stdout, /vitest --coverage/);
  });

  it('exits 1 when coverage file exists but has no entry for changed file', () => {
    const base = commitFile(repo, 'pkg/src/x.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/x.ts',
      'export const x = 1;\nexport const y = 2;\n',
      'add y',
    );
    // Coverage for a DIFFERENT file.
    writeCoverageFile(repo, {
      'pkg/src/other.ts': { lines: { 1: 1 } },
    });
    const r = runGate(repo, { base, head, json: true });
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'missing-coverage-for-files');
    assert.deepEqual(parsed.missingFiles, ['pkg/src/x.ts']);
  });
});

// ── Argv + CLI plumbing ──────────────────────────────────────────────────────

describe('check-pr-patch-coverage — CLI argument handling', () => {
  let repo;

  before(() => {
    repo = initRepo();
    commitFile(repo, 'README.md', '# x\n', 'init');
  });

  after(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('exits 2 with usage when --base is missing', () => {
    const r = spawnSync('node', [SCRIPT, '--head', 'abc'], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });

  it('exits 2 with usage when --head is missing', () => {
    const r = spawnSync('node', [SCRIPT, '--base', 'abc'], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });

  it('exits 2 when --threshold is not a valid number', () => {
    const r = spawnSync('node', [SCRIPT, '--base', 'a', '--head', 'b', '--threshold', 'foo'], {
      encoding: 'utf-8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid --threshold/);
  });

  it('exits 2 when --threshold is out of range', () => {
    const r = spawnSync('node', [SCRIPT, '--base', 'a', '--head', 'b', '--threshold', '120'], {
      encoding: 'utf-8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid --threshold/);
  });

  it('exits 2 when --coverage-root does not exist', () => {
    const r = spawnSync(
      'node',
      [
        SCRIPT,
        '--base',
        'a',
        '--head',
        'b',
        '--cwd',
        repo,
        '--coverage-root',
        '/nonexistent/path/that/does/not/exist',
      ],
      { encoding: 'utf-8' },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /coverage root does not exist/);
  });
});

// ── Edge: threshold customization ────────────────────────────────────────────

describe('check-pr-patch-coverage — threshold customization', () => {
  let repo;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('passes at 50% threshold with 60% coverage', () => {
    const base = commitFile(repo, 'pkg/src/x.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/x.ts',
      [
        'export const x = 1;',
        'export const a = 1;',
        'export const b = 2;',
        'export const c = 3;',
        'export const d = 4;',
        'export const e = 5;',
      ].join('\n'),
      'add 5 lines',
    );
    writeCoverageFile(repo, {
      'pkg/src/x.ts': { lines: { 2: 1, 3: 1, 4: 1, 5: 0, 6: 0 } },
    });
    const r = runGate(repo, { base, head, threshold: 50, json: true });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.patchPct, 60);
  });

  it('fails at 90% threshold with 60% coverage', () => {
    const base = commitFile(repo, 'pkg/src/x.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/x.ts',
      [
        'export const x = 1;',
        'export const a = 1;',
        'export const b = 2;',
        'export const c = 3;',
        'export const d = 4;',
        'export const e = 5;',
      ].join('\n'),
      'add 5 lines',
    );
    writeCoverageFile(repo, {
      'pkg/src/x.ts': { lines: { 2: 1, 3: 1, 4: 1, 5: 0, 6: 0 } },
    });
    const r = runGate(repo, { base, head, threshold: 90 });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /60\.00%.*<.*90%/);
  });
});

// ── Security: forgery defense (AISDLC-376 security review) ──────────────────

describe('check-pr-patch-coverage — rejects tracked (committed) coverage forgeries', () => {
  let repo;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('treats a committed coverage-final.json as a forgery and ignores its hit counts', () => {
    // Threat model: an attacker PR adds uncovered source code + a fabricated
    // coverage-final.json claiming every new line is covered. Without the
    // tracked-file rejection, the gate would walk the forgery, union its
    // attacker-chosen hit counts into the fused map, and pass at "100%".
    // The defense: any coverage-final.json that git ls-files reports as
    // tracked is rejected. Legitimate vitest output is always written to a
    // gitignored coverage/ dir and is therefore untracked.
    const base = commitFile(repo, 'pkg/src/x.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/x.ts',
      'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
      'add untested y and z',
    );

    // Build a forged coverage file in a directory the attacker controls,
    // claiming both new lines are covered.
    const forgeryDir = join(repo, 'forgery', 'coverage');
    mkdirSync(forgeryDir, { recursive: true });
    const forgedJson = {
      [join(repo, 'pkg', 'src', 'x.ts')]: {
        path: join(repo, 'pkg', 'src', 'x.ts'),
        statementMap: {
          0: { start: { line: 2, column: 0 }, end: { line: 2, column: 80 } },
          1: { start: { line: 3, column: 0 }, end: { line: 3, column: 80 } },
        },
        s: { 0: 99, 1: 99 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    };
    writeFileSync(join(forgeryDir, 'coverage-final.json'), JSON.stringify(forgedJson));

    // CRITICAL: commit the forgery so it's tracked by git. This is what
    // attackers would do — the file has to be in the PR to ride along.
    execFileSync('git', ['add', '--', 'forgery/coverage/coverage-final.json'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    execFileSync('git', ['commit', '-q', '-m', 'chore: add coverage report'], {
      cwd: repo,
      encoding: 'utf-8',
    });

    const r = runGate(repo, { base, head, json: true });

    // The forged file MUST be rejected. With no legitimate coverage data,
    // the gate fails with missing-coverage-data (no other coverage-final.json
    // exists in this hermetic fixture).
    assert.equal(
      r.status,
      1,
      `expected exit 1 (gate must NOT accept forgery), got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'missing-coverage-data');
    // Confirm the rejection was reported to stderr so the operator can see it.
    assert.match(r.stderr, /REJECTED.*tracked coverage-final\.json/i);
    assert.match(r.stderr, /forgery\/coverage\/coverage-final\.json/);
  });

  it('accepts legitimate untracked coverage-final.json alongside a rejected tracked forgery', () => {
    // Confirms the filter is per-file: a forgery doesn't poison the
    // legitimate signal next to it.
    const base = commitFile(repo, 'pkg/src/x.ts', 'export const x = 1;\n', 'init');
    const head = commitFile(
      repo,
      'pkg/src/x.ts',
      'export const x = 1;\nexport const y = 2;\n',
      'add y (covered)',
    );

    // Legitimate untracked vitest output: covers the new line.
    writeCoverageFile(repo, {
      'pkg/src/x.ts': { lines: { 2: 1 } },
    });

    // Plus a tracked forgery elsewhere claiming line 2 is uncovered (would
    // flip the verdict if it weren't rejected — the fusion treats absence as
    // uncovered).
    const forgeryDir = join(repo, 'forgery', 'coverage');
    mkdirSync(forgeryDir, { recursive: true });
    writeFileSync(
      join(forgeryDir, 'coverage-final.json'),
      JSON.stringify({
        [join(repo, 'pkg', 'src', 'x.ts')]: {
          path: join(repo, 'pkg', 'src', 'x.ts'),
          statementMap: {
            0: { start: { line: 2, column: 0 }, end: { line: 2, column: 80 } },
          },
          s: { 0: 0 },
          fnMap: {},
          f: {},
          branchMap: {},
          b: {},
        },
      }),
    );
    execFileSync('git', ['add', '--', 'forgery/coverage/coverage-final.json'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    execFileSync('git', ['commit', '-q', '-m', 'chore: forged coverage'], {
      cwd: repo,
      encoding: 'utf-8',
    });

    const r = runGate(repo, { base, head, json: true });
    assert.equal(r.status, 0, `expected exit 0 with legitimate coverage; stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.coveredLines, 1);
    assert.match(r.stderr, /REJECTED/);
  });
});

// ── Multi-file: union of per-file diffs feeds totals ─────────────────────────

describe('check-pr-patch-coverage — multi-file aggregation', () => {
  let repo;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('aggregates two files into one denominator', () => {
    commitFile(repo, 'README.md', '# x\n', 'init');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    writeWithoutCommit(repo, 'pkg/src/a.ts', 'export const a1 = 1;\nexport const a2 = 2;\n');
    writeWithoutCommit(repo, 'pkg/src/b.ts', 'export const b1 = 1;\nexport const b2 = 2;\n');
    execFileSync('git', ['add', '--', 'pkg/src/a.ts', 'pkg/src/b.ts'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    execFileSync('git', ['commit', '-q', '-m', 'feat: add a + b'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    writeCoverageFile(repo, {
      'pkg/src/a.ts': { lines: { 1: 1, 2: 1 } }, // 2/2
      'pkg/src/b.ts': { lines: { 1: 1, 2: 0 } }, // 1/2
    });
    const r = runGate(repo, { base, head, threshold: 70, json: true });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.totalChangedLines, 4);
    assert.equal(parsed.coveredLines, 3);
    assert.equal(parsed.patchPct, 75);
  });
});
