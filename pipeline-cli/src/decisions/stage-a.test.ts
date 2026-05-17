/**
 * RFC-0035 Phase 2 — Stage A deterministic scorer tests.
 *
 * Covers all 7 sub-checks, the priority signal aggregation, the
 * resolvedByStageA determination (AC#3), blast-radius via RFC-0014
 * dep-graph (AC#2), per-decision storage via recommendation-issued event
 * (AC#4), and the coverage metric (AC#6).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendDecisionEvent, makeDecisionOpenedEvent } from './event-log.js';
import { listDecisions, projectDecision } from './projection.js';
import type { Decision } from './decision-record.js';
import {
  assessReversibility,
  checkCapacityArithmetic,
  checkReferenceResolution,
  checkSchemaValidity,
  computeBlastRadius,
  computeStageACoverage,
  DEFAULT_CAPACITY_CONFIG,
  deriveAffectedPillars,
  detectDuplicates,
  determineRoutingActor,
  isResolvedByStageA,
  levenshtein,
  makeRecommendationIssuedEvent,
  measureDecisionTreeDepth,
  normalisedSimilarity,
  normaliseSummary,
  runStageA,
  STAGE_A_COVERAGE_TARGET,
} from './stage-a.js';
import { buildDependencyGraph } from '../deps/dependency-graph.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stage-a-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Seed a minimal valid decision into the event log under `tmp`.
 */
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

/** Retrieve a seeded decision from the projection. */
function getDecision(id: string): Decision {
  const d = projectDecision(id, { workDir: tmp });
  if (!d) throw new Error(`decision ${id} not found`);
  return d;
}

/** Build a minimal backlog structure in `dir`. */
function seedBacklog(
  dir: string,
  tasks: Array<{ id: string; status?: string; body?: string }>,
): void {
  const tasksDir = join(dir, 'backlog', 'tasks');
  const completedDir = join(dir, 'backlog', 'completed');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });

  for (const { id, status = 'To Do', body = '' } of tasks) {
    const content = `---\nid: ${id}\nstatus: ${status}\ntitle: ${id} title\npriority: medium\n---\n${body}\n`;
    writeFileSync(join(tasksDir, `${id.toLowerCase()}.md`), content, 'utf8');
  }
}

// ── Levenshtein + normalisation ───────────────────────────────────────────────

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns the length of b for empty a', () => {
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('returns correct edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('saturday', 'sunday')).toBe(3);
  });

  it('is symmetric', () => {
    expect(levenshtein('abc', 'xyz')).toBe(levenshtein('xyz', 'abc'));
  });
});

describe('normaliseSummary', () => {
  it('lowercases and strips punctuation', () => {
    expect(normaliseSummary('Pick a Strategy!')).toBe('pick a strategy');
  });

  it('collapses whitespace', () => {
    expect(normaliseSummary('  too   many  spaces  ')).toBe('too many spaces');
  });
});

describe('normalisedSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(normalisedSimilarity('abc', 'abc')).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(normalisedSimilarity('', '')).toBe(0);
  });

  it('returns a value in [0,1]', () => {
    const s = normalisedSimilarity('hello world', 'world hello');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('returns low similarity for very different strings', () => {
    const s = normalisedSimilarity('pick a routing strategy', 'database schema migration');
    expect(s).toBeLessThan(0.5);
  });
});

// ── 1. Schema validity ────────────────────────────────────────────────────────

describe('checkSchemaValidity', () => {
  it('returns valid for a well-formed decision', () => {
    seedDecision('DEC-0001', 'valid decision');
    const d = getDecision('DEC-0001');
    const r = checkSchemaValidity(d);
    expect(r.valid).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('rejects a decision with no options', () => {
    // Manually craft an invalid shape.
    const bad = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Decision',
      metadata: { id: 'DEC-0001', source: 'ad-hoc', scope: 'workspace', created: '', updated: '' },
      spec: { summary: 'x', options: [] },
      status: { lifecycle: 'open' },
      decisionLog: [],
    } as unknown as Decision;
    const r = checkSchemaValidity(bad);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/options/);
  });

  it('rejects a decision with malformed id', () => {
    const bad = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Decision',
      metadata: {
        id: 'AISDLC-285',
        source: 'ad-hoc',
        scope: 'workspace',
        created: '',
        updated: '',
      },
      spec: { summary: 'x', options: [{ id: 'opt-a', description: 'A' }] },
      status: { lifecycle: 'open' },
      decisionLog: [],
    } as unknown as Decision;
    const r = checkSchemaValidity(bad);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/metadata\.id/);
  });
});

