/**
 * RFC-0042 §Design Layer 4 — v6 attestation envelope signer.
 *
 * Builds and signs a v6 attestation envelope containing:
 *   - Per-reviewer transcript leaf summaries (leafIndex, reviewerName, transcriptHash)
 *   - Per-leaf Merkle inclusion proofs (RFC-6962 domain-separated tree)
 *   - Operator-signed Merkle root (any-of-N keys per OQ-4)
 *   - PR-bound nonce (replay protection, OQ-6)
 *
 * The resulting envelope is written to
 *   `.ai-sdlc/attestations/<head-sha>.v6.dsse.json`
 *
 * ## Key resolution (any-of-N per OQ-4)
 *
 * Multiple operator keys may be registered in `.ai-sdlc/trusted-reviewers.yaml`.
 * The signer uses the FIRST key found at the following paths (in order):
 *   1. `AISDLC_SIGNING_KEY_PATH` env var (explicit override)
 *   2. `~/.ai-sdlc/signing-key.pem`
 *
 * Any registered key's private counterpart that is locally available satisfies
 * the any-of-N requirement — the CI verifier accepts the first matching pubkey.
 *
 * ## Domain separation (CVE-2012-2459 mitigation)
 *
 * Leaf hashes use RFC-6962 domain prefix 0x00; internal nodes use 0x01.
 * `verifyInclusion` requires `leafCount` to bound-check `leafIndex`.
 *
 * @module attestation/sign-v6
 */

import { sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeMerkleRoot, generateNonce, loadLeaves, loadLeavesForPatchId } from './merkle.js';
import type { TranscriptLeaf } from './merkle.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single entry in the `transcriptLeaves` array of the v6 envelope. */
export interface V6TranscriptLeafSummary {
  leafIndex: number;
  reviewerName: string;
  transcriptHash: string;
}

/** A single entry in the `merkleProofs` array of the v6 envelope. */
export interface V6MerkleProof {
  leafIndex: number;
  proof: string[];
}

/** RFC-0042 §Design Layer 4 — v6 attestation envelope. */
export interface AttestationEnvelopeV6 {
  schemaVersion: 'v6';
  subject: {
    digest: {
      sha1: string;
    };
  };
  transcriptLeaves: V6TranscriptLeafSummary[];
  merkleProofs: V6MerkleProof[];
  rootHash: string;
  rootSignature: string;
  nonce: string;
  /** Total leaf count — required for CVE-2012-2459 bound-check in verifier. */
  leafCount: number;
  signerIdentity?: string;
  signedAt: string;
}

// ── Key resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the path to the operator's signing key.
 *
 * Resolution order (any-of-N per OQ-4):
 *  1. `AISDLC_SIGNING_KEY_PATH` env var
 *  2. `~/.ai-sdlc/signing-key.pem`
 *
 * Returns null when no key is found.
 */
export function resolveSigningKeyPath(): string | null {
  const envPath = process.env['AISDLC_SIGNING_KEY_PATH'];
  if (envPath) {
    return existsSync(envPath) ? envPath : null;
  }
  const defaultPath = join(homedir(), '.ai-sdlc', 'signing-key.pem');
  return existsSync(defaultPath) ? defaultPath : null;
}

// ── Envelope construction ─────────────────────────────────────────────────────

/**
 * Options for `buildV6Envelope`.
 */
export interface BuildV6EnvelopeOptions {
  /** Git commit SHA the envelope is bound to. */
  headSha: string;
  /** The subset of TranscriptLeaf entries to include in this PR's proof bundle. */
  prLeaves: TranscriptLeaf[];
  /** The full leaf set (all leaves in transcript-leaves.jsonl at sign time). */
  allLeaves: TranscriptLeaf[];
  /** 32-byte hex nonce bound to this PR's head SHA. */
  nonce: string;
  /** Operator ed25519 private key PEM. */
  privateKeyPem: string;
  /** Optional identity string embedded in the envelope (informational). */
  signerIdentity?: string;
}

