/**
 * RFC-0009 Phase 2.1 — tessellation admission composite tests.
 *
 * Covers acceptance criteria:
 *   AC #1: Admission composite reads `tessellation` field and routes through soul scope
 *   AC #2: `resolveAffectedSouls(w)` reads RFC-0014 dep-graph snapshot entries
 *   AC #3: Substrate-only changes fall through to min-over-all-souls degenerate case
 *   AC #4: Sα + Eρ₄ scores propagate per-soul correctly
 *   AC #5: Test fixtures cover tessellated+soul-touching, tessellated+substrate-only,
 *          non-tessellated (legacy path)
 */

import { describe, it, expect } from 'vitest';

import {
  resolveAffectedSouls,
  applyCrossSoulRule,
  computeTessellatedScores,
  type DepGraphSoulEntry,
  type TessellationContext,
  type SoulScores,
} from './tessellation-admission.js';

import { computeAdmissionComposite } from './admission-composite.js';
import type { AdmissionInput } from './admission-score.js';

// ── Fixture factories ──────────────────────────────────────────────────

function makeTessellation() {
  return {
    souls: [
      { soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a', status: 'active' as const },
      { soulId: 'soul-b', didUri: 'did:platform-x:soul:soul-b', status: 'active' as const },
      { soulId: 'soul-c', didUri: 'did:platform-x:soul:soul-c', status: 'active' as const },
    ],
    crossSoulScoringRule: 'min' as const,
    substrateInvariants: ['no-soul-conditionals-in-substrate'],
  };
}

function makeSoulScores(): Record<string, SoulScores> {
  return {
    'soul-a': { soulAlignment: 0.9, er4: 0.8 }, // high-scoring soul (e.g. HIPAA, mature DSB)
    'soul-b': { soulAlignment: 0.6, er4: 0.5 }, // medium-scoring soul
    'soul-c': { soulAlignment: 0.3, er4: 0.4 }, // low-scoring soul (e.g. nascent DSB)
  };
}

function makeDepGraphEntries(soulA = true): DepGraphSoulEntry[] {
  return [
    {
      id: 'AISDLC-313',
      targetedSoulIds: soulA ? ['soul-a'] : [],
    },
    {
      id: 'AISDLC-100',
      targetedSoulIds: ['soul-b', 'soul-c'], // multi-soul substrate change
    },
    {
      id: 'AISDLC-200',
      targetedSoulIds: [], // substrate-only task
    },
    // AISDLC-999 is NOT in the entries → treated as substrate-only
  ];
}

/**
 * Build an admission input with a canonical workItemId (e.g. "AISDLC-313").
 * The `workItemId` field is used by the tessellation routing to look up the
 * work item in the dep-graph snapshot entries — it must match the entry's
 * `id` field (RFC-0014 snapshot format: "AISDLC-N").
 *
 * `platformDsbContext` simulates the platform-aggregate DSB at low coverage
 * (lifecycle: stabilizing → catalogCoverage=40%, tokenCompliance=40%) so the
 * baseline score reflects the "Design pillar locked at 0.40" scenario from
 * RFC-0009 §2.1. The tessellated version uses soul-a's higher per-soul DSB.
 */
function makeAdmissionInput(issueNumber: number, taskId?: string): AdmissionInput {
  return {
    issueNumber,
    workItemId: taskId ?? `AISDLC-${issueNumber}`,
    title: 'feat: Add payment validation',
    body: '### Complexity\n5\n\n### Acceptance Criteria\n- Payment validator works',
    labels: ['spec'],
    reactionCount: 0,
    commentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    authorAssociation: 'OWNER',
    // Simulate platform-aggregate DSB at low coverage (the "locked at 0.40" scenario).
    // Eρ₄ from this context: 0.4×40 + 0.3×40 + 0.3×0 = 0.16 + 0.12 = 0.28
    // With inBootstrapPhase=false → postDesignSystem: computed = 0.28
    // (baseline Eρ₄ ≈ 0.28, well below soul-a's 0.80)
    designSystemContext: {
      catalogCoverage: 40,
      tokenCompliance: 40,
      inBootstrapPhase: false,
      baselineCoverage: 0,
      catalogGaps: [],
    },
  };
}

// ── resolveAffectedSouls unit tests ────────────────────────────────────

describe('resolveAffectedSouls', () => {
  const tessellation = makeTessellation();

  it('AC #2: returns soul IDs from dep-graph entry when present', () => {
    const entries = makeDepGraphEntries();
    const result = resolveAffectedSouls('AISDLC-313', entries, tessellation);
    expect(result).toEqual(['soul-a']);
  });

  it('AC #2: is case-insensitive on work item ID lookup', () => {
    const entries = makeDepGraphEntries();
    const result = resolveAffectedSouls('aisdlc-313', entries, tessellation);
    expect(result).toEqual(['soul-a']);
  });

  it('AC #3: returns empty array when entry has empty targetedSoulIds', () => {
    const entries = makeDepGraphEntries();
    const result = resolveAffectedSouls('AISDLC-200', entries, tessellation);
    expect(result).toEqual([]);
  });

  it('AC #3: returns empty array when work item not found in snapshot entries', () => {
    const entries = makeDepGraphEntries();
    const result = resolveAffectedSouls('AISDLC-999', entries, tessellation);
    expect(result).toEqual([]);
  });

  it('AC #3: returns empty array when depGraphEntries is undefined', () => {
    const result = resolveAffectedSouls('AISDLC-313', undefined, tessellation);
    expect(result).toEqual([]);
  });

  it('AC #3: returns empty array when depGraphEntries is empty', () => {
    const result = resolveAffectedSouls('AISDLC-313', [], tessellation);
    expect(result).toEqual([]);
  });

  it('AC #2: returns multiple soul IDs for substrate work touching multiple souls', () => {
    const entries = makeDepGraphEntries();
    const result = resolveAffectedSouls('AISDLC-100', entries, tessellation);
    expect(result).toEqual(['soul-b', 'soul-c']);
  });

  it('filters out soul IDs not present in the tessellation manifest', () => {
    const entries: DepGraphSoulEntry[] = [
      { id: 'AISDLC-X', targetedSoulIds: ['soul-a', 'soul-unknown'] },
    ];
    const result = resolveAffectedSouls('AISDLC-X', entries, tessellation);
    expect(result).toEqual(['soul-a']); // 'soul-unknown' filtered out
  });
});

// ── applyCrossSoulRule unit tests ──────────────────────────────────────

describe('applyCrossSoulRule', () => {
  const scores = { 'soul-a': 0.9, 'soul-b': 0.6, 'soul-c': 0.3 };

  it('min rule returns the lowest soul score', () => {
    expect(applyCrossSoulRule(['soul-a', 'soul-b', 'soul-c'], scores, 'min')).toBeCloseTo(0.3, 8);
  });

  it('max rule returns the highest soul score', () => {
    expect(applyCrossSoulRule(['soul-a', 'soul-b', 'soul-c'], scores, 'max')).toBeCloseTo(0.9, 8);
  });

  it('mean rule returns the arithmetic mean', () => {
    const result = applyCrossSoulRule(['soul-a', 'soul-b', 'soul-c'], scores, 'mean');
    expect(result).toBeCloseTo((0.9 + 0.6 + 0.3) / 3, 5);
  });

  it('weighted-traffic degenerates to min (no weight data available)', () => {
    expect(applyCrossSoulRule(['soul-a', 'soul-c'], scores, 'weighted-traffic')).toBeCloseTo(
      0.3,
      8,
    );
  });

  it('weighted-revenue degenerates to min (no weight data available)', () => {
    expect(applyCrossSoulRule(['soul-a', 'soul-c'], scores, 'weighted-revenue')).toBeCloseTo(
      0.3,
      8,
    );
  });

  it('undefined rule defaults to min', () => {
    expect(applyCrossSoulRule(['soul-a', 'soul-b'], scores, undefined)).toBeCloseTo(0.6, 8);
  });

  it('returns fallback when no matching soul scores exist', () => {
    expect(applyCrossSoulRule(['soul-z'], scores, 'min', 0.42)).toBeCloseTo(0.42, 8);
  });

  it('returns fallback when soulIds array is empty', () => {
    expect(applyCrossSoulRule([], scores, 'min', 0.42)).toBeCloseTo(0.42, 8);
  });
});

// ── computeTessellatedScores unit tests ───────────────────────────────

describe('computeTessellatedScores', () => {
  const tessellation = makeTessellation();
  const soulScores = makeSoulScores();

  // ── AC #5 Fixture 1: tessellated DID + soul-touching change ──────

  it('AC #4 + AC #5 [fixture-1]: single-soul work item routes to that soul DSB', () => {
    // soul-a has soulAlignment=0.9, er4=0.8 — higher than platform aggregate
    const ctx: TessellationContext = {
      tessellation,
      soulScores,
      depGraphEntries: makeDepGraphEntries(true),
    };
    const result = computeTessellatedScores('AISDLC-313', 0.5, 0.5, ctx);

    expect(result.routingPath).toBe('single-soul');
    expect(result.affectedSoulIds).toEqual(['soul-a']);
    // Soul-A has soulAlignment=0.9, er4=0.8 — per-soul DSB lifted above platform aggregate
    expect(result.soulAlignment).toBeCloseTo(0.9, 8);
    expect(result.er4).toBeCloseTo(0.8, 8);
  });

  // ── AC #5 Fixture 2: tessellated DID + substrate-only change ─────

  it('AC #3 + AC #5 [fixture-2]: substrate-only change falls through to min over ALL souls', () => {
    const ctx: TessellationContext = {
      tessellation,
      soulScores,
      depGraphEntries: makeDepGraphEntries(), // AISDLC-200 has no soul scope
    };
    // AISDLC-200 has empty targetedSoulIds → substrate-only
    const result = computeTessellatedScores('AISDLC-200', 0.5, 0.5, ctx);

    expect(result.routingPath).toBe('substrate-only');
    expect(result.affectedSoulIds).toEqual([]);
    // min over ALL souls: min(0.9, 0.6, 0.3) = 0.3 for soulAlignment
    expect(result.soulAlignment).toBeCloseTo(0.3, 8);
    // min over ALL souls: min(0.8, 0.5, 0.4) = 0.4 for er4
    expect(result.er4).toBeCloseTo(0.4, 8);
  });

  it('AC #3 [fixture-2 variant]: work item missing from snapshot → substrate-only degenerate', () => {
    const ctx: TessellationContext = {
      tessellation,
      soulScores,
      depGraphEntries: makeDepGraphEntries(),
    };
    // AISDLC-999 not in the snapshot → empty affected souls
    const result = computeTessellatedScores('AISDLC-999', 0.5, 0.5, ctx);

    expect(result.routingPath).toBe('substrate-only');
    expect(result.soulAlignment).toBeCloseTo(0.3, 8); // min over all
  });

  // ── AC #5 Fixture 3: non-tessellated DID (legacy path) ───────────

  it('AC #1 + AC #5 [fixture-3]: no tessellationContext → non-tessellated legacy path', () => {
    const result = computeTessellatedScores('AISDLC-313', 0.75, 0.65, undefined);

    expect(result.routingPath).toBe('non-tessellated');
    expect(result.affectedSoulIds).toEqual([]);
    // Fallback values are preserved unchanged (single-DID semantics)
    expect(result.soulAlignment).toBeCloseTo(0.75, 8);
    expect(result.er4).toBeCloseTo(0.65, 8);
  });

  // ── Multi-soul path ─────────────────────────────────────────────

  it('AC #4: multi-soul substrate change applies crossSoulScoringRule over affected souls only', () => {
    const ctx: TessellationContext = {
      tessellation,
      soulScores,
      depGraphEntries: makeDepGraphEntries(),
    };
    // AISDLC-100 targets soul-b and soul-c (NOT soul-a)
    // min(soul-b.sa=0.6, soul-c.sa=0.3) = 0.3 — NOT min over all 3 souls
    const result = computeTessellatedScores('AISDLC-100', 0.5, 0.5, ctx);

    expect(result.routingPath).toBe('multi-soul');
    expect(result.affectedSoulIds).toEqual(['soul-b', 'soul-c']);
    expect(result.soulAlignment).toBeCloseTo(0.3, 8); // min(0.6, 0.3)
    expect(result.er4).toBeCloseTo(0.4, 8); // min(0.5, 0.4)
  });

  it('AC #4: non-default crossSoulScoringRule (max) is respected', () => {
    const maxTessellation = { ...makeTessellation(), crossSoulScoringRule: 'max' as const };
    const ctx: TessellationContext = {
      tessellation: maxTessellation,
      soulScores,
      depGraphEntries: makeDepGraphEntries(),
    };
    const result = computeTessellatedScores('AISDLC-100', 0.5, 0.5, ctx);

    expect(result.routingPath).toBe('multi-soul');
    expect(result.soulAlignment).toBeCloseTo(0.6, 8); // max(0.6, 0.3)
    expect(result.er4).toBeCloseTo(0.5, 8); // max(0.5, 0.4)
  });
});

// ── computeAdmissionComposite with tessellationContext ─────────────────

describe('computeAdmissionComposite + tessellationContext (AC #1, #4)', () => {
  const tessellation = makeTessellation();
  const soulScores = makeSoulScores();

  // AC #5 Fixture 1: tessellated DID + soul-touching change
  it('[fixture-1] soul-bounded work uses soul-a DSB → higher pillar value', () => {
    // Input carries the platform-aggregate DSB at low coverage (Eρ₄ ≈ 0.28).
    // The baseline composite is: SA=0.9 × D-pi × min(0.5, 0.28) × (1+HC).
    const input = makeAdmissionInput(313); // work item "AISDLC-313" → targets soul-a

    // Platform-aggregate baseline (pre-tessellation):
    //   soulAlignment=0.9 (label 'spec'), designSystemReadiness=0.28 (platform DSB).
    const baseline = computeAdmissionComposite(input);

    // With tessellation — soul-a has soulAlignment=0.9, er4=0.8 (established DSB).
    // Tessellated composite: SA=0.9 × D-pi × min(0.5, 0.8) × (1+HC) — Eρ₄ lifted.
    const ctx: TessellationContext = {
      tessellation,
      soulScores,
      depGraphEntries: makeDepGraphEntries(true),
    };
    const tessellated = computeAdmissionComposite(input, undefined, {
      tessellationContext: ctx,
    });

    // The per-soul Eρ₄ (0.80) lifts executionReality above the platform-aggregate (0.28).
    // This produces a higher composite — demonstrating the "Design pillar lift" §11.4.
    expect(tessellated.score.composite).toBeGreaterThan(baseline.score.composite);
    expect(tessellated.breakdown.soulAlignment).toBeCloseTo(0.9, 8); // per-soul Sα (soul-a)
    // soul-a's Eρ₄=0.8 > platform-aggregate 0.28 → execution reality lifted
    expect(tessellated.breakdown.designSystemReadiness).toBeCloseTo(0.8, 8);
    expect(tessellated.breakdown.tessellation?.routingPath).toBe('single-soul');
    expect(tessellated.breakdown.tessellation?.affectedSoulIds).toEqual(['soul-a']);
  });

  // AC #5 Fixture 2: tessellated DID + substrate-only change
  it('[fixture-2] substrate-only change uses min-over-all-souls → lower pillar value', () => {
    const input = makeAdmissionInput(200); // work item "AISDLC-200" → substrate-only

    const ctx: TessellationContext = {
      tessellation,
      soulScores,
      depGraphEntries: makeDepGraphEntries(),
    };
    const tessellated = computeAdmissionComposite(input, undefined, {
      tessellationContext: ctx,
    });

    // Substrate-only: min over all souls → soul-c's low scores dominate
    expect(tessellated.breakdown.soulAlignment).toBeCloseTo(0.3, 8); // min(0.9, 0.6, 0.3)
    expect(tessellated.breakdown.designSystemReadiness).toBeCloseTo(0.4, 8); // min(0.8, 0.5, 0.4)
    expect(tessellated.breakdown.tessellation?.routingPath).toBe('substrate-only');
    expect(tessellated.breakdown.tessellation?.affectedSoulIds).toEqual([]);
  });

  // AC #5 Fixture 3: non-tessellated DID (legacy path)
  it('[fixture-3] no tessellationContext → legacy single-DID path unchanged', () => {
    const input = makeAdmissionInput(313);

    const legacy = computeAdmissionComposite(input);
    const noTessellation = computeAdmissionComposite(input, undefined, {});

    // Both calls produce the same composite (tessellationContext absent).
    // toBeCloseTo for float-accumulation determinism — runner-to-runner ulp
    // differences caused intermittent CI failures (AISDLC-374).
    expect(legacy.score.composite).toBeCloseTo(noTessellation.score.composite, 8);
    expect(legacy.breakdown.soulAlignment).toBeCloseTo(noTessellation.breakdown.soulAlignment, 8);
    // No tessellation breakdown field in legacy path
    expect(legacy.breakdown.tessellation).toBeUndefined();
    expect(noTessellation.breakdown.tessellation).toBeUndefined();
  });

  it('AC #1: tessellation field presence is what triggers routing — not labels', () => {
    const input = makeAdmissionInput(313);

    // Same input, two invocations — tessellationContext controls routing
    const withTessellation = computeAdmissionComposite(input, undefined, {
      tessellationContext: {
        tessellation,
        soulScores,
        depGraphEntries: makeDepGraphEntries(true),
      },
    });
    const withoutTessellation = computeAdmissionComposite(input);

    expect(withTessellation.breakdown.tessellation?.routingPath).toBe('single-soul');
    expect(withoutTessellation.breakdown.tessellation).toBeUndefined();
    // Both inputs have soulAlignment=0.9 from the 'spec' label heuristic;
    // tessellation routes to soul-a which also has soulAlignment=0.9 → same.
    expect(withTessellation.breakdown.soulAlignment).toBeCloseTo(0.9, 8);
    // The key tessellation lift is in designSystemReadiness (Eρ₄):
    //   - no-tessellation: platform-aggregate DSB (coverage=40%) → er4 ≈ 0.28
    //   - with-tessellation: soul-a's DSB (er4=0.8) → lifted
    expect(withTessellation.breakdown.designSystemReadiness).toBeGreaterThan(
      withoutTessellation.breakdown.designSystemReadiness,
    );
  });

  it('tessellation breakdown is absent when no tessellationContext provided', () => {
    const input = makeAdmissionInput(1);
    const result = computeAdmissionComposite(input);
    expect(result.breakdown.tessellation).toBeUndefined();
  });
});
