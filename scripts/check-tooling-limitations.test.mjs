/**
 * Tooling-limitations register consistency (AISDLC-964).
 * Run with: node --test scripts/check-tooling-limitations.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'docs/operations/tooling-limitations.md'), 'utf-8');

const rows = doc
  .split('\n')
  .filter((l) => l.startsWith('|'))
  .slice(2)
  .map((l) =>
    l
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim()),
  );

const REQUIRED = [
  /user token, core/i,
  /graphql/i,
  /secondary/i,
  /GITHUB_TOKEN/,
  /search api/i,
  /gh run rerun/,
  /loose-object/i,
  /worktree count/i,
];

describe('tooling-limitations register', () => {
  it('has the required ceilings', () => {
    for (const re of REQUIRED) {
      assert.ok(
        rows.some((r) => re.test(r[0])),
        `missing row for ${re}`,
      );
    }
  });

  it('every row has five-plus columns and a headroom pointer or unmeasured', () => {
    for (const r of rows) {
      assert.equal(r.length, 5, `row has ${r.length} columns: ${r[0]}`);
      const cell = r[2];
      if (/^unmeasured\b/.test(cell)) continue;
      const paths = [...cell.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
      assert.ok(paths.length > 0, `no headroom surface for: ${r[0]}`);
      for (const p of paths) {
        assert.ok(existsSync(join(root, p)), `headroom surface does not exist: ${p} (${r[0]})`);
      }
    }
  });
});