/**
 * Build and sign a v6 attestation envelope.
 *
 * Signs the Merkle root over ALL leaves in `allLeaves` (the full tree),
 * then includes only the `prLeaves` sub-proofs in the envelope. The CI
 * verifier can reconstruct the full root from the committed
 * `.ai-sdlc/transcript-leaves.jsonl` and verify each proof independently.
 *
 * @throws {Error} when the Merkle root is empty (no leaves).
 * @throws {Error} when a prLeaf has no proof in the full tree.
 */
export function buildV6Envelope(opts: BuildV6EnvelopeOptions): AttestationEnvelopeV6 {
  const { headSha, prLeaves, allLeaves, nonce, privateKeyPem, signerIdentity } = opts;

  // Compute Merkle root + proofs over ALL leaves (the full tree anchors the root).
  const { root, proofs } = computeMerkleRoot(allLeaves);

  if (!root) {
    throw new Error('[sign-v6] Cannot build v6 envelope: no leaves in the tree.');
  }

  // Sign the root with the operator's ed25519 key.
  const rootSignature = signRootHash(root, privateKeyPem);

  // Build transcriptLeaves summaries (only this PR's reviewer leaves).
  const transcriptLeaves: V6TranscriptLeafSummary[] = prLeaves.map((leaf) => ({
    leafIndex: leaf.leafIndex,
    reviewerName: leaf.reviewerName,
    transcriptHash: leaf.transcriptHash,
  }));

  // Build merkleProofs for each prLeaf.
  // The proof index is the leaf's ARRAY POSITION in allLeaves, which may differ
  // from leaf.leafIndex if loadLeaves skipped corrupt lines.
  const merkleProofs: V6MerkleProof[] = prLeaves.map((leaf) => {
    const arrayPos = allLeaves.findIndex((l) => l.leafIndex === leaf.leafIndex);
    if (arrayPos === -1) {
      throw new Error(`[sign-v6] prLeaf with leafIndex=${leaf.leafIndex} not found in allLeaves`);
    }
    const proof = proofs[arrayPos];
    if (!proof) {
      throw new Error(
        `[sign-v6] No Merkle proof found for array position ${arrayPos} (leafIndex=${leaf.leafIndex})`,
      );
    }
    return { leafIndex: leaf.leafIndex, proof };
  });

  const envelope: AttestationEnvelopeV6 = {
    schemaVersion: 'v6',
    subject: { digest: { sha1: headSha } },
    transcriptLeaves,
    merkleProofs,
    rootHash: root,
    rootSignature,
    nonce,
    leafCount: allLeaves.length,
    signedAt: new Date().toISOString(),
  };

  if (signerIdentity) {
    envelope.signerIdentity = signerIdentity;
  }

  return envelope;
}

/**
 * Sign a Merkle root hash using the operator's ed25519 private key.
 * Returns a base64-encoded signature.
 *
 * Ed25519 uses Node's `crypto.sign(undefined, data, key)` API — the `algorithm`
 * argument must be `null` or `undefined` for Ed25519 (the key type determines the
 * algorithm; passing a digest name throws "Unsupported crypto operation").
 */
function signRootHash(rootHash: string, privateKeyPem: string): string {
  const data = Buffer.from(rootHash, 'utf8');
  const signature = cryptoSign(null, data, privateKeyPem);
  return signature.toString('base64');
}

// ── Sign and write ────────────────────────────────────────────────────────────

/**
 * Options for `signAndWriteV6Envelope`.
 */
export interface SignAndWriteV6EnvelopeOptions {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Git commit SHA the envelope is bound to. */
  headSha: string;
  /** Task-ID used to select which leaves belong to this PR. */
  taskId: string;
  /** Operator ed25519 private key PEM. */
  privateKeyPem: string;
  /** Optional identity string embedded in the envelope. */
  signerIdentity?: string;
  /**
   * Optional content-addressed patch-id (AISDLC-398).
   *
   * When provided, the envelope is written ONLY to:
   *   - `<patchId>.v6.dsse.json` (primary content-addressed filename)
   *
   * The per-SHA bridge (`<headSha>.v6.dsse.json`) is NO LONGER written when a
   * patch-id is available (AISDLC-475 Fix B). The pre-push hook and verifier
   * both key off the patch-id filename; the per-SHA bridge was the source of
   * the re-sign loop (hook saw no patch-id envelope after HEAD moved past the
   * signed dev commit, fell through to the SHA check, missed the bridge because
   * HEAD had advanced, and re-signed unconditionally). Eliminating the bridge
   * write makes the idempotency surface unambiguous: patch-id file = signed.
   *
   * Legacy soak: the verifier retains a per-SHA fallback lookup for one release
   * to cover envelopes signed before this change. See AISDLC-475 / AISDLC-490.
   *
   * When absent, only the per-SHA filename is written (pre-AISDLC-398 behaviour,
   * preserved for callers that cannot compute a patch-id at sign time).
   *
   * The primary path is returned.
   */
  patchId?: string;
}

