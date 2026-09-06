/**
 * RFC-0042 §Design Layers 2-3 — Append-only Merkle leaf index + root computation.
 *
 * Pure-TypeScript, no external dependencies. Uses Node's built-in `node:crypto`
 * for SHA-256 hashing. Implements a binary Merkle tree with RFC-6962 domain
 * separation (CVE-2012-2459 second-preimage mitigation):
 *   - Each leaf is SHA-256 of (0x00 || canonical_json_utf8).
 *   - Internal nodes are SHA-256 of (0x01 || left_bytes || right_bytes).
 *   - Odd-length levels duplicate the last node to make the count even (standard
 *     binary Merkle padding).
 *   - `verifyInclusion` accepts a mandatory `leafCount` parameter and rejects
 *     `leafIndex >= leafCount` to prevent second-preimage attacks via out-of-bounds
 *     attacker-supplied indices.
 *
 * ## File layout
 *
 * Leaves are persisted at `.ai-sdlc/transcript-leaves.jsonl` (committed, never pruned).
 * Atomic append: write full content to a `.tmp` file then `renameSync` — relies on
 * POSIX rename atomicity. This makes appends corruption-resistant: a crash between
 * write and rename leaves a stale `.tmp` file (overwritten by next call) rather than
 * a partially-written leaf.
 *
 * ## Nonce binding (RFC-0042 §Nonce binding)
 *
 * `generateNonce(headSha)` derives a 32-byte hex value deterministically from the
 * PR's head SHA so nonces are replay-resistant across PRs. The nonce is included
 * verbatim in reviewer subagent prompts, becoming part of the transcript, which is
 * then hashed into the leaf. Replaying a leaf from another PR fails: the nonce won't
 * match this PR's head.
 *
 * ## Inclusion proof API
 *
 * `verifyInclusion(leafHash, proof, root, leafIndex, leafCount)` is the canonical
 * verification function. It is direction-aware (uses `leafIndex` to know left/right
 * at each level), bounds-checks `leafIndex` against `leafCount`, and returns true
 * only when the reconstructed root matches exactly.
 *
 * @module attestation/merkle
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  computeMerkleRoot as coreComputeMerkleRoot,
  hashLeaf as coreHashLeaf,
  verifyInclusion as coreVerifyInclusion,
} from '../../attestation-core/merkle-core.mjs';

// ── Leaf shape (RFC-0042 §Layer 2) ───────────────────────────────────────────

export interface TranscriptLeaf {
  /** Sequential index (0-based) in .ai-sdlc/transcript-leaves.jsonl. */
  leafIndex: number;
  /** AISDLC task identifier, e.g. "AISDLC-383.2". */
  taskId: string;
  /** Reviewer subagent role, e.g. "code-reviewer". */
  reviewerName: string;
  /** SHA-256 hex of the raw transcript JSONL file. */
  transcriptHash: string;
  /** 32-byte hex nonce bound to the PR's head SHA. */
  nonce: string;
  /** Harness name, e.g. "claude-code". */
  harness: string;
  /** LLM model identifier, e.g. "sonnet". */
  model: string;
  /** true when the reviewer approved, false when CHANGES_REQUESTED. */
  verdictApproved: boolean;
  /** Reviewer finding counts. */
  findings: {
    critical: number;
    major: number;
    minor: number;
    suggestion: number;
  };
  /** ISO-8601 timestamp when the leaf was signed. */
  signedAt: string;
  /**
   * AISDLC-568: trust class for this leaf — 'independent' when a real,
   * harness-spawned reviewer subagent produced the transcript; 'self-authored'
   * when the coordinator itself authored it (or the signal was absent/stale).
   * Optional for backward compatibility: leaves signed before AISDLC-568 omit
   * this field, and `hashLeaf` treats an `undefined` value identically to an
   * absent key (JSON.stringify drops `undefined` values), so historical leaf
   * hashes are unaffected. The verifier and envelope builder both default a
   * missing value to the lower-trust `'self-authored'` class — never over-claim.
   *
   * **FROZEN / legacy-read (RFC-0046, AISDLC-588):** superseded by
   * `independenceTier` below as the primary independence signal.
   * `emit-leaf` continues to populate this field for one release for
   * back-compat with pre-RFC-0046 consumers, but new code should read
   * `independenceTier` (with `verdictClass` as the dual-read fallback for
   * legacy envelopes that predate `independenceTier`). Do NOT add new
   * call sites that branch on `verdictClass` alone.
   */
  verdictClass?: 'independent' | 'self-authored';
  /**
   * RFC-0046 Phase 1 (AISDLC-588): the independence tier for this leaf —
   * 'none' (no independence signal / coordinator-authored), 'attested'
   * (structural/harness-attested independence, roughly equivalent to legacy
   * `verdictClass: 'independent'`), or 'isolated' (stronger isolation
   * guarantee — populated by later RFC-0046 phases). Supersedes
   * `verdictClass` as the primary independence signal.
   *
   * Optional for backward compatibility: leaves signed before this field
   * existed omit it, and `hashLeaf` treats an `undefined` value identically
   * to an absent key (JSON.stringify drops `undefined` values), so
   * historical leaf hashes are unaffected. Absent ⇒ treated as `'none'` by
   * both the verifier and any envelope/aggregate reader — never over-claim.
   * At this phase (Phase 1), `emit-leaf` derives this value from the same
   * signal as `verdictClass`: `'attested'` where `verdictClass` would be
   * `'independent'`, else `'none'`. Later phases (AISDLC-589/590/591)
   * populate `'isolated'` from stronger signals.
   */
  independenceTier?: 'none' | 'attested' | 'isolated';
  /**
   * AISDLC-570 (DEC-0013 → opt1): SHA-256 hex of the reviewer subagent's own
   * harness-captured execution transcript (`~/.claude/projects/.../agent-<id>.jsonl`),
   * computed and verified ONCE at sign time on the operator's machine. `null`/absent
   * when no harness signal exists (non-Claude-Code dispatch, unresolvable session,
   * missing diff-binding nonce, or non-reviewer agentType) — NEVER defaulted to
   * anything that reads as a pass. This is a SIGN-TIME-ONLY, informational signal:
   * unlike every other v6 field, a downstream CI verifier cannot independently
   * RE-DERIVE it (a fresh CI runner has no `~/.claude/projects/`), but because it
   * is part of this leaf, tampering with a signed value IS still caught by the
   * Merkle root signature. See `attestation/harness-transcript.ts` for the full
   * mechanism and honest limits. Optional for backward compatibility: leaves
   * signed before AISDLC-570 omit this field, and `hashLeaf` treats an
   * `undefined` value identically to an absent key, so historical leaf hashes
   * are unaffected.
   */
  harnessTranscriptHash?: string | null;
}

