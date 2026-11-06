/**
 * Hermetic tests for RFC-0043 Phase 2 — Clean-Room Signer (AISDLC-498)
 *
 * Coverage:
 *   - Isolation invariant: refuses to run when sandbox artifacts are present
 *   - Tampered report rejected at the Zod boundary
 *   - headSha cross-check: report.headSha differs from opts.headSha -> phase:zod-validation
 *   - Approval gate: unapproved or injection-flagged reports are refused
 *   - A fully approved report passes; nothing is signed or written
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectSandboxArtifacts,
  runCleanRoomSigner,
  unsignedReportPath,
  SANDBOX_ARTIFACT_SENTINELS,
} from './clean-room-signer.js';
import type { UntrustedPrReport } from './report-validator.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'clean-room-signer-test-'));
}

function writeJson(filePath: string, data: unknown): void {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const VALID_REPORT: UntrustedPrReport = {
  schemaVersion: 'untrusted-pr-report.v1',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  generatedAt: '2026-06-02T10:00:00.000Z',
  trust: { classification: 'untrusted', reason: 'author-not-in-allowlist' },
  astGate: { outcome: 'pass', offendingPaths: [] },
  differentialTest: {
    upstreamSuitePassed: true,
    newTestsPassed: true,
    newCodeCoveragePct: 87.5,
  },
  reviewers: {
    code: { approved: true, findings: [], promptInjectionDetected: false },
    test: { approved: true, findings: [], promptInjectionDetected: false },
    security: { approved: true, findings: [], promptInjectionDetected: false },
  },
  consensus: { approved: true, blockingFindings: 0 },
};

// ── Isolation invariant tests (AC#8) ─────────────────────────────────────────

describe('detectSandboxArtifacts (AC#8)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeFixtureDir(tmpDir);
  });

  it('returns null when no sentinel files are present', () => {
    expect(detectSandboxArtifacts(tmpDir)).toBeNull();
  });

  it('detects each known sentinel file', () => {
    for (const sentinel of SANDBOX_ARTIFACT_SENTINELS) {
      const sentinelPath = join(tmpDir, sentinel);
      writeFileSync(sentinelPath, '', 'utf8');
      const result = detectSandboxArtifacts(tmpDir);
      expect(result).toBe(sentinel);
      rmSync(sentinelPath);
    }
  });

  it('detects untrusted-pr-eval-active', () => {
    writeFileSync(join(tmpDir, 'untrusted-pr-eval-active'), '', 'utf8');
    expect(detectSandboxArtifacts(tmpDir)).toBe('untrusted-pr-eval-active');
  });

  it('detects stages-1-3-output directory', () => {
    mkdirSync(join(tmpDir, 'stages-1-3-output'));
    expect(detectSandboxArtifacts(tmpDir)).toBe('stages-1-3-output');
  });

  it('returns null for an unrelated file', () => {
    writeFileSync(join(tmpDir, 'benign-file.txt'), 'hello', 'utf8');
    expect(detectSandboxArtifacts(tmpDir)).toBeNull();
  });
});

describe('runCleanRoomSigner — isolation invariant enforcement (AC#8)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeFixtureDir(tmpDir);
  });

  it('fails with phase:isolation-check when sandbox sentinel is present', () => {
    writeFileSync(join(tmpDir, 'untrusted-pr-eval-active'), '', 'utf8');
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, VALID_REPORT);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: 'a'.repeat(40),
      workDir: tmpDir, // workDir contains the sentinel
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('isolation-check');
    expect(result.error).toContain('untrusted-pr-eval-active');
    expect(result.error).toContain('[clean-room-signer]');
  });

  it('fails with phase:isolation-check BEFORE reading the report', () => {
    // Place a sentinel in workDir but NO report file — if the signer reads
    // the report before checking isolation, it would fail with artifact-read,
    // not isolation-check. Isolation-check MUST come first.
    writeFileSync(join(tmpDir, '.sandbox-pid'), '12345', 'utf8');
    const nonExistentReport = join(tmpDir, 'does-not-exist.json');

    const result = runCleanRoomSigner({
      reportArtifactPath: nonExistentReport,
      headSha: 'a'.repeat(40),
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    // Must be isolation-check, not artifact-read
    expect(result.phase).toBe('isolation-check');
  });
});

// ── Report artifact read/parse tests ─────────────────────────────────────────

describe('runCleanRoomSigner — artifact read failures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeFixtureDir(tmpDir);
  });

  it('fails with phase:artifact-read when report file does not exist', () => {
    const result = runCleanRoomSigner({
      reportArtifactPath: join(tmpDir, 'missing.json'),
      headSha: 'a'.repeat(40),
      workDir: tmpDir, // clean workDir, no sentinels
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('artifact-read');
    expect(result.error).toContain('[clean-room-signer]');
  });

  it('fails with phase:artifact-read when report file contains invalid JSON', () => {
    const reportPath = join(tmpDir, 'report.json');
    writeFileSync(reportPath, '{ invalid json {{', 'utf8');

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: 'a'.repeat(40),
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('artifact-read');
  });
});

// ── Zod boundary validation tests (AC#5) ─────────────────────────────────────

describe('runCleanRoomSigner — Zod validation BEFORE key resolution (AC#5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeFixtureDir(tmpDir);
  });

  it('fails with phase:zod-validation for a tampered report', () => {
    const tamperedReport = {
      ...VALID_REPORT,
      schemaVersion: 'untrusted-pr-report.v99', // wrong version
    };
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, tamperedReport);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: 'a'.repeat(40),
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('zod-validation');
    // Key must NOT have been resolved — the signer should fail before key-resolution
    // phase when report is invalid. We verify this by checking it's not key-resolution or signing.
    expect(result.phase).not.toBe('key-resolution');
    expect(result.phase).not.toBe('signing');
    expect(result.error).toContain('[clean-room-signer]');
  });

  it('fails with phase:zod-validation for a report with forbidden severity', () => {
    const tamperedReport = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: {
          approved: false,
          findings: [{ severity: 'high', message: 'bad severity' }], // 'high' not in enum
          promptInjectionDetected: false,
        },
      },
    };
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, tamperedReport);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: 'a'.repeat(40),
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('zod-validation');
  });

  it('fails with phase:zod-validation before key-resolution when headSha is malformed', () => {
    const tamperedReport = { ...VALID_REPORT, headSha: 'short' };
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, tamperedReport);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: 'a'.repeat(40),
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    // Must be zod-validation, not key-resolution — key is NOT touched
    expect(result.phase).toBe('zod-validation');
  });
});

// ── headSha cross-check: mismatch → phase:zod-validation (finding #6) ─────────

describe('runCleanRoomSigner — headSha cross-check (finding #6)', () => {
  let tmpDir: string;
  let origSigningKeyPath: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origSigningKeyPath = process.env['AISDLC_SIGNING_KEY_PATH'];
    // Point to a non-existent key so we stop at key-resolution if cross-check passes
    process.env['AISDLC_SIGNING_KEY_PATH'] = join(tmpDir, 'no-key.pem');
  });

  afterEach(() => {
    removeFixtureDir(tmpDir);
    if (origSigningKeyPath !== undefined) {
      process.env['AISDLC_SIGNING_KEY_PATH'] = origSigningKeyPath;
    } else {
      delete process.env['AISDLC_SIGNING_KEY_PATH'];
    }
  });

  it('returns phase:zod-validation when report.headSha does not match opts.headSha', () => {
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, VALID_REPORT); // VALID_REPORT.headSha = 'a'.repeat(40)

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: 'b'.repeat(40), // intentionally different from report.headSha
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('zod-validation');
    expect(result.error).toContain('headSha mismatch');
    expect(result.error).toContain('a'.repeat(40)); // report value
    expect(result.error).toContain('b'.repeat(40)); // caller value
  });

  it('passes the cross-check when headSha matches', () => {
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, VALID_REPORT);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: VALID_REPORT.headSha, // matches report
      workDir: tmpDir,
    });

    expect(result.success).toBe(true);
  });
});

// ── CRITICAL fix #4 — Approval gate: signer refuses unapproved reports ───────

describe('runCleanRoomSigner — approval gate (CRITICAL fix #4)', () => {
  let tmpDir: string;
  let origSigningKeyPath: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origSigningKeyPath = process.env['AISDLC_SIGNING_KEY_PATH'];
    // Point to a non-existent key so we stop at consensus-rejected before key-resolution
    process.env['AISDLC_SIGNING_KEY_PATH'] = join(tmpDir, 'no-key.pem');
  });

  afterEach(() => {
    removeFixtureDir(tmpDir);
    if (origSigningKeyPath !== undefined) {
      process.env['AISDLC_SIGNING_KEY_PATH'] = origSigningKeyPath;
    } else {
      delete process.env['AISDLC_SIGNING_KEY_PATH'];
    }
  });

  it('refuses to sign when consensus.approved === false', () => {
    const unapprovedReport: UntrustedPrReport = {
      ...VALID_REPORT,
      consensus: { approved: false, blockingFindings: 2 },
    };
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, unapprovedReport);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: VALID_REPORT.headSha,
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('consensus-rejected');
    expect(result.error).toContain('[clean-room-signer]');
    expect(result.error).toContain('consensus.approved');
    // Must fail BEFORE key-resolution (approval check is before key touch)
    expect(result.phase).not.toBe('key-resolution');
    expect(result.phase).not.toBe('signing');
  });

  it('refuses to sign when any reviewer.approved === false', () => {
    const rejectedByCodeReview: UntrustedPrReport = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: {
          approved: false,
          findings: [{ severity: 'critical', message: 'injection risk' }],
          promptInjectionDetected: false,
        },
      },
      // Note: consensus.approved is still true in VALID_REPORT — this tests that
      // the signer checks individual reviewer approvals, not only the consensus field.
    };
    const reportPath = join(tmpDir, 'report-code-rejected.json');
    writeJson(reportPath, rejectedByCodeReview);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: VALID_REPORT.headSha,
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('consensus-rejected');
    expect(result.error).toContain('code');
    expect(result.error).toContain('approved === false');
  });

  it('refuses to sign when promptInjectionDetected === true (any reviewer)', () => {
    const injectionFlagged: UntrustedPrReport = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        security: { approved: true, findings: [], promptInjectionDetected: true },
      },
    };
    const reportPath = join(tmpDir, 'report-injection.json');
    writeJson(reportPath, injectionFlagged);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: VALID_REPORT.headSha,
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.phase).toBe('consensus-rejected');
    expect(result.error).toContain('promptInjectionDetected');
    expect(result.error).toContain('security');
  });

  it('passes a fully-approved report', () => {
    // VALID_REPORT has all reviewers approved + consensus.approved=true + no injection
    const reportPath = join(tmpDir, 'report-approved.json');
    writeJson(reportPath, VALID_REPORT);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      headSha: VALID_REPORT.headSha,
      workDir: tmpDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.report.prNumber).toBe(42);
  });
});

// ── unsignedReportPath helper ─────────────────────────────────────────────────

describe('unsignedReportPath', () => {
  it('generates the expected path', () => {
    const path = unsignedReportPath('/repo', 42);
    expect(path).toBe('/repo/.ai-sdlc/ucvg/reports/42.unsigned.json');
  });

  it('uses the prNumber in the filename', () => {
    const path = unsignedReportPath('/repo', 999);
    expect(path).toContain('999.unsigned.json');
  });
});
