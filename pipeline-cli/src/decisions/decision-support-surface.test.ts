/**
 * RFC-0035 Phase 6 (AISDLC-290) — decision-support-surface unit tests.
 *
 * Hermetic tests for the structured view builder + the Markdown renderer.
 * No I/O; every test constructs a `Decision` fixture in-memory.
 */

import { describe, expect, it } from 'vitest';

import {
  buildDecisionSupportView,
  buildSubDecisionGraph,
  renderDecisionSupportSurface,
  renderStageProvenance,
  renderSubDecisionGraphHtml,
  renderSubDecisionGraphMermaid,
  type DecisionSupportView,
} from './decision-support-surface.js';
import type { Decision, StageAOutput, StageBOutput, StageCOutput } from './decision-record.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function baseDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Decision',
    metadata: {
      id: 'DEC-0042',
      source: 'rfc-open-question',
      scope: 'rfc:RFC-0035',
      created: '2026-05-15T10:00:00.000Z',
      updated: '2026-05-15T10:00:00.000Z',
    },
    spec: {
      summary: 'Pick a routing strategy for cross-pillar decisions',
      body: 'Should multi-pillar decisions auto-route to operator?',
      reversible: true,
      options: [
        {
          id: 'opt-a',
          description: 'Always route multi-pillar to operator',
          consequences: ['Cross-pillar consensus deadlocks avoided'],
        },
        {
          id: 'opt-b',
          description: 'Concurrent sign-off from each pillar lead',
          consequences: ['Cross-pillar context preserved'],
        },
      ],
    },
    status: { lifecycle: 'open' },
    decisionLog: [],
    ...overrides,
  };
}

function makeStageA(overrides: Partial<StageAOutput> = {}): StageAOutput {
  return {
    schemaValidity: { valid: true, reasons: [] },
    blastRadius: { blockedTaskCount: 3, blockedRfcCount: 1, affectedPillars: ['engineering'] },
    referenceResolution: { resolved: true, broken: [] },
    decisionTreeDepth: 2,
    capacityCheck: { withinBudget: true, reason: 'within budget' },
    reversibility: 'reversible',
    duplicateDetection: { isDuplicate: false, candidateId: null, similarity: 0 },
    prioritySignal: 0.5,
    resolvedByStageA: false,
    routingActor: null,
    ...overrides,
  };
}

function makeStageB(overrides: Partial<StageBOutput> = {}): StageBOutput {
  return {
    rubricScores: {
      loadBearing: {
        score: 0.5,
        reversibility: 0,
        blastRadius: 0.5,
        downstreamDecisions: 0.5,
        deadlineCriticality: 0,
      },
      llmConfidence: {
        score: 0.5,
        rfcStatedPositionPresence: 0.5,
        evidenceCompleteness: 0.5,
        novelty: 0.5,
        exemplarSimilarity: 0.5,
      },
      actorFit: {
        score: 1,
        declaredPillarMatch: 1,
        capacityAvailability: 1,
        overrideHistoryFit: 0.5,
        expertiseTagMatch: 0.5,
      },
      costOfBlock: {
        score: 0.3,
        taskBlockScore: 0.3,
        deadlineScore: 0,
        downstreamPRScore: 0,
      },
    },
    routing: {
      primaryActor: 'operator',
      subActors: ['eng@example.com', 'product@example.com'],
      rationale: 'Multi-pillar decision routed to operator per §6.2.',
      llmEligible: true,
    },
    compositeScore: 0.55,
    resolvedByStageB: false,
    ...overrides,
  };
}

function makeStageC(overrides: Partial<StageCOutput> = {}): StageCOutput {
  return {
    corpusEntryId: 'corp-abc-123',
    effectiveThreshold: 0.7,
    model: 'claude-haiku-4-5',
    metBehindThreshold: true,
    recommendation: {
      optionId: 'opt-a',
      confidence: 0.82,
      rationale: 'Operator-as-decision-steward framing anchors single-actor routing.',
    },
    alternativesConsidered: [],
    counterArguments: [
      'Concurrent sign-off would preserve cross-pillar context the operator lacks.',
    ],
    subDecisionsImplied: [
      { optionId: 'opt-a', followUp: 'What is the operator-fatigue back-off?' },
    ],
    llmAnswerEligible: true,
    autoApplyAt: '2026-05-15T10:05:00.000Z',
    overrideWindowHours: 24,
    ...overrides,
  };
}

// ── buildDecisionSupportView ─────────────────────────────────────────────────

