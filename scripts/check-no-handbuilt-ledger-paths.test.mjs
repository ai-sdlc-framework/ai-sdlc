/** AISDLC-1020: only reviews-ledger.ts may build `.ai-sdlc/reviews/<id>` paths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['pipeline-cli/src', 'orchestrator/src', 'ai-sdlc-plugin'];
const SKIP_DIR = new Set(['node_modules', 'dist', '.git']);
const EXT = /\.(ts|js|mjs)$/;
const TEST_FILE = /\.test\.(ts|js|mjs)$/;
const ALLOWED = 'pipeline-cli/src/attestation/reviews-ledger.ts';
// The literal followed by a template interpolation or a concatenation builds a path.
const HANDBUILT = /\.ai-sdlc\/reviews\/(\$\{|['"`]\s*\+)/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXT.test(name) && !TEST_FILE.test(name)) yield full;
  }
}

export function findHandbuilt(lines) {
  return lines.flatMap((l, i) => (HANDBUILT.test(l) ? [i + 1] : []));
}

test('detector flags a template-built ledger path', () => {
  assert.deepEqual(findHandbuilt(['a', 'x = `.ai-sdlc/reviews/${id}.jsonl`']), [2]);
  assert.deepEqual(findHandbuilt(['// .ai-sdlc/reviews/<id>.jsonl']), []);
});

test('no hand-built .ai-sdlc/reviews/ paths outside reviews-ledger.ts', () => {
  const hits = [];
  for (const d of DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (rel === ALLOWED) continue;
      for (const n of findHandbuilt(readFileSync(file, 'utf8').split('\n'))) {
        hits.push(`${rel}:${n}`);
      }
    }
  }
  assert.deepEqual(hits, [], `use reviewsLedgerPath/reviewsLedgerRelativePath: ${hits.join(', ')}`);
});
