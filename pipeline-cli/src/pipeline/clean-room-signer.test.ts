/**
 * Hermetic tests for RFC-0043 Phase 2 — Clean-Room Signer (AISDLC-498)
 *
 * AC#10 coverage:
 *   - Signer isolation invariant: refuses to run when sandbox artifacts present
 *   - Tampered report rejected at Zod boundary BEFORE key is touched
 *   - Signs only after Zod validation passes
 *   - v6 envelope generation (mock key path)
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
    rmSync(tmpDir, { recursive: true, force: true });
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails with phase:isolation-check when sandbox sentinel is present', () => {
    writeFileSync(join(tmpDir, 'untrusted-pr-eval-active'), '', 'utf8');
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, VALID_REPORT);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
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
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails with phase:artifact-read when report file does not exist', () => {
    const result = runCleanRoomSigner({
      reportArtifactPath: join(tmpDir, 'missing.json'),
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
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
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
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
    rmSync(tmpDir, { recursive: true, force: true });
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
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
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
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
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
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
      headSha: 'a'.repeat(40),
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    // Must be zod-validation, not key-resolution — key is NOT touched
    expect(result.phase).toBe('zod-validation');
  });
});

// ── Key resolution failure test ───────────────────────────────────────────────

describe('runCleanRoomSigner — key resolution (AC#5 order)', () => {
  let tmpDir: string;
  let origSigningKeyPath: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origSigningKeyPath = process.env['AISDLC_SIGNING_KEY_PATH'];
    // Point to a non-existent key so key-resolution fails predictably
    process.env['AISDLC_SIGNING_KEY_PATH'] = join(tmpDir, 'nonexistent-key.pem');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origSigningKeyPath !== undefined) {
      process.env['AISDLC_SIGNING_KEY_PATH'] = origSigningKeyPath;
    } else {
      delete process.env['AISDLC_SIGNING_KEY_PATH'];
    }
  });

  it('fails with phase:key-resolution (not zod-validation) for a valid report with no key', () => {
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, VALID_REPORT);

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      repoRoot: tmpDir,
      taskId: 'AISDLC-498',
      headSha: 'a'.repeat(40),
      workDir: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    // Valid report passes Zod — failure must be at key-resolution, not earlier
    expect(result.phase).toBe('key-resolution');
    expect(result.error).toContain('[clean-room-signer]');
    expect(result.error).toContain('signing key');
  });
});

// ── v6 envelope generation test (AC#7) ───────────────────────────────────────

describe('runCleanRoomSigner — v6 envelope generation (AC#7)', () => {
  let tmpDir: string;
  let origSigningKeyPath: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origSigningKeyPath = process.env['AISDLC_SIGNING_KEY_PATH'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origSigningKeyPath !== undefined) {
      process.env['AISDLC_SIGNING_KEY_PATH'] = origSigningKeyPath;
    } else {
      delete process.env['AISDLC_SIGNING_KEY_PATH'];
    }
  });

  it('signs successfully with a real ed25519 key and produces v6 envelope', async () => {
    // Generate a test ed25519 key inline using Node's built-in crypto
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    // Write the key to a temp file
    const keyPath = join(tmpDir, 'test-signing-key.pem');
    writeFileSync(keyPath, privateKey, 'utf8');
    process.env['AISDLC_SIGNING_KEY_PATH'] = keyPath;

    // Write a valid report
    const reportPath = join(tmpDir, 'report.json');
    writeJson(reportPath, VALID_REPORT);

    // Write at least one transcript leaf so signAndWriteV6Envelope finds leaves
    const leavesDir = join(tmpDir, '.ai-sdlc', 'transcript-leaves');
    mkdirSync(leavesDir, { recursive: true });
    const taskId = 'aisdlc-498';
    // Use a fake patch-id (40-hex) so the per-patch-id path is used
    const fakePatchId = 'c'.repeat(40);
    const leaf = {
      leafIndex: 0,
      taskId,
      reviewerName: 'code-reviewer',
      transcriptHash: 'd'.repeat(64),
      nonce: 'e'.repeat(64),
      harness: 'claude-code',
      model: 'sonnet',
      verdictApproved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      signedAt: '2026-06-02T10:00:00.000Z',
    };
    writeFileSync(join(leavesDir, `${fakePatchId}.jsonl`), JSON.stringify(leaf) + '\n', 'utf8');

    const result = runCleanRoomSigner({
      reportArtifactPath: reportPath,
      repoRoot: tmpDir,
      taskId,
      headSha: VALID_REPORT.headSha,
      patchId: fakePatchId,
      workDir: tmpDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success, got ${result.phase}: ${result.error}`);
    }
    expect(result.report.schemaVersion).toBe('untrusted-pr-report.v1');
    expect(result.envelopePath).toContain(`${fakePatchId}.v6.dsse.json`);

    // Verify the written envelope is valid JSON and has v6 schema
    const { readFileSync } = await import('node:fs');
    const envelope = JSON.parse(readFileSync(result.envelopePath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(envelope['schemaVersion']).toBe('v6');
    expect(envelope['rootHash']).toBeTruthy();
    expect(envelope['rootSignature']).toBeTruthy();
    expect(typeof envelope['rootSignature']).toBe('string');
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
