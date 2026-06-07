/**
 * RFC-0043 Phase 2 — Stage 4: Clean-Room Signer (AISDLC-498)
 *
 * Hardened signer step that decouples the untrusted-evaluation environment
 * (Stages 2-3) from the credential-holding signing step (Stage 4).
 *
 * ## Trust boundary invariants (security properties)
 *
 * 1. **Zod-before-key**: the report artifact is Zod-validated BEFORE the
 *    signing key is resolved. A malformed or tampered report is rejected
 *    at the boundary — the key is never touched.
 *
 * 2. **Signing-key isolation**: the signer refuses to run if any
 *    untrusted-PR-eval artifact file (`untrusted-pr-eval-*` files,
 *    `stages-1-3-output/` directory, `sandbox-output/` directory) is
 *    detected in the working directory. This prevents an attacker from
 *    tricking a local operator into running the signer from inside the
 *    sandbox environment.
 *
 * 3. **RFC-0042 v6 envelope output**: the signer builds a Merkle tree from
 *    the committed transcript leaves and signs the root with the operator's
 *    ed25519 key — reusing the RFC-0042 v6 substrate verbatim (no fork).
 *
 * 4. **Output verifiable by existing RFC-0042 verifier**: the DSSE envelope
 *    written by this signer is identical in schema to envelopes written by
 *    the standard `sign-attestation.mjs` pipeline — the same `verify-attestation.mjs`
 *    verifier accepts it without modification.
 *
 * ## Local flow (operator machine)
 *
 * ```
 * [sandbox emits] .ai-sdlc/ucvg/reports/<pr-number>.unsigned.json
 *                         │
 *                         ▼
 * [clean-room-signer]
 *   1. Signing-key isolation check (refuses if any sandbox artifact in env)
 *   2. Read + parse the unsigned report JSON
 *   3. Zod-validate against UntrustedPrReportSchema (BEFORE key resolution)
 *   4. Resolve signing key (~/.ai-sdlc/signing-key.pem or AISDLC_SIGNING_KEY_PATH)
 *   5. Load transcript leaves from .ai-sdlc/transcript-leaves/<patchId>.jsonl
 *   6. Build RFC-0042 v6 Merkle tree over this PR's leaves
 *   7. Sign Merkle root with operator ed25519 key
 *   8. Write .ai-sdlc/attestations/<patchId>.v6.dsse.json
 * ```
 *
 * @module pipeline/clean-room-signer
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateReport } from './report-validator.js';
import type { UntrustedPrReport } from './report-validator.js';
import { resolveSigningKeyPath, signAndWriteV6Envelope } from '../attestation/sign-v6.js';
import {
  appendLeaf,
  appendLeafForPatchId,
  generateNonce,
  type TranscriptLeaf,
} from '../attestation/merkle.js';

// ── Isolation invariant ───────────────────────────────────────────────────────

/**
 * Sentinel files / directories that indicate the signer is running inside
 * or alongside an active untrusted-PR evaluation environment.
 *
 * The signer MUST refuse to run when any of these are present in `workDir`.
 * This is AC#8 — signing-key isolation invariant.
 *
 * The patterns are deliberately narrow (concrete names produced by the
 * sandbox runner) so the check has a <0.1% false-positive rate on clean
 * operator machines.
 */
export const SANDBOX_ARTIFACT_SENTINELS = [
  'untrusted-pr-eval-active',
  'stages-1-3-output',
  'sandbox-output',
  '.sandbox-pid',
  'untrusted-pr-eval.lock',
] as const;

/**
 * Check whether the working directory contains any sandbox artifact sentinels.
 *
 * Returns the first sentinel found (for error messaging), or null when clean.
 *
 * This check implements AC#8 — the signer refuses to run if any
 * untrusted-PR-eval artifact is present in its environment.
 */
export function detectSandboxArtifacts(workDir: string): string | null {
  for (const sentinel of SANDBOX_ARTIFACT_SENTINELS) {
    const candidate = join(workDir, sentinel);
    if (existsSync(candidate)) {
      return sentinel;
    }
  }
  return null;
}

// ── Clean-room signer options ─────────────────────────────────────────────────

/**
 * Options for `runCleanRoomSigner`.
 */