/**
 * Load leaves from the per-patch-id file (AISDLC-421) with a one-release-window
 * fallback to the legacy shared `.ai-sdlc/transcript-leaves.jsonl`, then build
 * + sign the v6 envelope and write it to
 * `.ai-sdlc/attestations/<patch-id>.v6.dsse.json` (primary, AISDLC-475 Fix B:
 * NO per-SHA bridge is written when patch-id is available — see JSDoc on
 * `SignAndWriteV6EnvelopeOptions.patchId` for the full rationale).
 *
 * Returns the absolute path of the written envelope (primary).
 *
 * AISDLC-421 read-path:
 *   1. If `patchId` is provided AND `<repo>/.ai-sdlc/transcript-leaves/<patchId>.jsonl`
 *      exists → use it (the post-migration canonical path).
 *   2. Otherwise fall back to `<repo>/.ai-sdlc/transcript-leaves.jsonl` filtered
 *      by `taskId` (the pre-migration shared-file path; retained for the
 *      migration window and for envelopes signed before this change).
 *
 * The Merkle tree is built ONLY from the leaves selected here (i.e. THIS PR's
 * leaves). Because every PR writes to its own file post-AISDLC-421, the tree
 * is per-PR and rootHash = f(THIS_PR_leaves), independent of all other PRs.
 *
 * @throws {Error} when no leaves can be found via either path.
 */