describe('buildDecisionSupportView', () => {
  it('captures the problem + options when no stages have run (AC#5 backward-compat)', () => {
    const view = buildDecisionSupportView(baseDecision());
    expect(view.decisionId).toBe('DEC-0042');
    expect(view.problemSummary).toMatch(/routing strategy/);
    expect(view.problemBody).toMatch(/auto-route to operator/);
    expect(view.options).toHaveLength(2);
    expect(view.options[0].id).toBe('opt-a');
    expect(view.options[0].consequences).toEqual(['Cross-pillar consensus deadlocks avoided']);
    // Backward-compat: every stage block is absent
    expect(view.recommendation).toBeUndefined();
    expect(view.counterArguments).toEqual([]);
    expect(view.stageAProvenance).toBeUndefined();
    expect(view.stageBProvenance).toBeUndefined();
    expect(view.stageCProvenance).toBeUndefined();
    // Sub-decision graph nodes exist (one per option) but with empty children
    expect(view.subDecisionGraph).toHaveLength(2);
    expect(view.subDecisionGraph[0].subDecisions).toEqual([]);
  });

  it('captures Stage A provenance when present', () => {
    const decision = baseDecision({
      status: {
        lifecycle: 'open',
        evaluation: { stageA: makeStageA({ resolvedByStageA: true, routingActor: 'framework' }) },
      },
    });
    const view = buildDecisionSupportView(decision);
    expect(view.stageAProvenance).toBeDefined();
    expect(view.stageAProvenance!.resolvedByStageA).toBe(true);
    expect(view.stageAProvenance!.routingActor).toBe('framework');
    expect(view.stageAProvenance!.blastRadius.blockedTaskCount).toBe(3);
  });

  it('captures Stage B routing (multi-pillar with sub-actors)', () => {
    const decision = baseDecision({
      status: {
        lifecycle: 'open',
        evaluation: { stageA: makeStageA(), stageB: makeStageB() },
      },
    });
    const view = buildDecisionSupportView(decision);
    expect(view.stageBProvenance!.primaryActor).toBe('operator');
    expect(view.stageBProvenance!.subActors).toEqual(['eng@example.com', 'product@example.com']);
    expect(view.stageBProvenance!.rationale).toMatch(/Multi-pillar/);
  });

  it('captures Stage C recommendation + counter-arguments + implied sub-decisions', () => {
    const decision = baseDecision({
      status: {
        lifecycle: 'open',
        evaluation: { stageC: makeStageC() },
      },
    });
    const view = buildDecisionSupportView(decision);
    expect(view.recommendation).toBeDefined();
    expect(view.recommendation!.optionId).toBe('opt-a');
    expect(view.recommendation!.confidence).toBe(0.82);
    expect(view.recommendation!.status).toBe('pending-operator');
    expect(view.counterArguments).toHaveLength(1);
    // Stage C implied sub-decision folds into the graph under opt-a
    const optA = view.subDecisionGraph.find((n) => n.optionId === 'opt-a');
    expect(optA!.subDecisions).toContainEqual({
      text: 'What is the operator-fatigue back-off?',
      source: 'implied',
    });
  });

  it('marks recommendation as auto-applied when the framework answered with the rec', () => {
    const decision = baseDecision({
      status: {
        lifecycle: 'answered',
        answeredOptionId: 'opt-a',
        answeredBy: 'framework',
        answeredAt: '2026-05-15T10:05:00.000Z',
        evaluation: { stageC: makeStageC() },
      },
    });
    const view = buildDecisionSupportView(decision);
    expect(view.recommendation!.status).toBe('auto-applied');
  });

  it('marks recommendation as pending-operator when answered by operator (not framework)', () => {
    const decision = baseDecision({
      status: {
        lifecycle: 'answered',
        answeredOptionId: 'opt-b', // operator picked the OTHER option
        answeredBy: 'operator@example.com',
        answeredAt: '2026-05-15T11:00:00.000Z',
        evaluation: { stageC: makeStageC() },
      },
    });
    const view = buildDecisionSupportView(decision);
    expect(view.recommendation!.status).toBe('pending-operator');
  });
});

// ── buildSubDecisionGraph ────────────────────────────────────────────────────

