# Substrate Contract — Operator Runbook

**Document type:** Informative / Operational  
**RFC:** [RFC-0028 — Engineering-Axis Substrate Enforcement](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md)  
**Shipped phases:** AISDLC-452 (Phase 1 — identityClass taxonomy), AISDLC-453 (Phase 2 — CI integrity gate), AISDLC-454 (Phase 3 — drift composition wiring)  
**Phase 4 cross-refs:** [RFC-0009](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md) §3 + §7.2 cross-reference edits shipped in AISDLC-455.

---

## Overview

A **Substrate Contract** is a typed, per-Soul-DID configuration object that shared substrate code reads from. Per-soul behavior emerges from contract values; the substrate has no soul-specific conditionals. This runbook covers day-to-day operator tasks for the substrate enforcement stack shipped in RFC-0028 Phases 1–4.

---

## Section 1 — Authoring a Substrate Contract

> **RFC-0028 §3 — Substrate Contract Pattern**

A Substrate Contract is a JSON file stored in `substrate-contracts/<soulId>.json`. The filename (without extension) is the **registry key** and MUST match `spec.soulId` exactly (enforced by CI Assertion 1).

### Minimum required structure

```json
{
  "apiVersion": "ai-sdlc/v1alpha1",
  "kind": "SubstrateContract",
  "metadata": { "name": "<soulId>" },
  "spec": {
    "soulId": "<soulId>",
    "fields": [
      {
        "name": "<fieldName>",
        "namedConsumer": "<substrate-file>#<function>",
        "defaultFallback": "<what happens when field is absent>",
        "identityClass": "core | evolving"
      }
    ]
  }
}
```

### Four required sub-contracts

Per RFC-0028 §3.1, every production Substrate Contract MUST compose at least these four sub-contracts:

| Sub-contract | Key fields | RFC-0009 mapping |
|---|---|---|
| **Council / Roster** | `council.director`, `council.agentIds` | §8.1 `AgentRole.soulBindings` |
| **Proactive / Cadence** | `cadenceMinIntervalDays`, `observerCooldownMs` | Engineering runtime maintenance per §4 |
| **Compliance** | `compliance.vulnerableAudience`, `compliance.locks` | §7.1 Eρ₅ Compliance Clearance |
| **Cross-Soul Policy** | `crossSoulPolicy.scoringRule` | §5.2 `crossSoulScoringRule` |

### Field-level `identityClass` annotation

