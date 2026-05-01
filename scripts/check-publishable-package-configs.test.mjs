/**
 * Tests for `scripts/check-publishable-package-configs.mjs` — AISDLC-97.
 *
 * Covers:
 *   - auditPackage on the four canonical states (missing, present, private, bad-access)
 *   - parseWorkspacePackages on the actual pnpm-workspace.yaml syntax we use
 *   - checkWorkspace end-to-end against synthetic temp workspaces
 *   - CLI exit codes (0 pass / 1 violation / 2 bad invocation)
 *
 * Run with: node --test scripts/check-publishable-package-configs.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditPackage,
  parseWorkspacePackages,
  checkWorkspace,
} from './check-publishable-package-configs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-publishable-package-configs.mjs');

// -------------------------------------------------------------- auditPackage

describe('auditPackage', () => {
  it('passes when publishConfig is fully correct', () => {
    const pkg = {
      name: '@ai-sdlc/foo',
      publishConfig: {
        access: 'public',
        registry: 'https://registry.npmjs.org/',
      },
    };
    assert.equal(auditPackage(pkg, 'foo/package.json'), null);
  });

  it('fails when publishConfig is missing entirely', () => {
    const pkg = { name: '@ai-sdlc/foo' };
    const v = auditPackage(pkg, 'foo/package.json');
    assert.match(v ?? '', /missing "publishConfig"/);
    assert.match(v ?? '', /E402/);
  });

  it('fails when access is missing or wrong', () => {
    const pkg = {
      name: '@ai-sdlc/foo',
      publishConfig: { registry: 'https://registry.npmjs.org/' },
    };
    const v = auditPackage(pkg, 'foo/package.json');
    assert.match(v ?? '', /access is/);
    assert.match(v ?? '', /must be "public"/);
  });

  it('fails when registry is wrong (e.g. GitHub Packages)', () => {
    const pkg = {
      name: '@ai-sdlc/foo',
      publishConfig: { access: 'public', registry: 'https://npm.pkg.github.com/' },
    };
    const v = auditPackage(pkg, 'foo/package.json');
    assert.match(v ?? '', /registry is/);
    assert.match(v ?? '', /https:\/\/registry\.npmjs\.org\//);
  });

  it('skips private packages (returns null without checking publishConfig)', () => {
    const pkg = { name: 'internal-tool', private: true };
    assert.equal(auditPackage(pkg, 'internal-tool/package.json'), null);
  });

  it('does NOT skip when private is set to anything other than literal true', () => {
    // Defensive: `"private": "true"` (string) is a common bug. We require strict true.
    const pkg = { name: '@ai-sdlc/foo', private: 'true' };
    const v = auditPackage(pkg, 'foo/package.json');
    assert.match(v ?? '', /missing "publishConfig"/);
  });
});

// ---------------------------------------------------- parseWorkspacePackages

describe('parseWorkspacePackages', () => {
  it('parses unquoted entries', () => {
    const yaml = 'packages:\n  - reference\n  - orchestrator\n';
    assert.deepEqual(parseWorkspacePackages(yaml), ['reference', 'orchestrator']);
  });

  it('parses quoted entries with paths', () => {
    const yaml = `packages:\n  - 'ai-sdlc-plugin/mcp-server'\n  - "conformance/runner"\n`;
    assert.deepEqual(parseWorkspacePackages(yaml), [
      'ai-sdlc-plugin/mcp-server',
      'conformance/runner',
    ]);
  });

  it('stops at the next top-level key', () => {
    const yaml = [
      'packages:',
      '  - reference',
      '  - orchestrator',
      'catalog:',
      '  - other',
      '',
    ].join('\n');
    assert.deepEqual(parseWorkspacePackages(yaml), ['reference', 'orchestrator']);
  });

  it('ignores comments and blank lines', () => {
    const yaml = [
      'packages:',
      '  # this is a comment',
      '  - reference',
      '',
      '  - orchestrator # trailing',
      '',
    ].join('\n');
    assert.deepEqual(parseWorkspacePackages(yaml), ['reference', 'orchestrator']);
  });

  it('returns empty when no packages key', () => {
    assert.deepEqual(parseWorkspacePackages('name: foo\n'), []);
  });
});

// ------------------------------------------------------------ checkWorkspace

function makeTempWorkspace(spec) {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-publishable-'));
  const lines = ['packages:', ...spec.packages.map((p) => `  - ${p}`), ''];
  writeFileSync(join(root, 'pnpm-workspace.yaml'), lines.join('\n'));
  for (const [pkgDir, pkgJson] of Object.entries(spec.pkgs ?? {})) {
    mkdirSync(join(root, pkgDir), { recursive: true });
    writeFileSync(join(root, pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  }
  return root;
}

describe('checkWorkspace (integration)', () => {
  const tempDirs = [];
  after(() => {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('passes for an all-good workspace', async () => {
    const root = makeTempWorkspace({
      packages: ['a', 'b'],
      pkgs: {
        a: {
          name: '@scope/a',
          publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
        },
        b: {
          name: '@scope/b',
          publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
        },
      },
    });
    tempDirs.push(root);
    const result = await checkWorkspace(root);
    assert.deepEqual(result.violations, []);
    assert.equal(result.passed, 2);
    assert.equal(result.total, 2);
  });

  it('flags one missing publishConfig in an otherwise-good workspace', async () => {
    const root = makeTempWorkspace({
      packages: ['a', 'b'],
      pkgs: {
        a: {
          name: '@scope/a',
          publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
        },
        b: { name: '@scope/b' },
      },
    });
    tempDirs.push(root);
    const result = await checkWorkspace(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /b\/package\.json/);
    assert.match(result.violations[0], /missing "publishConfig"/);
    assert.equal(result.passed, 1);
  });

  it('skips private packages without complaint', async () => {
    const root = makeTempWorkspace({
      packages: ['a', 'b'],
      pkgs: {
        a: {
          name: '@scope/a',
          publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
        },
        b: { name: 'internal', private: true },
      },
    });
    tempDirs.push(root);
    const result = await checkWorkspace(root);
    assert.deepEqual(result.violations, []);
    // private package is counted as passed (didn't violate anything)
    assert.equal(result.passed, 2);
  });

  it('flags missing package.json as a violation (not a silent skip)', async () => {
    const root = makeTempWorkspace({
      packages: ['a', 'missing-pkg'],
      pkgs: {
        a: {
          name: '@scope/a',
          publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
        },
      },
    });
    tempDirs.push(root);
    const result = await checkWorkspace(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /missing-pkg/);
    assert.match(result.violations[0], /package\.json not found/);
  });

  it('flags malformed package.json with a JSON parse error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-publishable-bad-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - a\n');
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'package.json'), '{ this is not json');
    const result = await checkWorkspace(root);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /invalid JSON/);
  });
});

// ------------------------------------------------------------------ CLI mode

describe('CLI', () => {
  it('exits 0 against the real workspace (regression safety net for this repo)', () => {
    // Run the script with no args, which defaults to the parent dir of scripts/
    // — i.e. this repo's root. If this assertion ever fails, it means a real
    // package in this repo lost its publishConfig (which is the AISDLC-97
    // regression we're guarding against).
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf-8' });
    assert.equal(
      r.status,
      0,
      `expected current workspace to pass; stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stdout, /publishable packages OK/);
  });

  it('exits 1 against a bad workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-publishable-cli-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - a\n');
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'package.json'), JSON.stringify({ name: '@scope/a' }));
    const r = spawnSync('node', [SCRIPT, '--root', root], { encoding: 'utf-8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1 violation\(s\) found/);
    assert.match(r.stderr, /missing "publishConfig"/);
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 on unknown argument', () => {
    const r = spawnSync('node', [SCRIPT, '--bogus'], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown argument/);
  });

  it('--help prints usage and exits 0', () => {
    const r = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /publishConfig/);
  });
});
