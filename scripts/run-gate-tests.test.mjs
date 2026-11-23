/**
 * Tests for the gate glob runner and its KNOWN_RED ratchet (AISDLC-805).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverGateTests,
  findUnscannedTests,
  runGateTests,
  selectGateTests,
  GATE_TEST_DIRS,
  KNOWN_RED,
} from './run-gate-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'gate-runner-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('discoverGateTests (AISDLC-805)', () => {
  test('discovers a *.test.mjs dropped into a gate dir, ignores other files', () => {
    const root = fixture({ 'g/a.test.mjs': '', 'g/b.mjs': '', 'g/c.test.ts': '' });
    try {
      assert.deepEqual(discoverGateTests(root, ['g'], {}), {
        files: ['g/a.test.mjs'],
        skipped: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('excludes and reports a KNOWN_RED entry', () => {
    const root = fixture({ 'g/a.test.mjs': '', 'g/red.test.mjs': '' });
    try {
      const r = discoverGateTests(root, ['g'], { 'g/red.test.mjs': 'why' });
      assert.deepEqual(r.files, ['g/a.test.mjs']);
      assert.deepEqual(r.skipped, ['g/red.test.mjs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a missing configured dir fails loudly', () => {
    const root = fixture({ 'g/a.test.mjs': '' });
    try {
      assert.throws(
        () => discoverGateTests(root, ['g', 'gone'], {}),
        /gate test dir missing.*gone/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runGateTests (AISDLC-805)', () => {
  const pass = "import {test} from 'node:test'; test('ok', () => {});";
  const fail = "import {test} from 'node:test'; test('bad', () => { throw new Error('x'); });";

  test('exits 0 when every child passes', () => {
    const root = fixture({ 'g/a.test.mjs': pass });
    try {
      assert.equal(runGateTests(root, [], ['g'], {}), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failing child makes the runner exit non-zero', () => {
    const root = fixture({ 'g/a.test.mjs': pass, 'g/b.test.mjs': fail });
    try {
      assert.notEqual(runGateTests(root, [], ['g'], {}), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failing KNOWN_RED child does not fail the run', () => {
    const root = fixture({ 'g/a.test.mjs': pass, 'g/red.test.mjs': fail });
    try {
      assert.equal(runGateTests(root, [], ['g'], { 'g/red.test.mjs': 'why' }), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('KNOWN_RED ratchet (AISDLC-805)', () => {
  // Growth requires editing this pin so reviewers see it. Shrink by deleting the entry and the pin.
  const PINNED = ['scripts/check-rm-guard.test.mjs'];

  test('KNOWN_RED is shrink-only: no id outside the frozen list', () => {
    const extra = Object.keys(KNOWN_RED).filter((k) => !PINNED.includes(k));
    assert.deepEqual(extra, [], `KNOWN_RED grew; fix the test instead: ${extra.join(', ')}`);
  });

  test('discovery fails on a test file under a subdirectory that is not scanned', () => {
    const root = fixture({ 'g/a.test.mjs': '', 'g/sub/b.test.mjs': '' });
    try {
      assert.deepEqual(findUnscannedTests(root, ['g']), ['g/sub/b.test.mjs']);
      assert.throws(() => discoverGateTests(root, ['g'], {}), /g\/sub\/b\.test\.mjs/);
      assert.deepEqual(findUnscannedTests(root, ['g', 'g/sub']), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('every KNOWN_RED key exists on disk and carries a reason', () => {
    for (const [k, reason] of Object.entries(KNOWN_RED)) {
      assert.ok(
        existsSync(join(ROOT, k)),
        `${k} is listed in KNOWN_RED but does not exist; delete the entry`,
      );
      assert.ok(reason.trim().length > 0, `${k} has no reason`);
    }
  });

  test('the real tree discovers this file and every configured dir exists', () => {
    const { files } = discoverGateTests(ROOT, GATE_TEST_DIRS, KNOWN_RED);
    assert.ok(files.includes('scripts/run-gate-tests.test.mjs'));
    assert.ok(files.length >= 50, `suspiciously few gate tests: ${files.length}`);
  });
});

describe('selectGateTests (AISDLC-1377, DEC-0423)', () => {
  const files = [
    'scripts/check-a.test.mjs',
    'scripts/check-b.test.mjs',
    'scripts/check-c.test.mjs',
  ];
  const sources = {
    'scripts/check-a.test.mjs': "import './check-a.mjs'",
    'scripts/check-b.test.mjs': "readFile('docs/operations/guarded.md')",
    'scripts/check-c.test.mjs': 'nothing',
  };
  const read = (f) => sources[f];

  test('a change under a gate guarded path runs that gate and no unrelated gate', () => {
    assert.deepEqual(selectGateTests('/r', ['scripts/check-a.mjs'], files, read), [files[0]]);
    assert.deepEqual(selectGateTests('/r', ['docs/operations/guarded.md'], files, read), [
      files[1],
    ]);
  });
  test('a changed gate test selects itself', () => {
    assert.deepEqual(selectGateTests('/r', ['scripts/check-c.test.mjs'], files, read), [files[2]]);
  });
  test('an unrelated change selects no gate', () => {
    assert.deepEqual(selectGateTests('/r', ['pipeline-cli/src/z.ts'], files, read), []);
  });
  for (const trigger of [
    'package.json',
    'pipeline-cli/package.json',
    'pnpm-lock.yaml',
    'scripts/run-gate-tests.mjs',
  ]) {
    test(`${trigger} runs every gate`, () => {
      assert.equal(selectGateTests('/r', [trigger], files, read), null);
    });
  }
  test('no change list runs every gate', () => {
    assert.equal(selectGateTests('/r', [], files, read), null);
    assert.equal(selectGateTests('/r', null, files, read), null);
  });
});
