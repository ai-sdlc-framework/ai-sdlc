/**
 * Tests for RFC-0025 §13 OQ-6 — framework-coverage-gap response.
 * Phase 5 (AISDLC-306).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FRAMEWORK_COVERAGE_GAP_SOURCE, recordFrameworkCoverageGap } from './coverage-gap.js';

let workdir: string;
let artifactsDir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'coverage-gap-'));
  artifactsDir = join(workdir, 'artifacts');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('recordFrameworkCoverageGap', () => {
  it('writes an RFC-0024 capture with source=framework-coverage-gap + triage=tbd', () => {
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-200',
      reason: 'no catalogued handler matched; falling through to UnknownFailureMode',
      artifactsDir,
    });

    expect(result.shouldQuarantine).toBe(true); // default
    expect(result.capture).not.toBeNull();
    expect(result.capture?.triage).toBe('tbd');
    expect(result.capture?.severity).toBe('unknown');
    expect(result.capture?.source.type).toBe('ai-agent');
    expect(result.capture?.source.agentRole).toBe('orchestrator');
    expect(result.capture?.source.context).toBe(FRAMEWORK_COVERAGE_GAP_SOURCE);
    expect(result.capture?.relatedIssueId).toBe('AISDLC-200');
    expect(result.capture?.finding).toMatch(/framework-coverage-gap/);
  });

  it('persists the capture to $ARTIFACTS_DIR/_captures/<id>.jsonl', () => {
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-201',
      reason: 'orchestrator failed',
      artifactsDir,
    });
    expect(result.capture).not.toBeNull();
    const capturesDir = join(artifactsDir, '_captures');
    const files = readdirSync(capturesDir);
    expect(files).toContain(`${result.capture?.id}.jsonl`);
    const parsed = JSON.parse(
      readFileSync(join(capturesDir, `${result.capture?.id}.jsonl`), 'utf8'),
    ) as { triage: string; finding: string };
    expect(parsed.triage).toBe('tbd');
    expect(parsed.finding).toMatch(/framework-coverage-gap/);
  });

  it('shouldQuarantine=false when config.autoQuarantine is false', () => {
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-202',
      reason: 'orchestrator failed',
      artifactsDir,
      config: { autoQuarantine: false },
    });
    expect(result.shouldQuarantine).toBe(false);
    // fileCapture still defaults to true
    expect(result.capture).not.toBeNull();
  });

  it('capture is null when config.fileCapture is false', () => {
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-203',
      reason: 'orchestrator failed',
      artifactsDir,
      config: { fileCapture: false },
    });
    expect(result.capture).toBeNull();
    // _captures directory should not have been created
    expect(existsSync(join(artifactsDir, '_captures'))).toBe(false);
    // Quarantine signal still honored
    expect(result.shouldQuarantine).toBe(true);
  });

  it('includes the full reason (truncated to 2000 chars) in evidence.additionalContext', () => {
    const longReason = 'X'.repeat(5000);
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-204',
      reason: longReason,
      artifactsDir,
    });
    const ctx = result.capture?.evidence.additionalContext ?? '';
    expect(ctx).toMatch(/source: framework-coverage-gap/);
    expect(ctx).toMatch(/taskId: AISDLC-204/);
    // Truncated to 2000 chars (we look for at least one X but not the full 5000)
    expect(ctx).toMatch(/X{100}/);
    // The truncation cap is enforced at 2000; original is 5000
    const xRunMatch = /X+/.exec(ctx);
    expect(xRunMatch?.[0].length ?? 0).toBeLessThanOrEqual(2000);
  });

  it('falls back to generic finding when reason is empty', () => {
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-205',
      reason: '',
      artifactsDir,
    });
    expect(result.capture?.finding).toMatch(
      /framework-coverage-gap: uncatalogued orchestrator failure mode/,
    );
  });

  it('captures sourceHint and prUrl in evidence when provided', () => {
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-206',
      reason: 'something blew up',
      sourceHint: 'verify-step',
      prUrl: 'https://github.com/example/repo/pull/42',
      artifactsDir,
    });
    const ctx = result.capture?.evidence.additionalContext ?? '';
    expect(ctx).toMatch(/sourceHint: verify-step/);
    expect(ctx).toMatch(/prUrl: https:\/\/github\.com\/example\/repo\/pull\/42/);
  });

  it('uses operator-supplied now for deterministic ts', () => {
    const now = new Date('2026-05-24T12:34:56.789Z');
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-207',
      reason: 'oops',
      artifactsDir,
      now,
    });
    expect(result.capture?.timestamp).toBe('2026-05-24T12:34:56.789Z');
  });

  it('swallows write failures and returns capture: null', () => {
    // Force a write failure by pointing artifactsDir at a non-directory path
    // (we create a file where the directory would be expected). mkdir under
    // <blockedDir>/artifacts/_captures will fail because blockedDir is a
    // regular file, not a directory.
    const blockedDir = join(workdir, 'not-a-dir');
    const fakeArt = join(blockedDir, 'artifacts');
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    writeFileSync(blockedDir, 'sentinel', 'utf8');

    const warnings: string[] = [];
    const result = recordFrameworkCoverageGap({
      taskId: 'AISDLC-208',
      reason: 'cannot write',
      artifactsDir: fakeArt,
      logger: { warn: (m): void => void warnings.push(m) },
    });
    expect(result.capture).toBeNull();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatch(/coverage-gap/);
  });
});
