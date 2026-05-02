/**
 * `dor-bypass` label handler tests (RFC-0011 §7.4 + Phase 6).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOR_BYPASS_LABEL, handleBypassLabel } from './bypass.js';
import { resolveCalibrationLogPath } from './calibration-log.js';
import { DOR_CONFIG_DEFAULTS } from './dor-config.js';
import type { RefinementVerdict } from './types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-bypass-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function failingVerdict(): RefinementVerdict {
  return {
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'needs-clarification',
    overallConfidence: 'high',
    gates: [
      {
        gateId: 1,
        verdict: 'fail',
        severity: 'block',
        stage: 'B',
        confidence: 'high',
        finding: 'AC #2 is not binary-testable',
      },
    ],
    signedAt: '2026-05-01T12:00:00.000Z',
    evaluatorVersion: 'e2e-stage-b-v1',
    summary: 'Blocked on Gate 1.',
    questions: ['What metric and threshold define success?'],
  };
}

describe('handleBypassLabel — preconditions', () => {
  it('ignores unrelated labels', () => {
    const r = handleBypassLabel(
      {
        issueId: 'AISDLC-1',
        label: 'wontfix',
        actor: 'a@b.com',
        reason: 'because',
      },
      { checkActor: () => ({ allowed: true, reason: 'stub' }) },
    );
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain(`not the ${DOR_BYPASS_LABEL} label`);
    expect(r.calibrationEntry).toBeUndefined();
  });

  it('rejects empty reason', () => {
    const r = handleBypassLabel(
      {
        issueId: 'AISDLC-1',
        label: DOR_BYPASS_LABEL,
        actor: 'a@b.com',
        reason: '   ',
      },
      { checkActor: () => ({ allowed: true, reason: 'stub' }) },
    );
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain('non-empty reason');
    expect(r.calibrationEntry).toBeUndefined();
  });
});

describe('handleBypassLabel — trust gating', () => {
  it('denies an untrusted actor and does NOT write to the calibration log', () => {
    const logPath = resolveCalibrationLogPath({ artifactsDir: tmp });
    const r = handleBypassLabel(
      {
        issueId: 'AISDLC-1',
        label: DOR_BYPASS_LABEL,
        actor: 'stranger@example.com',
        reason: 'rubric false positive',
      },
      {
        checkActor: () => ({
          allowed: false,
          reason: "actor 'stranger@example.com' is not in .ai-sdlc/trusted-reviewers.yaml",
        }),
        calibrationLogOpts: { artifactsDir: tmp },
      },
    );
    expect(r.admitted).toBe(false);
    expect(r.reason).toContain('not allowed to bypass');
    expect(r.reason).toContain('trusted-reviewers.yaml');
    // No calibration entry should be written for a denied bypass.
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  it('passes the configured bypassRequiresRole through to the actor checker', () => {
    let captured: { actor?: string; role?: string } = {};
    handleBypassLabel(
      {
        issueId: 'AISDLC-1',
        label: DOR_BYPASS_LABEL,
        actor: 'a@b.com',
        reason: 'urgent fix',
      },
      {
        config: { ...DOR_CONFIG_DEFAULTS, bypassRequiresRole: 'release-manager' },
        checkActor: (actor, opts) => {
          captured = { actor, role: opts.requiredRole };
          return { allowed: true, reason: 'stub' };
        },
        calibrationLogOpts: { artifactsDir: tmp },
      },
    );
    expect(captured.actor).toBe('a@b.com');
    expect(captured.role).toBe('release-manager');
  });
});

describe('handleBypassLabel — admit + calibration log', () => {
  it('admits the issue and appends an override row', () => {
    const verdict = failingVerdict();
    verdict.issueId = 'AISDLC-1';
    const r = handleBypassLabel(
      {
        issueId: 'AISDLC-1',
        label: DOR_BYPASS_LABEL,
        actor: 'maintainer@example.com',
        reason: 'rubric Gate 5 false positive — surface IS named in body',
        verdict,
        issue: {
          id: 'AISDLC-1',
          source: 'github',
          title: 'Make search faster',
          body: '## Description\n\nMake search faster.',
        },
      },
      {
        checkActor: () => ({ allowed: true, reason: 'stub' }),
        calibrationLogOpts: { artifactsDir: tmp },
      },
    );

    expect(r.admitted).toBe(true);
    expect(r.reason).toContain('bypass admitted by maintainer@example.com');
    expect(r.reason).toContain('role=maintainer');

    const logPath = resolveCalibrationLogPath({ artifactsDir: tmp });
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.outcome).toBe('override');
    expect(entry.author).toBe('maintainer@example.com');
    expect(entry.notes).toContain('rubric Gate 5 false positive');
    expect(entry.issueId).toBe('AISDLC-1');
    expect(entry.failedGates).toEqual([1]);
    expect(r.calibrationLogPath).toBe(logPath);
    expect(r.calibrationEntry?.outcome).toBe('override');
  });

  it('writes a synthetic verdict when none is supplied', () => {
    const r = handleBypassLabel(
      {
        issueId: 'AISDLC-2',
        label: DOR_BYPASS_LABEL,
        actor: 'maintainer@example.com',
        reason: 'just admit it',
      },
      {
        checkActor: () => ({ allowed: true, reason: 'stub' }),
        calibrationLogOpts: { artifactsDir: tmp },
      },
    );
    expect(r.admitted).toBe(true);
    expect(r.calibrationEntry?.verdict.evaluatorVersion).toBe('override-synthetic');
    expect(r.calibrationEntry?.verdict.gates).toEqual([]);
  });

  it('trims whitespace around the supplied reason', () => {
    const r = handleBypassLabel(
      {
        issueId: 'AISDLC-3',
        label: DOR_BYPASS_LABEL,
        actor: 'maintainer@example.com',
        reason: '   urgent hotfix   \n',
      },
      {
        checkActor: () => ({ allowed: true, reason: 'stub' }),
        calibrationLogOpts: { artifactsDir: tmp },
      },
    );
    expect(r.admitted).toBe(true);
    expect(r.calibrationEntry?.notes).toBe('urgent hotfix');
  });

  it('falls back to the default config when none is supplied', () => {
    const r = handleBypassLabel(
      {
        issueId: 'AISDLC-4',
        label: DOR_BYPASS_LABEL,
        actor: 'a@b.com',
        reason: 'r',
      },
      {
        checkActor: () => ({ allowed: true, reason: 'stub' }),
        calibrationLogOpts: { artifactsDir: tmp },
      },
    );
    expect(r.admitted).toBe(true);
    // Default role is 'maintainer' per DOR_CONFIG_DEFAULTS.
    expect(r.reason).toContain('role=maintainer');
  });
});
