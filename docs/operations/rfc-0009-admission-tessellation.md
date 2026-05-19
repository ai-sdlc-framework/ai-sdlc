# RFC-0009 Phase 2.1 — Tessellation Routing for Admission Composite

**Status:** Implemented (AISDLC-313)  
**RFC:** [RFC-0009 §6 + §10 Phase 2](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md)  
**Depends on:** [RFC-0014 dep-graph composition](./deps-composition.md)

---

## Overview

Phase 2.1 extends the admission composite (`orchestrator/src/admission-composite.ts`) to
recognize the `tessellation` field on a Tessellated DID and route Soul Alignment (Sα) and
Design System Readiness (Eρ₄) through soul scope, per RFC-0009 §6.

Without tessellation routing, all work items score against the **platform-aggregate DSB** —
producing artificially flat scores (empirically observed: Design pillar locked at 0.40 when
soul-bounded work should score 0.7+ against the soul's own DSB). With tessellation routing,
soul-bounded work scores against the correct soul's DSB, lifting the Design pillar to its
proper value.

---

## Algorithm (RFC-0009 §6)

```
resolveAffectedSouls(w) → reads RFC-0014 dep-graph snapshot → returns affected soul IDs

If tessellation absent on DID:
  → single-DID path; behavior unchanged from RFC-0008

Else if |resolveAffectedSouls(w)| == 0:
  → substrate-only; Sα = min over ALL souls, Eρ₄ = min over ALL souls

Else if |resolveAffectedSouls(w)| == 1:
  → Sα = soul.soulAlignment, Eρ₄ = soul.er4  (soul-specific DSB)

Else:
  → Sα = crossSoulScoringRule(affectedSouls.soulAlignment)  (default `min`)
  → Eρ₄ = crossSoulScoringRule(affectedSouls.er4)
```

The **OQ-2 sub-decision** constrains "substrate-only" to mean: the work item's dep-graph entry
has an empty `targetedSoulIds` array, **or** the entry is absent from the snapshot entirely.
Only then does the `min`-over-all-souls degenerate case fire (§6 last clause). This prevents
over-pessimization of substrate changes that demonstrably touch only a subset of souls.

---

## Before / After Admit Invocations

### Setup — three-soul Platform-X

```typescript
import {
  computeAdmissionComposite,
  type AdmissionInput,
  type TessellationContext,
  type SoulScores,
} from '@ai-sdlc/orchestrator';

// Platform-X tessellation manifest (from Tessellated DID)
const tessellation = {
  souls: [
    { soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a', status: 'active' },
    { soulId: 'soul-b', didUri: 'did:platform-x:soul:soul-b', status: 'active' },
    { soulId: 'soul-c', didUri: 'did:platform-x:soul:soul-c', status: 'active' },
  ],
  crossSoulScoringRule: 'min',
  substrateInvariants: ['no-soul-conditionals-in-substrate'],
};

// Per-soul scores (computed from each soul's DSB at .ai-sdlc/souls/<slug>/design-system-binding.yaml)
const soulScores: Record<string, SoulScores> = {
  'soul-a': { soulAlignment: 0.9, er4: 0.8 },  // soul-a: established DSB, HIPAA-clear
  'soul-b': { soulAlignment: 0.6, er4: 0.5 },  // soul-b: bootstrapping DSB
  'soul-c': { soulAlignment: 0.3, er4: 0.4 },  // soul-c: nascent DSB, PCI-DSS scope
};

// Dep-graph soul scope entries (read from RFC-0014 snapshot via pipeline-cli)
const depGraphEntries = [
  { id: 'AISDLC-313', targetedSoulIds: ['soul-a'] },    // soul-bounded work
  { id: 'AISDLC-200', targetedSoulIds: [] },             // substrate-only work
];
```

---

### Invocation 1 (BEFORE — pre-tessellation, single-DID path)

**Work item:** AISDLC-313 (feat: Add HIPAA audit trail — targets Soul-A)

```typescript
const input: AdmissionInput = {
  issueNumber: 313,
  title: 'feat: Add HIPAA audit trail to soul-a patient module',
  body: '### Complexity\n5\n### Acceptance Criteria\n- Audit log captures all PHI access',
  labels: ['spec', 'compliance'],
  reactionCount: 0,
  commentCount: 2,
  createdAt: '2026-05-01T00:00:00Z',
  authorAssociation: 'OWNER',
};

// Before: no tessellation context — platform-aggregate DSB applies
const before = computeAdmissionComposite(input);

console.log('BEFORE (single-DID / platform-aggregate)');
console.log('  soulAlignment:', before.breakdown.soulAlignment);       // ~0.85 (label heuristic)
console.log('  designSystemReadiness:', before.breakdown.designSystemReadiness);  // platform-aggregate Eρ₄
console.log('  composite:', before.score.composite.toFixed(4));
console.log('  tessellation:', before.breakdown.tessellation);         // undefined
```

Expected output:
```
BEFORE (single-DID / platform-aggregate)
  soulAlignment: 0.85          ← label heuristic (compliance → 0.85)
  designSystemReadiness: 0.40  ← platform-aggregate DSB (lifecycle: stabilizing)
  composite: 0.2295            ← SA × D-pi × ER × (1+HC)
  tessellation: undefined
```

---

### Invocation 2 (AFTER — tessellation routing, soul-a path)

```typescript
const tessellationCtx: TessellationContext = {
  tessellation,
  soulScores,
  depGraphEntries,
};

// After: tessellation context present — soul-a DSB applies
const after = computeAdmissionComposite(input, undefined, {
  tessellationContext: tessellationCtx,
});

console.log('AFTER (soul-bounded, soul-a DSB)');
console.log('  soulAlignment:', after.breakdown.soulAlignment);        // 0.9 (soul-a)
console.log('  designSystemReadiness:', after.breakdown.designSystemReadiness);  // 0.8 (soul-a)
console.log('  composite:', after.score.composite.toFixed(4));         // lifted
console.log('  tessellation.routingPath:', after.breakdown.tessellation?.routingPath);  // 'single-soul'
console.log('  tessellation.affectedSoulIds:', after.breakdown.tessellation?.affectedSoulIds); // ['soul-a']
```

Expected output:
```
AFTER (soul-bounded, soul-a DSB)
  soulAlignment: 0.9           ← soul-a's per-soul Sα
  designSystemReadiness: 0.8   ← soul-a's per-soul Eρ₄ (established DSB, 0.8 vs 0.4 platform-aggregate)
  composite: 0.4428            ← higher composite due to soul-specific pillar values
  tessellation.routingPath: 'single-soul'
  tessellation.affectedSoulIds: ['soul-a']
```

**Design pillar lift: 0.40 → 0.80** (the empirical gap noted in RFC-0009 §2.1 is closed).

---

### Invocation 3 (AFTER — substrate-only work, min-over-all-souls degenerate)

**Work item:** AISDLC-200 (refactor: Upgrade shared event bus infrastructure)

```typescript
const substrateInput: AdmissionInput = {
  issueNumber: 200,
  title: 'refactor: Upgrade shared event bus (substrate infrastructure)',
  body: '### Complexity\n6\n### Acceptance Criteria\n- Event bus at v3\n- No soul breakage',
  labels: ['tech-debt'],
  reactionCount: 1,
  commentCount: 0,
  createdAt: '2026-05-01T00:00:00Z',
  authorAssociation: 'OWNER',
};

const substrateResult = computeAdmissionComposite(substrateInput, undefined, {
  tessellationContext: tessellationCtx,
});

console.log('SUBSTRATE-ONLY (min over all souls)');
console.log('  soulAlignment:', substrateResult.breakdown.soulAlignment);        // 0.3 (min)
console.log('  designSystemReadiness:', substrateResult.breakdown.designSystemReadiness);  // 0.4 (min)
console.log('  tessellation.routingPath:', substrateResult.breakdown.tessellation?.routingPath);  // 'substrate-only'
console.log('  tessellation.affectedSoulIds:', substrateResult.breakdown.tessellation?.affectedSoulIds); // []
```

Expected output:
```
SUBSTRATE-ONLY (min over all souls)
  soulAlignment: 0.3           ← min(soul-a=0.9, soul-b=0.6, soul-c=0.3) — soul-c's weaker soul constrains substrate
  designSystemReadiness: 0.4   ← min(soul-a=0.8, soul-b=0.5, soul-c=0.4)
  tessellation.routingPath: 'substrate-only'
  tessellation.affectedSoulIds: []
```

The substrate work's composite is lower than soul-a-specific work because it must satisfy every
soul's DSB, not just the highest-scoring one. This surfaces "soul-c's nascent DSB is a constraint
on all substrate work" — an actionable signal to invest in soul-c's DSB before dispatching
heavy substrate refactors.

---

## Building the TessellationContext

In a full Phase 2 implementation, the `TessellationContext` is built by the operator or pipeline
step that reads:

1. **Tessellation manifest** — from the platform's Tessellated DID at
   `.ai-sdlc/dids/<platform-name>.yaml` (the `tessellation` field).

2. **Per-soul DSBs** — from `.ai-sdlc/souls/<slug>/design-system-binding.yaml` per soul.
   Each DSB's `status.catalogHealth.coveragePercent` and `status.tokenCompliance.currentCoverage`
   feed the `computeDesignSystemReadiness` formula to produce the soul's `er4` score.

3. **Per-soul Sα** — from the soul's product vertex `triad.product.problemResonance` + soul DSB
   (same SA-1/SA-2 machinery as the single-DID path, scoped to the soul).

4. **Dep-graph soul scope** — from the latest RFC-0014 snapshot at
   `$ARTIFACTS_DIR/_deps/snapshot.*.jsonl`, read via `pipeline-cli/src/deps/snapshot.ts`.
   Each `SnapshotRecord`'s `id` is the task ID; callers populate `targetedSoulIds` from
   task frontmatter (`soulScope:` field) or soul-targeting labels.

```typescript
import { readLatestDepSnapshot } from '@ai-sdlc/pipeline-cli'; // pipeline-cli layer
import { computeDesignSystemReadiness } from '@ai-sdlc/orchestrator';

// Step 1: Read dep-graph snapshot
const { snapshot } = readLatestDepSnapshot({ workDir: process.cwd() });

// Step 2: Extract soul scope entries
const depGraphEntries = snapshot?.records.map((r) => ({
  id: r.id,
  targetedSoulIds: r.targetedSoulIds ?? [],  // pipeline-cli reader populates this
})) ?? [];

// Step 3: Load per-soul DSBs and compute scores
const soulScores: Record<string, SoulScores> = {};
for (const soul of tessellation.souls) {
  const dsb = await loadSoulDsb(soul.soulId);  // reads .ai-sdlc/souls/<slug>/dsb.yaml
  soulScores[soul.soulId] = {
    soulAlignment: await computeSoulSoulAlignment(soul.soulId, dsb),
    er4: computeDesignSystemReadiness({ designSystemBinding: dsb }),
  };
}
```

---

## Backward Compatibility

- When `tessellationContext` is **absent** from `AdmissionCompositeOptions`, the composite
  behaves exactly as before this change — single-DID path, platform-aggregate DSB, no
  `tessellation` field in the breakdown.
- The `breakdown.tessellation` field is `undefined` when the legacy path is taken.
- Existing callers of `computeAdmissionComposite` require no changes.

---

## Related

- [RFC-0009 §6 — Admission Composite Extension](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md#6-admission-composite-extension)
- [RFC-0014 — Dependency Graph Composition](../../spec/rfcs/RFC-0014-dependency-graph-composition.md)
- [orchestrator/src/tessellation-admission.ts](../../orchestrator/src/tessellation-admission.ts)
- [orchestrator/src/admission-composite.ts](../../orchestrator/src/admission-composite.ts)
