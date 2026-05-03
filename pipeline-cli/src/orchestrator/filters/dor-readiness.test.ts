/**
 * Filter 2 — DoR readiness (RFC-0015 Phase 3 / AISDLC-169.3) tests.
 *
 * Covers:
 *   - No log file → passed (v1 default — see module docstring).
 *   - Log exists but no entry for this task → passed.
 *   - Latest entry is `admit` → passed.
 *   - Latest entry is `needs-clarification` → failed + structured detail.
 *   - Override entry (bypass-applied) → passed.
 *   - `dor-bypass` frontmatter label → passed even when latest verdict blocks.
 *   - Latest entry is selected (not the first or any-pass entry).
 *   - Malformed JSONL lines are skipped silently.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDorReadiness } from './dor-readiness.js';

interface JsonlEntry {
  ts: string;
  issueId: string;
  rubricVersion: string;
  evaluatorVersion: string;
  overallVerdict: 'admit' | 'needs-clarification';
  failedGates: number[];
  outcome: 'admit' | 'needs-clarification' | 'override' | '';
  verdict: {
    issueId: string;
    rubricVersion: 'v1';
    overallVerdict: 'admit' | 'needs-clarification';
    gates: unknown[];
    signedAt: string;
    evaluatorVersion: string;
  };
}

function entry(opts: {
  issueId: string;
  overallVerdict: 'admit' | 'needs-clarification';
  outcome?: 'admit' | 'needs-clarification' | 'override' | '';
  signedAt?: string;
}): JsonlEntry {
  return {
    ts: '2026-05-02T12:00:00Z',
    issueId: opts.issueId,
    rubricVersion: 'v1',
    evaluatorVersion: 'test-1',
    overallVerdict: opts.overallVerdict,
    failedGates: opts.overallVerdict === 'needs-clarification' ? [4] : [],
    outcome: opts.outcome ?? '',
    verdict: {
      issueId: opts.issueId,
      rubricVersion: 'v1',
      overallVerdict: opts.overallVerdict,
      gates: [],
      signedAt: opts.signedAt ?? '2026-05-02T12:00:00Z',
      evaluatorVersion: 'test-1',
    },
  };
}

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'phase3-dor-'));
  logPath = join(tmp, 'calibration.jsonl');
});
afterEach(() => {
  // Ephemeral; vitest's tmp dir is cleaned by the OS.
});

describe('checkDorReadiness — no-log + no-entry defaults', () => {
  it('passes when the calibration log file does not exist', () => {
    const result = checkDorReadiness({
      taskId: 'AISDLC-X',
      calibrationLogPath: join(tmp, 'missing.jsonl'),
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('DorReadiness');
  });

  it('passes when the log exists but has no entry for this task', () => {
    writeFileSync(
      logPath,
      JSON.stringify(entry({ issueId: 'AISDLC-OTHER', overallVerdict: 'admit' })) + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', calibrationLogPath: logPath });
    expect(result.passed).toBe(true);
  });
});

describe('checkDorReadiness — latest verdict gating', () => {
  it('passes when the latest verdict is admit', () => {
    writeFileSync(
      logPath,
      JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'admit' })) + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', calibrationLogPath: logPath });
    expect(result.passed).toBe(true);
  });

  it('fails when the latest verdict is needs-clarification', () => {
    writeFileSync(
      logPath,
      JSON.stringify(
        entry({
          issueId: 'AISDLC-X',
          overallVerdict: 'needs-clarification',
          signedAt: '2026-05-02T13:00:00Z',
        }),
      ) + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', calibrationLogPath: logPath });
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({
      kind: 'dor-blocked',
      verdict: 'needs-clarification',
      signedAt: '2026-05-02T13:00:00Z',
    });
  });

  it('reads the LAST entry for the task (not the first, not any-pass)', () => {
    // First an admit, then a needs-clarification — latest wins.
    writeFileSync(
      logPath,
      [
        JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'admit' })),
        JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'needs-clarification' })),
      ].join('\n') + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', calibrationLogPath: logPath });
    expect(result.passed).toBe(false);
  });

  it('case-insensitive issueId matching', () => {
    writeFileSync(
      logPath,
      JSON.stringify(entry({ issueId: 'aisdlc-x', overallVerdict: 'admit' })) + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', calibrationLogPath: logPath });
    expect(result.passed).toBe(true);
  });

  it('skips malformed JSONL lines silently', () => {
    writeFileSync(
      logPath,
      [
        '{"not json',
        JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'admit' })),
        '   ',
      ].join('\n') + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', calibrationLogPath: logPath });
    expect(result.passed).toBe(true);
  });
});

describe('checkDorReadiness — override + bypass paths', () => {
  it('admits when the latest entry is an override (`outcome: override`)', () => {
    writeFileSync(
      logPath,
      [
        // First a needs-clarification, then an override entry — override wins.
        JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'needs-clarification' })),
        JSON.stringify(
          entry({ issueId: 'AISDLC-X', overallVerdict: 'admit', outcome: 'override' }),
        ),
      ].join('\n') + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', calibrationLogPath: logPath });
    expect(result.passed).toBe(true);
  });

  it('admits when the task carries the `dor-bypass` frontmatter label, even when the latest verdict blocks', () => {
    writeFileSync(
      logPath,
      JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'needs-clarification' })) + '\n',
    );
    const result = checkDorReadiness({
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
      taskLabels: ['dor-bypass'],
    });
    expect(result.passed).toBe(true);
  });

  it('bypass label match is case-insensitive', () => {
    writeFileSync(
      logPath,
      JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'needs-clarification' })) + '\n',
    );
    const result = checkDorReadiness({
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
      taskLabels: ['DOR-BYPASS'],
    });
    expect(result.passed).toBe(true);
  });

  it('non-bypass labels do not admit', () => {
    writeFileSync(
      logPath,
      JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'needs-clarification' })) + '\n',
    );
    const result = checkDorReadiness({
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
      taskLabels: ['rfc-0015', 'phase-3'],
    });
    expect(result.passed).toBe(false);
  });
});

describe('checkDorReadiness — artifactsDir resolution', () => {
  it('reads the conventional path under a custom artifactsDir', () => {
    const dir = join(tmp, 'art');
    const logDir = join(dir, '_dor');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, 'calibration.jsonl'),
      JSON.stringify(entry({ issueId: 'AISDLC-X', overallVerdict: 'admit' })) + '\n',
    );
    const result = checkDorReadiness({ taskId: 'AISDLC-X', artifactsDir: dir });
    expect(result.passed).toBe(true);
  });
});
