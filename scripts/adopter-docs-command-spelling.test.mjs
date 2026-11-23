/**
 * Adopter docs spell plugin commands as registered (AISDLC-1372).
 * The plugin `ai-sdlc` registers commands/execute.md as `/ai-sdlc:execute`.
 *
 * Run with: node --test scripts/adopter-docs-command-spelling.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const names = readdirSync(join(root, 'ai-sdlc-plugin/commands'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3));
const gs = join(root, 'docs/getting-started');
const files = [
  'README.md',
  'ai-sdlc-plugin/README.md',
  ...readdirSync(gs, { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs/getting-started', f)),
];
const spaced = new RegExp(`(?<![\\w/.-])/ai-sdlc (${names.join('|')})(?![\\w-])`, 'g');

describe('adopter docs command spelling', () => {
  it('finds registered commands', () => {
    assert.ok(names.includes('execute'));
  });
  for (const f of files) {
    it(`${f} uses /ai-sdlc:<command>`, () => {
      const hits = [...readFileSync(join(root, f), 'utf-8').matchAll(spaced)].map((m) => m[0]);
      assert.deepEqual(hits, []);
    });
  }
});
