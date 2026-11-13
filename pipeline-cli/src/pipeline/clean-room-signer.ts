/**
 * RFC-0043 Phase 2 — Stage 4: Clean-Room Signer (AISDLC-498)
 *
 * Hardened signer step that decouples the untrusted-evaluation environment
 * (Stages 2-3) from the credential-holding signing step (Stage 4).
 *
 * ## Trust boundary invariants (security properties)
 *
 * 1. **Zod-before-trust**: the report artifact is Zod-validated BEFORE any of
 *    its fields is read. A malformed or tampered report is rejected at the
 *    boundary.
 *
 * 2. **Isolation**: the step refuses to run if any untrusted-PR-eval artifact
 *    file (`untrusted-pr-eval-*` files, `stages-1-3-output/` directory,
 *    `sandbox-output/` directory) is detected in the working directory.
 *
 * 3. **Approval gate**: a report that is not fully approved, or whose
 *    reviewers flagged prompt injection, is refused.
 *
 * The step no longer signs anything (RFC-0061 phase 3): the verdict record
 * (`cli-ucvg emit-verdict`, written by the trusted verdict-writer) is the
 * only output of the clean-room job that the merge gate reads.
 *
 * @module pipeline/clean-room-signer
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReport } from './report-validator.js';
import type { UntrustedPrReport } from './report-validator.js';

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
  /** Git commit SHA of the PR head; the report must have been produced for it. */
  headSha: string;
  /**
   * Working directory for the isolation-invariant check (AC#8).
   * Defaults to `process.cwd()`.
   *
   * This MUST be the operator's working directory, NOT the sandbox directory.
   * The step detects if it has been invoked from inside the sandbox.
   */
  workDir?: string;
}

// ── Result types ──────────────────────────────────────────────────────────────

/** Result of a successful clean-room validation. */
export interface CleanRoomSignerSuccess {
  success: true;
  /** The parsed, Zod-validated report. */
  report: UntrustedPrReport;
}

/**
 * Result of a failed clean-room validation.
 *
 * `phase` identifies where in the pipeline the failure occurred:
 *
 * - `isolation-check`   — sandbox artifacts detected.
 * - `artifact-read`     — could not read/parse the report artifact file.
 * - `zod-validation`    — report failed Zod boundary validation or the head SHA check.
 * - `consensus-rejected` — report not approved, or a reviewer detected injection.
 */
export interface CleanRoomSignerFailure {
  success: false;
  phase: 'isolation-check' | 'artifact-read' | 'zod-validation' | 'consensus-rejected';
  error: string;
}

export type CleanRoomSignerResult = CleanRoomSignerSuccess | CleanRoomSignerFailure;

// ── Main signer function ──────────────────────────────────────────────────────

/**
 * Run the RFC-0043 Stage-4 clean-room validation.
 *
 * Implements all security-relevant steps in the strict order required to
 * enforce the trust boundary:
 *
 * 1. **Isolation check** (AC#8) — refuse if sandbox artifacts detected.
 * 2. **Read + parse** the unsigned report artifact.
 * 3. **Zod validate** (AC#5) — reject before any field is trusted.
 *
 *
 * Returns a typed discriminated union — callers MUST check `result.success`
 * before accessing `result.report` / `result.envelopePath`.
 */
export function runCleanRoomSigner(opts: CleanRoomSignerOptions): CleanRoomSignerResult {
  const { reportArtifactPath, headSha } = opts;
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

  // (d) AISDLC-1267: the sandbox test flags are checked here directly,
  // independent of the consensus value: upstream suite AND new tests passed.
  if (
    report.differentialTest.upstreamSuitePassed !== true ||
    report.differentialTest.newTestsPassed !== true
  ) {
    return {
      success: false,
      phase: 'consensus-rejected',
      error:
        `[clean-room-signer] Signing refused: sandbox tests did not pass ` +
        `(upstreamSuitePassed=${String(report.differentialTest.upstreamSuitePassed)}, ` +
        `newTestsPassed=${String(report.differentialTest.newTestsPassed)}). ` +
        `Approval requires both to be true.`,
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

  return { success: true, report };
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
