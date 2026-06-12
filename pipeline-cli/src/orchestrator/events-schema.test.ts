/**
 * Schema-validation tests for the orchestrator events stream
 * (RFC-0015 Phase 4 / AISDLC-169.4).
 *
 * Validates a representative event of each type emitted by the loop
 * + a synthetic WorkerStateTransition (forwarded from Phase 2 playbook
 * events) against `spec/schemas/orchestrator-events.v1.schema.json`.
 *
 * The intent is "if the loop emits it, the schema accepts it" — so the
 * downstream consumer contract (cli-status, future dashboard) is
 * locked in. New event types added by future RFC-0015 phases (or other
 * RFCs) extend the enum + add a representative sample here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import type { OrchestratorEvent } from './events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'spec',
  'schemas',
  'orchestrator-events.v1.schema.json',
);

// Schema declares `$schema: draft/2020-12` — use the Ajv2020 entry
// point which bundles the right meta-schema. `strict: false` permits
// the `format: 'date-time'` annotation without `ajv-formats` (we still
// assert every other constraint: required, additionalProperties, enum,
// type).
const ajv = new Ajv2020({ strict: false, allErrors: true });

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const validate = ajv.compile(schema);

function expectValid(event: OrchestratorEvent): void {
  const ok = validate(event);
  if (!ok) {
    const errs = (validate.errors ?? []).map((e: ErrorObject) => `${e.instancePath} ${e.message}`);
    throw new Error(
      `Schema rejected valid event: ${JSON.stringify(event)}\n  ${errs.join('\n  ')}`,
    );
  }
  expect(ok).toBe(true);
}

function expectInvalid(event: unknown): void {
  expect(validate(event)).toBe(false);
}

describe('orchestrator-events.v1.schema.json — accepts every emitted type', () => {
  const baseTs = '2026-05-02T00:00:00Z';
  const runId = 'd4e8c6a2-1234-5678-9abc-def012345678';

  it('accepts OrchestratorTick', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorTick',
      runId,
      tick: 1,
      candidates: 5,
      dispatched: 2,
    });
  });

  it('accepts OrchestratorDispatched', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorDispatched',
      taskId: 'AISDLC-169.4',
      runId,
      tick: 1,
    });
  });

  it('accepts OrchestratorCompleted', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorCompleted',
      taskId: 'AISDLC-169.4',
      runId,
      tick: 1,
      outcome: 'approved',
      prUrl: 'https://github.com/x/y/pull/42',
    });
  });

  it('accepts OrchestratorFailed', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorFailed',
      taskId: 'AISDLC-169.4',
      runId,
      tick: 1,
      mode: 'UnknownFailureMode',
      reason: 'synthetic verification failure',
      prUrl: null,
    });
  });

  it('accepts OrchestratorRecovered', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorRecovered',
      taskId: 'AISDLC-169.4',
      runId,
      tick: 1,
      mode: 'SecretScanBlocked',
      outcome: 'approved',
      prUrl: 'https://github.com/x/y/pull/42',
    });
  });

  it('accepts OrchestratorAwaitingExternal (Phase 3 reservation)', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorAwaitingExternal',
      taskId: 'AISDLC-200',
      runId,
      reason: 'awaiting npm-foo-2.0',
      context: { externalDepId: 'npm-foo-2.0', kind: 'npm-version' },
    });
  });

  it('accepts OrchestratorOrphanParent (AISDLC-175)', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorOrphanParent',
      taskId: 'AISDLC-70',
      runId,
      tick: 1,
      completedChildren: ['aisdlc-70.1', 'aisdlc-70.2', 'aisdlc-70.3'],
    });
  });

  it('accepts WorkerStateTransition (Phase 2 forensic forward)', () => {
    expectValid({
      ts: baseTs,
      type: 'WorkerStateTransition',
      taskId: 'AISDLC-169.4',
      workerId: 'w-aisdlc-169.4',
      runId,
      from: 'DEV_RUNNING',
      to: 'REVIEW_RUNNING',
      duration_ms: 612000,
      context: { verdicts_summary: '0c/0M/1m/2s' },
    });
  });

  it('accepts DeveloperContractRetry (AISDLC-176)', () => {
    expectValid({
      ts: baseTs,
      type: 'DeveloperContractRetry',
      taskId: 'AISDLC-176',
      runId,
      tick: 1,
      initialOutputPreview: 'Done. AISDLC-176 shipped — see git log.',
      retryDurationMs: 234,
      // AISDLC-196 — phase discriminator (initial-dispatch path).
      phase: 'initial',
    });
  });

  it('accepts DeveloperContractRetry with iteration-path discriminator (AISDLC-196)', () => {
    expectValid({
      ts: baseTs,
      type: 'DeveloperContractRetry',
      taskId: 'AISDLC-196',
      runId,
      tick: 1,
      initialOutputPreview: 'Sorry, no JSON envelope on iter 2.',
      retryDurationMs: 187,
      phase: 'iteration',
      iteration: 2,
    });
  });

  it('accepts OrchestratorRollback (AISDLC-177, no quarantine)', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorRollback',
      taskId: 'AISDLC-70',
      runId,
      tick: 1,
      fromStatus: 'To Do',
      toStatus: 'To Do',
      // AISDLC-186 — explicit per-side-effect boolean.
      statusReverted: true,
      worktreeRemoved: true,
      branchQuarantined: false,
    });
  });

  it('accepts OrchestratorRollback (AISDLC-177, with quarantine, AISDLC-186 ms-precision ref)', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorRollback',
      taskId: 'AISDLC-70',
      runId,
      tick: 1,
      fromStatus: 'To Do',
      toStatus: 'To Do',
      statusReverted: true,
      worktreeRemoved: true,
      branchQuarantined: true,
      quarantineRef: 'quarantine/aisdlc-70-2026-05-04T14-23-44-123',
    });
  });

  it('accepts OrchestratorRollback (AISDLC-186, partial — statusReverted=false)', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorRollback',
      taskId: 'AISDLC-70',
      runId,
      tick: 1,
      fromStatus: 'To Do',
      toStatus: 'To Do',
      // AISDLC-186 — task file disappeared between Step 4 and rollback;
      // event payload must report the partial state explicitly.
      statusReverted: false,
      worktreeRemoved: true,
      branchQuarantined: false,
    });
  });

  it('accepts OrchestratorWorkQuarantined (AISDLC-177)', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorWorkQuarantined',
      taskId: 'AISDLC-70',
      runId,
      tick: 1,
      branch: 'ai-sdlc/aisdlc-70',
      quarantineRef: 'quarantine/aisdlc-70-2026-05-04T14-23-44-123',
      commitSha: 'abc1234deadbeef',
      commitCount: 2,
    });
  });

  it('accepts WorktreeAutoCleaned (AISDLC-224)', () => {
    expectValid({
      ts: baseTs,
      type: 'WorktreeAutoCleaned',
      taskId: 'AISDLC-99',
      runId,
      tick: 1,
      branch: 'ai-sdlc/aisdlc-99',
      reason: 'branch already exists',
      hadOpenPR: false,
      hadUncommittedChanges: false,
    });
  });

  it('accepts the minimal envelope (only ts + type)', () => {
    expectValid({ ts: baseTs, type: 'OrchestratorTick' });
  });

  it('accepts TaskBlocked (AISDLC-223) with required fields only', () => {
    expectValid({
      ts: baseTs,
      type: 'TaskBlocked',
      taskId: 'AISDLC-115',
      runId,
      tick: 1,
      reason: 'Soaking — feature flag promotion gated on AISDLC-116 evidence',
    });
  });

  it('accepts TaskBlocked (AISDLC-223) with optional until field', () => {
    expectValid({
      ts: baseTs,
      type: 'TaskBlocked',
      taskId: 'AISDLC-115',
      runId,
      tick: 1,
      reason: 'Soaking — feature flag promotion gated on AISDLC-116 evidence',
      until: '2026-05-13',
    });
  });

  it('accepts OrchestratorWorktreeSwept (AISDLC-256)', () => {
    expectValid({
      ts: baseTs,
      type: 'OrchestratorWorktreeSwept',
      runId,
      tick: 1,
      worktreePath: '/home/op/.worktrees/aisdlc-256',
      branch: 'ai-sdlc/aisdlc-256',
      mergedAt: '2026-05-09T12:00:00Z',
    });
  });

  it('accepts EstimateCaptured (RFC-0016 Phase 2 / AISDLC-280)', () => {
    expectValid({
      ts: baseTs,
      type: 'EstimateCaptured',
      taskId: 'AISDLC-280',
      bucket: 'S',
      finalBucket: 'S',
      class: 'feature',
      estimateInputHash: 'sha256:' + 'a'.repeat(64),
      runIndex: 1,
      confidence: 'high',
      escalateToStageB: false,
    });
  });

  it('accepts EstimateInputChanged (RFC-0016 §8.4 / AISDLC-280)', () => {
    expectValid({
      ts: baseTs,
      type: 'EstimateInputChanged',
      taskId: 'AISDLC-280',
      oldHash: 'sha256:' + 'b'.repeat(64),
      newHash: 'sha256:' + 'c'.repeat(64),
    });
  });

  // AISDLC-493 — new event types. Doc-comment mandates one representative sample per type.
  it('accepts PrOpened (AISDLC-493) with required fields only', () => {
    expectValid({
      ts: baseTs,
      type: 'PrOpened',
      taskId: 'AISDLC-493',
      prUrl: 'https://github.com/org/repo/pull/909',
      prOpenedAt: '2026-05-31T10:00:00.000Z',
    });
  });

  it('accepts PrOpened (AISDLC-493) with optional runId', () => {
    expectValid({
      ts: baseTs,
      type: 'PrOpened',
      taskId: 'AISDLC-493',
      runId,
      prUrl: 'https://github.com/org/repo/pull/909',
      prOpenedAt: '2026-05-31T10:00:00.000Z',
    });
  });

  it('accepts ReconcileCompleted (AISDLC-493) with all fields', () => {
    expectValid({
      ts: baseTs,
      type: 'ReconcileCompleted',
      taskId: 'AISDLC-493',
      runId,
      prUrl: 'https://github.com/org/repo/pull/909',
      rebased: true,
      reSignCount: 1,
      reconcileDurationMs: 45_000,
    });
  });

  it('accepts ReconcileCompleted (AISDLC-493) without optional reconcileDurationMs', () => {
    // Minor #4 fix: reconcileDurationMs is optional — when timestamps are invalid
    // the aggregator receives no sample rather than a zero.
    expectValid({
      ts: baseTs,
      type: 'ReconcileCompleted',
      taskId: 'AISDLC-493',
      rebased: false,
      reSignCount: 0,
    });
  });

  it('accepts DispatchToMergeCompleted (AISDLC-493) with ciWaitMs', () => {
    expectValid({
      ts: baseTs,
      type: 'DispatchToMergeCompleted',
      taskId: 'AISDLC-493',
      runId,
      dispatchedAt: '2026-05-31T10:00:00.000Z',
      mergedAt: '2026-05-31T16:00:00.000Z',
      totalLifecycleMs: 21_600_000,
      ciWaitMs: 180_000,
    });
  });

  it('accepts DispatchToMergeCompleted (AISDLC-493) with ciWaitMs=null', () => {
    expectValid({
      ts: baseTs,
      type: 'DispatchToMergeCompleted',
      taskId: 'AISDLC-493',
      dispatchedAt: '2026-05-31T10:00:00.000Z',
      mergedAt: '2026-05-31T16:00:00.000Z',
      totalLifecycleMs: 21_600_000,
      ciWaitMs: null,
    });
  });
});

describe('orchestrator-events.v1.schema.json — rejects malformed events', () => {
  it('rejects events missing ts', () => {
    expectInvalid({ type: 'OrchestratorTick' });
  });

  it('rejects events missing type', () => {
    expectInvalid({ ts: '2026-05-02T00:00:00Z' });
  });

  it('rejects events with an unknown type', () => {
    expectInvalid({ ts: '2026-05-02T00:00:00Z', type: 'NotARealType' });
  });

  it('rejects events with negative duration_ms', () => {
    expectInvalid({
      ts: '2026-05-02T00:00:00Z',
      type: 'WorkerStateTransition',
      from: 'DEV_RUNNING',
      to: 'REVIEW_RUNNING',
      duration_ms: -1,
    });
  });

  it('rejects unknown top-level fields (additionalProperties: false)', () => {
    expectInvalid({
      ts: '2026-05-02T00:00:00Z',
      type: 'OrchestratorTick',
      bogusKey: 'should-be-rejected',
    });
  });
});
