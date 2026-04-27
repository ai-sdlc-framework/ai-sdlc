# Design Intent & Soul Alignment

APIs introduced by RFC-0008 (PPA Triad Integration). They cover three
layers of work: enriching admission inputs from a `DesignIntentDocument`
+ `DesignSystemBinding`, scoring Soul Alignment (SA-1, SA-2), and
closing the feedback loop with category-scoped calibration and drift
detection.

## Module map

| Module | Path | Purpose |
|---|---|---|
| Admission enrichment | `@ai-sdlc/orchestrator` | Populate `designSystemContext`, `autonomyContext`, `codeAreaQuality`, `designAuthoritySignal` from state + resolved resources |
| Admission composite | `@ai-sdlc/orchestrator` | §A.6 admission-subset composite (`SA × D-pi × ER × (1 + HC)`) |
| Pillar breakdown | `@ai-sdlc/orchestrator` | §A.6 product / design / engineering pillar contributions + tension flags |
| SA scoring | `@ai-sdlc/orchestrator` | Three-layer SA scorer (deterministic + BM25 + LLM) — Addendum B |
| DID compiler | `@ai-sdlc/orchestrator` | Compile DID into scope lists, BM25 corpus, principle corpora |
| Depparse client | `@ai-sdlc/orchestrator` | HTTP client for the Python spaCy sidecar |
| Feedback flywheel | `@ai-sdlc/orchestrator` | Category-scoped calibration, phase-weight auto-calibration, drift detection |
| Design Intent reconciler | `@ai-sdlc/reference` | Continuous DID drift / event emission |

## Quick start

Score an issue end-to-end against a DID + DSB pair:

```typescript
import {
  enrichAdmissionInput,
  scoreIssueForAdmission,
  scoreSoulAlignment,
  HttpDepparseClient,
  loadConfigAsync,
  resolveRepoRoot,
  StateStore,
} from '@ai-sdlc/orchestrator';

const workDir = await resolveRepoRoot();
const config = await loadConfigAsync(`${workDir}/.ai-sdlc`);
const did = config.designIntentDocuments?.[0];
const dsb = config.designSystemBindings?.[0];
const stateStore = StateStore.open(`${workDir}/.ai-sdlc/state.db`);

const enriched = enrichAdmissionInput(input, {
  stateStore,
  designSystemBinding: dsb,
  designIntentDocument: did,
  codeArea: 'components/Button.tsx',
});

const result = scoreIssueForAdmission(enriched, {
  minimumScore: 0.05,
  minimumConfidence: 0.2,
});

console.log(result.score.composite);     // SA × D-pi × ER × (1 + HC)
console.log(result.pillarBreakdown);     // product / design / engineering
console.log(result.pillarBreakdown.tensions); // [TensionFlag, ...]
```

For full SA scoring (BM25 + LLM), use `scoreSoulAlignment` and pass its
result into `computeAdmissionComposite`'s `soulAlignmentOverride`.

---

## Admission enrichment

Populate the new RFC-0008 enrichment fields on an `AdmissionInput`. The
function is **stateless when no DSB is resolved** (preDesignSystem
phase) — you can wire it in to existing pipelines without breaking
admission for repos that haven't adopted a design system.

### `enrichAdmissionInput(input, ctx)`

```typescript
function enrichAdmissionInput(
  input: AdmissionInput,
  ctx: EnrichmentContext,
): AdmissionInput;
```

#### `EnrichmentContext`