Every field MUST declare `identityClass: "core"` or `identityClass: "evolving"` — see [Section 2](#section-2--choosing-identityclass) for the canonical taxonomy. Omitting `identityClass` defaults to `"core"` with a warning (see `orchestrator/src/substrate/identity-class.ts#defaultIdentityClassForNovelField`).

### No-dead-wires rule

A field without a `namedConsumer` is inadmissible — it must be removed or wired before the contract ships. `namedConsumer` is a string in the format `<repo-relative-path>#<function-or-variable>`, e.g. `orchestrator/src/substrate/cadence.ts#getCooldown`.

### Supporting files

| File | Purpose | Required? |
|---|---|---|
| `substrate-contracts/tessellation.json` | Soul membership set — enables Assertion 2 | Optional; gate skips Assertion 2 when absent |
| `substrate-contracts/marker-registry.json` | SSOT marker registry — enables Assertion 5 | Optional; gate skips Assertion 5 when absent |

Both files support either `{ "souls": [...] }` / `{ "markers": [...] }` (flat) or the structured `{ "spec": { "souls": [...] } }` form.

---

## Section 2 — Choosing `identityClass` Values

> **RFC-0028 §7.1 OQ resolution — operator walkthrough 2026-05-27**

`identityClass` is a per-field annotation that controls what kind of rescoring fires when the field changes. Picking the wrong class causes either false-positive Soul pivots (all-`core` footgun) or missed Soul pivots (incorrect `evolving`).

### Canonical taxonomy

**`core`** — change = Soul pivot (full re-scoring fires)

These fields define *who the Soul is*, not *how it operates*:

| Field category | Examples |
|---|---|
| Categorical compliance locks | `requiresTenantPhysicalIsolation`, `requiresVulnerableAudienceLockout` |
| Compliance regime declarations | HIPAA, PCI-DSS, SOC2, FedRAMP, GDPR posture |
| Director / orchestrator agent identifier | `director`, `orchestratorAgentId` |
| `complianceFloor: inherit` lock | `complianceFloor` |

**`evolving`** — change = admission re-score only (not a Soul pivot)

These fields are operational tuning — they move within tightening-only bounds:

| Field category | Examples |
|---|---|
| Operational cadence | `observerCooldownMs`, `cadenceMinIntervalDays` |
| Scoring tuning weights | `bidDiversityWeight`, `recencyHalfLife` |
| Similarity thresholds | `clustering.similarityThreshold` |
| Quota quantities | `tenantQuotaShare` |

**Default `core` for novel fields.** Any field not yet classified resolves to `core` (conservative default). Promotion to `evolving` requires an RFC amendment with Design + Engineering sign-off — the burden of proof is "argue why this is operational, not identity."

See the canonical lookup table in `orchestrator/src/substrate/identity-class.ts` (`CANONICAL_FIELD_CLASSIFICATIONS`, `CORE_BUCKET`, `EVOLVING_BUCKET`).

### Tightening-only enforcement at the type system

RFC-0028 §6 + §7.1. When a field is `core` AND carries a categorical compliance lock:

- **Boolean locks** are typed as `true` literals (`LockedBoolean`) — assigning `false` fails at compile time.
- **Numeric caps** use bounded discriminated unions (`BoundedNumericCap`) — authors must declare `kind: 'tightened'` with `previousMax`, and `assertTightenedCap()` catches loosening at module-load time.
- **Categorical inheritance** is enforced via TypeScript template-literal types (`TightenedCategorical<Parent, Child>`) — the child's value must be a provably strict subset of the parent union.

Child Soul DIDs that attempt to loosen a `core` lock fail at compile time. See `orchestrator/src/substrate/identity-class.ts` for the type primitives.

---

## Section 3 — Reading the CI Integrity Gate Output

> **RFC-0028 §4 — CI Integrity Gate (type-registry layer detection)**  
> **RFC-0028 §7.2 OQ resolution — structural drift composition rule 1**

The CI integrity gate runs as `pnpm test:substrate-contract-gate` and is invoked by `node scripts/check-substrate-contract.mjs`. It implements 5 deterministic assertions — no LLM, no network I/O.

### Gate output anatomy

```
[substrate-contract] Checked 3 contract(s). Failures: 1
::error::Assertion 2 FAIL (phantom-Soul DID registration — §4.2 concrete catch): soulId "soul-x" is NOT in tessellation souls[soul-a, soul-b, soul-c]

[substrate-contract] 1 assertion failure(s) detected.
Decision: substrate-structural-drift-detected (severity HIGH)
Correct the listed drift(s) before pushing. See RFC-0028 §4 for assertion details.
```

### The 5 assertions and their remediation

| Assertion | Drift class | Failure message prefix | Remediation |
|---|---|---|---|
| **1** — Registry key matches `soulId` | Mis-registration drift | `Assertion 1 FAIL (mis-registration drift)` | Rename the contract file to `<soulId>.json` OR correct `spec.soulId` to match the filename |
| **2** — `soulId` ∈ runtime soul-membership set | Phantom-Soul DID registration | `Assertion 2 FAIL (phantom-Soul DID registration — §4.2 concrete catch)` | Add the `soulId` to `tessellation.json#souls[]` OR remove the contract file |
| **3** — Eρ₅ compliance locks inviolable on vulnerable Souls | Categorical gate bypass | `Assertion 3 FAIL (compliance lock missing / disabled)` | Set `spec.compliance.locks.requiresVulnerableAudienceLockout: true` in the contract |
| **4** — Director ∈ council membership | Cross-soul authority leak | `Assertion 4 FAIL (cross-soul authority leak)` | Add the director agent ID to `spec.council.agentIds[]` |
| **5** — Marker keys ∈ SSOT registry | Substrate contamination | `Assertion 5 FAIL (substrate contamination)` | Register the marker key(s) in `marker-registry.json#markers[]` OR remove unknown keys from `spec.markerKeys[]` |

### Structural drift Decision routing

When any assertion fails, the gate also emits a `Decision: substrate-structural-drift-detected` via the RFC-0035 Decision Catalog (`cli-decisions.mjs add --scope substrate-enforcement --option fix:... --option exempt:...`). The decision lists two options:

- `fix` — correct the contract field causing the assertion failure
- `exempt` — document an RFC-approved exemption for this soul

The CI hard gate (exit code 1) fires regardless of whether Decision emission succeeds. The Decision is for operator audit correlation, not the enforcement mechanism.

### Cold-start behavior

When `substrate-contracts/` does not exist or contains zero contract files, the gate exits 0 with:

```
[substrate-contract] No substrate contracts found — cold-start (no-op)
```

This is correct — a fresh adopter has no contracts to check. Structural detection activates automatically as contracts are added.

### Bypass variables

| Variable | Effect |
|---|---|
| `AI_SDLC_BYPASS_ALL_GATES=1` | Skips ALL pre-push gates (emergency only) |
| `AI_SDLC_SKIP_SUBSTRATE_GATE=1` | Skips only this gate |
| `AI_SDLC_SKIP_DECISION_EMIT=1` | Skips Decision Catalog emission (gate still blocks) |

---

## Section 4 — Reconciling Statistical Drift Decisions

> **RFC-0028 §7.2 OQ resolution — statistical drift composition rule 2 + three reconciliation paths**

Statistical drift is runtime-detected via PPA's `SoulDriftDetected` signal. Unlike structural drift (hard CI gate), **statistical drift is non-blocking** — it surfaces to the operator as an RFC-0035 G0 Decision for batch review.

### What triggers a statistical drift Decision

A `soul-statistical-drift-detected` Decision fires when, for a given Soul DID:

- Rolling 30-day mean < **0.4** (`MEAN_FLOOR`), OR
- Rolling 30-day population stddev > **0.15** (`STDDEV_CEILING`)

...AND the above condition has held for at least **3 consecutive sprints** (`SUSTAINED_SPRINTS`).

See `orchestrator/src/substrate/drift-composition.ts` (`MEAN_FLOOR`, `STDDEV_CEILING`, `SUSTAINED_SPRINTS`, `evaluateStatisticalDrift()`).

### The three reconciliation paths

When a `soul-statistical-drift-detected` Decision appears in the catalog, choose exactly one:

**Path (a) — Confirm drift as legitimate evolution**

The Soul's actual identity has shifted in an intended direction (e.g. a product pivot, audience expansion). This path ratifies the new baseline.

Actions: emit a DID amendment documenting the rationale; update the Soul DID's design intent; re-run calibration from the new baseline.

Decision option ID: `confirm-as-evolution`

**Path (b) — Confirm drift as substrate violation**

The drift was unintended — the substrate diverged from the contracted intent without a corresponding DID amendment. This path initiates a fix.

Actions: file a backlog task to restore the substrate to its contracted baseline; open a PR with the fix; verify the drift signal resolves in the next sprint window.

Decision option ID: `confirm-as-violation`

**Path (c) — Defer for next operator review window**

Insufficient signal or ambiguity about intent — do not decide this sprint.

Actions: the Decision re-surfaces unchanged at the next batch review window. No state changes.

Decision option ID: `defer`

### Catalog query

To see all drift events for a Soul DID (structural + statistical side-by-side):

```bash
node pipeline-cli/bin/cli-decisions.mjs list --scope substrate-drift
```

The `substrate-drift` scope contains both `substrate-structural-drift-detected` (from CI failures) and `soul-statistical-drift-detected` (from runtime PPA signal) for closed-loop drift audit.

See `orchestrator/src/substrate/drift-composition.ts` (`correlateDriftBySoul()`, `DRIFT_DECISION_SCOPE`).

---

## Section 5 — Cold-Start Period

> **RFC-0028 §7.2 OQ resolution — cold-start calibration window**

Statistical drift detection requires a rolling 30-day baseline. During the **cold-start period** (the first 30 days after deploying a new Soul DID's substrate contracts), no statistical Decisions are emitted.

### What happens during cold-start

- `evaluateStatisticalDrift()` returns `status: "calibrating"` with `drifted: false` and null statistics.
- The Decision Catalog receives no `soul-statistical-drift-detected` entries for this Soul.
- **Structural drift detection (CI gate) is the sole defense during calibration.**

The detector output during cold-start:

```
Baseline incomplete (14.2d / 30d) — calibrating; structural detection is sole defense.
```

### When does the baseline accumulate?

The baseline window is computed from the earliest metric sample to `now`. Once the span exceeds 30 days (`BASELINE_WINDOW_DAYS`), the detector becomes `active` and statistical Decisions can fire.

Sparse cadence (fewer samples than the window would expect): the detector falls back to the whole sample series if the trailing 30d window is empty. The 3-sustained-sprints rule still applies.

### Operating posture during cold-start

During cold-start:

1. Monitor the CI integrity gate closely — it is the only safety net.
2. Do not expect statistical drift Decisions in the catalog — their absence is correct.
3. Ensure `tessellation.json` and `marker-registry.json` are populated to enable Assertions 2 and 5.
4. The cold-start period is the right time to perform the [promotion runbook](#section-6--promotion-runbook) audit.

This cold-start shape mirrors RFC-0030 §13 OQ-13.5's z-score flooding detector — the same proven calibration-window pattern.

---

## Section 6 — Promotion Runbook

> **RFC-0028 §7.1 OQ resolution — promotion from `core` to `evolving`**

When a field initially classified as `core` has accumulated evidence suggesting it is actually operational (not identity), it may be promoted to `evolving`. This promotion requires evidence, sign-off, and an RFC amendment.

### When to consider promotion

A field is a promotion candidate when:

- It has changed in multiple releases without triggering legitimate Soul pivots.
- Operational metrics show a 100x+ cost overhead from the pivot rescoring (the primary motivation for the `evolving` classification).
- Product and Engineering agree the field controls tuning/cadence, not identity.

### Promotion gate: corpus-driven evidence

Before filing for promotion, gather evidence:

1. **Corpus run**: examine the calibration log for `identityclass-classification-disagreement` Decision records filed during AISDLC-452 (check `.ai-sdlc/_decisions/events.jsonl` for `DEC-0003`).
2. **Change history**: count how many times the field changed vs. how many times a Soul pivot was warranted.
3. **Rescoring cost**: verify that the field's `core` classification is generating pivot rescoring overhead that would be avoided by `evolving`.

### Promotion sign-off

Promotion requires **both** Design Authority and Engineering Authority sign-off:

- Design Authority: the field does not define the Soul's visual or audience identity.
- Engineering Authority: the field does not define the Soul's compliance posture or agent membership.

Document the sign-off with a GitHub issue or Decision Catalog entry before filing the RFC amendment.

### RFC amendment

1. Open a PR that edits the canonical taxonomy in `orchestrator/src/substrate/identity-class.ts`:
   - Move the field name from the `CORE_BUCKET` list to the `EVOLVING_BUCKET` list (or add it to `EVOLVING_BUCKET` if not yet listed).
   - Update the JSDoc rationale for the moved field.
2. Reference the RFC-0028 §7.1 resolution + the sign-off evidence in the PR body.
3. Re-run `pnpm --filter @ai-sdlc/orchestrator test` — the taxonomy enumeration tests must pass.

> **Cross-link: RFC-0028 §7.1 resolution** — "Promotion to `evolving` requires RFC amendment with Design + Engineering sign-off (conservative default; burden-of-proof is 'argue why operational')."

---

## Cross-links

| Topic | RFC section | Implemented in |
|---|---|---|
| Substrate Contract pattern | [RFC-0028 §3](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#3-substrate-contract-pattern) | `spec/schemas/substrate-contract.v1.schema.json` |
| identityClass taxonomy (OQ-7.1) | [RFC-0028 §7.1](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#71-identityclass-core--evolving-at-substrate-field-level) | `orchestrator/src/substrate/identity-class.ts` |
| CI integrity gate (OQ-7.2 rule 1) | [RFC-0028 §4](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#4-ci-integrity-gate--proposed-72-type-registry-layer-detection-candidate) | `scripts/check-substrate-contract.mjs` |
| Statistical drift (OQ-7.2 rule 2) | [RFC-0028 §7.2](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#72-structural-vs-statistical-drift-pairing) | `orchestrator/src/substrate/drift-composition.ts` |
| Cold-start (OQ-7.2 rule 4) | [RFC-0028 §7.2](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#72-structural-vs-statistical-drift-pairing) | `orchestrator/src/substrate/drift-composition.ts#evaluateStatisticalDrift` |
| Centroid slot (OQ-7.3) | [RFC-0028 §7.3](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#73-centroid-computation-slot) | §3.2 named-consumer rule |
| RFC-0009 cross-refs (OQ-7.4) | [RFC-0028 §7.4](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#74-cross-reference-path-back-to-rfc-0009-72) | RFC-0009 §3 + §7.2 "See also" blocks (AISDLC-455) |
| Eρ₅ compliance clearance | [RFC-0009 §7.1](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md) | CI Assertion 3 |
| Substrate invariants | [RFC-0009 §3](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md) | CI Assertions 1, 2, 5 |
| Decision Catalog routing | [RFC-0035](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) | `pipeline-cli/bin/cli-decisions.mjs` |
