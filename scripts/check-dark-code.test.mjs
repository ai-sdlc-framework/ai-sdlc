/**
 * Tests for the dark-code gate (AISDLC-552).
 *
 * The gate's whole value is the reachability judgement, so these tests are
 * built around fixtures that make each reachability path explicit — a barrel
 * re-export, a dynamic import, an `.mjs` bin shim — plus the negative case the
 * gate exists for: a module imported ONLY by its own test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCandidate,
  isTestFile,
  referenceMatcher,
  extractRfcMarker,
  findDarkModules,
  loadBaseline,
  diffAgainstBaseline,
  formatReport,
  writeBaseline,
} from './check-dark-code.mjs';

/**
 * Build a throwaway repo:
 *   src/           — the scanned root
 *   bin/           — .mjs shims counted as importers
 * `files` maps repo-relative paths to contents.
 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dark-code-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const scan = (root, opts = {}) =>
  findDarkModules({ workDir: root, roots: ['src'], binDirs: ['bin'], ...opts });

describe('isCandidate', () => {
  it('accepts ordinary source modules', () => {
    assert.equal(isCandidate('src/policy/design-ci.ts'), true);
    assert.equal(isCandidate('src/tui/app.tsx'), true);
  });

  it('excludes tests — they are consumers, not the consumed', () => {
    assert.equal(isCandidate('src/policy/design-ci.test.ts'), false);
    assert.equal(isCandidate('src/policy/design-ci.spec.tsx'), false);
    assert.equal(isTestFile('src/x.test.mjs'), true);
  });

  it('excludes index barrels — they are the re-export surface itself', () => {
    assert.equal(isCandidate('src/policy/index.ts'), false);
  });

  it('excludes cli/ and bin/ entry modules invoked by shims', () => {
    assert.equal(isCandidate('src/cli/dor-check.ts'), false);
    assert.equal(isCandidate('src/bin/thing.ts'), false);
  });

  it('excludes .d.ts declarations', () => {
    assert.equal(isCandidate('src/types.d.ts'), false);
  });
});

describe('referenceMatcher', () => {
  it('matches static import, re-export, and dynamic import', () => {
    const re = referenceMatcher('design-ci');
    assert.ok(re.test("import { runDesignCI } from './policy/design-ci.js';"));
    assert.ok(re.test("export * from './design-ci.js';"));
    assert.ok(re.test('const m = await import("../policy/design-ci.js");'));
  });

  it('does NOT match a bare mention of the name', () => {
    const re = referenceMatcher('design-ci');
    assert.equal(re.test('// design-ci is described in RFC-0006'), false);
    assert.equal(re.test("from './design-ci-helpers.js'"), false);
  });
});

describe('extractRfcMarker', () => {
  it('pulls the RFC id out of a header docblock', () => {
    assert.equal(extractRfcMarker('/**\n * Design CI (RFC-0006 §A.3).\n */\n'), 'RFC-0006');
  });

  it('returns null when the header declares none', () => {
    assert.equal(extractRfcMarker('/** Just a helper. */\n'), null);
  });

  it('ignores an RFC id that appears far below the header', () => {
    assert.equal(extractRfcMarker(`/** header */\n${'x'.repeat(900)}\nRFC-0006`), null);
  });
});