| Field | Type | Purpose |
|---|---|---|
| `stateStore` | `StateStore?` | Visual baselines, code-area metrics |
| `designSystemBinding` | `DesignSystemBinding?` | Resolved DSB (drives lifecycle phase) |
| `designIntentDocument` | `DesignIntentDocument?` | Resolved DID (threaded through for SA scorer) |
| `dsbAdoptedAt` | `string?` | ISO timestamp; drives age-based bootstrap detection |
| `catalogGaps` | `string[]?` | Pre-computed gaps from a catalog adapter |
| `codeArea` | `string?` | Code area identifier for C3 defect-risk lookup |
| `autonomyPolicy` | `AutonomyPolicy?` | Drives C4 autonomy factor |
| `agentName` | `string?` | Pick a specific entry from `autonomyPolicy.status.agents` |
| `complexity` | `number?` | Maps to required autonomy level (≤3 → L1, ≤6 → L2, else L3) |
| `areaComplianceScore` | `number?` | Modulates C5 design-authority weight |
| `now` | `() => number?` | Injectable clock for tests |

#### Lifecycle phase detection

```typescript
type LifecyclePhase = 'preDesignSystem' | 'catalogBootstrap' | 'postDesignSystem';
```

| Phase | Trigger | `executionReality` |
|---|---|---|
| `preDesignSystem` | No DSB resolved | 1.0 (no design gate) |
| `catalogBootstrap` | `coverage < 20%` AND `age < 90d` | `max(0.3, 0.4×cat + 0.3×tok + 0.3×baseline)` (floor=0.3) |
| `postDesignSystem` | Otherwise | Full §A.5 formula |

#### Helpers

| Function | Purpose |
|---|---|
| `computeDefectRiskFactor(quality)` | C3 defect-risk in `[0, 0.5]` (frontend-aware blend when `hasFrontendComponents`) |
| `computeAutonomyFactor(ctx)` | C4 autonomy gap → factor in `[0.1, 1.0]` |
| `computeDesignAuthorityWeight(signal)` | C5 weight in `[-1, 1]` |
| `computeDesignSystemReadiness(ctx)` | C2 Eρ₄ readiness in `[0.3, 1.0]` |
| `computeBaselineCoverage(store, name)` | Approved/total over `visual_regression_results` |
| `computeDsbAgeDays(adoptedAt, now?)` | Days since adoption (clamped ≥ 0) |
| `complexityToAutonomyLevel(complexity)` | `≤3 → 1`, `≤6 → 2`, else `3` |
| `detectLifecyclePhase(dsb, coverage, ageDays)` | Returns one of the three `LifecyclePhase` values |

---

## Admission composite (§A.6)

The admission-subset composite — a strict subset of the full PPA — used
at admission time. Runtime PPA still applies M-φ, E-τ, C-κ later.

```
P_admission = SA × D-pi_adjusted × ER × (1 + HC)

where  D-pi_adjusted = rawDP × (1 − defectRiskFactor)
       ER            = min(baseER × autonomyFactor, designSystemReadiness)
       baseER        = 1 − complexity / 10
       HC            = tanh(0.2×exp + 0.45×con + 0.25×dec + 0.10×design)
```

`override: true` short-circuits to `composite = Infinity` without
running the math (position-1 bypass preserved).

### `computeAdmissionComposite(input, config?, options?)`

```typescript
interface AdmissionCompositeOptions {
  /** Replaces the label-based heuristic — typically a Phase 2b/2c/3 SA-1 score. */
  soulAlignmentOverride?: number;
}

function computeAdmissionComposite(
  input: AdmissionInput,
  config?: PriorityConfig,
  options?: AdmissionCompositeOptions,
): AdmissionComposite;
```

The returned `AdmissionComposite` includes a full `breakdown` object
exposing every term in the formula (`soulAlignment`, `rawDemandPressure`,
`defectRiskFactor`, `demandPressureAdjusted`, `baseExecutionReality`,
`autonomyFactor`, `designSystemReadiness`, `executionReality`,
`humanCurve`).

---

## Pillar breakdown (§A.6)

Decompose any admission composite into Product / Design / Engineering
contributions and detect cross-pillar tensions.

### `computePillarBreakdown(composite)`

```typescript
type PillarName = 'product' | 'design' | 'engineering';

interface PillarContribution {
  pillar: PillarName;
  governedDimensions: string[];
  signal: number;            // [0, 1]
  interpretation: string;    // e.g. "strong Design signal"
}

interface PillarBreakdown {
  product: PillarContribution;
  design: PillarContribution;
  engineering: PillarContribution;
  shared: SharedDimensions;
  tensions: TensionFlag[];
}
```