export function signAndWriteV6Envelope(opts: SignAndWriteV6EnvelopeOptions): string {
  const { repoRoot, headSha, taskId, privateKeyPem, signerIdentity, patchId } = opts;

  // AISDLC-421: per-patch-id-first read with shared-file fallback.
  // `prLeaves` is the per-PR leaf set (the Merkle tree is built from these
  // ONLY — no cross-PR shared root anymore).
  let prLeaves: TranscriptLeaf[] = [];
  let leafSource = 'unknown';

  if (patchId) {
    const perPatchLeaves = loadLeavesForPatchId(patchId, repoRoot);
    if (perPatchLeaves.length > 0) {
      prLeaves = perPatchLeaves;
      leafSource = `per-patch-id (.ai-sdlc/transcript-leaves/${patchId}.jsonl)`;
    }
  }

  if (prLeaves.length === 0) {
    // Migration-window fallback: legacy shared file filtered by taskId.
    // Pre-AISDLC-421 callers wrote ALL PRs' leaves to this one file, so a
    // simple read returns leaves from many PRs interleaved; we filter by
    // taskId to recover this PR's subset.
    const sharedLeaves = loadLeaves(repoRoot);
    const filteredByTask = sharedLeaves.filter(
      (l) => l.taskId.toLowerCase() === taskId.toLowerCase(),
    );
    if (filteredByTask.length > 0) {
      prLeaves = filteredByTask;
      leafSource = 'shared (.ai-sdlc/transcript-leaves.jsonl) [AISDLC-421 migration fallback]';
    }
  }

  if (prLeaves.length === 0) {
    throw new Error(
      `[sign-v6] No transcript leaves found for taskId '${taskId}'` +
        (patchId ? ` (patch-id ${patchId.slice(0, 12)}...)` : '') +
        `. Checked per-patch-id file (.ai-sdlc/transcript-leaves/<patch-id>.jsonl) and ` +
        `shared fallback (.ai-sdlc/transcript-leaves.jsonl). Ensure reviewers ran and ` +
        `appended leaves before signing.`,
    );
  }

  // Surface which file the leaves came from — helpful for debugging the
  // migration window when the read may have hit either path.
  process.stderr.write(`[sign-v6] leaves source: ${leafSource} (${prLeaves.length} leaves)\n`);

  const nonce = generateNonce(headSha);

  // AISDLC-421: the Merkle tree is built from THIS PR's leaves only. There is
  // no longer a cross-PR shared root — each PR's rootHash is computed over its
  // own per-patch-id leaf set, so allLeaves === prLeaves.
  const envelope = buildV6Envelope({
    headSha,
    prLeaves,
    allLeaves: prLeaves,
    nonce,
    privateKeyPem,
    signerIdentity,
  });

  const serialized = JSON.stringify(envelope, null, 2) + '\n';
  const outDir = join(repoRoot, '.ai-sdlc', 'attestations');
  mkdirSync(outDir, { recursive: true });

  // AISDLC-475 Fix B: when a patch-id is available, write ONLY the
  // content-addressed `<patchId>.v6.dsse.json` file.
  //
  // The legacy per-SHA bridge (`<headSha>.v6.dsse.json`) is NO LONGER written
  // when a patch-id is present. The bridge was the root cause of the re-sign
  // loop: the pre-push hook saw no valid patch-id envelope after HEAD moved
  // past the signed dev commit (chore-commit / rebase), fell through to the
  // per-SHA idempotency check, missed the bridge because HEAD had advanced to
  // the chore SHA, and re-signed unconditionally — producing an infinite loop.
  //
  // The verifier retains a per-SHA fallback lookup (read-only, 1-release soak)
  // for envelopes signed before this change. See AISDLC-490 for the follow-up
  // that eliminates the chore-commit class entirely.
  //
  // Pre-patch-id fallback: when no patch-id is available (e.g. the diff is
  // empty after exclusions, or git patch-id failed), write the per-SHA file
  // as before (pre-AISDLC-398 behaviour — preserves the guarantee that callers
  // always get back a written file path).
  if (patchId) {
    const primaryPath = join(outDir, `${patchId}.v6.dsse.json`);
    writeFileSync(primaryPath, serialized, { encoding: 'utf8' });
    return primaryPath;
  }

  const legacyPath = join(outDir, `${headSha}.v6.dsse.json`);
  writeFileSync(legacyPath, serialized, { encoding: 'utf8' });
  return legacyPath;
}

// ── Pretty-print (inspect-v6) ─────────────────────────────────────────────────

/**
 * Pretty-print a v6 attestation envelope for human inspection.
 * Returns a formatted multi-line string.
 */
export function formatV6Envelope(envelope: AttestationEnvelopeV6): string {
  const lines: string[] = [];
  lines.push(`Schema version : v6`);
  lines.push(`Head SHA       : ${envelope.subject.digest.sha1}`);
  lines.push(`Signed at      : ${envelope.signedAt}`);
  if (envelope.signerIdentity) {
    lines.push(`Signer         : ${envelope.signerIdentity}`);
  }
  lines.push(`Leaf count     : ${envelope.leafCount}`);
  lines.push(`Root hash      : ${envelope.rootHash}`);
  lines.push(
    `Root signature : ${envelope.rootSignature.slice(0, 32)}... (base64, ${envelope.rootSignature.length} chars)`,
  );
  lines.push(`Nonce          : ${envelope.nonce}`);
  lines.push(`Transcript leaves (${envelope.transcriptLeaves.length}):`);
  for (const leaf of envelope.transcriptLeaves) {
    lines.push(
      `  [${leaf.leafIndex}] ${leaf.reviewerName.padEnd(22)} transcript: ${leaf.transcriptHash.slice(0, 16)}...`,
    );
  }
  lines.push(`Merkle proofs (${envelope.merkleProofs.length}):`);
  for (const mp of envelope.merkleProofs) {
    lines.push(`  [${mp.leafIndex}] proof depth: ${mp.proof.length}`);
  }
  return lines.join('\n');
}

// ── Re-exports from merkle for convenience ───────────────────────────────────

export { hashLeaf, loadLeaves, verifyInclusion } from './merkle.js';
export type { TranscriptLeaf } from './merkle.js';
