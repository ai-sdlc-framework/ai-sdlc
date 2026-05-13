/**
 * Unit tests for RFC-0024 capture writer/reader.
 *
 * Uses a temporary directory so no real ARTIFACTS_DIR is needed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  writeCapture,
  applyTriageUpdate,
  redactCapture,
  resolveCapturesDir,
} from './capture-writer.js';
import { loadCaptures, loadCaptureById, hasPendingCapturesForIssue } from './capture-reader.js';

let tmpDir: string;
let artifactsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-capture-test-'));
  artifactsDir = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveCapturesDir', () => {
  it('appends _captures to the artifacts dir', () => {
    const dir = resolveCapturesDir('/artifacts');
    expect(dir).toBe('/artifacts/_captures');
  });
});

// AISDLC-269 PR #483 review fix: regression for path-traversal via captureId.
// Pre-fix: applyTriageUpdate / redactCapture / loadCaptureById joined the raw
// captureId into the path with no validation, so `..` segments escaped the
// _captures dir and let a caller read+overwrite arbitrary .jsonl files.
// Fix: assertSafeCaptureId() validates against /^cap_[\d-]+T[\d-]+_[a-f0-9]{6}$/.
// These tests pin the contract: any non-canonical ID throws.
describe('AISDLC-269 path-traversal hardening (PR #483 review fix)', () => {
  const malicious = ['../../etc/passwd', '..', '../foo', 'foo/bar', 'cap_2026/x', ''];
  for (const id of malicious) {
    it(`applyTriageUpdate rejects malformed captureId: ${JSON.stringify(id)}`, () => {
      expect(() =>
        applyTriageUpdate({
          captureId: id,
          triage: 'new-issue',
          artifactsDir,
        }),
      ).toThrow(/invalid captureId/);
    });
    it(`redactCapture rejects malformed captureId: ${JSON.stringify(id)}`, () => {
      expect(() =>
        redactCapture({
          captureId: id,
          actor: 'op',
          artifactsDir,
        }),
      ).toThrow(/invalid captureId/);
    });
    it(`loadCaptureById rejects malformed captureId: ${JSON.stringify(id)}`, () => {
      expect(() => loadCaptureById(id, artifactsDir)).toThrow(/invalid captureId/);
    });
  }
  it('canonical captureId is accepted (negative control)', () => {
    // applyTriageUpdate throws "not found" rather than "invalid captureId" for
    // a canonical-shape ID that doesn't exist on disk — proves the validator
    // passed it through to the file-existence check.
    expect(() =>
      applyTriageUpdate({
        captureId: 'cap_2026-05-13T14-30-00_abc123',
        triage: 'new-issue',
        artifactsDir,
      }),
    ).toThrow(/not found/);
  });
});

describe('writeCapture', () => {
  it('writes a capture record and returns it', () => {
    const record = writeCapture({
      finding: 'auth middleware does not refresh tokens',
      sourceType: 'operator',
      operator: 'test@example.com',
      artifactsDir,
    });

    expect(record.id).toMatch(/^cap_/);
    expect(record.schemaVersion).toBe('v1');
    expect(record.finding).toBe('auth middleware does not refresh tokens');
    expect(record.severity).toBe('unknown'); // default
    expect(record.triage).toBe('tbd'); // default
    expect(record.source.type).toBe('operator');
    expect(record.source.operator).toBe('test@example.com');
    expect(record.auditTrail).toHaveLength(1);
    expect(record.auditTrail[0].action).toBe('captured');
  });

  it('writes a capture with all evidence fields', () => {
    const record = writeCapture({
      finding: 'retry loop missing jitter',
      severity: 'minor',
      triage: 'new-issue',
      sourceType: 'ai-agent',
      agentRole: 'code-reviewer',
      evidence: {
        filePath: 'src/retry.ts',
        line: 42,
        prNumber: 234,
      },
      artifactsDir,
    });

    expect(record.severity).toBe('minor');
    expect(record.triage).toBe('new-issue');
    expect(record.source.type).toBe('ai-agent');
    expect(record.source.agentRole).toBe('code-reviewer');
    expect(record.evidence.filePath).toBe('src/retry.ts');
    expect(record.evidence.line).toBe(42);
    expect(record.evidence.prNumber).toBe(234);
  });

  it('sets resolvedAt when triage is terminal', () => {
    const record = writeCapture({
      finding: 'quick fix needed',
      triage: 'quick-fix',
      sourceType: 'operator',
      operator: 'test@example.com',
      artifactsDir,
    });

    expect(record.resolvedAt).toBeTruthy();
    expect(record.resolvedBy).toBe('test@example.com');
  });

  it('leaves resolvedAt null for tbd', () => {
    const record = writeCapture({
      finding: 'something',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'test@example.com',
      artifactsDir,
    });

    expect(record.resolvedAt).toBeNull();
    expect(record.resolvedBy).toBeNull();
  });
});

describe('applyTriageUpdate', () => {
  it('applies a triage update and appends an audit entry', () => {
    const original = writeCapture({
      finding: 'token refresh bug',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'test@example.com',
      artifactsDir,
    });

    const updated = applyTriageUpdate({
      captureId: original.id,
      triage: 'new-issue',
      resolvedBy: 'test@example.com',
      artifactsDir,
    });

    expect(updated.triage).toBe('new-issue');
    expect(updated.resolvedAt).toBeTruthy();
    expect(updated.resolvedBy).toBe('test@example.com');
    expect(updated.auditTrail).toHaveLength(2);
    expect(updated.auditTrail[1].action).toBe('triaged');
  });

  it('throws when trying to re-triage a terminal capture', () => {
    const record = writeCapture({
      finding: 'already triaged',
      triage: 'new-issue',
      sourceType: 'operator',
      operator: 'test@example.com',
      artifactsDir,
    });

    expect(() =>
      applyTriageUpdate({
        captureId: record.id,
        triage: 'quick-fix',
        resolvedBy: 'test@example.com',
        artifactsDir,
      }),
    ).toThrow('already has terminal triage');
  });

  it('throws when the capture ID does not exist', () => {
    expect(() =>
      applyTriageUpdate({
        captureId: 'cap_9999-01-01T00-00-00_abcdef',
        triage: 'quick-fix',
        resolvedBy: 'test@example.com',
        artifactsDir,
      }),
    ).toThrow('not found');
  });
});

describe('redactCapture', () => {
  it('scrubs finding and context, preserves audit trail', () => {
    const original = writeCapture({
      finding: 'sensitive PII: user email was logged',
      context: 'saw it in the logs',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'test@example.com',
      artifactsDir,
    });

    const redacted = redactCapture({
      captureId: original.id,
      reason: 'PII accidentally captured',
      redactedBy: 'test@example.com',
      artifactsDir,
    });

    expect(redacted.finding).toBe('[REDACTED]');
    expect(redacted.auditTrail).toHaveLength(2);
    expect(redacted.auditTrail[1].action).toBe('redacted');
    const redactEntry = redacted.auditTrail[1] as Record<string, unknown>;
    expect(redactEntry.reason).toBe('PII accidentally captured');
  });
});

describe('loadCaptures', () => {
  it('returns empty when no captures exist', () => {
    const { records, skippedFiles } = loadCaptures({ artifactsDir });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(0);
  });

  it('loads all written captures', () => {
    writeCapture({ finding: 'one', sourceType: 'operator', operator: 'a@b.com', artifactsDir });
    writeCapture({ finding: 'two', sourceType: 'operator', operator: 'a@b.com', artifactsDir });
    writeCapture({ finding: 'three', sourceType: 'operator', operator: 'a@b.com', artifactsDir });

    const { records } = loadCaptures({ artifactsDir });
    expect(records).toHaveLength(3);
  });

  it('filters by triage', () => {
    writeCapture({
      finding: 'pending',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });
    writeCapture({
      finding: 'done',
      triage: 'new-issue',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });

    const { records: pending } = loadCaptures({ artifactsDir, triage: 'tbd' });
    expect(pending).toHaveLength(1);
    expect(pending[0].finding).toBe('pending');
  });

  it('pendingOnly filter works', () => {
    writeCapture({
      finding: 'p1',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });
    writeCapture({
      finding: 'p2',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });
    writeCapture({
      finding: 'done',
      triage: 'quick-fix',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });

    const { records } = loadCaptures({ artifactsDir, pendingOnly: true });
    expect(records).toHaveLength(2);
  });
});

describe('loadCaptureById', () => {
  it('loads a specific capture by ID', () => {
    const written = writeCapture({
      finding: 'specific',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });
    const loaded = loadCaptureById(written.id, artifactsDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(written.id);
    expect(loaded!.finding).toBe('specific');
  });

  it('returns null for a non-existent ID', () => {
    expect(loadCaptureById('cap_2099-01-01T00-00-00_ffffff', artifactsDir)).toBeNull();
  });
});

describe('hasPendingCapturesForIssue', () => {
  it('returns false when no pending captures reference the issue', () => {
    writeCapture({
      finding: 'something',
      triage: 'tbd',
      relatedIssueId: 'AISDLC-999',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });

    expect(hasPendingCapturesForIssue('AISDLC-100', artifactsDir)).toBe(false);
  });

  it('returns true when a pending capture has relatedIssueId matching the issue', () => {
    writeCapture({
      finding: 'related',
      triage: 'tbd',
      relatedIssueId: 'AISDLC-100',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });

    expect(hasPendingCapturesForIssue('AISDLC-100', artifactsDir)).toBe(true);
  });

  it('returns true when a pending capture has blocksIssueId matching the issue', () => {
    writeCapture({
      finding: 'blocking',
      triage: 'tbd',
      blocksIssueId: 'AISDLC-200',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });

    expect(hasPendingCapturesForIssue('AISDLC-200', artifactsDir)).toBe(true);
  });

  it('returns false when the only pending capture was already triaged', () => {
    const written = writeCapture({
      finding: 'triaged',
      triage: 'tbd',
      relatedIssueId: 'AISDLC-300',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });
    applyTriageUpdate({
      captureId: written.id,
      triage: 'new-issue',
      resolvedBy: 'a@b.com',
      artifactsDir,
    });

    expect(hasPendingCapturesForIssue('AISDLC-300', artifactsDir)).toBe(false);
  });

  it('is case-insensitive on issue ID comparison', () => {
    writeCapture({
      finding: 'case test',
      triage: 'tbd',
      relatedIssueId: 'AISDLC-400',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir,
    });

    expect(hasPendingCapturesForIssue('aisdlc-400', artifactsDir)).toBe(true);
  });
});