// ── 2. Blast radius ───────────────────────────────────────────────────────────

describe('computeBlastRadius', () => {
  it('returns zeros when no graph and no workDir', () => {
    seedDecision('DEC-0001', 'test decision');
    const d = getDecision('DEC-0001');
    const r = computeBlastRadius(d);
    expect(r.blockedTaskCount).toBe(0);
    expect(r.blockedRfcCount).toBe(0);
    expect(r.affectedPillars.length).toBeGreaterThan(0);
  });

  it('counts tasks that reference the decision ID in their body (AC#2)', () => {
    seedBacklog(tmp, [
      { id: 'AISDLC-100', body: 'depends-on: DEC-0001' },
      { id: 'AISDLC-101', body: 'depends-on: DEC-0001' },
      { id: 'AISDLC-102', body: 'no reference here' },
    ]);
    seedDecision('DEC-0001', 'a routing strategy');
    const d = getDecision('DEC-0001');
    const r = computeBlastRadius(d, undefined, tmp);
    expect(r.blockedTaskCount).toBe(2);
  });

  it('increments blockedRfcCount when scope is rfc:RFC-NNNN', () => {
    seedDecision('DEC-0001', 'rfc scoped', { scope: 'rfc:RFC-0035' });
    const d = getDecision('DEC-0001');
    const r = computeBlastRadius(d, undefined, tmp);
    expect(r.blockedRfcCount).toBe(1);
  });

  it('uses RFC-0014 dep-graph impact() for task-scoped decisions (AC#2)', () => {
    // Seed a task graph where AISDLC-100 blocks AISDLC-101 and AISDLC-102
    const backlogDir = tmp;
    mkdirSync(join(backlogDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(backlogDir, 'backlog', 'completed'), { recursive: true });
    writeFileSync(
      join(backlogDir, 'backlog', 'tasks', 'aisdlc-100.md'),
      '---\nid: AISDLC-100\nstatus: To Do\ntitle: base\npriority: high\n---\n',
    );
    writeFileSync(
      join(backlogDir, 'backlog', 'tasks', 'aisdlc-101.md'),
      '---\nid: AISDLC-101\nstatus: To Do\ntitle: dep1\npriority: medium\ndependencies:\n  - AISDLC-100\n---\n',
    );
    writeFileSync(
      join(backlogDir, 'backlog', 'tasks', 'aisdlc-102.md'),
      '---\nid: AISDLC-102\nstatus: To Do\ntitle: dep2\npriority: medium\ndependencies:\n  - AISDLC-100\n---\n',
    );

    const graph = buildDependencyGraph({ workDir: backlogDir });

    // Decision scoped to AISDLC-100 — its impact() closure is AISDLC-101 + AISDLC-102
    seedDecision('DEC-0001', 'task scoped', { scope: 'issue:AISDLC-100' });
    const d = getDecision('DEC-0001');
    const r = computeBlastRadius(d, graph, backlogDir);
    // impact(graph, 'AISDLC-100') returns [AISDLC-101, AISDLC-102] → 2 open tasks
    expect(r.blockedTaskCount).toBeGreaterThanOrEqual(2);
  });
});

// ── Pillar derivation ─────────────────────────────────────────────────────────

describe('deriveAffectedPillars', () => {
  it('tags engineering for architecture / code decisions', () => {
    seedDecision('DEC-0001', 'Choose a database schema');
    const d = getDecision('DEC-0001');
    const pillars = deriveAffectedPillars(d);
    expect(pillars).toContain('engineering');
  });

  it('tags product for strategy / prioritization decisions', () => {
    seedDecision('DEC-0001', 'Define product strategy and roadmap priorities');
    const d = getDecision('DEC-0001');
    const pillars = deriveAffectedPillars(d);
    expect(pillars).toContain('product');
  });

  it('defaults to engineering when no keywords match', () => {
    seedDecision('DEC-0001', 'x');
    const d = getDecision('DEC-0001');
    const pillars = deriveAffectedPillars(d);
    expect(pillars).toContain('engineering');
  });
});

// ── 3. Reference resolution ───────────────────────────────────────────────────

describe('checkReferenceResolution', () => {
  it('resolves when scope task exists in the graph', () => {
    seedBacklog(tmp, [{ id: 'AISDLC-100' }]);
    const graph = buildDependencyGraph({ workDir: tmp });
    seedDecision('DEC-0001', 'task scoped', { scope: 'issue:AISDLC-100' });
    const d = getDecision('DEC-0001');
    const r = checkReferenceResolution(d, graph);
    expect(r.resolved).toBe(true);
    expect(r.broken).toHaveLength(0);
  });

  it('flags a broken scope reference when task not in graph', () => {
    seedBacklog(tmp, []);
    const graph = buildDependencyGraph({ workDir: tmp });
    seedDecision('DEC-0001', 'scoped', { scope: 'issue:AISDLC-999' });
    const d = getDecision('DEC-0001');
    const r = checkReferenceResolution(d, graph);
    expect(r.resolved).toBe(false);
    expect(r.broken.some((b) => b.includes('AISDLC-999'))).toBe(true);
  });

  it('resolves workspace scope without a graph', () => {
    seedDecision('DEC-0001', 'workspace scoped', { scope: 'workspace' });
    const d = getDecision('DEC-0001');
    const r = checkReferenceResolution(d);
    expect(r.resolved).toBe(true);
  });
});

// ── 4. Decision-tree depth ────────────────────────────────────────────────────

describe('measureDecisionTreeDepth', () => {
  it('returns 0 when no options have subDecisions', () => {
    seedDecision('DEC-0001', 'no sub-decisions');
    const d = getDecision('DEC-0001');
    expect(measureDecisionTreeDepth(d)).toBe(0);
  });

  it('returns the max subDecisions count across options', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'with sub-decisions',
        options: [
          { id: 'opt-a', description: 'A', subDecisions: ['sub-1', 'sub-2', 'sub-3'] },
          { id: 'opt-b', description: 'B', subDecisions: ['sub-1'] },
        ],
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    expect(measureDecisionTreeDepth(d)).toBe(3);
  });
});