### Tension flags

`detectTensions(breakdown)` emits one of:

| Type | Meaning |
|---|---|
| `PRODUCT_HIGH_DESIGN_LOW` | Product wants it; design system not ready (catalogue gaps, low readiness). Often a C7 lookahead trigger. |
| `PRODUCT_HIGH_ENGINEERING_LOW` | Product wants it; engineering risk is elevated (defect density, autonomy gap). |
| `DESIGN_HIGH_PRODUCT_LOW` | Design pushing for it; weak product demand → debate priority. |
| `ENGINEERING_HIGH_PRODUCT_LOW` | Engineering wants it (refactor / cleanup); weak product pull. |
| `ALL_MEDIUM` | All three pillars in the medium band → ambiguous case worth a human review. |

---

## SA scoring (Addendum B)

The three-layer scorer. **Layer 1 is deterministic** and never invokes
the LLM; if it hard-gates, Layer 3 is skipped.

### `scoreSoulAlignment(input, deps)`

```typescript
interface ScoreSoulAlignmentInput {
  issueText: string;
  did: DesignIntentDocument;
  dsb?: DesignSystemBinding;
  phase: '2a' | '2b' | '2c' | '3';
  calibratedWeights?: PhaseWeights;
  observedMetrics?: Record<string, number>;
  issueNumber?: number;
}

interface ScoreSoulAlignmentDeps {
  depparse: DepparseClient;
  llm: LLMClient;
  stateStore?: StateStore;
  compiledDid?: CompiledDid;
}

interface SoulAlignmentScoringResult {
  sa1: number;                 // final SA-1 (0 in shadow mode)
  sa2: number;                 // final SA-2 (0 in shadow mode)
  composite: SoulAlignmentResult;
  layer1: DeterministicScoringResult;
  layer2: { domainRelevance; principleCoverage; };
  layer3?: LLMScoringResult;    // absent when layer1.hardGated
  shadowMode: boolean;
  phase: SaPhase;
  weights: PhaseWeights;
}
```

### Phase weights

| Phase | `wStructural` | `wLlm` | Notes |
|---|---|---|---|
| `2a` | 0.0 | 0.0 | Shadow mode — score not used in ranking |
| `2b` | 0.20 | 0.80 | First active phase |
| `2c` | 0.35 | 0.65 | Default for promoted DIDs |
| `3` | calibrated, ≥ 0.20 | `1 − wStructural` | Auto-calibrated from feedback signals |

The `W_STRUCTURAL_FLOOR` (`0.20`, CR-2) is enforced both at the JS layer
and at the SQLite `sa_phase_weights` table CHECK constraint.

### SA-1 formula (§B.7.1)

```
hardGated → 0
otherwise:
  blended         = wStructural × domainRelevance + wLlm × domainIntent × subtleMult
  conflictPenalty = max(0, 1 − coreCount × 0.4 − evolvingCount × 0.1)
  SA-1            = clamp01(blended × conflictPenalty)
```

### SA-2 formula (§B.7.2, CR-1)

```
computableScore       = 0.3 × tokenCompliance + 0.2 × catalogHealth   // up to 0.5
blendedScore          = wStructural × principleCoverage + wLlm × principleAlignment × subtleMult
designConflictPenalty = max(0, 1 − min(0.6, coreAp × 0.3 + evolvingAp × 0.1))
llmComponent          = blendedScore × designConflictPenalty
SA-2                  = clamp01(computableScore + 0.5 × llmComponent)
```

`computableScore` and `0.5 × llmComponent` each top out at 0.5 — perfect
inputs reach SA-2 = 1.0.

---

## DID compiler

Compile a DID into the artifacts the SA scorer consumes.

```typescript
function compileDid(did: DesignIntentDocument): CompiledDid;
```

