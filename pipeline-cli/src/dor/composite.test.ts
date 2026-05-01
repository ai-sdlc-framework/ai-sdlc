/**
 * Composite Stage A + Stage B evaluator unit tests.
 *
 * RFC-0011 Phase 2b. Validates the merge / aggregation logic — the
 * deterministic core of the pipeline. Stage B is mocked via
 * MockSpawner; real-LLM behavior is out of scope here (Phase 7 soak
 * per RFC §12).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import {
  aggregateConfidence,
  chooseWinner,
  evaluateIssueE2E,
  mergeVerdicts,
  stripDurationMs,
} from './composite.js';
import type { StageBResult } from './stage-b.js';
import type { GateEvaluation, GateId, IssueInput, StageAVerdict } from './types.js';

function gate(
  id: GateId,
  verdict: 'pass' | 'fail' | 'skip',
  confidence: 'high' | 'medium' | 'low',
  stage: 'A' | 'B' = 'A',
  finding?: string,
  clarificationQuestion?: string,
): GateEvaluation {
  return {
    gateId: id,
    verdict,
    severity: 'block',
    stage,
    confidence,
    finding,
    clarificationQuestion,
  };
}

function fixedDate(): Date {
  return new Date('2026-05-01T12:00:00.000Z');
}

const READY_BODY = [
  '## Description',
  'Add a new flag to `pipeline-cli/src/cli/index.ts`.',
  '',
  '## Acceptance Criteria',
  '- [ ] #1 `pipeline-cli/src/cli/index.ts` accepts the flag',
  '- [ ] #2 README documents the flag',
].join('\n');

function readyInput(): IssueInput {
  return {
    source: 'backlog',
    id: 'AISDLC-test',
    title: 'Add CLI flag',
    body: READY_BODY,
  };
}

describe('chooseWinner', () => {
  it('Stage A wins when it produced a high-confidence block', () => {
    const a = gate(2, 'fail', 'high', 'A', 'TBD detected');
    const b = gate(2, 'pass', 'medium', 'B');
    expect(chooseWinner(a, b)).toBe(a);
  });

  it('Stage B wins for medium-confidence Stage A passes', () => {
    const a = gate(1, 'pass', 'medium', 'A');
    const b = gate(1, 'fail', 'high', 'B', 'AC not testable');
    expect(chooseWinner(a, b)).toBe(b);
  });

  it('Stage B wins for Stage A skips (gate 4/6)', () => {
    const a = gate(4, 'skip', 'low', 'A');
    const b = gate(4, 'fail', 'high', 'B', 'multi-PR scope');
    expect(chooseWinner(a, b)).toBe(b);
  });

  it('Stage A wins when Stage B skipped (parse failure / spawner error)', () => {
    const a = gate(1, 'pass', 'medium', 'A');
    const b = gate(1, 'skip', 'low', 'B');
    expect(chooseWinner(a, b)).toBe(a);
  });

  it('keeps Stage B skip when both stages skipped (preserves the floor)', () => {
    const a = gate(4, 'skip', 'low', 'A');
    const b = gate(4, 'skip', 'low', 'B');
    expect(chooseWinner(a, b)).toBe(b);
  });
});

describe('aggregateConfidence', () => {
  it('returns high when all contributing gates are high', () => {
    const gates = [gate(1, 'pass', 'high'), gate(2, 'pass', 'high')];
    expect(aggregateConfidence(gates)).toBe('high');
  });

  it('returns medium when at least one contributing gate is medium', () => {
    const gates = [gate(1, 'pass', 'high'), gate(2, 'pass', 'medium')];
    expect(aggregateConfidence(gates)).toBe('medium');
  });

  it('returns low when any contributing gate is low', () => {
    const gates = [gate(1, 'pass', 'high'), gate(2, 'pass', 'low')];
    expect(aggregateConfidence(gates)).toBe('low');
  });

  it('skips Stage A skip verdicts when computing the floor', () => {
    const gates = [gate(1, 'pass', 'high'), gate(4, 'skip', 'low')];
    expect(aggregateConfidence(gates)).toBe('high');
  });

  it('returns high when blocking gates are all high', () => {
    const gates = [gate(1, 'fail', 'high'), gate(2, 'pass', 'high')];
    expect(aggregateConfidence(gates)).toBe('high');
  });

  it('returns medium when blocking gates are mixed high/medium', () => {
    const gates = [gate(1, 'fail', 'medium'), gate(2, 'pass', 'high')];
    expect(aggregateConfidence(gates)).toBe('medium');
  });

  it('returns low when any blocking gate is low', () => {
    const gates = [gate(1, 'fail', 'low'), gate(2, 'pass', 'high')];
    expect(aggregateConfidence(gates)).toBe('low');
  });

  it('returns low when there are no contributing gates at all', () => {
    const gates = [gate(4, 'skip', 'low'), gate(6, 'skip', 'low')];
    expect(aggregateConfidence(gates)).toBe('low');
  });
});

function stageAFixture(overrides: Partial<StageAVerdict> = {}): StageAVerdict {
  return {
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'admit',
    gates: [
      gate(1, 'pass', 'medium'),
      gate(2, 'pass', 'high'),
      gate(3, 'pass', 'high'),
      gate(4, 'skip', 'low'),
      gate(5, 'pass', 'medium'),
      gate(6, 'skip', 'low'),
      gate(7, 'pass', 'medium'),
    ],
    signedAt: fixedDate().toISOString(),
    evaluatorVersion: 'stage-a-test',
    summary: 'Stage A admit — all deterministic gates passed.',
    overallConfidence: 'medium',
    durationMs: 5,
    ...overrides,
  };
}

function stageBFixture(map: Partial<Record<GateId, GateEvaluation>>): StageBResult {
  const gateEvaluations = new Map<GateId, GateEvaluation>();
  for (const [k, v] of Object.entries(map)) {
    if (v) gateEvaluations.set(Number(k) as GateId, v);
  }
  return {
    gateEvaluations,
    raw: { type: 'refinement-reviewer', output: '', status: 'success', durationMs: 0 },
  };
}

describe('mergeVerdicts', () => {
  it('admits when Stage A admits and Stage B passes 4 + 6', () => {
    const a = stageAFixture();
    const b = stageBFixture({
      4: gate(4, 'pass', 'high', 'B'),
      6: gate(6, 'pass', 'high', 'B'),
    });
    const v = mergeVerdicts(a, b);
    expect(v.overallVerdict).toBe('admit');
    expect(v.rubricVersion).toBe('v1');
  });

  it('flips to needs-clarification when Stage B fails an owned gate', () => {
    const a = stageAFixture();
    const b = stageBFixture({
      4: gate(4, 'fail', 'high', 'B', 'multi-PR scope', 'Split the issue.'),
      6: gate(6, 'pass', 'high', 'B'),
    });
    const v = mergeVerdicts(a, b);
    expect(v.overallVerdict).toBe('needs-clarification');
    const failed = v.gates.find((g) => g.gateId === 4);
    expect(failed?.verdict).toBe('fail');
    expect(failed?.stage).toBe('B');
    expect(v.questions).toContain('Split the issue.');
  });

  it('preserves Stage A high-confidence blocks even when Stage B disagrees', () => {
    const a = stageAFixture({
      overallVerdict: 'needs-clarification',
      gates: [
        gate(1, 'pass', 'medium'),
        gate(2, 'fail', 'high', 'A', 'TBD found', 'Resolve TBD'),
        gate(3, 'pass', 'high'),
        gate(4, 'skip', 'low'),
        gate(5, 'pass', 'medium'),
        gate(6, 'skip', 'low'),
        gate(7, 'pass', 'medium'),
      ],
    });
    // Even if Stage B somehow returned a verdict for gate 2, the merge
    // never asks it to (gate 2 is not in pickStageBGates for a fail).
    // But verify the chooseWinner rule directly: A high-fail wins.
    const b = stageBFixture({
      2: gate(2, 'pass', 'high', 'B'),
      4: gate(4, 'pass', 'high', 'B'),
      6: gate(6, 'pass', 'high', 'B'),
    });
    const v = mergeVerdicts(a, b);
    const g2 = v.gates.find((g) => g.gateId === 2)!;
    expect(g2.verdict).toBe('fail');
    expect(g2.stage).toBe('A');
    expect(v.overallVerdict).toBe('needs-clarification');
  });

  it('falls back to Stage A finding when Stage B returns skip', () => {
    const a = stageAFixture({
      gates: [
        gate(1, 'pass', 'medium'),
        gate(2, 'pass', 'high'),
        gate(3, 'pass', 'high'),
        gate(4, 'skip', 'low'),
        gate(5, 'pass', 'high', 'A', 'Stage A found surface'),
        gate(6, 'skip', 'low'),
        gate(7, 'pass', 'medium'),
      ],
    });
    const b = stageBFixture({
      4: gate(4, 'pass', 'high', 'B'),
      6: gate(6, 'pass', 'high', 'B'),
      // gate 5 not in B map → preserved as A
    });
    const v = mergeVerdicts(a, b);
    expect(v.gates.find((g) => g.gateId === 5)?.stage).toBe('A');
  });

  it('uses Stage B summary when provided', () => {
    const a = stageAFixture();
    const b = stageBFixture({
      4: gate(4, 'pass', 'high', 'B'),
      6: gate(6, 'pass', 'high', 'B'),
    });
    b.summary = 'LLM says all good';
    const v = mergeVerdicts(a, b);
    expect(v.summary).toBe('LLM says all good');
  });

  it('builds an aggregate summary when Stage B did not provide one', () => {
    const a = stageAFixture();
    const b = stageBFixture({
      4: gate(4, 'fail', 'high', 'B', 'too big'),
      6: gate(6, 'pass', 'high', 'B'),
    });
    const v = mergeVerdicts(a, b);
    expect(v.summary).toContain('Gate 4');
  });

  it('strips internal durationMs by virtue of constructing a RefinementVerdict', () => {
    const a = stageAFixture();
    const b = stageBFixture({
      4: gate(4, 'pass', 'high', 'B'),
      6: gate(6, 'pass', 'high', 'B'),
    });
    const v = mergeVerdicts(a, b);
    expect((v as unknown as { durationMs?: number }).durationMs).toBeUndefined();
  });
});

describe('stripDurationMs', () => {
  it('removes durationMs and pins rubricVersion to v1', () => {
    const a = stageAFixture({ durationMs: 99 });
    const v = stripDurationMs(a);
    expect((v as unknown as { durationMs?: number }).durationMs).toBeUndefined();
    expect(v.rubricVersion).toBe('v1');
  });
});

describe('evaluateIssueE2E', () => {
  it('returns Stage A only (schema-shaped) when no Stage B opts provided', async () => {
    const stub = mkdtempSync(join(tmpdir(), 'dor-e2e-stub-'));
    try {
      const v = await evaluateIssueE2E(readyInput(), {
        hermetic: true,
        now: () => fixedDate(),
        evaluatorVersion: 'stage-a-test',
      });
      expect(v.rubricVersion).toBe('v1');
      expect((v as unknown as { durationMs?: number }).durationMs).toBeUndefined();
      // Even without Stage B, the gate 4 + 6 verdicts remain skipped from Stage A
      expect(v.gates.find((g) => g.gateId === 4)?.verdict).toBe('skip');
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it('runs Stage B via the spawner when provided', async () => {
    const spawner = new MockSpawner({
      'refinement-reviewer': () => ({
        type: 'refinement-reviewer',
        output: JSON.stringify({
          gates: [
            { gateId: 1, verdict: 'pass', confidence: 'high', finding: 'AC ok' },
            {
              gateId: 4,
              verdict: 'fail',
              confidence: 'high',
              finding: 'too big',
              clarificationQuestion: 'Split it',
            },
            { gateId: 5, verdict: 'pass', confidence: 'high', finding: 'surface ok' },
            { gateId: 6, verdict: 'pass', confidence: 'high', finding: 'done-state ok' },
            { gateId: 7, verdict: 'pass', confidence: 'high', finding: 'no deps' },
          ],
          summary: 'Composite verdict',
        }),
        status: 'success',
        durationMs: 50,
      }),
    });
    const v = await evaluateIssueE2E(readyInput(), {
      hermetic: true,
      stageB: { spawner },
    });
    expect(v.overallVerdict).toBe('needs-clarification');
    expect(v.gates.find((g) => g.gateId === 4)?.stage).toBe('B');
    expect(v.summary).toBe('Composite verdict');
    expect(v.questions).toContain('Split it');
    expect(spawner.getCallCount('refinement-reviewer')).toBe(1);
  });
});
