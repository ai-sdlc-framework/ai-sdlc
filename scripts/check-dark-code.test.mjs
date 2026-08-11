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
  extractSpecifiers,
  stripComments,
  resolveSpecifierTargets,
  validateAllowlist,
  baselineGrowth,
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

  it('excludes test-helper infrastructure — being test-only is its job', () => {
    // Real case: orchestrator/src/__test-helpers/git-env.ts is imported only by
    // tests, while a DIFFERENT runtime/git-env.ts is imported by production
    // code. Path resolution correctly separates them; the helper still should
    // not be reported, because shared test infrastructure is not dark code.
    assert.equal(isCandidate(join('orchestrator', 'src', '__test-helpers', 'git-env.ts')), false);
    assert.equal(isCandidate(join('pipeline-cli', 'src', '__fixtures__', 'sample.ts')), false);
    assert.equal(isCandidate(join('orchestrator', 'src', 'runtime', 'git-env.ts')), true);
  });

  it('excludes .d.ts declarations', () => {
    assert.equal(isCandidate('src/types.d.ts'), false);
  });
});

describe('extractSpecifiers', () => {
  it('collects static import, re-export, and dynamic import specifiers', () => {
    const text = [
      "import { a } from './policy/design-ci.js';",
      "export * from './barrel.js';",
      'const m = await import("../lazy.js");',
      "import pkg from '@ai-sdlc/reference';",
    ].join('\n');
    assert.deepEqual(extractSpecifiers(text), [
      './policy/design-ci.js',
      './barrel.js',
      '../lazy.js',
      '@ai-sdlc/reference',
    ]);
  });

  it('returns [] when nothing is imported', () => {
    assert.deepEqual(extractSpecifiers('export const a = 1;\n'), []);
  });
});

describe('stripComments', () => {
  it('removes line and block comments but keeps code', () => {
    assert.equal(stripComments('a; // note\nb;'), 'a; \nb;');
    assert.equal(stripComments('a; /* note */ b;'), 'a;  b;');
  });

  it('does not treat // inside a string as a comment', () => {
    assert.equal(stripComments("const u = 'https://x.dev';"), "const u = 'https://x.dev';");
  });

  it('honours escaped quotes inside strings', () => {
    assert.equal(stripComments("const s = 'a\\'b'; // x"), "const s = 'a\\'b'; ");
  });
});

describe('extractSpecifiers — comment-only mentions confer nothing', () => {
  it('ignores a dynamic import written only in a line comment', () => {
    // Round-3 review repro: a TODO mentioning import('./dark.js') must not
    // mark dark.ts reachable — this gate tells people not to silence it with a
    // token import, so honouring a token MENTION would be worse.
    assert.deepEqual(extractSpecifiers("// TODO: consider import('./dark.js') here"), []);
  });

  it('ignores a JSDoc usage example referencing another module', () => {
    const text = [
      '/**',
      " * Example: import { x } from './other.js';",
      ' */',
      'export const a = 1;',
    ].join('\n');
    assert.deepEqual(extractSpecifiers(text), []);
  });

  it('still collects real imports adjacent to comments', () => {
    const text = ["// see './ignored.js'", "import { a } from './real.js';"].join('\n');
    assert.deepEqual(extractSpecifiers(text), ['./real.js']);
  });
});

