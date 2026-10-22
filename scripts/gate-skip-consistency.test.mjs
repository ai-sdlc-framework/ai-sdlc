// AISDLC-1013: every pr-ready `needs` job gated on a detect output must be in
// the alls-green allowed-skips list, or a skipped job fails the rollup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync(new URL('../.github/workflows/ai-sdlc-gate.yml', import.meta.url), 'utf8');

function jobBlock(name) {
  const m = yml.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'),
  );
  return m ? m[1] : '';
}

test('issue-link is skipped on docs-only and records-only changesets', () => {
  const b = jobBlock('issue-link');
  assert.match(b, /needs\.detect\.outputs\.docs_only != 'true'/);
  assert.match(b, /needs\.detect\.outputs\.records_only != 'true'/);
});

test('detect-gated jobs in the pr-ready needs are listed in allowed-skips', () => {
  const rollup = jobBlock('pr-ready');
  const needs = rollup.match(/needs:\s*\[([\s\S]*?)\]/) ?? rollup.match(/needs:\n((?:\s+- .*\n)+)/);
  assert.ok(needs, 'pr-ready needs found');
  const names = needs[1].split(/[\s,\-\[\]]+/).filter(Boolean);
  const skips = rollup.match(/allowed-skips: >-\n([\s\S]*?)\n\n/)?.[1] ?? '';
  const allowed = skips.split(/[\s,]+/).filter(Boolean);
  for (const n of names) {
    const b = jobBlock(n);
    if (/needs\.detect\.outputs\.(docs_only|records_only)/.test(b)) {
      assert.ok(allowed.includes(n), `${n} is detect-gated but missing from allowed-skips`);
    }
  }
});