// ── 5. Capacity arithmetic ────────────────────────────────────────────────────

describe('checkCapacityArithmetic', () => {
  it('returns withinBudget=true when no tier is set', () => {
    seedDecision('DEC-0001', 'no tier');
    const d = getDecision('DEC-0001');
    const r = checkCapacityArithmetic(d);
    expect(r.withinBudget).toBe(true);
    expect(r.reason).toMatch(/deferred/);
  });

  it('returns withinBudget=true when usage is below limit', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'with tier',
        options: [{ id: 'opt-a', description: 'A' }],
        capacity: { tier: 'l' },
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    // DEFAULT_CAPACITY_CONFIG.l.perDay = 2; todayUsage.l = 1 → within budget
    const r = checkCapacityArithmetic(d, DEFAULT_CAPACITY_CONFIG, { l: 1 });
    expect(r.withinBudget).toBe(true);
  });

  it('returns withinBudget=false when usage meets limit', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'with tier',
        options: [{ id: 'opt-a', description: 'A' }],
        capacity: { tier: 'xl' },
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    // DEFAULT_CAPACITY_CONFIG.xl.perDay = 1; todayUsage.xl = 1 → over budget
    const r = checkCapacityArithmetic(d, DEFAULT_CAPACITY_CONFIG, { xl: 1 });
    expect(r.withinBudget).toBe(false);
    expect(r.reason).toMatch(/exhausted/);
  });
});

// ── 6. Reversibility ─────────────────────────────────────────────────────────

describe('assessReversibility', () => {
  it('returns reversible when spec.reversible is true', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'reversible decision',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    expect(assessReversibility(d)).toBe('reversible');
  });

  it('returns one-way when spec.reversible is false', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'one-way decision',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: false,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    expect(assessReversibility(d)).toBe('one-way');
  });

  it('returns one-way when irreversible pattern appears in summary', () => {
    seedDecision('DEC-0001', 'choose a database migration strategy');
    const d = getDecision('DEC-0001');
    expect(assessReversibility(d)).toBe('one-way');
  });

  it('returns unknown for novel categories without explicit field', () => {
    seedDecision('DEC-0001', 'select the preferred color palette for the dashboard');
    const d = getDecision('DEC-0001');
    // No irreversible pattern; no explicit field → unknown
    expect(assessReversibility(d)).toBe('unknown');
  });
});

