/**
 * Stage B (LLM-backed evaluator) unit tests.
 *
 * RFC-0011 Phase 2b. These tests validate the orchestration layer ONLY
 * — they use `MockSpawner` to return canned per-gate JSON the way a
 * "calibrated LLM" would. Real-LLM accuracy is established in Phase 7
 * soak per RFC §12.
 */

import { describe, expect, it } from 'vitest';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import type { SpawnOpts, SubagentResult } from '../types.js';
import {
  STAGE_B_GATE_QUESTIONS,
  STAGE_B_OWNED_GATES,
  buildStageBPrompt,
  evaluateStageB,
  parseStageBResponse,
  pickStageBGates,
} from './stage-b.js';
import type { GateEvaluation, IssueInput, StageAVerdict } from './types.js';

function stageA(overrides: Partial<StageAVerdict> = {}): StageAVerdict {
  const base: StageAVerdict = {
    issueId: 'AISDLC-115.3',
    rubricVersion: 'v1',
    overallVerdict: 'admit',
    gates: defaultGates(),
    signedAt: '2026-05-01T00:00:00.000Z',
    evaluatorVersion: 'stage-a-test',
    summary: 'Stage A admit — all deterministic gates passed.',
    overallConfidence: 'medium',
    durationMs: 5,
    ...overrides,
  };
  return base;
}