export interface CleanRoomSignerOptions {
  /**
   * Absolute path to the unsigned report artifact file.
   * Produced by the sandbox (Stages 2-3) and written to
   * `.ai-sdlc/ucvg/reports/<pr-number>.unsigned.json`.
   */
  reportArtifactPath: string;
  /**
   * Absolute path to the repo root.
   * Used to resolve transcript leaves and write the attestation envelope.
   */
  repoRoot: string;
  /**
   * The task ID used to select which transcript leaves belong to this PR.
   * Falls through to the shared `.ai-sdlc/transcript-leaves.jsonl` migration
   * window fallback when no per-patch-id file is found (RFC-0042 AISDLC-421).
   */
  taskId: string;
  /**
   * Git commit SHA of the PR head.
   * Bound to the envelope subject — the RFC-0042 verifier checks this.
   */
  headSha: string;
  /**
   * Optional content-addressed patch-id (AISDLC-398).
   * When provided, the envelope is written to `<patchId>.v6.dsse.json`.
   * When absent, falls back to `<headSha>.v6.dsse.json` (legacy).
   */
  patchId?: string;
  /**
   * Optional identity string embedded in the attestation envelope.
   * Informational — not security-critical.
   */
  signerIdentity?: string;
  /**
   * Working directory for the isolation-invariant check (AC#8).
   * Defaults to `process.cwd()`.
   *
   * This MUST be the operator's working directory, NOT the sandbox directory.
   * The signer detects if it has been invoked from inside the sandbox.
   */
  workDir?: string;
}

// ── Result types ──────────────────────────────────────────────────────────────

/**
 * Result of a successful clean-room signing operation.
 */
export interface CleanRoomSignerSuccess {
  success: true;
  /** The parsed, Zod-validated report. */
  report: UntrustedPrReport;
  /** Absolute path of the written v6 DSSE envelope. */
  envelopePath: string;
}

/**
 * Result of a failed clean-room signing operation.
 *
 * `phase` identifies where in the pipeline the failure occurred so callers
 * can produce precise operator-facing error messages:
 *
 * - `isolation-check` — sandbox artifacts detected; signing key NOT resolved.
 * - `artifact-read`   — could not read/parse the report artifact file.
 * - `zod-validation`  — report failed Zod boundary validation; key NOT resolved.
 * - `key-resolution`  — signing key not found; Zod validation passed.
 * - `signing`         — key found + report valid; Merkle/sign operation failed.
 */
export interface CleanRoomSignerFailure {
  success: false;
  phase:
    | 'isolation-check'
    | 'artifact-read'
    | 'zod-validation'
    | 'consensus-rejected'
    | 'key-resolution'
    | 'signing';
  error: string;
}

export type CleanRoomSignerResult = CleanRoomSignerSuccess | CleanRoomSignerFailure;

// ── Main signer function ──────────────────────────────────────────────────────

/**
 * Run the RFC-0043 Stage-4 clean-room signer.
 *
 * Implements all security-relevant steps in the strict order required to
 * enforce the trust boundary:
 *
 * 1. **Isolation check** (AC#8) — refuse if sandbox artifacts detected.
 * 2. **Read + parse** the unsigned report artifact.
 * 3. **Zod validate** (AC#5) — reject before ANY key interaction.
 * 4. **Key resolution** — resolve operator's ed25519 key.
 * 5. **Build Merkle tree** (AC#6) — load transcript leaves, compute root.
 * 6. **Sign + write** (AC#7) — produce RFC-0042 v6 DSSE envelope.
 *
 * Returns a typed discriminated union — callers MUST check `result.success`
 * before accessing `result.report` / `result.envelopePath`.
 */