describe('buildSubDecisionGraph', () => {
  it('unions declared + Stage C-implied sub-decisions per option', () => {
    const decision = baseDecision({
      spec: {
        summary: 'x',
        options: [
          {
            id: 'opt-a',
            description: 'A',
            subDecisions: ['How do we keep sync?', 'What is the GC policy?'],
          },
          { id: 'opt-b', description: 'B' },
        ],
      },
    });
    const stageC: StageCOutput = makeStageC({
      subDecisionsImplied: [
        { optionId: 'opt-a', followUp: 'Override window?' },
        { optionId: 'opt-b', followUp: 'How to dedup?' },
      ],
    });
    const graph = buildSubDecisionGraph(decision, stageC);
    expect(graph).toHaveLength(2);
    expect(graph[0].subDecisions).toEqual([
      { text: 'How do we keep sync?', source: 'declared' },
      { text: 'What is the GC policy?', source: 'declared' },
      { text: 'Override window?', source: 'implied' },
    ]);
    expect(graph[1].subDecisions).toEqual([{ text: 'How to dedup?', source: 'implied' }]);
  });

  it('returns nodes with empty subDecisions when neither source has data', () => {
    const graph = buildSubDecisionGraph(baseDecision(), undefined);
    expect(graph).toHaveLength(2);
    expect(graph.every((n) => n.subDecisions.length === 0)).toBe(true);
  });
});

// ── renderSubDecisionGraphMermaid ────────────────────────────────────────────

describe('renderSubDecisionGraphMermaid', () => {
  it('returns null when no option has sub-decisions (AC#5 backward-compat)', () => {
    const graph = buildSubDecisionGraph(baseDecision(), undefined);
    expect(renderSubDecisionGraphMermaid(graph, 'DEC-0042')).toBeNull();
  });

  it('renders a flowchart with the decision as root and options as children', () => {
    const decision = baseDecision({
      spec: {
        summary: 'x',
        options: [
          { id: 'opt-a', description: 'A', subDecisions: ['sub-1', 'sub-2'] },
          { id: 'opt-b', description: 'B' },
        ],
      },
    });
    const graph = buildSubDecisionGraph(decision, undefined);
    const mermaid = renderSubDecisionGraphMermaid(graph, 'DEC-0042');
    expect(mermaid).not.toBeNull();
    expect(mermaid!).toMatch(/flowchart TD/);
    expect(mermaid!).toMatch(/D\["DEC-0042"\]/);
    expect(mermaid!).toMatch(/O0\["opt-a: A"\]/);
    expect(mermaid!).toMatch(/D --> O0/);
    expect(mermaid!).toMatch(/O0 --> O0S0/);
    expect(mermaid!).toMatch(/O0S0\["sub-1"\]/);
    expect(mermaid!).toMatch(/O0S1\["sub-2"\]/);
    // opt-b has no sub-decisions → SKIPPED from the diagram (AC#5)
    expect(mermaid!).not.toMatch(/opt-b/);
  });

  it('marks Stage C-implied sub-decisions with the ?? prefix', () => {
    const decision = baseDecision({
      spec: { summary: 'x', options: [{ id: 'opt-a', description: 'A' }] },
    });
    const graph = buildSubDecisionGraph(
      decision,
      makeStageC({ subDecisionsImplied: [{ optionId: 'opt-a', followUp: 'maybe X?' }] }),
    );
    const mermaid = renderSubDecisionGraphMermaid(graph, 'DEC-0042');
    expect(mermaid).toMatch(/\? maybe X\?/);
  });

  it('escapes internal double-quotes in labels', () => {
    const decision = baseDecision({
      spec: {
        summary: 'x',
        options: [{ id: 'opt-a', description: 'Quoted "fields" choice', subDecisions: ['ok'] }],
      },
    });
    const graph = buildSubDecisionGraph(decision, undefined);
    const mermaid = renderSubDecisionGraphMermaid(graph, 'DEC-0042');
    expect(mermaid).toMatch(/Quoted &quot;fields&quot; choice/);
  });
});

// ── renderStageProvenance ────────────────────────────────────────────────────