Outputs:

- `scopeLists.inScope` / `scopeLists.outOfScope` — for Layer 1 scope gate
- `constraintRules` — patterns + relationships for Layer 1 dep-parse
- `antiPatternLists` — product/design/voice/visual term lists
- `bm25Corpus` — full DID corpus (core fields weighted 2×) for SA-1 BM25
- `principleCorpora` — per-principle corpora for SA-2 BM25 vector
- `measurableSignals` — operator + threshold checks
- `sourceHash` — `sha256(canonicalJson(did.spec))`

`validatePhase2bReadiness(compiled)` enforces §B.10.2 minimums (≥ 1
in-scope label, ≥ 1 measurable signal, etc.) before promoting from
shadow mode.

---

## Depparse sidecar

The Layer 1 constraint detector calls a Python spaCy sidecar
(`sidecar-depparse/`) over HTTP for dependency-parse-aware matching.
Tests use `FakeDepparseClient`.

### `HttpDepparseClient`

```typescript
new HttpDepparseClient({
  baseUrl: 'http://depparse:8000',  // MUST be http: or https:
  timeoutMs: 5_000,
  retries: 1,
  fetchImpl: fetch,
});
```

The constructor refuses non-`http(s)` schemes (`file://`, `data:`, etc.)
to prevent local-file reads via env-var overrides. Errors surface as a
typed `DepparseError` with `kind`: `network | timeout | model-unavailable | bad-request | server-error`.

---

## Feedback flywheel

Three pieces close the loop between SA scores and ranking outcomes.

### `SAFeedbackStore`

Wraps the `did_feedback_events` table. Records `accept | dismiss | escalate | override` signals; computes directional precision and category-scoped FP rates.

```typescript
const feedback = new SAFeedbackStore(stateStore);

feedback.record({
  didName: 'acme-did',
  issueNumber: 42,
  dimension: 'SA-1',
  signal: 'accept',
  principal: 'alice',
  category: 'product',
});

feedback.structuralPrecision({ dimension: 'SA-1', since });
feedback.llmPrecision({ since });
feedback.highFalsePositiveCategories({ since }, 3 /* min sample size */);
```

Signal semantics:

| Signal | Meaning |
|---|---|
| `accept` | Admitted item was correctly scored — true positive on positive path |
| `dismiss` | Admitted item should NOT have been — false positive |
| `escalate` | Scored too low; should have been ranked higher — false negative |
| `override` | HC_override bypass — auto-emitted, excluded from precision |

### Phase-weight auto-calibration

```typescript
const result = await autoCalibratePhaseWeights({
  feedback: new SAFeedbackStore(stateStore),
  stateStore,
  windowDays: 90,        // default
  shiftSize: 0.05,       // default
});
console.log(renderCalibrationDiff(result));
```

Per dimension: shifts `wStructural` by `±shiftSize` toward whichever
layer has higher precision (delta threshold `0.1`). Output is clamped
to `[W_STRUCTURAL_FLOOR, 1 − W_STRUCTURAL_FLOOR]` = `[0.20, 0.80]`.

### Category-scoped Cκ

```typescript
import { computeCalibrationCoefficient } from '@ai-sdlc/orchestrator';

const cκ = computeCalibrationCoefficient(category, feedbackEvents);
// 1.0 + (accepts − escalates) / total × 0.3, clamped [0.7, 1.3]
```

Wire into `computePriority` via `categoryResolver(input) → string` to
get per-category calibration. Backward-compatible — absent resolver
uses the scalar coefficient.

### Drift monitor

```typescript
const event = detectSoulDrift('SA-1', {
  stateStore,
  config: {
    meanThreshold: 0.4,
    stddevThreshold: 0.15,
    consecutiveWindows: 3,
    windowDays: 30,
    recoveryMs: 7 × 86_400_000,
  },
  getLastTriggerAt: (dim) => stateStore.getLastDriftTriggerAt(dim),
});
```

