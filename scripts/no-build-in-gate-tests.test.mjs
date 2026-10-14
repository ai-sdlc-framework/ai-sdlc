/**
 * AISDLC-862: gate tests reuse the built dist and never build inside a test.
 * A concurrent `pnpm build` races the tsc output dir, so a test that builds
 * flakes or times out. Missing dist must fail fast with a precondition message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'no-build-in-gate-tests.test.mjs';
const Q = `['"\`]`;
// Built from parts so this file does not match its own patterns.
const FORBIDDEN = [
  new RegExp(`\\[[^\\]]*${Q}build${Q}[^\\]]*\\]`), // spawn('pnpm', [..., 'build'])
  new RegExp(`${Q}tsc${Q}`), // spawn('tsc', ...)
  new RegExp(`(?:exec|spawn)\\w*\\(\\s*${Q}[^'"\`]*(?:pnpm|npm|tsc)[^'"\`]*build`), // shell string
];

function testFiles(dir) {
  return readdirSync(join(REPO, dir))
    .filter((n) => n.endsWith('.test.mjs') && n !== SELF)
    .map((n) => join(dir, n));
}

describe('gate tests do not build (AISDLC-862)', () => {
  for (const dir of ['scripts', 'ai-sdlc-plugin/scripts']) {
    it(`no test under ${dir}/ spawns a build or tsc`, () => {
      const offenders = [];
      for (const f of testFiles(dir)) {
        const text = readFileSync(join(REPO, f), 'utf-8');
        for (const re of FORBIDDEN) if (re.test(text)) offenders.push(`${f} ~ ${re}`);
      }
      assert.deepEqual(offenders, []);
    });
  }
});
