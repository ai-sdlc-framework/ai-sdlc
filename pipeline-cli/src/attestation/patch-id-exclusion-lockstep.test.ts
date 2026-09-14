/**
 * AISDLC-610 — attestation patch-id lockstep: emit-leaf / sign-v6 /
 * backlog-move.
 *
 * ## Root cause (local-trades LT-595, HIGH-2 + MED-5)
 *
 * `computePatchId` (`pipeline-cli/src/attestation/patch-id.ts`) excluded
 * `.ai-sdlc/attestations/` + `.ai-sdlc/transcript-leaves/` +
 * `.ai-sdlc/transcript-leaves.jsonl` from its diff, but NOT
 * `backlog/{tasks,completed}/`. The task-Done file move (`tasks/ →
 * completed/`) is a normal part of `/ai-sdlc execute`'s pipeline and SHIFTS
 * the content patch-id, because the move is a real diff hunk (a delete +
 * an add) that `git diff-tree` sees. When `emit-leaf` runs BEFORE the move
 * and `sign-v6` runs AFTER (or vice-versa), the two compute DIFFERENT
 * patch-ids for what is semantically the exact same reviewed diff — so
 * `sign-v6`'s per-patch-id leaf lookup misses the leaves `emit-leaf` just
 * wrote and fails with "No transcript leaves found for taskId …", even
 * though `.ai-sdlc/transcript-leaves/<emit-leaf's-patch-id>.jsonl` exists on
 * disk under a DIFFERENT key.
 *
 * ## The fix
 *
 * `backlog/tasks/` + `backlog/completed/` were added to the exclusion set
 * in LOCKSTEP across all four consumers that must agree on a patch-id:
 *
 *   1. Signer: `PATCH_ID_EXCLUSIONS` (`patch-id.ts`, this module)
 *   2. Verifier: `ATTESTATION_PATH_EXCLUSIONS`
 *      (`pipeline-cli/attestation-core/verify-core.mjs`)
 *   3. `emit-leaf` (imports `computePatchId` from this module directly)
 *   4. `sign-v6` (imports `computePatchId` from this module directly, or —
 *      for the `ai-sdlc-plugin/scripts/sign-attestation.mjs` v6 driver —
 *      resolves and imports the COMPILED copy of this exact module rather
 *      than a re-implementation)
 *
 * This test file is the AISDLC-610 lockstep guard: AC-1 (backlog move
 * doesn't shift patch-id), AC-2 (end-to-end emit-leaf → move → sign-v6 →
 * verify), AC-3 (`sign-v6` honors explicit `--patch-id`), AC-4 (exclusion
 * lists identical across signer/verifier).
 *
 * @module attestation/patch-id-exclusion-lockstep.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computePatchId, PATCH_ID_EXCLUSIONS } from './patch-id.js';
import { appendLeafForPatchId, loadLeavesForPatchId, type TranscriptLeaf } from './merkle.js';
import { signAndWriteV6Envelope } from './sign-v6.js';
// verify-core.mjs is a plain, dependency-free ESM sibling — no .d.ts, so
// these imports are untyped at the TS boundary (matches
// sign-verify-parity.test.ts's documented pattern for consuming this file).
// @ts-expect-error -- plain ESM, no type declarations shipped
import { verifyV6Envelope } from '../../attestation-core/verify-core.mjs';
// @ts-expect-error -- plain ESM, no type declarations shipped
import { ATTESTATION_PATH_EXCLUSIONS } from '../../attestation-core/verify-core.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  sh('git init -b main', dir);
  sh('git config user.email "test@test.example"', dir);
  sh('git config user.name "Test"', dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  sh('git add README.md', dir);
  sh('git commit -m "init"', dir);
}

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-610',
    reviewerName: 'code-reviewer',
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 1, suggestion: 0 },
    signedAt: '2026-09-14T10:00:00.000Z',
    ...overrides,
  };
}

let repoDir: string;

beforeEach(() => {
  repoDir = join(tmpdir(), `aisdlc-610-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  makeRepo(repoDir);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-4: exclusion lists identical across signer + verifier
// ---------------------------------------------------------------------------

describe('AISDLC-610 AC-4: signer/verifier exclusion-list lockstep', () => {
  it('PATCH_ID_EXCLUSIONS (signer) and ATTESTATION_PATH_EXCLUSIONS (verifier) contain the SAME pathspecs', () => {
    // Order-independent: git pathspecs are unordered, so we compare as sets.
    // An asymmetric SET (not just asymmetric order) is the actual AISDLC-421
    // bug class — order drift alone does not change patch-id output.
    const signerSet = [...PATCH_ID_EXCLUSIONS].sort();
    const verifierSet = [...ATTESTATION_PATH_EXCLUSIONS].sort();
    expect(verifierSet).toEqual(signerSet);
  });

  it('both lists include backlog/tasks/ and backlog/completed/ (AISDLC-610)', () => {
    expect(PATCH_ID_EXCLUSIONS).toContain(':!backlog/tasks/');
    expect(PATCH_ID_EXCLUSIONS).toContain(':!backlog/completed/');
    expect(ATTESTATION_PATH_EXCLUSIONS).toContain(':!backlog/tasks/');
    expect(ATTESTATION_PATH_EXCLUSIONS).toContain(':!backlog/completed/');
  });

  it('neither list has grown beyond the five canonical entries (regression guard)', () => {
    // Pins the exact canonical set so a future one-sided addition (the
    // AISDLC-421 bug class) fails loudly here rather than silently breaking
    // attestation lookups in production.
    const canonical = [
      ':!.ai-sdlc/attestations/',
      ':!.ai-sdlc/transcript-leaves/',
      ':!.ai-sdlc/transcript-leaves.jsonl',
      ':!backlog/tasks/',
      ':!backlog/completed/',
    ].sort();
    expect([...PATCH_ID_EXCLUSIONS].sort()).toEqual(canonical);
    expect([...ATTESTATION_PATH_EXCLUSIONS].sort()).toEqual(canonical);
  });
});

// ---------------------------------------------------------------------------
// AC-1: patch-id unchanged across a simulated tasks/ → completed/ move
// ---------------------------------------------------------------------------

describe('AISDLC-610 AC-1: backlog Done-move does not shift patch-id', () => {
  it('moving a backlog task file from tasks/ to completed/ leaves the patch-id UNCHANGED', () => {
    sh('git checkout -b feat-610-move', repoDir);

    // Reviewed source content + a backlog task file, both committed together
    // (the state right after `/ai-sdlc execute`'s dev step, task file still
    // in backlog/tasks/).
    writeFileSync(join(repoDir, 'src-610.ts'), 'export const v = 610;\n');
    mkdirSync(join(repoDir, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(repoDir, 'backlog', 'tasks', 'aisdlc-610-test.md'),
      '---\nid: AISDLC-610\nstatus: In Progress\n---\nbody\n',
    );
    sh('git add src-610.ts backlog/tasks/aisdlc-610-test.md', repoDir);
    sh('git commit -m "feat: source change + task file (AISDLC-610)"', repoDir);

    const base = sh('git merge-base main HEAD', repoDir);
    const headBeforeMove = sh('git rev-parse HEAD', repoDir);
    const pidBeforeMove = computePatchId(base, headBeforeMove, repoDir);
    expect(pidBeforeMove).not.toBeNull();
    expect(pidBeforeMove).toMatch(/^[0-9a-f]{40}$/);

    // Simulate the Done move: tasks/ → completed/ (this is exactly what
    // check-task-moved.sh / the dev subagent does before push).
    mkdirSync(join(repoDir, 'backlog', 'completed'), { recursive: true });
    sh('git mv backlog/tasks/aisdlc-610-test.md backlog/completed/aisdlc-610-test.md', repoDir);
    sh('git commit -m "chore: move task to completed (AISDLC-610)"', repoDir);

    const headAfterMove = sh('git rev-parse HEAD', repoDir);
    const pidAfterMove = computePatchId(base, headAfterMove, repoDir);

    expect(headAfterMove).not.toBe(headBeforeMove);
    expect(pidAfterMove).not.toBeNull();
    // THE core AC-1 assertion: the backlog move must NOT shift the patch-id.
    expect(pidAfterMove).toBe(pidBeforeMove);
  });

  it('a content change to the SAME source file (not the backlog move) still correctly changes the patch-id', () => {
    // Sanity companion: the exclusion must not accidentally swallow real
    // source diffs.
    sh('git checkout -b feat-610-content', repoDir);
    writeFileSync(join(repoDir, 'src-610b.ts'), 'export const v = 1;\n');
    sh('git add src-610b.ts', repoDir);
    sh('git commit -m "feat: v=1"', repoDir);
    const base = sh('git merge-base main HEAD', repoDir);
    const head1 = sh('git rev-parse HEAD', repoDir);
    const pid1 = computePatchId(base, head1, repoDir);

    writeFileSync(join(repoDir, 'src-610b.ts'), 'export const v = 2;\n');
    sh('git add src-610b.ts', repoDir);
    sh('git commit -m "feat: v=2"', repoDir);
    const head2 = sh('git rev-parse HEAD', repoDir);
    const pid2 = computePatchId(base, head2, repoDir);

    expect(pid1).not.toBeNull();
    expect(pid2).not.toBeNull();
    expect(pid1).not.toBe(pid2);
  });
});

// ---------------------------------------------------------------------------
// AC-2: end-to-end — emit-leaf writes leaves, backlog Done-move happens,
// sign-v6 finds the leaves via the per-patch-id file, verify-attestation
// accepts.
// ---------------------------------------------------------------------------

describe('AISDLC-610 AC-2: emit-leaf → backlog move → sign-v6 → verify (end-to-end)', () => {
  it('sign-v6 finds emit-leaf leaves via the per-patch-id file across a backlog Done-move, and the envelope verifies', () => {
    sh('git checkout -b feat-610-e2e', repoDir);

    writeFileSync(join(repoDir, 'feature-610.ts'), 'export const feature = true;\n');
    mkdirSync(join(repoDir, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(repoDir, 'backlog', 'tasks', 'aisdlc-610-e2e.md'),
      '---\nid: AISDLC-610\nstatus: In Progress\n---\nbody\n',
    );
    sh('git add feature-610.ts backlog/tasks/aisdlc-610-e2e.md', repoDir);
    sh('git commit -m "feat: e2e feature + task file (AISDLC-610)"', repoDir);

    const base = sh('git merge-base main HEAD', repoDir);
    const headBeforeMove = sh('git rev-parse HEAD', repoDir);

    // Step 1: emit-leaf computes the patch-id BEFORE the Done move and
    // writes leaves under that key (mirrors the reviewer fan-out step,
    // which runs before Step 10's backlog move in some orderings).
    const emitLeafPatchId = computePatchId(base, headBeforeMove, repoDir);
    expect(emitLeafPatchId).not.toBeNull();
    if (!emitLeafPatchId) throw new Error('unreachable');

    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer' }),
      emitLeafPatchId,
      repoDir,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      emitLeafPatchId,
      repoDir,
    );

    // Step 2: the backlog Done-move happens AFTER emit-leaf ran.
    mkdirSync(join(repoDir, 'backlog', 'completed'), { recursive: true });
    sh('git mv backlog/tasks/aisdlc-610-e2e.md backlog/completed/aisdlc-610-e2e.md', repoDir);
    sh('git commit -m "chore: move task to completed (AISDLC-610)"', repoDir);
    const headAfterMove = sh('git rev-parse HEAD', repoDir);

    // Step 3: sign-v6 computes its OWN patch-id AFTER the move.
    const signV6PatchId = computePatchId(base, headAfterMove, repoDir);
    expect(signV6PatchId).not.toBeNull();

    // THE core AISDLC-610 assertion: sign-v6's independently-recomputed
    // patch-id (after the move) must equal emit-leaf's (before the move).
    expect(signV6PatchId).toBe(emitLeafPatchId);

    // Step 4: sign-v6 looks up leaves via ITS OWN patch-id — per-patch-id
    // file only, NO shared fallback (this is the load-bearing HIGH-2 check:
    // pre-fix, this lookup would have missed because the keys differed).
    const leavesFound = loadLeavesForPatchId(signV6PatchId as string, repoDir);
    expect(leavesFound).toHaveLength(2);

    // Step 5: sign-v6 builds + signs the v6 envelope using its own patch-id.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

    const outPath = signAndWriteV6Envelope({
      repoRoot: repoDir,
      headSha: headAfterMove,
      taskId: 'AISDLC-610',
      privateKeyPem,
      patchId: signV6PatchId as string,
    });
    expect(existsSync(outPath)).toBe(true);
    expect(outPath).toContain(`${signV6PatchId}.v6.dsse.json`);

    const envelope = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(envelope.transcriptLeaves).toHaveLength(2);

    // Step 6: verify-attestation accepts.
    const result = verifyV6Envelope({
      envelope,
      envelopeFileName: `${headAfterMove}.v6.dsse.json`,
      headSha: headAfterMove,
      trustedReviewers: [{ pubkey: publicKeyPem }],
      repoRoot: repoDir,
      patchIdHint: signV6PatchId,
    }) as { status: string; reason: string };

    expect(result.status).toBe('valid');
  });
});
