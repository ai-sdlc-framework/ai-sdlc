/**
 * AISDLC-575 — drift/dup guard: exactly ONE `verifyV6Envelope` implementation
 * ships in this repo.
 *
 * The whole point of AISDLC-575's consolidation is that the plugin-less
 * `cli-attestation verify` subcommand, the plugin-installed
 * `ai-sdlc-plugin/scripts/verify-attestation.mjs`, and the repo CI
 * `scripts/verify-attestation.mjs` all call the SAME verification code — a
 * vendored/drifting second copy could false-accept or false-reject
 * (exactly the trust-boundary concern AISDLC-566 raised). This test scans
 * every non-build, non-dependency file in the repo for a
 * `function verifyV6Envelope(` definition and fails if more than one
 * source file defines it.
 *
 * Deliberately excludes `dist/`, `node_modules/`, and this file's own test
 * fixtures/backups so a compiled copy or a `.orig`/`.bak` artifact left
 * behind by a bad merge doesn't produce a false pass OR a false failure.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.worktrees',
  'build',
]);

const DEFINITION_PATTERN = /(?:export\s+)?(?:async\s+)?function\s+verifyV6Envelope\s*\(/;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(mjs|js|ts|cjs)$/.test(entry) && !/\.test\.(mjs|js|ts|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
}

describe('verify-core dup guard (AISDLC-575)', () => {
  it('ships exactly one verifyV6Envelope implementation, in pipeline-cli/attestation-core/', () => {
    const files: string[] = [];
    walk(REPO_ROOT, files);

    const definers = files.filter((f) => {
      let source: string;
      try {
        source = readFileSync(f, 'utf-8');
      } catch {
        return false;
      }
      return DEFINITION_PATTERN.test(source);
    });

    const relativeDefiners = definers.map((f) => f.slice(REPO_ROOT.length + 1));

    expect(
      relativeDefiners,
      `expected exactly one verifyV6Envelope() definition (the canonical implementation), found: ` +
        `${JSON.stringify(relativeDefiners)}. A second copy re-introduces the AISDLC-566/575 ` +
        `vendored-verifier drift risk — consolidate into pipeline-cli/attestation-core/verify-core.mjs ` +
        `and have every driver import that one file.`,
    ).toEqual(['pipeline-cli/attestation-core/verify-core.mjs']);
  });
});