describe('resolveSpecifierTargets', () => {
  it('maps an ESM .js specifier onto its .ts/.tsx source', () => {
    const targets = resolveSpecifierTargets('/repo/src/a/importer.ts', './thing.js');
    assert.ok(targets.includes('/repo/src/a/thing.ts'));
    assert.ok(targets.includes('/repo/src/a/thing.tsx'));
  });

  it('resolves relative to the IMPORTING file, not the repo root', () => {
    const targets = resolveSpecifierTargets('/repo/src/deep/nested/importer.ts', '../thing.js');
    assert.ok(targets.includes('/repo/src/deep/thing.ts'));
    assert.equal(targets.includes('/repo/src/deep/nested/thing.ts'), false);
  });

  it('maps a directory specifier onto its index', () => {
    const targets = resolveSpecifierTargets('/repo/src/importer.ts', './policy');
    assert.ok(targets.includes('/repo/src/policy/index.ts'));
  });

  it('ignores bare package specifiers (they address barrels, not modules)', () => {
    assert.deepEqual(resolveSpecifierTargets('/repo/src/a.ts', '@ai-sdlc/reference'), []);
    assert.deepEqual(resolveSpecifierTargets('/repo/src/a.ts', 'node:fs'), []);
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

describe('findDarkModules — path resolution defects the security review caught', () => {
  it('does NOT let an unrelated same-basename import mask a dark module', () => {
    // The original basename-matching implementation reported src/b/types.ts as
    // reachable because src/a/types.ts was imported somewhere. That is a false
    // NEGATIVE: the gate silently misses real dark code.
    const root = fixture({
      'src/a/types.ts': 'export type A = 1;\n',
      'src/a/user.ts': "import type { A } from './types.js';\nexport const a: A = 1;\n",
      'src/index.ts': "export * from './a/user.js';\n",
      'src/b/types.ts': 'export type B = 2;\n',
    });
    try {
      const dark = scan(root).map((d) => d.path);
      assert.deepEqual(dark, [join('src', 'b', 'types.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not credit a same-named module in a different directory', () => {
    const root = fixture({
      'src/one/helper.ts': 'export const h = 1;\n',
      'src/two/helper.ts': 'export const h = 2;\n',
      'src/index.ts': "export * from './one/helper.js';\n",
    });
    try {
      assert.deepEqual(
        scan(root).map((d) => d.path),
        [join('src', 'two', 'helper.ts')],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let a comment in ANOTHER file mask a dark module (round-3 repro)', () => {
    const root = fixture({
      'src/dark.ts': 'export const d = 1;\n',
      'src/user.ts':
        "// TODO: consider using import('./dark.js') here eventually\nexport const u = 1;\n",
      'src/index.ts': "export * from './user.js';\n",
    });
    try {
      assert.deepEqual(
        scan(root).map((d) => d.path),
        [join('src', 'dark.ts')],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes <pkg>/src/cli entries but NOT a nested directory merely named cli', () => {
    assert.equal(isCandidate(join('pipeline-cli', 'src', 'cli', 'dor-check.ts')), false);
    assert.equal(isCandidate(join('orchestrator', 'src', 'features', 'cli', 'sneaky.ts')), true);
  });
});

describe('validateAllowlist', () => {
  it('accepts entries carrying a non-empty reason', () => {
    assert.deepEqual(
      validateAllowlist([{ path: 'src/gen.ts', reason: 'codegen entry point' }]),
      [],
    );
  });

  it('rejects a bare string entry — an exemption with no justification', () => {
    const errors = validateAllowlist(['src/gen.ts']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bare string/);
  });

  it('rejects an entry with a missing or blank reason', () => {
    assert.match(validateAllowlist([{ path: 'src/gen.ts' }])[0], /missing a non-empty 'reason'/);
    assert.match(
      validateAllowlist([{ path: 'src/gen.ts', reason: '   ' }])[0],
      /missing a non-empty 'reason'/,
    );
  });

  it('rejects an entry with no path', () => {
    assert.match(validateAllowlist([{ reason: 'why' }])[0], /missing a 'path'/);
  });
});

describe('baselineGrowth — the ratchet', () => {
  it('reports paths added relative to the base ref', () => {
    const grown = baselineGrowth(
      { darkModules: [{ path: 'src/old.ts' }] },
      { darkModules: [{ path: 'src/old.ts' }, { path: 'src/absorbed.ts' }] },
    );
    assert.deepEqual(grown, ['src/absorbed.ts']);
  });

  it('allows removals (wiring a module shrinks the baseline)', () => {
    const grown = baselineGrowth(
      { darkModules: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
      { darkModules: [{ path: 'src/a.ts' }] },
    );
    assert.deepEqual(grown, []);
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
  });

  it("renders '—' for a module with no RFC marker (AC#5)", () => {
    const out = formatReport({
      newlyDark: [{ path: 'src/plain.ts', rfc: null }],
      nowReachable: [],
      totalDark: 0,
    });
    assert.match(out, /src\/plain\.ts \(—\)/);
    assert.match(out, /Do NOT add a token import/);
  });

  it('reports OK with the baselined count when nothing is newly dark', () => {
    const out = formatReport({ newlyDark: [], nowReachable: [], totalDark: 24 });
    assert.match(out, /OK: no newly unwired modules \(24 baselined\)/);
  });

  it('fails loudly when the baseline grew', () => {
    const out = formatReport({
      newlyDark: [],
      nowReachable: [],
      totalDark: 3,
      grown: ['src/absorbed.ts'],
    });
    assert.match(out, /baseline GREW by 1/);
    assert.match(out, /may shrink, never grow/);
  });

  it('renders allowlist validation errors', () => {
    const out = formatReport({
      newlyDark: [],
      nowReachable: [],
      totalDark: 0,
      allowlistErrors: ["allowlist[0] is a bare string ('x.ts')"],
    });
    assert.match(out, /invalid allowlist entries/);
  });

  it('surfaces the ratchet hint when baselined modules became reachable', () => {
    const out = formatReport({ newlyDark: [], nowReachable: ['src/wired.ts'], totalDark: 3 });
    assert.match(out, /--update-baseline/);
    assert.match(out, /\+ src\/wired\.ts/);
  });
});
