/**
 * AISDLC-575 — drift/dup guard: exactly ONE `verifyV6Envelope` implementation
 * ships in this repo.
 *
 * AISDLC-579 extension: exactly ONE `computeMerkleRoot(` and ONE `hashLeaf(`
 * implementation (function DECLARATIONS, not re-export/wrapper call sites)
 * ships in this repo. Before AISDLC-579, `pipeline-cli/src/attestation/
 * merkle.ts` and `pipeline-cli/attestation-core/verify-core.mjs` each
 * defined their OWN copy of the RFC-6962 leaf-hash / Merkle-root algorithm.
 * They drifted — AISDLC-570 added a `harnessTranscriptHash` field to
 * merkle.ts's `hashLeaf()` but not to verify-core.mjs's inline
 * `v6HashLeaf()` — causing every multi-reviewer v6 envelope with a
 * harness-verified leaf to recompute a different Merkle root on the verify
 * side than the signer produced, and `rootSignature` to fail verification.
 * The fix moved the canonical implementation into
 * `pipeline-cli/attestation-core/merkle-core.mjs`; both `merkle.ts` and
 * `verify-core.mjs` now import (not reimplement) it. This test guards
 * against a THIRD copy — or an accidental reintroduction of the original
 * two — ever landing again.
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

// ── AISDLC-579: single-source merkle primitives guard ───────────────────────
//
// `hashLeaf`/`computeMerkleRoot` are RE-EXPORTED (thin wrapper functions) by
// both `pipeline-cli/src/attestation/merkle.ts` and
// `pipeline-cli/attestation-core/verify-core.mjs`, so a naive scan for
// `function hashLeaf(` / `function computeMerkleRoot(` declarations would
// false-positive on the wrappers themselves. Instead this test looks for the
// distinctive RFC-6962 domain-separator byte-array literals
// (`Buffer.from([0x00])` / `Buffer.from([0x01])`) that only appear inside the
// ACTUAL hashing algorithm body — these must exist in EXACTLY ONE file
// (`attestation-core/merkle-core.mjs`, the canonical implementation).
describe('merkle-core dup guard (AISDLC-579)', () => {
  const LEAF_DOMAIN_LITERAL = /Buffer\.from\(\[0x00\]\)/;
  const NODE_DOMAIN_LITERAL = /Buffer\.from\(\[0x01\]\)/;

  function findDefiners(pattern: RegExp): string[] {
    const files: string[] = [];
    walk(REPO_ROOT, files);
    return files
      .filter((f) => {
        let source: string;
        try {
          source = readFileSync(f, 'utf-8');
        } catch {
          return false;
        }
        return pattern.test(source);
      })
      .map((f) => f.slice(REPO_ROOT.length + 1));
  }

  it('ships exactly one RFC-6962 leaf-domain-separator implementation (0x00), in attestation-core/merkle-core.mjs', () => {
    const definers = findDefiners(LEAF_DOMAIN_LITERAL);
    expect(
      definers,
      `expected exactly one leaf-hash domain-separator literal (Buffer.from([0x00])), found: ` +
        `${JSON.stringify(definers)}. A second copy re-introduces the AISDLC-579 sign/verify ` +
        `Merkle-root drift risk (see that file's header) — consolidate into ` +
        `pipeline-cli/attestation-core/merkle-core.mjs and have every caller import it.`,
    ).toEqual(['pipeline-cli/attestation-core/merkle-core.mjs']);
  });

  it('ships exactly one RFC-6962 node-domain-separator implementation (0x01), in attestation-core/merkle-core.mjs', () => {
    const definers = findDefiners(NODE_DOMAIN_LITERAL);
    expect(
      definers,
      `expected exactly one internal-node-hash domain-separator literal (Buffer.from([0x01])), found: ` +
        `${JSON.stringify(definers)}. A second copy re-introduces the AISDLC-579 sign/verify ` +
        `Merkle-root drift risk (see that file's header) — consolidate into ` +
        `pipeline-cli/attestation-core/merkle-core.mjs and have every caller import it.`,
    ).toEqual(['pipeline-cli/attestation-core/merkle-core.mjs']);
  });
});
