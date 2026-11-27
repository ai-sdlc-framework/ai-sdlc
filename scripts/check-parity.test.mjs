import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkParity, checkScope, flattenExemptions } from './check-parity.mjs';
import { buildManifest, serializeManifest } from './generate-parity-manifest.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'reference/src/core/types.ts',
  'reference/src/metrics/types.ts',
  'reference/src/telemetry/semantic-conventions.ts',
  'reference/src/compliance/mappings.ts',
];

function fixture(exemptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'parity-'));
  for (const f of FILES) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    cpSync(join(REPO, f), join(root, f));
  }
  mkdirSync(join(root, 'conformance/parity'), { recursive: true });
  writeFileSync(
    join(root, 'conformance/parity/manifest.json'),
    serializeManifest(buildManifest(root)),
  );
  writeFileSync(join(root, 'conformance/parity/exemptions.json'), JSON.stringify(exemptions));
  return root;
}

test('committed manifest is current and sections are sorted', () => {
  assert.deepEqual(checkParity(REPO, null), []);
  const m = JSON.parse(readFileSync(join(REPO, 'conformance/parity/manifest.json'), 'utf8'));
  assert.equal(Object.keys(m).length, 8);
  assert.equal(m.complianceMappings.length, 40);
  assert.equal(m.resourceKinds.length, 11);
  for (const names of Object.values(m)) assert.deepEqual(names, [...names].sort());
});

test('fixture passes when manifest matches the reference', () => {
  assert.deepEqual(checkParity(fixture(), {}), []);
});

test('fails when a name is added to STANDARD_METRICS without regenerating', () => {
  const root = fixture();
  const f = join(root, 'reference/src/metrics/types.ts');
  const src = readFileSync(f, 'utf8').replace(
    'export const STANDARD_METRICS: readonly MetricDefinition[] = [',
    "export const STANDARD_METRICS: readonly MetricDefinition[] = [\n  { name: 'brand-new-metric', category: 'task-effectiveness', description: 'x', unit: 'count' },",
  );
  writeFileSync(f, src);
  const problems = checkParity(root, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /out of date/);
});

test('fails when a mapping row cites a different clause without regenerating', () => {
  const root = fixture();
  const f = join(root, 'reference/src/compliance/mappings.ts');
  writeFileSync(
    f,
    readFileSync(f, 'utf8').replace('Clause 9.2 - Internal Audit', 'Clause 9.9 - Bogus'),
  );
  const problems = checkParity(root, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /out of date/);
});

test('buildManifest refuses a mappings file with no rows', () => {
  const root = fixture();
  const f = join(root, 'reference/src/compliance/mappings.ts');
  writeFileSync(f, readFileSync(f, 'utf8').replaceAll('controlId:', 'control:'));
  assert.throws(() => buildManifest(root), /complianceMappings: no rows found/);
});

test('fails when exemptions gain an entry the base lacks', () => {
  const base = { python: { spanNames: ['a'] } };
  const root = fixture({ python: { spanNames: ['a', 'b'] } });
  const problems = checkParity(root, base);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /python\/spanNames\/b/);
});

test('shrinking exemptions passes; null base skips the growth check', () => {
  const root = fixture({ go: { spanNames: ['a'] } });
  assert.deepEqual(checkParity(root, { go: { spanNames: ['a', 'b'] } }), []);
  assert.deepEqual(checkParity(root, null), []);
  assert.equal(flattenExemptions(undefined).size, 0);
});

function scopeFixture(modules, dirs = Object.keys(modules)) {
  const root = mkdtempSync(join(tmpdir(), 'scope-'));
  for (const d of dirs) mkdirSync(join(root, 'reference/src', d), { recursive: true });
  mkdirSync(join(root, 'conformance/parity'), { recursive: true });
  writeFileSync(join(root, 'conformance/parity/scope.json'), JSON.stringify({ modules }));
  mkdirSync(join(root, 'sdk-typescript'), { recursive: true });
  writeFileSync(
    join(root, 'sdk-typescript/package.json'),
    JSON.stringify({ exports: { './core': {} } }),
  );
  mkdirSync(join(root, 'sdk-python/src/ai_sdlc/core'), { recursive: true });
  mkdirSync(join(root, 'sdk-go/core'), { recursive: true });
  return root;
}
const ok = {
  core: { class: 'shared', reason: 'r' },
  utils: { class: 'typescript-only', reason: 'r' },
};

test('committed scope.json passes', () => {
  assert.deepEqual(checkScope(REPO), []);
});

test('scope fixture passes; missing file fails', () => {
  assert.deepEqual(checkScope(scopeFixture(ok)), []);
  assert.match(checkScope(mkdtempSync(join(tmpdir(), 'empty-')))[0], /missing/);
});

test('fails when a reference directory has no entry', () => {
  const p = checkScope(scopeFixture(ok, ['core', 'utils', 'newmod']));
  assert.equal(p.length, 1);
  assert.match(p[0], /no entry for reference\/src\/newmod/);
});

test('fails when a shared entry lacks a counterpart (python, go, exports)', () => {
  let root = scopeFixture(ok);
  rmSync(join(root, 'sdk-python/src/ai_sdlc/core'), { recursive: true });
  assert.match(checkScope(root).join('\n'), /no package in sdk-python/);
  root = scopeFixture(ok);
  rmSync(join(root, 'sdk-go/core'), { recursive: true });
  assert.match(checkScope(root).join('\n'), /no directory in sdk-go/);
  root = scopeFixture(ok);
  writeFileSync(join(root, 'sdk-typescript/package.json'), JSON.stringify({ exports: {} }));
  assert.match(checkScope(root).join('\n'), /not in sdk-typescript\/package.json exports/);
});

test('fails on entry without directory, unknown class, missing reason', () => {
  const noDir = scopeFixture({ ...ok, ghost: { class: 'typescript-only', reason: 'r' } }, [
    'core',
    'utils',
  ]);
  assert.match(checkScope(noDir).join('\n'), /"ghost" but reference\/src\/ghost does not exist/);
  const badClass = scopeFixture({ ...ok, utils: { class: 'weird', reason: 'r' } });
  assert.match(checkScope(badClass).join('\n'), /unknown class "weird"/);
  const noReason = scopeFixture({ ...ok, utils: { class: 'typescript-only' } });
  assert.match(checkScope(noReason).join('\n'), /"utils" has no reason/);
});