// ── Merkle result shapes ──────────────────────────────────────────────────────

export interface MerkleResult {
  /** SHA-256 root of the full tree. Empty string when leaves array is empty. */
  root: string;
  /**
   * Per-leaf inclusion proofs keyed by the leaf's 0-based array position
   * (NOT TranscriptLeaf.leafIndex — the two diverge if loadLeaves skips
   * corrupt JSONL lines). Each proof is a list of sibling hashes from leaf
   * level up to (but not including) the root. Pass to `verifyInclusion`
   * together with the leaf hash and root.
   */
  proofs: Record<number, string[]>;
}

// ── SHA-256 helpers ───────────────────────────────────────────────────────────

/** SHA-256 of a UTF-8 string. Returns lowercase 64-char hex. */
export function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// ── Leaf hashing + Merkle tree computation (AISDLC-579 single-sourced) ───────
//
// The actual hashing/root/proof algorithms live in
// `pipeline-cli/attestation-core/merkle-core.mjs` — a plain, dependency-free
// ESM module shared with the verifier (`attestation-core/verify-core.mjs`).
// This file re-exports them so every existing caller of
// `hashLeaf`/`computeMerkleRoot`/`verifyInclusion` from `./merkle.js` keeps
// working unchanged. See `merkle-core.mjs`'s header for the full rationale:
// prior to AISDLC-579 this logic was duplicated in both files and drifted
// (AISDLC-570's `harnessTranscriptHash` field was added here but never
// mirrored into the verifier's inline copy), causing every multi-reviewer
// v6 envelope with at least one harness-verified leaf to recompute a
// DIFFERENT Merkle root on the verify side than the signer produced.
//
// Do NOT reintroduce a second implementation here — import and re-export
// from `merkle-core.mjs` only.

/**
 * Canonical leaf hash: SHA-256(0x00 || canonical_json_utf8) per RFC-6962.
 * See `merkle-core.mjs` for the algorithm and field-order contract.
 */
export function hashLeaf(leaf: TranscriptLeaf): string {
  return coreHashLeaf(leaf);
}

