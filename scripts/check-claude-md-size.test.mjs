/**
 * CLAUDE.md size budget (AISDLC-651.2).
 *
 * CLAUDE.md is re-read on every turn of every session, so its size is paid on every
 * turn. Reference material belongs in docs/operations/ behind a one-line pointer.
 *
 * Run with: node --test scripts/check-claude-md-size.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');

/** Budget in characters (not bytes). */
export const CLAUDE_MD_BUDGET = 15_000;

describe('CLAUDE.md size budget', () => {
  it(`stays at or under ${CLAUDE_MD_BUDGET} characters`, () => {
    assert.ok(
      claudeMd.length <= CLAUDE_MD_BUDGET,
      `CLAUDE.md is ${claudeMd.length} characters (budget ${CLAUDE_MD_BUDGET}); move reference material to docs/operations/ and leave a one-line pointer`,
    );
  });

  it('every docs/operations pointer resolves to a real file', () => {
    const pointers = [...claudeMd.matchAll(/\]\((docs\/operations\/[^)#\s]+)/g)].map((m) => m[1]);
    assert.ok(pointers.length > 0, 'CLAUDE.md should point at docs/operations runbooks');
    for (const p of new Set(pointers)) {
      assert.ok(existsSync(join(root, p)), `CLAUDE.md points at missing ${p}`);
    }
  });

  it('keeps the load-bearing rules in the file itself', () => {
    for (const needle of [
      'cli-merge-if-eligible',
      'Never close',
      'Always rebase',
      'MUST NOT resolve RFC Open Questions',
      'PATCH_ID_EXCLUSIONS',
      'read-only',
    ]) {
      assert.ok(claudeMd.includes(needle), `CLAUDE.md lost rule text: ${needle}`);
    }
  });
});