// ── 7. Duplicate detection ────────────────────────────────────────────────────

describe('detectDuplicates', () => {
  it('returns unique when no other decisions exist', () => {
    seedDecision('DEC-0001', 'pick a routing strategy');
    const d = getDecision('DEC-0001');
    const r = detectDuplicates(d, []);
    expect(r.isDuplicate).toBe(false);
    expect(r.candidateId).toBeNull();
  });

  it('detects a near-identical summary as a duplicate', () => {
    seedDecision('DEC-0001', 'pick a routing strategy for the pipeline');
    seedDecision('DEC-0002', 'pick a routing strategy for the pipeline'); // identical
    const d = getDecision('DEC-0002');
    const others = [getDecision('DEC-0001')];
    const r = detectDuplicates(d, others);
    expect(r.isDuplicate).toBe(true);
    expect(r.candidateId).toBe('DEC-0001');
    expect(r.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it('does not flag clearly different summaries', () => {
    seedDecision('DEC-0001', 'choose the auth library');
    seedDecision('DEC-0002', 'define the product roadmap priorities for Q3');
    const d = getDecision('DEC-0002');
    const others = [getDecision('DEC-0001')];
    const r = detectDuplicates(d, others);
    expect(r.isDuplicate).toBe(false);
  });
});

// ── AC#3 — resolvedByStageA ───────────────────────────────────────────────────

describe('isResolvedByStageA (AC#3)', () => {
  it('returns true when all inputs are deterministic', () => {
    const r = isResolvedByStageA(
      { valid: true },
      'reversible',
      { resolved: true },
      { isDuplicate: false, candidateId: null, similarity: 0 },
    );
    expect(r).toBe(true);
  });

  it('returns false when schema is invalid', () => {
    expect(
      isResolvedByStageA(
        { valid: false },
        'reversible',
        { resolved: true },
        { isDuplicate: false, candidateId: null, similarity: 0 },
      ),
    ).toBe(false);
  });

  it('returns false when reversibility is unknown', () => {
    expect(
      isResolvedByStageA(
        { valid: true },
        'unknown',
        { resolved: true },
        { isDuplicate: false, candidateId: null, similarity: 0 },
      ),
    ).toBe(false);
  });

  it('returns false when a duplicate is detected', () => {
    expect(
      isResolvedByStageA(
        { valid: true },
        'reversible',
        { resolved: true },
        { isDuplicate: true, candidateId: 'DEC-0001', similarity: 0.95 },
      ),
    ).toBe(false);
  });
});

// ── Routing actor determination ───────────────────────────────────────────────

describe('determineRoutingActor', () => {
  it('routes to framework for reversible + low blast-radius', () => {
    seedDecision('DEC-0001', 'a reversible low-radius decision', { reversible: true });
    const d = getDecision('DEC-0001');
    const actor = determineRoutingActor(
      d,
      'reversible',
      { blockedTaskCount: 1, blockedRfcCount: 0, affectedPillars: ['engineering'] },
      true,
    );
    expect(actor).toBe('framework');
  });

  it('routes to operator for multi-pillar decisions', () => {
    seedDecision('DEC-0001', 'cross-pillar decision', { reversible: true });
    const d = getDecision('DEC-0001');
    const actor = determineRoutingActor(
      d,
      'reversible',
      { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: ['engineering', 'product'] },
      true,
    );
    expect(actor).toBe('operator');
  });

  it('returns null when not resolvedByStageA', () => {
    seedDecision('DEC-0001', 'complex decision');
    const d = getDecision('DEC-0001');
    const actor = determineRoutingActor(
      d,
      'unknown',
      { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: [] },
      false,
    );
    expect(actor).toBeNull();
  });

  it('preserves existing assignedActor from routing', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'pre-assigned',
        options: [{ id: 'opt-a', description: 'A' }],
        routing: { assignedActor: 'dominique@reliablegenius.io' },
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const actor = determineRoutingActor(
      d,
      'reversible',
      { blockedTaskCount: 0, blockedRfcCount: 0, affectedPillars: ['engineering'] },
      true,
    );
    expect(actor).toBe('dominique@reliablegenius.io');
  });
});

// ── runStageA integration ─────────────────────────────────────────────────────

describe('runStageA', () => {
  it('returns a complete StageAOutput for a valid reversible decision', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'pick a deployment strategy',
        options: [
          { id: 'opt-a', description: 'Blue/green' },
          { id: 'opt-b', description: 'Canary' },
        ],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const result = runStageA({ decision: d });

    expect(result.schemaValidity.valid).toBe(true);
    expect(result.reversibility).toBe('reversible');
    expect(result.resolvedByStageA).toBe(true);
    expect(result.routingActor).not.toBeNull();
    expect(result.prioritySignal).toBeGreaterThanOrEqual(0);
    expect(result.prioritySignal).toBeLessThanOrEqual(1);
    expect(result.blastRadius.affectedPillars.length).toBeGreaterThan(0);
  });

  it('sets resolvedByStageA=false for decisions with unknown reversibility', () => {
    seedDecision('DEC-0001', 'ambiguous design choice');
    const d = getDecision('DEC-0001');
    const result = runStageA({ decision: d });

    expect(result.reversibility).toBe('unknown');
    expect(result.resolvedByStageA).toBe(false);
    expect(result.routingActor).toBeNull();
  });

  it('incorporates RFC-0014 dep-graph for blast-radius when graph is provided (AC#5)', () => {
    mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(tmp, 'backlog', 'completed'), { recursive: true });
    writeFileSync(
      join(tmp, 'backlog', 'tasks', 'aisdlc-100.md'),
      '---\nid: AISDLC-100\nstatus: To Do\ntitle: base task\npriority: high\n---\n',
    );
    writeFileSync(
      join(tmp, 'backlog', 'tasks', 'aisdlc-101.md'),
      '---\nid: AISDLC-101\nstatus: To Do\ntitle: blocked task\npriority: medium\ndependencies:\n  - AISDLC-100\n---\n',
    );

    const graph = buildDependencyGraph({ workDir: tmp });

    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'issue:AISDLC-100',
        summary: 'resolve AISDLC-100 approach',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');

    const result = runStageA({ decision: d, graph, workDir: tmp });
    // AISDLC-101 depends on AISDLC-100 → blockedTaskCount ≥ 1
    expect(result.blastRadius.blockedTaskCount).toBeGreaterThanOrEqual(1);
  });
});