/**
 * Compute the Merkle root from an array of leaves and return per-leaf
 * inclusion proofs (keyed by ARRAY POSITION). See `merkle-core.mjs`.
 */
export function computeMerkleRoot(leaves: TranscriptLeaf[]): MerkleResult {
  return coreComputeMerkleRoot(leaves);
}

/**
 * Verify that `leafHash` is included in the Merkle tree rooted at `root`,
 * using `proof` as the sibling-hash path and `leafIndex` for direction.
 * See `merkle-core.mjs` for the CVE-2012-2459 bounds-check contract.
 */
export function verifyInclusion(
  leafHash: string,
  proof: string[],
  root: string,
  leafIndex: number,
  leafCount: number,
): boolean {
  return coreVerifyInclusion(leafHash, proof, root, leafIndex, leafCount);
}

// ── Nonce generation (RFC-0042 §Nonce binding) ────────────────────────────────

/**
 * Generate a 32-byte hex nonce bound to the PR's head SHA.
 *
 * Derivation: SHA-256(headSha_utf8 || hex(16-random-bytes)_utf8) → 64 hex
 * chars = 32 bytes. (The random bytes are hex-encoded and the hash input is
 * the UTF-8 encoding of that hex string, not the 16 raw bytes — output
 * cryptographic strength is unchanged either way.)
 *
 * Properties:
 *   - Unique per invocation (random component).
 *   - Cryptographically bound to this PR's head SHA at GENERATION time only —
 *     the resulting 32-byte nonce is opaque, so a verifier cannot recover
 *     headSha from the nonce alone. The "replay-resistant" property is
 *     realized by the Layer-5 CI verifier (RFC-0042 §Layer 5 step 4) matching
 *     transcriptLeaves[].nonce against a CI-issued nonce store.
 *
 * Per OQ-6: first push IS genesis — no ceremony required.
 */
export function generateNonce(headSha: string): string {
  const random = randomBytes(16).toString('hex');
  return createHash('sha256').update(headSha, 'utf8').update(random, 'utf8').digest('hex');
}

// ── Leaf file I/O ─────────────────────────────────────────────────────────────

/**
 * Repo-relative path of the SHARED legacy leaf index (pre-AISDLC-421).
 *
 * Retained read-only during the migration window for legacy envelope verification.
 * NEW writes go to `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` (per-patch-id files)
 * to eliminate the cross-PR rebase conflict surface AISDLC-421 addresses.
 */
export const LEAVES_FILE_RELATIVE = '.ai-sdlc/transcript-leaves.jsonl';

/**
 * Repo-relative DIRECTORY for per-patch-id leaf files (AISDLC-421).
 *
 * Each PR's signing operation writes to `<dir>/<patch-id>.jsonl` so concurrent
 * PRs land in disjoint files and never produce git merge conflicts on rebase.
 */
export const LEAVES_DIR_RELATIVE = '.ai-sdlc/transcript-leaves';

/**
 * Resolve the absolute path of the SHARED legacy leaves file given a repo root.
 * Defaults to `process.cwd()` when `repoRoot` is not supplied.
 *
 * AISDLC-421: legacy path; used for fallback during the migration window only.
 */
export function leavesFilePath(repoRoot?: string): string {
  return join(repoRoot ?? process.cwd(), LEAVES_FILE_RELATIVE);
}

/**
 * Resolve the absolute path of the per-patch-id leaves file (AISDLC-421).
 *
 * Layout: `<repoRoot>/.ai-sdlc/transcript-leaves/<patch-id>.jsonl`.
 *
 * The patch-id is the content-addressed identifier computed by AISDLC-398's
 * `computePatchId(base, head, repoRoot)` (i.e. `git patch-id --stable` of the
 * PR's diff with `.ai-sdlc/attestations/**` excluded). Using patch-id (not
 * task-id) means the file name survives rebases — same content → same name.
 */
export function leavesFilePathForPatchId(patchId: string, repoRoot?: string): string {
  if (!/^[0-9a-f]{40}$/i.test(patchId)) {
    throw new Error(
      `[merkle] leavesFilePathForPatchId: patchId must be 40 lowercase hex characters, got: ${JSON.stringify(
        patchId,
      )}`,
    );
  }
  return join(repoRoot ?? process.cwd(), LEAVES_DIR_RELATIVE, `${patchId.toLowerCase()}.jsonl`);
}

