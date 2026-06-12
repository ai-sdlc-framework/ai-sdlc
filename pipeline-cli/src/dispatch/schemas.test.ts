/**
 * Schema-validation tests for Dispatch Board JSON contracts (RFC-0041
 * Phase 1 + Phase 1.5 / AISDLC-377.2).
 *
 * MAJOR #4 (iteration-2 review close-out): the diff adds a new
 * resume-signal schema and evolves manifest+verdict for Phase 1.5
 * iteration fields, but earlier revisions never validated the JSON shapes
 * end-to-end. This file fixes that gap with hermetic Ajv2020 tests:
 *
 *   - Resume signal: valid round-trip, missing-required rejection,
 *     additionalProperties rejection.
 *   - Manifest v1.0 (no iteration fields) — backward-compat smoke test
 *     against the v1.1 schema (the Phase 1.5 fields are OPTIONAL so v1.0
 *     payloads must continue validating).
 *   - Manifest v1.1 (with iteration fields) — validates including
 *     iterationsAttempted, iterationBudget, lastSessionId.
 *   - Verdict with outcome='iterate-needed' + iterationsAttempted —
 *     validates.
 *   - Verdict with outcome='iteration-exhausted' + cause — validates the
 *     new Phase 1.5 outcome enum + diagnostic shape.
 *   - Verdict with an unknown outcome string — REJECTED.
 *
 * Bypasses Ajv's `format` keyword for `date-time` (we'd need ajv-formats
 * to enforce it strictly, but that's a follow-up; the structural shape
 * is what matters for the contract surface here).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import type { DispatchManifest, DispatchVerdict, ResumeSignal } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_DIR = resolve(__dirname, '..', '..', '..', 'spec', 'schemas');

function loadSchema(filename: string): object {
  return JSON.parse(readFileSync(resolve(SCHEMA_DIR, filename), 'utf-8'));
}

// Single Ajv instance with strict mode off (the schemas use `description`
// alongside `additionalProperties: false`, which is fine but strict mode
// would warn). allErrors:true so test failures list every mismatch at once.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateResumeSignal = ajv.compile(loadSchema('dispatch-resume-signal.v1.schema.json'));
const validateManifest = ajv.compile(loadSchema('dispatch-manifest.v1.schema.json'));
const validateVerdict = ajv.compile(loadSchema('dispatch-verdict.v1.schema.json'));

// ---------------------------------------------------------------------------
// dispatch-resume-signal.v1.schema.json
// ---------------------------------------------------------------------------

describe('dispatch-resume-signal.v1.schema.json', () => {
  const valid: ResumeSignal = {
    schemaVersion: 'v1',
    taskId: 'AISDLC-3300',
    feedback: 'verifier failed: 2 assertions in pipeline-cli/src/X.test.ts',
    triggeredAt: '2026-05-20T11:00:00.000Z',
    triggeredBy: 'conductor-session-abc123',
    priorIteration: 1,
    priorOutcome: 'iterate-needed',
  };

  it('validates a complete resume signal', () => {
    const ok = validateResumeSignal(valid);
    if (!ok) {
      const errs = (validateResumeSignal.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('\n  ');
      throw new Error(`schema rejected valid signal:\n  ${errs}`);
    }
    expect(ok).toBe(true);
  });

  it('validates a minimal resume signal (no optional fields)', () => {
    // priorIteration + priorOutcome are optional per the schema (Phase 1.5
    // only supports iterate-needed today, but the field is still nullable).
    const minimal: Partial<ResumeSignal> = {
      schemaVersion: 'v1',
      taskId: 'AISDLC-100',
      feedback: 'feedback text',
      triggeredAt: '2026-05-20T11:00:00.000Z',
      triggeredBy: 'conductor',
    };
    expect(validateResumeSignal(minimal)).toBe(true);
  });

  it('rejects a signal missing required `feedback`', () => {
    const invalid = { ...valid } as Partial<ResumeSignal>;
    delete invalid.feedback;
    expect(validateResumeSignal(invalid)).toBe(false);
  });

  it('rejects a signal missing required `taskId`', () => {
    const invalid = { ...valid } as Partial<ResumeSignal>;
    delete invalid.taskId;
    expect(validateResumeSignal(invalid)).toBe(false);
  });

  it('rejects a signal missing required `triggeredAt`', () => {
    const invalid = { ...valid } as Partial<ResumeSignal>;
    delete invalid.triggeredAt;
    expect(validateResumeSignal(invalid)).toBe(false);
  });

  it('rejects a signal with the wrong schemaVersion', () => {
    const invalid = { ...valid, schemaVersion: 'v2' };
    expect(validateResumeSignal(invalid)).toBe(false);
  });

  it('rejects a malformed taskId (does not match the pattern)', () => {
    const invalid = { ...valid, taskId: 'lowercase-bad' };
    expect(validateResumeSignal(invalid)).toBe(false);
  });

  it('rejects unknown top-level properties (additionalProperties:false)', () => {
    const invalid = { ...valid, rogue: 'extra' };
    expect(validateResumeSignal(invalid)).toBe(false);
  });

  it('rejects an empty feedback string (minLength:1)', () => {
    const invalid = { ...valid, feedback: '' };
    expect(validateResumeSignal(invalid)).toBe(false);
  });

  it('rejects priorOutcome other than iterate-needed (Phase 1.5 scope)', () => {
    const invalid = { ...valid, priorOutcome: 'success' };
    expect(validateResumeSignal(invalid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatch-manifest.v1.schema.json — Phase 1.5 backward compat
// ---------------------------------------------------------------------------

describe('dispatch-manifest.v1.schema.json (Phase 1.5 backward compat)', () => {
  // A pre-Phase-1.5 manifest payload — no iterationsAttempted /
  // iterationBudget / lastSessionId. MUST continue validating against the
  // v1.1 schema since all new fields are OPTIONAL.
  const manifestV10: DispatchManifest = {
    schemaVersion: 'v1',
    taskId: 'AISDLC-100',
    branch: 'ai-sdlc/aisdlc-100-feat',
    worktree: '.worktrees/aisdlc-100',
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: 'backlog/tasks/aisdlc-100 - feat.md',
      verifyCommands: ['pnpm build', 'pnpm test'],
    },
  };

  it('v1.0 manifest (no iteration fields) still validates', () => {
    const ok = validateManifest(manifestV10);
    if (!ok) {
      const errs = (validateManifest.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('\n  ');
      throw new Error(`v1.1 schema rejected v1.0 payload:\n  ${errs}`);
    }
    expect(ok).toBe(true);
  });

  it('v1.1 manifest with all Phase 1.5 fields validates', () => {
    const v11: DispatchManifest = {
      ...manifestV10,
      iterationsAttempted: 1,
      iterationBudget: 2,
      lastSessionId: 'abc-def-123',
    };
    expect(validateManifest(v11)).toBe(true);
  });

  it('rejects iterationsAttempted < 0', () => {
    const invalid = { ...manifestV10, iterationsAttempted: -1 };
    expect(validateManifest(invalid)).toBe(false);
  });

  it('rejects iterationBudget < 0', () => {
    const invalid = { ...manifestV10, iterationBudget: -1 };
    expect(validateManifest(invalid)).toBe(false);
  });

  it('rejects non-integer iterationsAttempted', () => {
    const invalid = { ...manifestV10, iterationsAttempted: 1.5 };
    expect(validateManifest(invalid)).toBe(false);
  });

  it('rejects empty lastSessionId (minLength:1)', () => {
    const invalid = { ...manifestV10, lastSessionId: '' };
    expect(validateManifest(invalid)).toBe(false);
  });

  it('rejects unknown top-level fields (additionalProperties:false)', () => {
    const invalid = { ...manifestV10, rogue: 'extra' };
    expect(validateManifest(invalid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatch-verdict.v1.schema.json — Phase 1.5 outcomes + iteration fields
// ---------------------------------------------------------------------------

describe('dispatch-verdict.v1.schema.json (Phase 1.5 outcomes + iteration fields)', () => {
  const verdictBase: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId: 'AISDLC-200',
    outcome: 'success',
    completedAt: '2026-05-20T10:30:00.000Z',
    workerId: 'worker-test-1',
  };

  it('v1.0 verdict (no iteration fields) still validates', () => {
    expect(validateVerdict(verdictBase)).toBe(true);
  });

  it('outcome=iterate-needed + iterationsAttempted validates', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      outcome: 'iterate-needed',
      iterationsAttempted: 1,
      notes: 'verifier failed: pnpm test 2 assertions',
    };
    expect(validateVerdict(v)).toBe(true);
  });

  it('outcome=iteration-exhausted + cause validates (Conductor escalation diagnostic)', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      outcome: 'iteration-exhausted',
      iterationsAttempted: 2,
      cause: 'iteration-budget-exhausted',
      notes: 'attempts=2 budget=2; Conductor refused to trigger further resume',
    };
    expect(validateVerdict(v)).toBe(true);
  });

  it('outcome=quota-exhausted + retryAfter validates', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      outcome: 'quota-exhausted',
      cause: 'quota-exhausted',
      retryAfter: 600,
    };
    expect(validateVerdict(v)).toBe(true);
  });

  it('verdict with sessionId (claude-p-shell capture) validates', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      outcome: 'success',
      sessionId: 'abc-def-123',
      workerKind: 'claude-p-shell',
    };
    expect(validateVerdict(v)).toBe(true);
  });

  it('rejects an unknown outcome string', () => {
    const v = { ...verdictBase, outcome: 'rocketscience' };
    expect(validateVerdict(v)).toBe(false);
  });

  it('rejects a missing required completedAt', () => {
    const v = { ...verdictBase } as Partial<DispatchVerdict>;
    delete v.completedAt;
    expect(validateVerdict(v)).toBe(false);
  });

  it('rejects iterationsAttempted < 0', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      outcome: 'iterate-needed',
      iterationsAttempted: -1,
    };
    expect(validateVerdict(v)).toBe(false);
  });

  it('rejects non-integer iterationsAttempted', () => {
    const v = {
      ...verdictBase,
      outcome: 'iterate-needed' as const,
      iterationsAttempted: 1.5,
    };
    expect(validateVerdict(v)).toBe(false);
  });

  it('rejects unknown top-level properties (additionalProperties:false)', () => {
    const v = { ...verdictBase, rogue: 'extra' };
    expect(validateVerdict(v)).toBe(false);
  });

  it('rejects an invalid verifications status value', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      verifications: {
        // @ts-expect-error — intentionally invalid for the schema-side test
        build: 'maybe',
      },
    };
    expect(validateVerdict(v)).toBe(false);
  });

  // AISDLC-493 — new lifecycle timestamp fields on the verdict.
  // Round-trip: accept when present (all four), accept when absent.
  it('accepts verdict with all four AISDLC-493 timing fields present', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      reviewerStartedAt: '2026-05-31T11:00:00.000Z',
      reviewerCompletedAt: '2026-05-31T11:05:00.000Z',
      signedAt: '2026-05-31T11:06:00.000Z',
      prOpenedAt: '2026-05-31T11:07:00.000Z',
    };
    const ok = validateVerdict(v);
    if (!ok) {
      const errs = (validateVerdict.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('\n  ');
      throw new Error(`schema rejected verdict with timing fields:\n  ${errs}`);
    }
    expect(ok).toBe(true);
  });

  it('accepts verdict without any AISDLC-493 timing fields (all optional)', () => {
    // verdictBase has none of the new timing fields — must still validate.
    expect(validateVerdict(verdictBase)).toBe(true);
  });

  it('accepts verdict with only signedAt populated (partial timing)', () => {
    const v: DispatchVerdict = {
      ...verdictBase,
      signedAt: '2026-05-31T11:06:00.000Z',
    };
    expect(validateVerdict(v)).toBe(true);
  });
});