Fires `SoulDriftDetected` when 3 consecutive 30-day windows show
`mean < 0.4` OR `stddev > 0.15`. Hysteresis suppresses re-fire within
the recovery window. The event payload includes `driftSource`
(structural mean vs. LLM mean) so consumers can distinguish
LLM drift from product drift.

### Core-identity-changed handler

```typescript
import { handleCoreIdentityChanged } from '@ai-sdlc/orchestrator';

const reshuffled = await handleCoreIdentityChanged(
  { type: 'CoreIdentityChanged', didName: 'acme-did', changedFields: [...], timestamp },
  { getDid, recompileArtifacts, rescoreFullBacklog, flagInFlight },
);
// Emits: BacklogReshuffled (with rescoredItems + inFlightFlagged counts)
```

The handler runs the four steps in order:

1. Recompile DID artifacts
2. Rescore full backlog
3. Flag in-flight items as `SoulGraphStale`
4. Emit `BacklogReshuffled`

---

## Pattern-test CLI

Validate a DID's `detectionPatterns` set against a labelled fixture set.
Phase 2a deliverable (CR-3).

```sh
# Single issue
ai-sdlc pattern-test \
  --did acme-did \
  --field constraints.no-developer-integration \
  --issue-text "Add inventory sync via webhook for developer integration"

# Whole fixture set
ai-sdlc pattern-test \
  --did acme-did \
  --field constraints.no-developer-integration \
  --issue-set ./.ai-sdlc/sa-exemplars.yaml
# Exits 1 if FP rate > 20%
```

Runs **Layer 1 only** (no BM25, no LLM). The output format is pinned
to the §B.10.1 template by snapshot test.

Path traversal is blocked: `--issue-text`, `--issue-file`, `--issue-set`,
and (in `cli-admit`) `--body-file` are routed through `assertSafeReadPath`,
which restricts reads to the repo root, `os.tmpdir()`, or `RUNNER_TEMP`.

---

## Design Intent reconciler

Watches a DID for drift and emits the events listed in
[the spec](/docs/spec/design-intent#5-reconciler-events).

```typescript
import { createDesignIntentReconciler } from '@ai-sdlc/reference';

const reconcile = createDesignIntentReconciler({
  getDesignSystemBinding: () => dsb,
  getLastSnapshot: async (didName) => store.getDidSnapshot(didName),
  saveSnapshot: async (didName, snap) => store.saveDidSnapshot(didName, snap),
  countInFlightItems: async (didName) => store.countInFlight(didName),
  onEvent: (e) => bus.emit(e),
});

const result = await reconcile(did);
```

**First-run behaviour:** when `getLastSnapshot` returns `undefined`, the
reconciler captures the baseline without emitting `DesignChangePlanned`
for existing `plannedChanges[]` entries — only **newly added** entries
on subsequent runs trigger the event.

---

## Migration & state schema

RFC-0008 introduces Migration V11 (six new tables) and V12
(`sa_phase_weights`).

V11 tables:
- `did_compiled_artifacts` — cached compile output keyed by `source_hash`
- `did_scoring_events` — Layer 1/2/3 results + composite per scoring run
- `did_feedback_events` — `accept | dismiss | escalate | override` signals
- `design_change_events` — emitted from `spec.plannedChanges[]` diffs
- `design_lookahead_notifications` — C7 dedupe (7-day expiry)
- ALTER `code_area_metrics` ADD `has_frontend_components`, `design_metrics_json`, `data_point_count`

Each migration runs inside `db.transaction(...)` so a mid-migration
crash cannot leave the schema half-applied. The `sa_phase_weights`
CHECK constraint enforces `[0.20, 0.80]` on both `w_structural` and
`w_llm` (CR-2).

---

## Related

- Spec: [DesignIntentDocument](/docs/spec/design-intent)
- Spec: [Glossary](/docs/spec/glossary)
- API: [Priority Scoring (PPA)](/docs/api-reference/priority)
- API: [Reconciler](/docs/api-reference/reconciler)
