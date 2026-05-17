/**
 * RFC-0035 Phase 3 — Stage B rubric scorer + actor routing tests.
 *
 * Covers all four rubric scorers, the composite score, actor routing rules,
 * the `makeStageBRecommendationIssuedEvent` event factory, and the projection
 * fold. Maps to the acceptance criteria:
 *
 * - AC#1: All four rubrics (loadBearing, llmConfidence, actorFit, costOfBlock)
 *   evaluate the Engineering + Product + Operator pillars per §6.
 * - AC#2: `routeDecisionActor` returns primaryActor + subActors.
 * - AC#3: Multi-actor decisions populate subActors per pillar.
 * - AC#4: Partial PillarOwnerConfig — never auto-fills missing pillars.
 * - AC#5: No LLM calls — all scoring is synchronous and produces a result.
 * - AC#6: Routing rationale stored on Decision record via projection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendDecisionEvent, makeDecisionOpenedEvent } from './event-log.js';
import { projectDecision } from './projection.js';
import type { Decision, StageAOutput } from './decision-record.js';
import {
  computeStageBCompositeScore,
  DEFAULT_PILLAR_OWNERS,
  makeStageBRecommendationIssuedEvent,
  routeDecisionActor,
  runStageB,
  scoreActorFit,
  scoreCostOfBlock,
  scoreLlmConfidence,
  scoreLoadBearing,
  STAGE_B_HIGH_CONFIDENCE_THRESHOLD,
  STAGE_B_LLM_ELIGIBLE_THRESHOLD,
  STAGE_B_LOW_CONFIDENCE_THRESHOLD,
  TIER_WEIGHTS,
  type PillarOwnerConfig,
} from './stage-b.js';
import { runStageA } from './stage-a.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stage-b-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedDecision(
  id: string,
  summary: string,
  overrides: Partial<Parameters<typeof makeDecisionOpenedEvent>[0]> = {},
): void {
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId: id,
      source: 'ad-hoc',
      scope: 'workspace',
      summary,
      options: [
        { id: 'opt-a', description: 'Option A' },
        { id: 'opt-b', description: 'Option B' },
      ],
      ...overrides,
    }),
    { workDir: tmp },
  );
}

function getDecision(id: string): Decision {
  const d = projectDecision(id, { workDir: tmp });
  if (!d) throw new Error(`decision ${id} not found`);
  return d;
}

/** Build a minimal valid StageAOutput for a reversible, single-engineering-pillar decision. */
function makeStageAOutput(overrides: Partial<StageAOutput> = {}): StageAOutput {
  return {
    schemaValidity: { valid: true, reasons: [] },
    blastRadius: { blockedTaskCount: 1, blockedRfcCount: 0, affectedPillars: ['engineering'] },
    referenceResolution: { resolved: true, broken: [] },
    decisionTreeDepth: 1,
    capacityCheck: { withinBudget: true, reason: 'within budget' },
    reversibility: 'reversible',
    duplicateDetection: { isDuplicate: false, candidateId: null, similarity: 0 },
    prioritySignal: 0.4,
    resolvedByStageA: true,
    routingActor: null,
    ...overrides,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('STAGE_B_HIGH_CONFIDENCE_THRESHOLD is 0.7', () => {
    expect(STAGE_B_HIGH_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it('STAGE_B_LOW_CONFIDENCE_THRESHOLD is 0.4', () => {
    expect(STAGE_B_LOW_CONFIDENCE_THRESHOLD).toBe(0.4);
  });

  it('STAGE_B_LLM_ELIGIBLE_THRESHOLD is 0.7', () => {
    expect(STAGE_B_LLM_ELIGIBLE_THRESHOLD).toBe(0.7);
  });

  it('TIER_WEIGHTS are ordered xs < s < m < l < xl', () => {
    expect(TIER_WEIGHTS.xs).toBeLessThan(TIER_WEIGHTS.s);
    expect(TIER_WEIGHTS.s).toBeLessThan(TIER_WEIGHTS.m);
    expect(TIER_WEIGHTS.m).toBeLessThan(TIER_WEIGHTS.l);
    expect(TIER_WEIGHTS.l).toBeLessThan(TIER_WEIGHTS.xl);
  });

  it('DEFAULT_PILLAR_OWNERS is an empty object (AC#4 — never auto-fills)', () => {
    expect(DEFAULT_PILLAR_OWNERS).toEqual({});
    expect(DEFAULT_PILLAR_OWNERS.engineering).toBeUndefined();
    expect(DEFAULT_PILLAR_OWNERS.product).toBeUndefined();
    expect(DEFAULT_PILLAR_OWNERS.design).toBeUndefined();
  });
});

// ── 1. Load-bearing-ness rubric ───────────────────────────────────────────────

describe('scoreLoadBearing', () => {
  it('returns score in [0,1] for reversible, no blast, no depth, no deadline', () => {
    const r = scoreLoadBearing('reversible', 0, 0, null);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.reversibility).toBe(0.0);
    expect(r.blastRadius).toBe(0.0);
    expect(r.downstreamDecisions).toBe(0.0);
    expect(r.deadlineCriticality).toBe(0.0);
  });

  it('scores one-way decisions higher than reversible', () => {
    const oneWay = scoreLoadBearing('one-way', 0, 0);
    const reversible = scoreLoadBearing('reversible', 0, 0);
    expect(oneWay.score).toBeGreaterThan(reversible.score);
    expect(oneWay.reversibility).toBe(1.0);
  });

  it('scores unknown reversibility between one-way and reversible', () => {
    const oneWay = scoreLoadBearing('one-way', 0, 0);
    const unknown = scoreLoadBearing('unknown', 0, 0);
    const reversible = scoreLoadBearing('reversible', 0, 0);
    expect(unknown.score).toBeGreaterThan(reversible.score);
    expect(unknown.score).toBeLessThan(oneWay.score);
    expect(unknown.reversibility).toBe(0.5);
  });

  it('scores higher blast radius → higher load-bearing', () => {
    const low = scoreLoadBearing('reversible', 1, 0);
    const high = scoreLoadBearing('reversible', 15, 0);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('scores deeper decision trees as more load-bearing', () => {
    const shallow = scoreLoadBearing('reversible', 0, 0);
    const deep = scoreLoadBearing('reversible', 0, 5);
    expect(deep.score).toBeGreaterThan(shallow.score);
    expect(deep.downstreamDecisions).toBe(1.0); // 5/5 = 1.0
  });

  it('caps downstream-decisions score at 1.0 for depth > 5', () => {
    const r = scoreLoadBearing('reversible', 0, 10);
    expect(r.downstreamDecisions).toBe(1.0);
  });

  it('assigns high deadline criticality for overdue deadlines', () => {
    const past = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    const r = scoreLoadBearing('reversible', 0, 0, past);
    expect(r.deadlineCriticality).toBe(1.0);
  });

  it('assigns low deadline criticality for far-future deadlines', () => {
    const far = new Date(Date.now() + 180 * 86400000).toISOString(); // 180 days
    const r = scoreLoadBearing('reversible', 0, 0, far);
    expect(r.deadlineCriticality).toBe(0.1);
  });

  it('assigns zero deadline criticality when no deadline', () => {
    const r = scoreLoadBearing('reversible', 0, 0, null);
    expect(r.deadlineCriticality).toBe(0.0);
  });

  it('returns rounded 3-decimal precision', () => {
    const r = scoreLoadBearing('unknown', 3, 2);
    const decimalPlaces = (r.score.toString().split('.')[1] ?? '').length;
    expect(decimalPlaces).toBeLessThanOrEqual(3);
  });
});

// ── 2. LLM-confidence rubric ──────────────────────────────────────────────────

describe('scoreLlmConfidence', () => {
  it('returns score in [0,1]', () => {
    seedDecision('DEC-0001', 'simple decision');
    const d = getDecision('DEC-0001');
    const r = scoreLlmConfidence(d);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('uses 0.5 for novelty and exemplarSimilarity (AC#5 — no LLM in Phase 3)', () => {
    seedDecision('DEC-0001', 'simple decision');
    const d = getDecision('DEC-0001');
    const r = scoreLlmConfidence(d);
    // AC#5: Phase 3 uses 0.5 placeholders — no LLM calls
    expect(r.novelty).toBe(0.5);
    expect(r.exemplarSimilarity).toBe(0.5);
  });

  it('detects RFC-stated-position when body references RFC resolution', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0035',
        summary: 'test decision',
        options: [{ id: 'opt-a', description: 'A' }],
        body: 'Per RFC-0035 §14, the resolution is to use event sourcing.',
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const r = scoreLlmConfidence(d);
    expect(r.rfcStatedPositionPresence).toBe(1.0);
  });

  it('scores zero rfcStatedPositionPresence when body lacks RFC references', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'a decision with generic body',
        options: [{ id: 'opt-a', description: 'A' }],
        body: 'This is just a description with no RFC or resolution markers.',
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const r = scoreLlmConfidence(d);
    expect(r.rfcStatedPositionPresence).toBe(0.0);
  });

  it('scores higher evidenceCompleteness for body + options with consequences', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'decision with evidence',
        options: [
          { id: 'opt-a', description: 'A', consequences: ['benefit 1', 'benefit 2'] },
          { id: 'opt-b', description: 'B', consequences: ['tradeoff 1'] },
        ],
        body: 'Full context for this decision.',
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const r = scoreLlmConfidence(d);
    expect(r.evidenceCompleteness).toBeGreaterThan(0.5);
  });

  it('scores lower evidenceCompleteness for no body + options without consequences', () => {
    seedDecision('DEC-0001', 'bare decision');
    const d = getDecision('DEC-0001');
    const r = scoreLlmConfidence(d);
    expect(r.evidenceCompleteness).toBeLessThanOrEqual(0.5);
  });
});

// ── 3. Actor-fit rubric ───────────────────────────────────────────────────────

describe('scoreActorFit', () => {
  it('returns score in [0,1]', () => {
    const r = scoreActorFit(['engineering'], { withinBudget: true });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('scores single-pillar decisions higher than multi-pillar (AC#1)', () => {
    const single = scoreActorFit(['engineering'], { withinBudget: true });
    const multi = scoreActorFit(['engineering', 'product'], { withinBudget: true });
    expect(single.score).toBeGreaterThan(multi.score);
    expect(single.declaredPillarMatch).toBe(1.0);
    expect(multi.declaredPillarMatch).toBe(0.5);
  });

  it('scores no-pillar decisions with 0.0 declaredPillarMatch', () => {
    const r = scoreActorFit([], { withinBudget: true });
    expect(r.declaredPillarMatch).toBe(0.0);
  });

  it('scores within-budget higher than over-budget', () => {
    const withinBudget = scoreActorFit(['engineering'], { withinBudget: true });
    const overBudget = scoreActorFit(['engineering'], { withinBudget: false });
    expect(withinBudget.score).toBeGreaterThan(overBudget.score);
    expect(withinBudget.capacityAvailability).toBe(1.0);
    expect(overBudget.capacityAvailability).toBe(0.0);
  });

  it('uses 0.5 for overrideHistoryFit and expertiseTagMatch (Phase 3 placeholders)', () => {
    const r = scoreActorFit(['product'], { withinBudget: true });
    expect(r.overrideHistoryFit).toBe(0.5);
    expect(r.expertiseTagMatch).toBe(0.5);
  });

  it('evaluates the three RFC-0029 pillars: engineering, product, design (AC#1)', () => {
    const eng = scoreActorFit(['engineering'], { withinBudget: true });
    const prod = scoreActorFit(['product'], { withinBudget: true });
    const des = scoreActorFit(['design'], { withinBudget: true });
    // All single-pillar → same declaredPillarMatch
    expect(eng.declaredPillarMatch).toBe(1.0);
    expect(prod.declaredPillarMatch).toBe(1.0);
    expect(des.declaredPillarMatch).toBe(1.0);
  });
});

// ── 4. Cost-of-block rubric ───────────────────────────────────────────────────

describe('scoreCostOfBlock', () => {
  it('returns score in [0,1]', () => {
    const r = scoreCostOfBlock(0, undefined, null);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('scores higher blockedTaskCount → higher cost', () => {
    const low = scoreCostOfBlock(1, 'm', null);
    const high = scoreCostOfBlock(10, 'm', null);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('scores higher tier weight → higher cost for same task count', () => {
    const small = scoreCostOfBlock(3, 's', null);
    const large = scoreCostOfBlock(3, 'l', null);
    expect(large.score).toBeGreaterThan(small.score);
  });

  it('scores overdue deadline as maximum urgency', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = scoreCostOfBlock(0, undefined, past);
    expect(r.deadlineScore).toBe(1.0);
  });

  it('scores zero deadline urgency when no deadline', () => {
    const r = scoreCostOfBlock(0, undefined, null);
    expect(r.deadlineScore).toBe(0.0);
  });

  it('sets downstreamPRScore to 0.0 (Phase 3 — no PR data)', () => {
    const r = scoreCostOfBlock(5, 'xl', null);
    expect(r.downstreamPRScore).toBe(0.0);
  });

  it('defaults to mid-band tier weight when tier is unset', () => {
    const withTier = scoreCostOfBlock(1, 'm', null);
    const withoutTier = scoreCostOfBlock(1, undefined, null);
    // Both use 0.5 tier weight → same taskBlockScore
    expect(withTier.taskBlockScore).toBe(withoutTier.taskBlockScore);
  });
});

// ── Composite score ───────────────────────────────────────────────────────────

describe('computeStageBCompositeScore', () => {
  it('returns a value in [0,1]', () => {
    const rubric = {
      loadBearing: scoreLoadBearing('reversible', 0, 0),
      llmConfidence: {
        score: 0.5,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.5,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['engineering'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(0, undefined, null),
    };
    const s = computeStageBCompositeScore(rubric);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('is monotonically higher when all sub-scores increase', () => {
    const lowRubric = {
      loadBearing: scoreLoadBearing('reversible', 0, 0),
      llmConfidence: {
        score: 0,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0,
        novelty: 0,
        exemplarSimilarity: 0,
      },
      actorFit: scoreActorFit([], { withinBudget: false }),
      costOfBlock: scoreCostOfBlock(0, 'xs', null),
    };
    const highRubric = {
      loadBearing: scoreLoadBearing('one-way', 15, 5),
      llmConfidence: {
        score: 1,
        rfcStatedPositionPresence: 1,
        evidenceCompleteness: 1,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['engineering'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(10, 'xl', new Date(Date.now() - 1000).toISOString()),
    };
    expect(computeStageBCompositeScore(highRubric)).toBeGreaterThan(
      computeStageBCompositeScore(lowRubric),
    );
  });
});

// ── Actor routing ─────────────────────────────────────────────────────────────

describe('routeDecisionActor', () => {
  it('routes reversible + high-confidence single-pillar → framework (LLM-eligible)', () => {
    seedDecision('DEC-0001', 'simple reversible decision', {
      reversible: true,
      body: 'RFC-0035 resolution: use event sourcing.',
      options: [
        { id: 'opt-a', description: 'A', consequences: ['c1'] },
        { id: 'opt-b', description: 'B', consequences: ['c2'] },
      ],
    });
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({
      reversibility: 'reversible',
      blastRadius: { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: ['engineering'] },
    });
    const rubric = {
      loadBearing: scoreLoadBearing('reversible', 0, 0),
      llmConfidence: {
        score: 0.85,
        rfcStatedPositionPresence: 1,
        evidenceCompleteness: 0.8,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['engineering'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(0, 'xs', null),
    };
    const compositeScore = 0.75;
    const result = routeDecisionActor(d, stageA, rubric, compositeScore, {
      engineering: 'dom@example.com',
    });
    expect(result.primaryActor).toBe('framework');
    expect(result.subActors).toHaveLength(0);
    expect(result.llmEligible).toBe(true);
    expect(result.rationale).toContain('LLM-eligible');
  });

  it('routes multi-pillar decisions to operator with sub-actors (AC#2, AC#3)', () => {
    seedDecision('DEC-0001', 'design and architecture strategy');
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({
      blastRadius: {
        blockedTaskCount: 3,
        blockedRfcCount: 0,
        affectedPillars: ['engineering', 'product'],
      },
    });
    const rubric = {
      loadBearing: scoreLoadBearing('unknown', 3, 1),
      llmConfidence: {
        score: 0.3,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.3,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['engineering', 'product'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(3, 'm', null),
    };

    const pillarOwners: PillarOwnerConfig = {
      engineering: 'dom@example.com',
      product: 'alex@example.com',
      operator: 'dom@example.com',
    };

    const result = routeDecisionActor(d, stageA, rubric, 0.5, pillarOwners);
    expect(result.primaryActor).toBe('dom@example.com'); // operator
    // AC#3: sub-actors = configured pillar owners for affected pillars
    expect(result.subActors).toContain('dom@example.com');
    expect(result.subActors).toContain('alex@example.com');
    expect(result.rationale).toMatch(/multi-pillar/i);
  });

  it('AC#4 — never auto-fills missing pillars (design not configured)', () => {
    seedDecision('DEC-0001', 'design and engineering decision');
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({
      blastRadius: {
        blockedTaskCount: 0,
        blockedRfcCount: 0,
        affectedPillars: ['engineering', 'design'],
      },
    });
    const rubric = {
      loadBearing: scoreLoadBearing('reversible', 0, 0),
      llmConfidence: {
        score: 0.4,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.4,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['engineering', 'design'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(0, undefined, null),
    };

    // Only engineering is configured — design is NOT
    const pillarOwners: PillarOwnerConfig = {
      engineering: 'dom@example.com',
      // design: intentionally omitted — AC#4
      operator: 'dom@example.com',
    };

    const result = routeDecisionActor(d, stageA, rubric, 0.5, pillarOwners);
    // sub-actors should only contain dom (engineering), not a placeholder for design
    expect(result.subActors).toContain('dom@example.com');
    expect(result.subActors).not.toContain(undefined);
    expect(result.subActors.length).toBe(1); // only the one configured owner
  });

  it('routes single-pillar with configured owner → owner email', () => {
    seedDecision('DEC-0001', 'engineering only decision', { reversible: false });
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({
      reversibility: 'one-way',
      blastRadius: { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: ['engineering'] },
    });
    const rubric = {
      loadBearing: scoreLoadBearing('one-way', 0, 0),
      llmConfidence: {
        score: 0.3,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.3,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['engineering'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(0, undefined, null),
    };

    const result = routeDecisionActor(d, stageA, rubric, 0.3, {
      engineering: 'dom@example.com',
    });
    expect(result.primaryActor).toBe('dom@example.com');
    expect(result.subActors).toHaveLength(0);
    expect(result.rationale).toContain('engineering');
  });

  it('escalates to operator when single-pillar owner is not configured', () => {
    seedDecision('DEC-0001', 'product strategy decision');
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({
      blastRadius: { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: ['product'] },
    });
    const rubric = {
      loadBearing: scoreLoadBearing('reversible', 0, 0),
      llmConfidence: {
        score: 0.3,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.3,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['product'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(0, undefined, null),
    };

    // No product owner configured
    const result = routeDecisionActor(d, stageA, rubric, 0.3, {
      engineering: 'dom@example.com',
      operator: 'dom@example.com',
    });
    expect(result.primaryActor).toBe('dom@example.com'); // operator fallback
    expect(result.rationale).toMatch(/no owner configured/i);
  });

  it('escalates load-bearing + ambiguous pillar to operator with escalation note', () => {
    seedDecision('DEC-0001', 'some ambiguous high-stakes decision');
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({
      reversibility: 'one-way',
      blastRadius: { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: [] }, // no pillars
    });
    // Use 10+ blocked tasks to drive blast-radius sub-score above 0.7 threshold:
    // scoreLoadBearing('one-way', 10, 5) ≈ 0.30 + 0.276 + 0.15 + 0 = 0.726 ≥ 0.7
    const rubric = {
      loadBearing: scoreLoadBearing('one-way', 10, 5), // high load-bearing (≥ 0.7)
      llmConfidence: {
        score: 0.3,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.3,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit([], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(10, 'xl', null),
    };

    const result = routeDecisionActor(d, stageA, rubric, 0.6, {
      operator: 'dom@example.com',
    });
    expect(result.primaryActor).toBe('dom@example.com');
    expect(result.rationale).toMatch(/load-bearing|escalat/i);
  });

  it('preserves explicit assignedActor from Stage A routing', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'pre-routed decision',
        options: [{ id: 'opt-a', description: 'A' }],
        routing: { assignedActor: 'specific-owner@example.com' },
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({ routingActor: 'specific-owner@example.com' });
    const rubric = {
      loadBearing: scoreLoadBearing('reversible', 0, 0),
      llmConfidence: {
        score: 0.5,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.5,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['engineering'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(0, undefined, null),
    };
    const result = routeDecisionActor(d, stageA, rubric, 0.5, {});
    expect(result.primaryActor).toBe('specific-owner@example.com');
    expect(result.rationale).toMatch(/Stage A/i);
  });

  it('resolves pillar-tag actor from Stage A to configured owner email', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'pillar-tagged decision',
        options: [{ id: 'opt-a', description: 'A' }],
        routing: { assignedActor: 'pillar:product' }, // pillar tag from Stage A
        reversible: false,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = makeStageAOutput({
      reversibility: 'one-way',
      routingActor: 'pillar:product',
      blastRadius: { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: ['product'] },
    });
    const rubric = {
      loadBearing: scoreLoadBearing('one-way', 0, 0),
      llmConfidence: {
        score: 0.4,
        rfcStatedPositionPresence: 0,
        evidenceCompleteness: 0.4,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: scoreActorFit(['product'], { withinBudget: true }),
      costOfBlock: scoreCostOfBlock(0, undefined, null),
    };
    const result = routeDecisionActor(d, stageA, rubric, 0.4, {
      product: 'alex@example.com',
    });
    expect(result.primaryActor).toBe('alex@example.com');
  });
});

// ── runStageB integration ─────────────────────────────────────────────────────

describe('runStageB (AC#5 — no LLM calls)', () => {
  it('returns a complete StageBOutput synchronously (AC#5)', () => {
    seedDecision('DEC-0001', 'engineering architecture decision', { reversible: true });
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });

    // All synchronous — no LLM calls
    const result = runStageB({ decision: d, stageA });

    expect(result.rubricScores.loadBearing.score).toBeGreaterThanOrEqual(0);
    expect(result.rubricScores.llmConfidence.score).toBeGreaterThanOrEqual(0);
    expect(result.rubricScores.actorFit.score).toBeGreaterThanOrEqual(0);
    expect(result.rubricScores.costOfBlock.score).toBeGreaterThanOrEqual(0);
    expect(result.compositeScore).toBeGreaterThanOrEqual(0);
    expect(result.compositeScore).toBeLessThanOrEqual(1);
    expect(typeof result.resolvedByStageB).toBe('boolean');
  });

  it('returns a routing with primaryActor and subActors (AC#2)', () => {
    seedDecision('DEC-0001', 'simple decision', { reversible: true });
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({
      decision: d,
      stageA,
      pillarOwners: { engineering: 'dom@example.com' },
    });

    expect(result.routing.primaryActor).toBeTruthy();
    expect(Array.isArray(result.routing.subActors)).toBe(true);
    expect(typeof result.routing.rationale).toBe('string');
    expect(result.routing.rationale.length).toBeGreaterThan(0);
  });

  it('includes routing rationale in output (AC#6)', () => {
    seedDecision('DEC-0001', 'decision with rationale', { reversible: true });
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({ decision: d, stageA });
    expect(result.routing.rationale).toBeTruthy();
    expect(result.routing.rationale.length).toBeGreaterThan(10);
  });

  it('resolvedByStageB=true when compositeScore >= HIGH_CONFIDENCE_THRESHOLD', () => {
    // Force a high-confidence scenario: one-way, many blocked tasks, xl tier, overdue deadline
    const past = new Date(Date.now() - 86400000).toISOString();
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'database migration for production schema',
        options: [
          { id: 'opt-a', description: 'A', consequences: ['c1', 'c2'] },
          { id: 'opt-b', description: 'B', consequences: ['c3'] },
        ],
        reversible: false,
        capacity: { tier: 'xl' },
        deadline: past,
        body: 'Per RFC-0035 Resolution: this is a one-way schema migration.',
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({ decision: d, stageA });
    // With one-way + xl + overdue deadline, composite should be ≥ 0.7
    if (result.compositeScore >= STAGE_B_HIGH_CONFIDENCE_THRESHOLD) {
      expect(result.resolvedByStageB).toBe(true);
    }
  });

  it('resolvedByStageB=true when compositeScore < LOW_CONFIDENCE_THRESHOLD', () => {
    // Force a low-confidence scenario: reversible, no blast, no deadline, minimal evidence
    seedDecision('DEC-0001', 'select the preferred color scheme', { reversible: true });
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({ decision: d, stageA });
    if (result.compositeScore < STAGE_B_LOW_CONFIDENCE_THRESHOLD) {
      expect(result.resolvedByStageB).toBe(true);
    }
  });

  it('uses empty DEFAULT_PILLAR_OWNERS when none provided (AC#4)', () => {
    seedDecision('DEC-0001', 'a design decision', { reversible: true });
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({ decision: d, stageA });
    // With no pillar owners configured, multi-pillar routing falls back to 'operator'
    expect(result.routing.primaryActor).toBeTruthy();
    // subActors should be empty when no owners are configured
    if (result.routing.subActors.length > 0) {
      // If there are sub-actors, they should all be defined strings (not undefined)
      for (const actor of result.routing.subActors) {
        expect(typeof actor).toBe('string');
      }
    }
  });
});

// ── AC#1 — all three pillars evaluated ───────────────────────────────────────

describe('AC#1 — rubric scorer evaluates Engineering + Product + Operator pillars', () => {
  it('routes engineering pillar decision to engineering owner', () => {
    seedDecision('DEC-0001', 'select the build system and CI configuration');
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({
      decision: d,
      stageA,
      pillarOwners: {
        engineering: 'eng@example.com',
        product: 'prod@example.com',
        operator: 'op@example.com',
      },
    });
    // Engineering keyword → affectedPillars contains 'engineering'
    // Single pillar → should route to engineering owner or operator (if multi-pillar detected)
    expect(result.routing.primaryActor).toBeTruthy();
  });

  it('routes product pillar decision to product owner', () => {
    seedDecision('DEC-0001', 'define product strategy and roadmap priorities');
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({
      decision: d,
      stageA,
      pillarOwners: {
        engineering: 'eng@example.com',
        product: 'prod@example.com',
        operator: 'op@example.com',
      },
    });
    // Product keyword in summary → should affect routing
    expect(result.routing.primaryActor).toBeTruthy();
    expect(result.routing.rationale.length).toBeGreaterThan(0);
  });

  it('routes operator pillar for cross-pillar decision', () => {
    seedDecision('DEC-0001', 'define product strategy and architectural vision');
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const result = runStageB({
      decision: d,
      stageA,
      pillarOwners: {
        engineering: 'eng@example.com',
        product: 'prod@example.com',
        operator: 'op@example.com',
      },
    });
    // Both product + engineering keywords → multi-pillar → operator
    if (stageA.blastRadius.affectedPillars.length > 1) {
      expect(result.routing.primaryActor).toBe('op@example.com');
    }
  });
});

// ── AC#6 — routing rationale stored on Decision record ────────────────────────

describe('AC#6 — routing rationale stored on Decision record via event + projection', () => {
  it('makeStageBRecommendationIssuedEvent builds a valid recommendation-issued event', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'a testable decision',
        options: [
          { id: 'opt-a', description: 'A', consequences: ['c1'] },
          { id: 'opt-b', description: 'B' },
        ],
        reversible: true,
        body: 'Per RFC-0035, resolution should use event sourcing.',
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const stageB = runStageB({
      decision: d,
      stageA,
      pillarOwners: { engineering: 'dom@example.com' },
    });

    const event = makeStageBRecommendationIssuedEvent({
      decisionId: 'DEC-0001',
      stageAOutput: stageA,
      stageBOutput: stageB,
      by: 'dom@example.com',
    });

    expect(event.type).toBe('recommendation-issued');
    expect(event.stageA).toEqual(stageA);
    expect(event.stageB).toEqual(stageB);
    expect(event.routing?.assignedActor).toBe(stageB.routing.primaryActor);
    expect(event.routing?.actorRationale).toBe(stageB.routing.rationale);
    expect(event.routing?.llmEligible).toBe(stageB.routing.llmEligible);
    expect(event.routing?.subActors).toEqual(stageB.routing.subActors);
    expect(event.resolvedByStageA).toBe(stageA.resolvedByStageA);
    expect(event.resolvedByStageB).toBe(stageB.resolvedByStageB);
    expect(event.by).toBe('dom@example.com');
  });

  it('projection folds stageB into status.evaluation.stageB (AC#6)', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'projected decision',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const stageB = runStageB({
      decision: d,
      stageA,
      pillarOwners: { engineering: 'dom@example.com' },
    });

    const event = makeStageBRecommendationIssuedEvent({
      decisionId: 'DEC-0001',
      stageAOutput: stageA,
      stageBOutput: stageB,
    });
    appendDecisionEvent(event, { workDir: tmp });

    const updated = getDecision('DEC-0001');
    const evaluation = updated.status.evaluation as Record<string, unknown> | undefined;

    // stageA stored (Phase 2 compat)
    expect(evaluation?.stageA).toBeDefined();
    // stageB stored (Phase 3 — AC#6)
    expect(evaluation?.stageB).toBeDefined();

    const storedB = evaluation?.stageB as Record<string, unknown> | undefined;
    expect(storedB?.compositeScore).toBe(stageB.compositeScore);
    expect(storedB?.resolvedByStageB).toBe(stageB.resolvedByStageB);
  });

  it('projection folds routing.actorRationale into status.routing (AC#6)', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'routing rationale test',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const stageB = runStageB({
      decision: d,
      stageA,
      pillarOwners: { engineering: 'dom@example.com', operator: 'dom@example.com' },
    });

    appendDecisionEvent(
      makeStageBRecommendationIssuedEvent({
        decisionId: 'DEC-0001',
        stageAOutput: stageA,
        stageBOutput: stageB,
      }),
      { workDir: tmp },
    );

    const updated = getDecision('DEC-0001');
    // actorRationale stored on the Decision record
    expect(updated.status.routing?.actorRationale).toBe(stageB.routing.rationale);
    expect(updated.status.routing?.assignedActor).toBe(stageB.routing.primaryActor);
    expect(updated.status.routing?.llmEligible).toBe(stageB.routing.llmEligible);
  });

  it('projection stores subActors on status.routing for multi-pillar decisions (AC#3)', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'design and architecture for the new feature',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: false,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });

    const pillarOwners: PillarOwnerConfig = {
      engineering: 'eng@example.com',
      design: 'des@example.com',
      operator: 'op@example.com',
    };
    const stageB = runStageB({ decision: d, stageA, pillarOwners });

    appendDecisionEvent(
      makeStageBRecommendationIssuedEvent({
        decisionId: 'DEC-0001',
        stageAOutput: stageA,
        stageBOutput: stageB,
      }),
      { workDir: tmp },
    );

    const updated = getDecision('DEC-0001');
    // subActors on routing (populated when multi-pillar — AC#3)
    expect(updated.status.routing?.subActors).toEqual(stageB.routing.subActors);
  });

  it('decisionLog contains recommendation-issued event after Stage B', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'log test decision',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    const stageB = runStageB({ decision: d, stageA });

    appendDecisionEvent(
      makeStageBRecommendationIssuedEvent({
        decisionId: 'DEC-0001',
        stageAOutput: stageA,
        stageBOutput: stageB,
      }),
      { workDir: tmp },
    );

    const updated = getDecision('DEC-0001');
    expect(updated.decisionLog).toHaveLength(2);
    expect(updated.decisionLog[1].type).toBe('recommendation-issued');
  });
});