describe('renderStageProvenance', () => {
  it('returns empty array when no stages have provenance (AC#5 backward-compat)', () => {
    const view: DecisionSupportView = buildDecisionSupportView(baseDecision());
    expect(renderStageProvenance(view)).toEqual([]);
  });

  it('emits Stage A only when only Stage A is present', () => {
    const decision = baseDecision({
      status: { lifecycle: 'open', evaluation: { stageA: makeStageA() } },
    });
    const view = buildDecisionSupportView(decision);
    const lines = renderStageProvenance(view);
    expect(lines.some((l) => l.includes('### Stage A'))).toBe(true);
    expect(lines.some((l) => l.includes('### Stage B'))).toBe(false);
    expect(lines.some((l) => l.includes('### Stage C'))).toBe(false);
  });

  it('emits Stage A + B + C with separator lines when all three present (AC#4)', () => {
    const decision = baseDecision({
      status: {
        lifecycle: 'open',
        evaluation: { stageA: makeStageA(), stageB: makeStageB(), stageC: makeStageC() },
      },
    });
    const view = buildDecisionSupportView(decision);
    const lines = renderStageProvenance(view);
    expect(lines.some((l) => l.includes('### Stage A'))).toBe(true);
    expect(lines.some((l) => l.includes('### Stage B'))).toBe(true);
    expect(lines.some((l) => l.includes('### Stage C'))).toBe(true);
    // Composite/threshold/model surfaced for Stage C audit
    expect(lines.some((l) => l.includes('threshold:'))).toBe(true);
    expect(lines.some((l) => l.includes('model:'))).toBe(true);
  });

  it('surfaces sub-actors only when present (Stage B multi-pillar)', () => {
    const decisionSingle = baseDecision({
      status: {
        lifecycle: 'open',
        evaluation: {
          stageB: makeStageB({
            routing: {
              primaryActor: 'eng@example.com',
              subActors: [],
              rationale: 'single-pillar',
              llmEligible: false,
            },
          }),
        },
      },
    });
    const viewSingle = buildDecisionSupportView(decisionSingle);
    const linesSingle = renderStageProvenance(viewSingle);
    expect(linesSingle.some((l) => l.includes('sub-actors'))).toBe(false);

    const decisionMulti = baseDecision({
      status: { lifecycle: 'open', evaluation: { stageB: makeStageB() } },
    });
    const viewMulti = buildDecisionSupportView(decisionMulti);
    const linesMulti = renderStageProvenance(viewMulti);
    expect(
      linesMulti.some((l) => l.includes('sub-actors: eng@example.com, product@example.com')),
    ).toBe(true);
  });

  it('surfaces Stage C error + auto-apply window when present', () => {
    const decision = baseDecision({
      status: {
        lifecycle: 'open',
        evaluation: {
          stageC: makeStageC({
            error: 'invoker timed out',
            autoApplyAt: '2026-05-15T10:05:00.000Z',
            overrideWindowHours: 24,
          }),
        },
      },
    });
    const view = buildDecisionSupportView(decision);
    const lines = renderStageProvenance(view);
    expect(lines.some((l) => l.includes('error: invoker timed out'))).toBe(true);
    expect(lines.some((l) => l.includes('auto-applied at:'))).toBe(true);
    expect(lines.some((l) => l.includes('override window: 24h'))).toBe(true);
  });
});

// ── renderDecisionSupportSurface ─────────────────────────────────────────────