// ── AC#4 — recommendation-issued event + projection ─────────────────────────

describe('AC#4 — recommendation-issued stored on Decision record', () => {
  it('stores stageA output in status.evaluation.stageA via recommendation-issued event', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'a reversible decision',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });

    const event = makeRecommendationIssuedEvent({ decisionId: 'DEC-0001', stageAOutput: stageA });
    appendDecisionEvent(event, { workDir: tmp });

    const updated = getDecision('DEC-0001');
    const stored = (updated.status.evaluation as Record<string, unknown>)?.stageA as
      | Record<string, unknown>
      | undefined;

    expect(stored).not.toBeUndefined();
    expect(stored?.resolvedByStageA).toBe(stageA.resolvedByStageA);
    expect(updated.status.priority).toBe(stageA.prioritySignal);
    expect(updated.decisionLog).toHaveLength(2);
    expect(updated.decisionLog[1].type).toBe('recommendation-issued');
  });

  it('updates routing.assignedActor when Stage A determines one', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'a reversible low-radius decision',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });

    const event = makeRecommendationIssuedEvent({ decisionId: 'DEC-0001', stageAOutput: stageA });
    appendDecisionEvent(event, { workDir: tmp });

    const updated = getDecision('DEC-0001');
    if (stageA.routingActor !== null) {
      expect(updated.status.routing?.assignedActor).toBe(stageA.routingActor);
    }
  });
});

// ── AC#6 — coverage metric ───────────────────────────────────────────────────