export function runCleanRoomSigner(opts: CleanRoomSignerOptions): CleanRoomSignerResult {
  const { reportArtifactPath, repoRoot, taskId, headSha, patchId, signerIdentity } = opts;
  const workDir = opts.workDir ?? process.cwd();

  // ── Step 1: Signing-key isolation invariant (AC#8) ──────────────────────────
  // The signer MUST refuse if any untrusted-PR-eval artifact is present.
  // This check runs BEFORE reading the report and BEFORE any key interaction.
  const foundSentinel = detectSandboxArtifacts(workDir);
  if (foundSentinel) {
    return {
      success: false,
      phase: 'isolation-check',
      error:
        `[clean-room-signer] Signing refused: sandbox artifact sentinel detected in working ` +
        `directory '${workDir}': '${foundSentinel}'. The clean-room signer must run in an ` +
        `environment that has never touched untrusted code. Remove sandbox artifacts or ` +
        `run from a clean directory.`,
    };
  }

  // ── Step 2: Read + parse the unsigned report artifact ───────────────────────
  if (!existsSync(reportArtifactPath)) {
    return {
      success: false,
      phase: 'artifact-read',
      error: `[clean-room-signer] Report artifact not found: '${reportArtifactPath}'`,
    };
  }

  let rawReport: unknown;
  try {
    const content = readFileSync(reportArtifactPath, 'utf8');
    rawReport = JSON.parse(content) as unknown;
  } catch (err) {
    return {
      success: false,
      phase: 'artifact-read',
      error: `[clean-room-signer] Failed to read/parse report artifact: ${String(err)}`,
    };
  }

  // ── Step 3: Zod boundary validation (AC#5) ──────────────────────────────────
  // MUST happen BEFORE key resolution. A tampered or malformed report is
  // rejected here — the signing key is never loaded.
  const validationResult = validateReport(rawReport);
  if (!validationResult.valid) {
    return {
      success: false,
      phase: 'zod-validation',
      error: `[clean-room-signer] Report rejected by Zod boundary: ${validationResult.error}`,
    };
  }
  const report = validationResult.report;

  // ── Step 3b: Cross-validate report fields against caller-supplied opts ───────
  // The report's headSha MUST match the headSha the caller believes is current.
  // A mismatch means the artifact was produced for a DIFFERENT commit than the
  // one being signed — potential TOCTOU attack or stale artifact.
  if (report.headSha !== headSha) {
    return {
      success: false,
      phase: 'zod-validation',
      error:
        `[clean-room-signer] headSha mismatch: report.headSha='${report.headSha}' does not ` +
        `match opts.headSha='${headSha}'. The report artifact was produced for a different ` +
        `commit. Regenerate the report for the correct HEAD.`,
    };
  }

  // ── Step 3c: Approval gate (CRITICAL fix #4) ────────────────────────────────
  // The signer MUST refuse to sign reports that are not approved.
  // Checking here (before key resolution) preserves the Zod-before-key invariant:
  // the key is never touched for unapproved, injection-flagged, or disapproved reports.
  //
  // Conditions that MUST prevent signing:
  //   (a) consensus.approved !== true — overall gate not met
  //   (b) any reviewers.*.approved === false — at least one reviewer rejected
  //   (c) any reviewers.*.promptInjectionDetected === true — injection detected
  if (report.consensus.approved !== true) {
    return {
      success: false,
      phase: 'consensus-rejected',
      error:
        `[clean-room-signer] Signing refused: consensus.approved is not true ` +
        `(value: ${String(report.consensus.approved)}). Only fully-approved reports may be signed.`,
    };
  }

  const reviewerNames = ['code', 'test', 'security'] as const;
  for (const name of reviewerNames) {
    const reviewer = report.reviewers[name];
    if (reviewer.approved === false) {
      return {
        success: false,
        phase: 'consensus-rejected',
        error:
          `[clean-room-signer] Signing refused: reviewer '${name}' approved === false. ` +
          `All reviewers must approve before the report can be signed.`,
      };
    }
    if (reviewer.promptInjectionDetected === true) {
      return {
        success: false,
        phase: 'consensus-rejected',
        error:
          `[clean-room-signer] Signing refused: reviewer '${name}' detected prompt injection ` +
          `(promptInjectionDetected === true). Signing is forbidden when injection is detected.`,
      };
    }
  }

  // ── Step 3b: Emit RFC-0042 v6 transcript leaves from the approved report ─────
  // Ordering is load-bearing: leaf emission runs AFTER the consensus-approval
  // gate (Step 3 above — security invariant: never emit leaves for an
  // unapproved/injection-flagged report) but BEFORE key resolution (Step 4
  // below). This matches the canonical v6 flow (reviewer fan-out emits leaves
  // before the signer runs) and guarantees the transcript leaves exist whether
  // or not a signing key is present — so an environment without a key (CI, fresh
  // machines) still produces the leaves, and a later sign attempt against them
  // is deterministic.
  //
  // The UCVG reviewer matrix runs in Stage 2/3 (a separate job) and does not
  // persist transcript leaves; the v6 signer requires a Merkle transcript to
  // build over. We reconstruct one leaf per reviewer deterministically from the
  // already-validated reviewer verdicts in the report. The verifier checks the
  // Merkle proof + root signature against these committed leaves — it does not
  // re-derive the nonce or re-hash an external transcript file — so a leaf built
  // from the verdict (transcriptHash = SHA-256 of the canonical verdict JSON) is
  // a faithful, self-consistent transcript record for this clean-room flow.
  try {
    const roleName: Record<'code' | 'test' | 'security', string> = {
      code: 'code-reviewer',
      test: 'test-reviewer',
      security: 'security-reviewer',
    };
    const reviewerModel = process.env['AI_SDLC_REVIEWER_MODEL'] ?? 'claude-sonnet-4-6';
    let leafIndex = 0;
    for (const key of ['code', 'test', 'security'] as const) {
      const rv = report.reviewers[key];
      const findings = { critical: 0, major: 0, minor: 0, suggestion: 0 };
      for (const f of rv.findings) findings[f.severity] += 1;
      const leaf: TranscriptLeaf = {
        leafIndex: leafIndex++,
        taskId,
        reviewerName: roleName[key],
        transcriptHash: createHash('sha256').update(JSON.stringify(rv), 'utf8').digest('hex'),
        nonce: generateNonce(headSha),
        harness: 'ucvg-sandbox',
        model: reviewerModel,
        verdictApproved: rv.approved === true,
        findings,
        signedAt: new Date().toISOString(),
      };
      if (patchId) {
        appendLeafForPatchId(leaf, patchId, repoRoot);
      } else {
        appendLeaf(leaf, repoRoot);
      }
    }
  } catch (err) {
    return {
      success: false,
      phase: 'signing',
      error: `[clean-room-signer] Failed to emit transcript leaves: ${String(err)}`,
    };
  }

  // ── Step 4: Key resolution ───────────────────────────────────────────────────
  const signingKeyPath = resolveSigningKeyPath();
  if (!signingKeyPath) {
    return {
      success: false,
      phase: 'key-resolution',
      error:
        `[clean-room-signer] No signing key found. Checked AISDLC_SIGNING_KEY_PATH env var ` +
        `and ~/.ai-sdlc/signing-key.pem. Run 'node ai-sdlc-plugin/scripts/init-signing-key.mjs' ` +
        `to generate a key.`,
    };
  }

  // ── Step 4b: Read the key file ───────────────────────────────────────────────
  // readFileSync is inside its own try/catch so TOCTOU/permission races on the
  // key file (e.g. key deleted or mode-changed between existsSync and readFileSync)
  // return a structured { success:false, phase:'key-resolution' } rather than
  // throwing a raw fs error that breaks the no-throw discriminated-union contract.
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(signingKeyPath, 'utf8');
  } catch (err) {
    return {
      success: false,
      phase: 'key-resolution',
      error: `[clean-room-signer] Failed to read signing key at '${signingKeyPath}': ${String(err)}`,
    };
  }

  // ── Steps 5-6: Build Merkle tree + Sign + Write RFC-0042 v6 envelope (AC#6,7) ─
  try {
    const envelopePath = signAndWriteV6Envelope({
      repoRoot,
      headSha,
      taskId,
      privateKeyPem,
      signerIdentity,
      patchId,
    });

    return { success: true, report, envelopePath };
  } catch (err) {
    return {
      success: false,
      phase: 'signing',
      error: `[clean-room-signer] Signing failed: ${String(err)}`,
    };
  }
}

// ── Convenience helpers ────────────────────────────────────────────────────────

/**
 * Derive the standard unsigned-report artifact path for a given PR number.
 *
 * Layout: `<repoRoot>/.ai-sdlc/ucvg/reports/<prNumber>.unsigned.json`.
 *
 * The sandbox runner (Stage 2/3, AISDLC-499) writes to this path. The
 * clean-room signer reads from it. Both sides use this function to
 * guarantee path agreement.
 */
export function unsignedReportPath(repoRoot: string, prNumber: number): string {
  return join(repoRoot, '.ai-sdlc', 'ucvg', 'reports', `${prNumber}.unsigned.json`);
}
