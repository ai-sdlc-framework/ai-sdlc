import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkParity, flattenExemptions } from './check-parity.mjs';
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
  assert.equal(Object.keys(m).length, 7);
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