/**
 * Load all leaves from a specific JSONL file path.
 *
 * Returns an empty array when the file does not exist.
 * Lines that fail JSON.parse are skipped and logged to stderr.
 * Lines where `leaf.leafIndex !== arrayPosition` are also logged to stderr
 * (index mismatch indicates a file corruption or concurrent write race).
 *
 * @internal — building block for `loadLeaves` (legacy) and
 * `loadLeavesForPatchId` (AISDLC-421 per-patch-id path).
 */
export function loadLeavesFromFile(filePath: string): TranscriptLeaf[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  const leaves: TranscriptLeaf[] = [];
  let lineNo = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    lineNo++;
    if (!trimmed) continue;
    let leaf: TranscriptLeaf;
    try {
      leaf = JSON.parse(trimmed) as TranscriptLeaf;
    } catch (err) {
      process.stderr.write(
        `[merkle] WARNING: skipping malformed JSONL line ${lineNo} in ${filePath}: ${String(err)}\n`,
      );
      continue;
    }
    const arrayPosition = leaves.length;
    if (leaf.leafIndex !== arrayPosition) {
      process.stderr.write(
        `[merkle] WARNING: leaf at line ${lineNo} has leafIndex=${leaf.leafIndex} ` +
          `but array position is ${arrayPosition} — possible file corruption or concurrent write\n`,
      );
    }
    leaves.push(leaf);
  }
  return leaves;
}

/**
 * Load all leaves from the SHARED legacy `.ai-sdlc/transcript-leaves.jsonl`.
 *
 * AISDLC-421: retained read-only for legacy envelope verification fallback.
 * New writes go to per-patch-id files via `loadLeavesForPatchId`.
 */
export function loadLeaves(repoRoot?: string): TranscriptLeaf[] {
  return loadLeavesFromFile(leavesFilePath(repoRoot));
}

/**
 * Load leaves from the per-patch-id file `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`
 * (AISDLC-421).
 *
 * Returns an empty array when the file does not exist (caller should fall back to
 * the legacy shared-file path during the migration window).
 */
export function loadLeavesForPatchId(patchId: string, repoRoot?: string): TranscriptLeaf[] {
  return loadLeavesFromFile(leavesFilePathForPatchId(patchId, repoRoot));
}

/**
 * Atomically append a single leaf to a JSONL file at `filePath`.
 *
 * The leaf is serialised as one JSON line (JSONL format). Atomicity is achieved
 * via write-to-tmp + renameSync: on POSIX, rename(2) is atomic within the same
 * filesystem, so readers always see either the old file or the complete new file.
 *
 * Concurrent callers may race on the rename — the last writer wins. This is
 * acceptable because the slash command body is the sole writer per task run.
 *
 * @internal — building block for `appendLeaf` (legacy) and
 * `appendLeafForPatchId` (AISDLC-421 per-patch-id path).
 */
export function appendLeafToFile(leaf: TranscriptLeaf, filePath: string): void {
  const dir = dirname(filePath);

  mkdirSync(dir, { recursive: true });

  // Read existing content.
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';

  // Ensure the existing content ends with a newline before appending.
  const newLine = JSON.stringify(leaf) + '\n';
  const newContent =
    existing === '' || existing.endsWith('\n') ? existing + newLine : existing + '\n' + newLine;

  // Atomic write via tmp + rename.
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, newContent, { encoding: 'utf8' });
  renameSync(tmpPath, filePath);
}

/**
 * Atomically append a single leaf to the SHARED legacy
 * `.ai-sdlc/transcript-leaves.jsonl`.
 *
 * AISDLC-421: retained for backward compatibility but NOT called by the
 * default `cli-attestation emit-leaf` path anymore. New writes go to
 * per-patch-id files via `appendLeafForPatchId`.
 */
export function appendLeaf(leaf: TranscriptLeaf, repoRoot?: string): void {
  appendLeafToFile(leaf, leavesFilePath(repoRoot));
}

/**
 * Atomically append a single leaf to the per-patch-id file
 * `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` (AISDLC-421).
 *
 * Creates the parent directory if missing. Each PR writes to a disjoint file
 * (one per patch-id), eliminating the cross-PR rebase conflict surface that
 * the shared shared `transcript-leaves.jsonl` exhibited.
 */
export function appendLeafForPatchId(
  leaf: TranscriptLeaf,
  patchId: string,
  repoRoot?: string,
): void {
  appendLeafToFile(leaf, leavesFilePathForPatchId(patchId, repoRoot));
}
