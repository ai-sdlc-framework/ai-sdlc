/**
 * PoE docs must state the v6 rebase behaviour (AISDLC-989).
 * Run with: node --test scripts/check-poe-docs-rebase.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['docs/concepts/proof-of-execution.md', 'docs/whitepapers/proof-of-execution.md'];

describe('proof-of-execution docs rebase wording', () => {
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf-8');
    for (const phrase of ['survives rebases', 'does not invalidate the attestation']) {
      it(`${f} omits "${phrase}"`, () => {
        assert.ok(!text.toLowerCase().includes(phrase));
      });
    }
  }
  it('concept page links attestation-reference', () => {
    const text = readFileSync(join(root, files[0]), 'utf-8');
    assert.ok(text.includes('../operations/attestation-reference.md'));
  });
});