describe('renderDecisionSupportSurface', () => {
  it('renders the minimal Phase-1-style decision (problem + options only)', () => {
    const view = buildDecisionSupportView(baseDecision());
    const rendered = renderDecisionSupportSurface(view);
    expect(rendered).toMatch(/## Problem/);
    expect(rendered).toMatch(/routing strategy/);
    expect(rendered).toMatch(/## Options/);
    expect(rendered).toMatch(/\*\*opt-a\*\*/);
    expect(rendered).toMatch(/\*\*opt-b\*\*/);
    // AC#5: backward-compat sections absent
    expect(rendered).not.toMatch(/## Recommendation/);
    expect(rendered).not.toMatch(/## Counter-arguments/);
    expect(rendered).not.toMatch(/## Sub-decision graph/);
    expect(rendered).not.toMatch(/## Verdict provenance/);
  });

  it('renders the full surface for a fully-evaluated decision (AC#1 #2 #4)', () => {
    const decision = baseDecision({
      spec: {
        summary: 'Pick routing',
        body: 'Multi-pillar question',
        options: [
          {
            id: 'opt-a',
            description: 'Operator routes',
            consequences: ['no deadlock'],
            subDecisions: ['back-off model'],
          },
          { id: 'opt-b', description: 'Concurrent sign-off' },
        ],
      },
      status: {
        lifecycle: 'open',
        evaluation: { stageA: makeStageA(), stageB: makeStageB(), stageC: makeStageC() },
      },
    });
    const view = buildDecisionSupportView(decision);
    const rendered = renderDecisionSupportSurface(view);
    // AC#1 — recommendation, confidence, counter-argument all rendered
    expect(rendered).toMatch(/## Recommendation/);
    expect(rendered).toMatch(/\*\*option:\*\* opt-a/);
    expect(rendered).toMatch(/\*\*confidence:\*\* 0\.820/);
    expect(rendered).toMatch(/## Counter-arguments/);
    expect(rendered).toMatch(/Concurrent sign-off would preserve/);
    // AC#2 — Mermaid graph
    expect(rendered).toMatch(/```mermaid/);
    expect(rendered).toMatch(/flowchart TD/);
    expect(rendered).toMatch(/D\["DEC-0042"\]/);
    // AC#2 fallback — text outline included alongside Mermaid for TUI consumers
    expect(rendered).toMatch(/Text outline \(TUI fallback\)/);
    // AC#4 — Stage A/B/C provenance all surfaced
    expect(rendered).toMatch(/### Stage A/);
    expect(rendered).toMatch(/### Stage B/);
    expect(rendered).toMatch(/### Stage C/);
  });

  it('renders option dependents when present', () => {
    const decision = baseDecision({
      spec: {
        summary: 'x',
        options: [{ id: 'opt-a', description: 'A', dependents: ['AISDLC-100', 'AISDLC-101'] }],
      },
    });
    const view = buildDecisionSupportView(decision);
    const rendered = renderDecisionSupportSurface(view);
    expect(rendered).toMatch(/dependent: AISDLC-100/);
    expect(rendered).toMatch(/dependent: AISDLC-101/);
  });

  it('surfaces auto-applied recommendation status differently from pending-operator', () => {
    const autoApplied = baseDecision({
      status: {
        lifecycle: 'answered',
        answeredOptionId: 'opt-a',
        answeredBy: 'framework',
        evaluation: { stageC: makeStageC() },
      },
    });
    const renderedAuto = renderDecisionSupportSurface(buildDecisionSupportView(autoApplied));
    expect(renderedAuto).toMatch(/\*\*status:\*\* auto-applied/);

    const pending = baseDecision({
      status: { lifecycle: 'open', evaluation: { stageC: makeStageC() } },
    });
    const renderedPending = renderDecisionSupportSurface(buildDecisionSupportView(pending));
    expect(renderedPending).toMatch(/\*\*status:\*\* pending-operator/);
  });
});

// ── Phase 10 (AISDLC-294) — HTML graph renderer ─────────────────────────────

describe('renderSubDecisionGraphHtml', () => {
  it('returns null when graph has no sub-decisions', () => {
    const decision = baseDecision();
    const graph = buildSubDecisionGraph(decision, undefined);
    expect(renderSubDecisionGraphHtml(graph, decision.metadata.id)).toBeNull();
  });

  it('emits a standalone HTML doc when graph has content', () => {
    const decision = baseDecision({
      spec: {
        summary: 'x',
        options: [{ id: 'opt-a', description: 'A', subDecisions: ['who owns the rollout?'] }],
      },
    });
    const graph = buildSubDecisionGraph(decision, undefined);
    const html = renderSubDecisionGraphHtml(graph, decision.metadata.id);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('class="mermaid"');
    expect(html).toContain('flowchart TD');
    expect(html).toContain('who owns the rollout?');
    expect(html).toContain('mermaid.esm.min.mjs');
  });

  it('HTML-escapes the page title', () => {
    const decision = baseDecision({ metadata: { ...baseDecision().metadata, id: 'DEC-0042' } });
    decision.spec = {
      summary: 'x',
      options: [{ id: 'opt-a', description: 'A', subDecisions: ['x'] }],
    };
    const graph = buildSubDecisionGraph(decision, undefined);
    const html = renderSubDecisionGraphHtml(graph, decision.metadata.id);
    expect(html).toContain('Decision DEC-0042 — sub-decision graph');
  });

  it('defends against </script> injection in option text', () => {
    const decision = baseDecision({
      spec: {
        summary: 'x',
        options: [
          {
            id: 'opt-a',
            description: 'A</script><script>alert(1)</script>',
            subDecisions: ['x'],
          },
        ],
      },
    });
    const graph = buildSubDecisionGraph(decision, undefined);
    const html = renderSubDecisionGraphHtml(graph, decision.metadata.id);
    // The literal `</script>` must NOT appear in the rendered HTML at the
    // top-level (any occurrence must be escaped). Mermaid metachar handling
    // happens inside the Mermaid renderer, but the HTML wrapper must
    // sanitize.
    expect(html).not.toMatch(/<\/script><script>alert/);
    expect(html).toContain('&lt;/script&gt;');
  });
});