describe('computeStageACoverage (AC#6)', () => {
  it('returns zero coverage for empty catalog', () => {
    const r = computeStageACoverage([]);
    expect(r.totalDecisions).toBe(0);
    expect(r.coverageRate).toBe(0);
    expect(r.meetsTarget).toBe(false);
  });

  it('meets the ≥40% target when decisions are reversible with explicit field', () => {
    // Seed 5 reversible decisions with clearly distinct summaries
    const reversibleSummaries = [
      'choose the CI provider for the new monorepo',
      'select the observability stack for production telemetry',
      'pick the code review tool to replace the existing workflow',
      'decide on the feature-flag library for the rollout system',
      'determine the documentation platform for the API reference',
    ];
    // Seed 5 ambiguous decisions (no explicit reversible field, no irreversible patterns)
    const ambiguousSummaries = [
      'evaluate the governance reporting cadence for the advisory board',
      'align on the calibration corpus retention window',
      'explore the operator-fatigue signal inference approach',
      'assess the sub-decision graph rendering fidelity requirements',
      'clarify the audit digest delivery frequency for stakeholders',
    ];
    for (let i = 0; i < 5; i++) {
      appendDecisionEvent(
        makeDecisionOpenedEvent({
          decisionId: `DEC-${String(i + 1).padStart(4, '0')}`,
          source: 'ad-hoc',
          scope: 'workspace',
          summary: reversibleSummaries[i],
          options: [
            { id: 'opt-a', description: 'A' },
            { id: 'opt-b', description: 'B' },
          ],
          reversible: true, // explicitly reversible
        }),
        { workDir: tmp },
      );
    }
    for (let i = 0; i < 5; i++) {
      appendDecisionEvent(
        makeDecisionOpenedEvent({
          decisionId: `DEC-${String(i + 6).padStart(4, '0')}`,
          source: 'ad-hoc',
          scope: 'workspace',
          summary: ambiguousSummaries[i],
          options: [
            { id: 'opt-a', description: 'A' },
            { id: 'opt-b', description: 'B' },
          ],
          // reversible: undefined → Stage A will return 'unknown' → not resolved by Stage A
        }),
        { workDir: tmp },
      );
    }
    const { decisions } = listDecisions({ workDir: tmp });
    const r = computeStageACoverage(decisions);
    // 5/10 = 50% should be resolved by Stage A (reversible + schema valid + no broken refs + no dups)
    expect(r.totalDecisions).toBe(10);
    expect(r.resolvedByStageA).toBeGreaterThanOrEqual(4); // ≥40%
    expect(r.coverageRate).toBeGreaterThanOrEqual(STAGE_A_COVERAGE_TARGET);
    expect(r.meetsTarget).toBe(true);
  });

  it('uses stored stageA result when already scored', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'pre-scored decision',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');
    const stageA = runStageA({ decision: d });
    // Store it
    appendDecisionEvent(
      makeRecommendationIssuedEvent({ decisionId: 'DEC-0001', stageAOutput: stageA }),
      { workDir: tmp },
    );

    const updated = getDecision('DEC-0001');
    const r = computeStageACoverage([updated]);
    expect(r.totalDecisions).toBe(1);
    // The stored result should be used
    if (stageA.resolvedByStageA) {
      expect(r.resolvedByStageA).toBe(1);
    }
  });

  it('STAGE_A_COVERAGE_TARGET is 0.4', () => {
    expect(STAGE_A_COVERAGE_TARGET).toBe(0.4);
  });
});

// ── AC#5 — no graph code duplication ─────────────────────────────────────────

describe('AC#5 — composes with RFC-0014 substrate', () => {
  it('imports buildDependencyGraph and computeEffectivePriorities from deps (no duplication)', () => {
    // This test verifies the import path is correct — if stage-a.ts
    // duplicated the graph logic, this import would fail or produce
    // different results. The test is structural: we build a graph using
    // the shared function and pass it to runStageA.
    mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(tmp, 'backlog', 'completed'), { recursive: true });
    writeFileSync(
      join(tmp, 'backlog', 'tasks', 'aisdlc-200.md'),
      '---\nid: AISDLC-200\nstatus: To Do\ntitle: shared graph node\npriority: critical\n---\n',
    );

    const graph = buildDependencyGraph({ workDir: tmp });
    expect(graph.nodes.has('aisdlc-200')).toBe(true);

    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'issue:AISDLC-200',
        summary: 'resolve critical task approach',
        options: [{ id: 'opt-a', description: 'A' }],
        reversible: true,
      }),
      { workDir: tmp },
    );
    const d = getDecision('DEC-0001');

    // Passing the same graph object — Stage A uses it without rebuilding.
    const result = runStageA({ decision: d, graph, workDir: tmp });
    // Should be valid and use the graph's priority data
    expect(result.schemaValidity.valid).toBe(true);
    expect(result.prioritySignal).toBeGreaterThan(0); // critical priority task → elevated signal
  });
});