describe('findDarkModules — reachability', () => {
  it('treats a barrel re-export as reachable', () => {
    const root = fixture({
      'src/thing.ts': 'export const a = 1;\n',
      'src/index.ts': "export * from './thing.js';\n",
    });
    try {
      assert.deepEqual(scan(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a dynamic import as reachable', () => {
    const root = fixture({
      'src/thing.ts': 'export const a = 1;\n',
      'src/loader.ts': "export const load = () => import('./thing.js');\n",
      'src/index.ts': "export * from './loader.js';\n",
    });
    try {
      assert.deepEqual(scan(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats an .mjs bin shim as reachable (CLI modules are not dark)', () => {
    const root = fixture({
      'src/runner.ts': 'export const run = () => 1;\n',
      'bin/cli-runner.mjs': "import { run } from '../src/runner.js';\nrun();\n",
    });
    try {
      assert.deepEqual(scan(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a module imported ONLY by its own test — the whole point', () => {
    const root = fixture({
      'src/orphan.ts': '/** Orphan (RFC-0006 §A.6). */\nexport const a = 1;\n',
      'src/orphan.test.ts': "import { a } from './orphan.js';\nconsole.log(a);\n",
    });
    try {
      const dark = scan(root);
      assert.equal(dark.length, 1);
      assert.equal(dark[0].path, join('src', 'orphan.ts'));
      assert.equal(dark[0].rfc, 'RFC-0006');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count a module importing itself as reachable', () => {
    const root = fixture({ 'src/selfref.ts': "// see './selfref.js'\nexport const a = 1;\n" });
    try {
      assert.equal(scan(root).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honours the allowlist', () => {
    const root = fixture({ 'src/orphan.ts': 'export const a = 1;\n' });
    try {
      assert.equal(scan(root).length, 1);
      const allowed = scan(root, {
        allowlist: [{ path: join('src', 'orphan.ts'), reason: 'generator entry point' }],
      });
      assert.deepEqual(allowed, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('baseline behaviour', () => {
  const darkOf = (p, rfc = null) => ({ path: p, rfc });

  it('suppresses baselined modules and fails only on newly dark ones', () => {
    const baseline = { darkModules: [{ path: 'src/known.ts', rfc: null }], allowlist: [] };
    const diff = diffAgainstBaseline([darkOf('src/known.ts'), darkOf('src/fresh.ts')], baseline);
    assert.deepEqual(
      diff.newlyDark.map((d) => d.path),
      ['src/fresh.ts'],
    );
  });

  it('reports baselined modules that became reachable (the ratchet)', () => {
    const baseline = {
      darkModules: [{ path: 'src/known.ts' }, { path: 'src/wired.ts' }],
      allowlist: [],
    };
    const diff = diffAgainstBaseline([darkOf('src/known.ts')], baseline);
    assert.deepEqual(diff.newlyDark, []);
    assert.deepEqual(diff.nowReachable, ['src/wired.ts']);
  });

  it('accepts string entries as well as objects in the baseline', () => {
    const diff = diffAgainstBaseline([darkOf('src/known.ts')], {
      darkModules: ['src/known.ts'],
      allowlist: [],
    });
    assert.deepEqual(diff.newlyDark, []);
  });

  it('treats a missing baseline file as empty (first run)', () => {
    const root = fixture({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      assert.deepEqual(loadBaseline(root), { darkModules: [], allowlist: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws an actionable error on malformed baseline JSON', () => {
    const root = fixture({ '.ai-sdlc/dark-code-baseline.json': '{ not json' });
    try {
      assert.throws(() => loadBaseline(root), /not valid JSON/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips through writeBaseline', () => {
    const root = fixture({ '.ai-sdlc/.keep': '' });
    try {
      writeBaseline([darkOf('src/a.ts', 'RFC-0006')], root, '.ai-sdlc/dark-code-baseline.json', [
        { path: 'src/gen.ts', reason: 'codegen entry' },
      ]);
      const reloaded = loadBaseline(root);
      assert.deepEqual(reloaded.darkModules, [{ path: 'src/a.ts', rfc: 'RFC-0006' }]);
      assert.equal(reloaded.allowlist[0].reason, 'codegen entry');
      const raw = readFileSync(join(root, '.ai-sdlc/dark-code-baseline.json'), 'utf-8');
      assert.match(raw, /ratchet/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatReport', () => {
  it('names each newly dark module and refuses the token-import shortcut', () => {
    const out = formatReport({
      newlyDark: [{ path: 'src/fresh.ts', rfc: 'RFC-0018' }],
      nowReachable: [],
      totalDark: 5,
    });
    assert.match(out, /FAIL: 1 newly unwired/);
    assert.match(out, /src\/fresh\.ts \(RFC-0018\)/);
    assert.match(out, /Do NOT add a token import/);
  });

  it('reports OK with the baselined count when nothing is newly dark', () => {
    const out = formatReport({ newlyDark: [], nowReachable: [], totalDark: 24 });
    assert.match(out, /OK: no newly unwired modules \(24 baselined\)/);
  });

  it('surfaces the ratchet hint when baselined modules became reachable', () => {
    const out = formatReport({ newlyDark: [], nowReachable: ['src/wired.ts'], totalDark: 3 });
    assert.match(out, /--update-baseline/);
    assert.match(out, /\+ src\/wired\.ts/);
  });
});