function defaultGates(): GateEvaluation[] {
  return [
    { gateId: 1, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'medium' },
    { gateId: 2, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
    { gateId: 3, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
    { gateId: 4, verdict: 'skip', severity: 'block', stage: 'A', confidence: 'low' },
    { gateId: 5, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'medium' },
    { gateId: 6, verdict: 'skip', severity: 'block', stage: 'A', confidence: 'low' },
    { gateId: 7, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'medium' },
  ];
}

function input(): IssueInput {
  return {
    source: 'backlog',
    id: 'AISDLC-115.3',
    title: 'Phase 2b refinement reviewer',
    body: '## Description\nAdd Stage B.\n\n## Acceptance Criteria\n- [ ] #1 Stage B works\n',
  };
}

describe('pickStageBGates', () => {
  it('always includes the Stage-B-owned gates (4, 6)', () => {
    const ids = pickStageBGates(stageA());
    expect(ids).toContain(4);
    expect(ids).toContain(6);
  });

  it('includes Stage A passes that are not high-confidence', () => {
    const ids = pickStageBGates(stageA());
    // Default gates 1, 5, 7 are pass+medium → included
    expect(ids).toContain(1);
    expect(ids).toContain(5);
    expect(ids).toContain(7);
  });

  it('excludes Stage A high-confidence passes', () => {
    const ids = pickStageBGates(stageA());
    // Gates 2 + 3 are pass+high in defaults
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
  });

  it('excludes gates Stage A blocked on definitively', () => {
    const sa = stageA({
      overallVerdict: 'needs-clarification',
      gates: [
        ...defaultGates().slice(0, 1),
        { gateId: 2, verdict: 'fail', severity: 'block', stage: 'A', confidence: 'high' },
        ...defaultGates().slice(2),
      ],
    });
    const ids = pickStageBGates(sa);
    expect(ids).not.toContain(2);
  });

  it('returns gate IDs in ascending order', () => {
    const ids = pickStageBGates(stageA());
    const sorted = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sorted);
  });

  it('exposes STAGE_B_OWNED_GATES with gates 4 and 6', () => {
    expect([...STAGE_B_OWNED_GATES]).toEqual([4, 6]);
  });
});

describe('buildStageBPrompt', () => {
  it('embeds issue id, title, and body', () => {
    const p = buildStageBPrompt(input(), stageA(), [4, 6]);
    expect(p).toContain('AISDLC-115.3');
    expect(p).toContain('Phase 2b refinement reviewer');
    expect(p).toContain('Stage B works');
  });

  it('embeds Stage A overall verdict + summary', () => {
    const p = buildStageBPrompt(input(), stageA(), [4, 6]);
    expect(p).toMatch(/Overall:.*admit/);
    expect(p).toMatch(/Stage A admit/);
  });

  it('emits a per-gate question block for every requested gate', () => {
    const p = buildStageBPrompt(input(), stageA(), [4, 6]);
    expect(p).toContain('### Gate 4');
    expect(p).toContain('### Gate 6');
    expect(p).toContain(STAGE_B_GATE_QUESTIONS[4]);
    expect(p).toContain(STAGE_B_GATE_QUESTIONS[6]);
  });

  it('includes the Stage A finding for each gate (or "(none)")', () => {
    const sa = stageA({
      gates: [
        ...defaultGates().slice(0, 3),
        {
          gateId: 4,
          verdict: 'skip',
          severity: 'block',
          stage: 'A',
          confidence: 'low',
          finding: 'Soft heuristic: body=300 lines',
        },
        ...defaultGates().slice(4),
      ],
    });
    const p = buildStageBPrompt(input(), sa, [4, 6]);
    expect(p).toContain('Soft heuristic: body=300 lines');
    expect(p).toMatch(/Stage A finding: \(none\)/);
  });

  it('mentions JSON output format and the high|medium|low confidence tiering', () => {
    const p = buildStageBPrompt(input(), stageA(), [4, 6]);
    expect(p).toContain('JSON');
    expect(p).toContain('high');
    expect(p).toContain('medium');
    expect(p).toContain('low');
  });
});

describe('parseStageBResponse', () => {
  it('parses plain JSON', () => {
    const got = parseStageBResponse(
      '{"gates":[{"gateId":4,"verdict":"pass","confidence":"high"}]}',
    );
    expect(got?.gates).toHaveLength(1);
    expect(got?.gates[0].gateId).toBe(4);
  });

  it('strips a ```json fence', () => {
    const wrapped = '```json\n{"gates":[{"gateId":6,"verdict":"fail","confidence":"medium"}]}\n```';
    const got = parseStageBResponse(wrapped);
    expect(got?.gates[0].gateId).toBe(6);
    expect(got?.gates[0].verdict).toBe('fail');
  });

  it('strips an unlabelled ``` fence', () => {
    const wrapped = '```\n{"gates":[{"gateId":4,"verdict":"pass","confidence":"high"}]}\n```';
    const got = parseStageBResponse(wrapped);
    expect(got?.gates[0].gateId).toBe(4);
  });

  it('returns null on malformed JSON', () => {
    expect(parseStageBResponse('not json at all')).toBeNull();
    expect(parseStageBResponse('{"gates":[}')).toBeNull();
  });

  it('returns null on empty / non-string input', () => {
    expect(parseStageBResponse('')).toBeNull();
    expect(parseStageBResponse(null as unknown as string)).toBeNull();
  });

  it('returns null when gateId is out of range', () => {
    expect(
      parseStageBResponse('{"gates":[{"gateId":99,"verdict":"pass","confidence":"high"}]}'),
    ).toBeNull();
  });

  it('returns null when verdict / confidence is bogus', () => {
    expect(
      parseStageBResponse('{"gates":[{"gateId":4,"verdict":"maybe","confidence":"high"}]}'),
    ).toBeNull();
    expect(
      parseStageBResponse('{"gates":[{"gateId":4,"verdict":"pass","confidence":"unknown"}]}'),
    ).toBeNull();
  });

  it('returns null when gates is missing', () => {
    expect(parseStageBResponse('{"summary":"hi"}')).toBeNull();
  });

  it('keeps optional summary field', () => {
    const got = parseStageBResponse(
      '{"gates":[{"gateId":4,"verdict":"pass","confidence":"high"}],"summary":"all good"}',
    );
    expect(got?.summary).toBe('all good');
  });
});

describe('evaluateStageB', () => {
  function spawnerReturning(payload: unknown): MockSpawner {
    return new MockSpawner({
      'refinement-reviewer': (): SubagentResult => ({
        type: 'refinement-reviewer',
        output: typeof payload === 'string' ? payload : JSON.stringify(payload),
        status: 'success',
        durationMs: 10,
      }),
    });
  }

  it('returns per-gate evaluations for the requested set', async () => {
    const spawner = spawnerReturning({
      gates: [
        { gateId: 4, verdict: 'fail', confidence: 'high', finding: 'multi-PR' },
        { gateId: 6, verdict: 'pass', confidence: 'medium', finding: 'AC describes done' },
      ],
      summary: 'mixed',
    });
    const result = await evaluateStageB(input(), stageA({ gates: minimalSkipGates() }), {
      spawner,
      gates: [4, 6],
    });

    const g4 = result.gateEvaluations.get(4)!;
    expect(g4.verdict).toBe('fail');
    expect(g4.stage).toBe('B');
    expect(g4.confidence).toBe('high');
    const g6 = result.gateEvaluations.get(6)!;
    expect(g6.verdict).toBe('pass');
    expect(g6.confidence).toBe('medium');
    expect(result.summary).toBe('mixed');
  });

  it('falls back to skip+low when the spawner errors', async () => {
    const spawner = new MockSpawner({
      'refinement-reviewer': (): SubagentResult => ({
        type: 'refinement-reviewer',
        output: '',
        status: 'error',
        error: 'boom',
        durationMs: 1,
      }),
    });
    const result = await evaluateStageB(input(), stageA(), { spawner, gates: [4] });
    const g4 = result.gateEvaluations.get(4)!;
    expect(g4.verdict).toBe('skip');
    expect(g4.confidence).toBe('low');
    expect(g4.stage).toBe('B');
  });

  it('falls back to skip+low when output is unparseable', async () => {
    const spawner = spawnerReturning('not json');
    const result = await evaluateStageB(input(), stageA(), { spawner, gates: [4, 6] });
    expect(result.gateEvaluations.get(4)?.verdict).toBe('skip');
    expect(result.gateEvaluations.get(6)?.verdict).toBe('skip');
  });

  it('ignores stray gateIds that were not requested', async () => {
    const spawner = spawnerReturning({
      gates: [
        { gateId: 4, verdict: 'pass', confidence: 'high' },
        { gateId: 99 as unknown as number, verdict: 'fail', confidence: 'high' }, // bad — parser rejects whole payload
      ],
    });
    // Whole payload rejected because 99 is out of range → all gates skip.
    const result = await evaluateStageB(input(), stageA(), { spawner, gates: [4] });
    expect(result.gateEvaluations.get(4)?.verdict).toBe('skip');
  });

  it('only emits agent calls with type=refinement-reviewer', async () => {
    let captured: SpawnOpts | undefined;
    const spawner = new MockSpawner({
      'refinement-reviewer': (opts): SubagentResult => {
        captured = opts;
        return {
          type: 'refinement-reviewer',
          output: '{"gates":[{"gateId":4,"verdict":"pass","confidence":"high"}]}',
          status: 'success',
          durationMs: 1,
        };
      },
    });
    await evaluateStageB(input(), stageA(), { spawner, gates: [4] });
    expect(captured?.type).toBe('refinement-reviewer');
    expect(captured?.prompt).toContain('Gate 4');
  });

  it('forwards timeout when provided', async () => {
    let captured: SpawnOpts | undefined;
    const spawner = new MockSpawner({
      'refinement-reviewer': (opts): SubagentResult => {
        captured = opts;
        return {
          type: 'refinement-reviewer',
          output: '{"gates":[]}',
          status: 'success',
          durationMs: 0,
        };
      },
    });
    await evaluateStageB(input(), stageA(), { spawner, gates: [4], timeoutMs: 60000 });
    expect(captured?.timeout).toBe(60000);
  });

  it('uses pickStageBGates when opts.gates is omitted', async () => {
    let capturedPrompt = '';
    const spawner = new MockSpawner({
      'refinement-reviewer': (opts): SubagentResult => {
        capturedPrompt = opts.prompt;
        return {
          type: 'refinement-reviewer',
          output: '{"gates":[]}',
          status: 'success',
          durationMs: 0,
        };
      },
    });
    await evaluateStageB(input(), stageA(), { spawner });
    // pickStageBGates returns [1,4,5,6,7] for the default StageA fixture
    expect(capturedPrompt).toContain('### Gate 4');
    expect(capturedPrompt).toContain('### Gate 6');
    expect(capturedPrompt).toContain('### Gate 1');
  });
});

function minimalSkipGates(): GateEvaluation[] {
  return [
    { gateId: 4, verdict: 'skip', severity: 'block', stage: 'A', confidence: 'low' },
    { gateId: 6, verdict: 'skip', severity: 'block', stage: 'A', confidence: 'low' },
  ];
}
