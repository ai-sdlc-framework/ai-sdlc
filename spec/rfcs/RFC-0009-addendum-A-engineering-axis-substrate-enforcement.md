# RFC-0009 Addendum A — Engineering-Axis Substrate Enforcement

**Status**: Draft (proposed addendum)
**Companion**: RFC-0009 v3.4 (Tessellated Design Intent Documents, all 13 OQs closed 2026-05-04)
**Source**: Live multi-product reference platform — multi-month operation across 6 Soul DIDs spanning consumer, professional, and vulnerable-audience compliance regimes. Operationalized against v3.2; addendum aligned to v3.4 vocabulary (Soul DID per OQ-4 rename, Eρ₅/Eρ₆/Eτ Greek notation per §7).
**Authors**: Alexander Kline (RFC-0009 v3.2 author + PPA v1.0/v1.1 author, reference-platform dogfood) + Claude Opus 4.7
**Convergent with**: PPA Composite (v1.1 ER1–ER6 alignment with RFC §7 Eρ-family; v1.2 direction for identityClass), RFC-0006 Addendum A, RFC-0007, RFC-0011 (DoR)

## 1. Motivation

RFC-0009 specifies the structural shape of a Tessellated DID (§5), the soul-membership invariants (§3 named invariants), and three §7.2 `Eτ_tessellation_drift` detection rules: Rule #1 AST scan (ships now), Rule #2 embedding distance (deferred RFC-0019), Rule #3 cross-soul provenance audits (deferred implementation phase). §15 Appendix A supplies a reference-implementation proof-by-existence.

The framework does not specify *how* the Fractal Triad's engineering vertex operationalizes substrate enforcement at the platform-implementation layer. In practice, every multi-soul platform must answer:

- How does shared substrate read per-soul configuration without conditional branching (the §7.2 Rule #1 AST scan target)?
- How are per-soul compliance regimes (§7.1 Eρ₅, hard regulatory only per OQ-5) enforced before code reaches runtime, instead of merely scoring against runtime gates?
- How is the §5.1 per-soul triad specialization rule ("inherit-and-tighten, never loosen") made impossible to violate at authoring time?
- How does the §3 Substrate Invariants invariant ("named constraints ALL souls must honor") get cross-checked against the actual contracts each Soul DID declares?

A live reference platform dogfooded a substrate-contract pattern that addresses these. This addendum proposes it as non-normative reference guidance complementing §15 Appendix A.

## 2. The Engineering Axis (in-PPA reference)

Per the PPA Composite three-axis basis:

```
Product DECLARES identity      (mission, experientialTargets, scope, constraints)
Design EXPRESSES identity      (designPrinciples, brandIdentity, voice/visual antipatterns)
Engineering MAINTAINS coherence at runtime
```

Engineering is asymmetric by design — its function is enforcement, not intent declaration. The asymmetry replicates fractally at platform and Soul-DID scope.

This addendum covers only the Engineering vertex. Product and Design vertex specifications are out of scope; they remain authored in the DID per RFC-0009 §5.1.

## 3. Substrate Contract Pattern

For each Soul DID registered in `tessellation.souls[]`, the platform declares a typed configuration object — the **Substrate Contract** — that the shared substrate reads from. The contract is pure data: no LLM, no I/O, no runtime ambiguity. Per-Soul-DID behavior emerges from contract values; the substrate has no Soul-DID-specific conditionals.

### 3.1 Required structure (composable)

A reference Substrate Contract composes orthogonal sub-contracts. The reference platform's contract uses 7 sub-contracts; minimum required is 4:

| Sub-contract | Purpose | Maps to |
|---|---|---|
| Council / Roster | Agent membership, director identification | §8.1 `AgentRole.soulBindings` resolution per Soul DID |
| Proactive / Cadence | Timing, cap, suppression values | Engineering runtime maintenance per §4 vertex |
| Compliance | Per-soul regime declaration | §7.1 Eρ₅ Compliance Clearance (hard regulatory only per OQ-5) |
| Cross-Soul Policy | Scoring rule (`min` default per OQ-2 resolution / `weighted-traffic` / `weighted-revenue` / `max`) | §5.2 `crossSoulScoringRule` |

Optional sub-contracts (in the reference platform): Journey (defers to RFC-0018 per OQ-3), Observer (substrate marker registration anchored to a shared SSOT), and a knowledge-boundary sub-contract.

### 3.2 Universal invariants (every field)

For each field in every sub-contract, the contract MUST document:

1. **Named consumer** — the substrate file/function that reads the value.
2. **Default-fallback semantic** — what happens if the field is absent (substrate must not silently drop behavior).
3. **Inheritance class** — `core` (cannot be loosened by child Soul DIDs) or `evolving` (may specialize within tightening-only bounds).

A "no-dead-wires" rule applies: a field without a named consumer is admissible-as-dead and must be removed or wired before the contract ships. This complements §3 Substrate Invariants by ensuring per-Soul-DID contract fields cannot accumulate silent no-ops.

## 4. CI Integrity Gate — proposed §7.2 Rule #4 candidate

§7.2 currently specifies three Eτ_tessellation_drift detection rules per OQ-6 resolution (orchestrator-side, staggered):

- **Rule #1**: AST scan for soul-slug literals + `if (soul === '<slug>')` in shared substrate. Ships now.
- **Rule #2**: Inter-soul embedding distance convergence detection. Deferred to RFC-0019.
- **Rule #3**: Cross-soul provenance audits. Deferred to implementation phase.

We propose a **Rule #4 candidate** at the **type-registry layer**, complementing the three existing rules:

For every Substrate Contract registered against a `tessellation.souls[]` entry, a CI assertion suite enforces:

| Assertion | Catches | Drift class |
|---|---|---|
| Registry key matches contract `soulId` field | Mis-registration drift | §3 Substrate Invariants violation |
| `soulId` ∈ runtime soul-membership set | Phantom-Soul DID registration | §5.2 souls[] integrity |
| §7.1 Eρ₅ compliance locks INVIOLABLE on declared-vulnerable Soul DIDs | Categorical gate bypass at authoring | Eρ₅ Compliance Clearance |
| Director agent ∈ council membership | Cross-soul authority leak | §12 Cross-Soul Isolation |
| Substrate marker keys ∈ shared SSOT marker registry | Substrate contamination | §3 No-Soul-Conditionals-in-Substrate |

These run as a deterministic test suite (no LLM, no integration); they fail the build before the commit lands. They catch a class of drift complementary to Rule #1: cross-file invariants the AST scan cannot see (e.g. a director declared in Soul DID A's contract but registered as a member of Soul DID B; a soul registered with a key that does not match its declared `soulId`).

### 4.1 Why Rule #4 is complementary, not a replacement

- **Rule #1 (AST)** catches source-level drift at any file (including third-party adapters not captured in any contract). Rule #4 cannot see those.
- **Rule #2 (embedding)** catches semantic convergence between Soul DIDs that have drifted toward soul-overlap despite distinct identifiers. Rule #4 cannot see semantic content.
- **Rule #3 (provenance)** catches cross-boundary work without amendment. Rule #4 catches authoring-time mis-declarations only.
- **Rule #4 (type-registry)** catches *declared* drift before it ships — the failure modes that Rules #1–3 detect *after* code lands. It runs at CI; the others run at orchestration time.

The four rules together close authoring-time + runtime detection, source-level + semantic-level + provenance-level + registry-level coverage.

### 4.2 Concrete catch (reference platform)

The reference platform deployed RFC-0009 v3.2 [implementation-anchored, pre-v3.3 rename]. For the full duration of v3.2's deployment, one of the platform's six Soul DIDs had its membership enforcement silently disabled: the Soul DID's identifier was missing from the runtime soul-membership set, so the platform's `assertAgentInSoul()`-equivalent check returned undefined-as-passing for every agent declared to belong to it. None of Rules #1–3 caught it (the source code was syntactically clean; embedding adapter not yet shipped; no provenance amendments triggered).

The Rule #4 type-registry assertion (`soulId` ∈ runtime soul-membership set) catches this exact omission at CI time. After implementation, the silent-bypass was caught and fixed.

This is the §7.2 Eτ failure mode under a §3 named-invariant violation — substrate contamination via a Soul DID whose membership constraint was never enforced — caught at authoring time instead of via Rule #2 runtime metric drift (which had not yet shipped) or Rule #3 provenance audit (which had not yet been triggered).

## 5. Eρ₅ Compliance Clearance at type+CI layer

§7.1 Eρ₅ Compliance Clearance is specified as a per-soul categorical gate (per OQ-5: hard regulatory only — HIPAA, PCI-DSS Level 1, FedRAMP, SOC2 with formal physical-isolation control, regional data residency, and analogous categorical regimes). PPA v1.1 ER5 is the same dimension under PPA notation. The framework specifies Eρ₅ as a **scoring** dimension that gates execution.

We propose Eρ₅ can be enforced at the type system + CI gate **in addition to** scoring. When a Soul DID's compliance regime declares a categorical lock (e.g. a vulnerable-audience Soul DID locking out high-trigger-risk patterns, or `requiresTenantPhysicalIsolation: true` per §8.7 OQ-11 trigger checklist), the Substrate Contract makes that lock **inviolable**:

- The field is required at contract authoring time.
- The Rule #4 CI assertion suite verifies the lock is preserved on every contract update.
- Tightening-only inheritance (per §5.1 per-soul triad specialization + RFC-0006 v5) is enforced at the type level — child Soul DIDs cannot loosen the lock.

The result: a vulnerable-audience Soul DID cannot accidentally regress to high-trigger-risk pattern dispatch even if a downstream contract author tries to override the field. The compliance regime is structurally protected at authoring, not runtime-protected at execution.

This complements §7.1 Eρ₅ scoring rather than replacing it; runtime Eρ₅ still gates execution for non-categorical compliance signals (resource availability, regulatory phase shifts, RFC-0022 derivedGates).

## 6. Tightening-only inheritance enforced at the type system

RFC-0009 §5.1 requires per-soul triad specialization to inherit from parent and tighten without loosening. RFC-0006 v5 specifies the same rule for multi-brand inheritance.

The substrate contract enforces tightening-only at the type system:

- Boolean compliance locks are typed as `true` literals (not `boolean`) when locked
- Numeric caps that may only decrease are typed with bounded discriminated unions
- Categorical inheritance is enforced via TypeScript template-literal types

This makes the tightening-only rule **impossible to violate** at authoring time, rather than merely detectable at runtime.

## 7. Open Questions

The following remain unresolved and are surfaced for framework-maintainer discussion:

### 7.1 `identityClass: core | evolving` at substrate-field level

PPA v1.2 introduces `identityClass` on DID content fields. The proposal: `core` changes are pivots (full re-scoring); `evolving` changes are normal evolution (admission queue re-scoring only).

The substrate contract pattern in this addendum currently treats every field as `core` (no override path). Open question: should the framework specify field-level `identityClass` on substrate fields too? Candidate distinctions:

- A categorical compliance lock (e.g. `requiresTenantPhysicalIsolation`) — clearly `core`
- An operational cadence value (e.g. observer cooldown ms) — arguably `evolving`
- A director / orchestrator agent identifier — `core` (changing the director is a Soul-DID-level event)
- A scoring tuning weight (e.g. bid diversity weight) — `evolving` (tuning, not identity)

We do not propose an answer; we surface the question.

### 7.2 Structural-vs-statistical drift pairing

The CI integrity gate is **structural drift detection** at authoring time. PPA's `SoulDriftDetected` event (rolling 30-day mean < 0.4 or stddev > 0.15 for 3 sprints) is **statistical drift detection** at runtime.

Proposal for the framework: specify both as complementary layers, not alternatives. Structural catches before commit; statistical catches when reality diverges from intent. Each closes a class the other cannot see.

The reference platform runs both via separate mechanisms (a runtime drift-telemetry channel at a tighter threshold + the type-registry integrity gate at authoring); the framework could specify their pairing as canonical.

### 7.3 Centroid computation slot

PPA's Internal Compass note: "the architectural slots are placed so centroid computation becomes possible later without changing the governance surface." The substrate contract pattern's per-field "named consumer" rule preserves this slot — adding centroid-derived fields later does not break the contract surface.

We do not require centroid computation in this addendum; we observe the slot is preserved.

## 8. Non-goals

- **Not a replacement for §7.2 AST scan.** The scan still catches source-level drift the registry cannot see (e.g. a soul-specific conditional inside a third-party adapter not captured in any contract).
- **Not a replacement for Eρ₅ runtime scoring.** Categorical locks live at the type+CI layer; non-categorical compliance signals (resource availability, regulatory phase shifts) still flow through PPA scoring.
- **Not prescriptive of contract field count.** The reference platform's instance uses 38 fields across 7 sub-contracts; minimum useful contract is closer to 12 fields across 4 sub-contracts.
- **Not prescriptive of test framework.** CI integrity gate is conceptual; implementations may use any deterministic test runner.

## 9. Reference implementation

A live reference-platform implementation of this pattern exists. Concrete implementation sources and architecture sign-off are available on request from the addendum authors; they are intentionally not included here to keep the addendum platform-agnostic.

Implementation summary:

- Contract type definition: ~870 LOC, 7 sub-contracts, 38 fields
- Rule #4 CI integrity gate: 5 assertions, ~40 tests, deterministic test-runner-agnostic
- Architecture sign-off doc paired with the implementation

## 10. Convergence

This addendum joins the framework's deterministic-first cluster:

| Artifact | Pattern |
|---|---|
| PPA SA scoring (Addendum B v1.2) | Three-layer assessment: deterministic + structural (BM25) + LLM |
| RFC-0006 Addendum A | Deterministic-first design review |
| RFC-0007 | DID-grounded prototype validation |
| RFC-0011 (DoR gate) | 7-gate deterministic-first actionability check |
| **RFC-0009 Addendum A (this)** | Type-registry-layer substrate enforcement |

All five share the architecture: a deterministic, model-independent, interpretable layer fronting LLM-based judgment. The LLM is a tool of last resort, not first.

## 11. Appendix A — PPA Composite mapping (cross-vocabulary)

For framework reviewers grounded in the PPA Composite (`P(w, s) = SA × D × M × ER × (1-ET) × (1+HC) × CK`):

| PPA dimension | RFC-0009 §7 dimension | Substrate Contract role |
|---|---|---|
| **SA (Soul Alignment)** — DID-grounded | (Soul DID content) | Out of scope (Product DECLARES + Design EXPRESSES authoring) |
| **D (Demand Pressure)** — platform-wide | — | Out of scope (admission-input concern) |
| **M (Market Force Multiplier)** — platform-wide | — | Out of scope |
| **ER1 Resource Availability** | — | Substrate may surface budget constraints to scoring |
| **ER2 Build Complexity** | — | Substrate may surface contract-layer complexity to scoring |
| **ER3 Dependency Clearance** | — | Out of scope |
| **ER4 Design System Readiness** | — | Out of scope (Design vertex) |
| **ER5 Compliance Clearance** | **§7.1 Eρ₅** | **PRIMARY** — categorical locks enforced at type+CI |
| **ER6 Cost Clearance** | **§7.3 Eρ₆** | Substrate may surface per-soul `tenantQuotaShare` (§8.5 SubscriptionPlan) |
| **ET Entropy Tax (tessellation drift)** | **§7.2 Eτ_tessellation_drift** | **PRIMARY** — Rule #4 candidate caught at CI |
| **HC Human Curve** | **§7.4 HC_cost** (cost channel only) | Out of scope (governance, not substrate) |
| **CK Calibration** | — | Out of scope (post-ship calibration, not substrate authoring) |

The Substrate Contract is primarily an Eρ₅ (compliance) + Eτ (tessellation drift) enforcement vehicle, with secondary surfacing of Eρ₆ (cost) per-soul quota share. It is not a scoring input; it is a **structural floor under scoring** that prevents categorical violations from ever reaching the score.

## 12. Appendix B — RFC-0009 §8 resource extension overlap

This addendum's pattern partially overlaps with §8 resource extensions. Concrete overlaps:

| §8 extension | Substrate Contract intersection |
|---|---|
| §8.1 `AgentRole.soulBindings` | Council sub-contract `agentIds` declares the inverse — which agents belong to a Soul DID. Together they form the bidirectional membership graph the Rule #4 assertion validates. |
| §8.2 `AdapterBinding.soulOverrides` | Substrate Contract values are the read-side of soulOverrides; per-soul values declared in the contract feed into adapter binding overrides at runtime. |
| §8.3 `ProvenanceRecord.targetedSouls` | Out of scope; provenance is runtime, contract is authoring. Rule #3 §7.2 audits these. |
| §8.4 `QualityGate.soulScope` | Substrate Contract `crossSoulPolicy.scoringRule` is the contract-side companion to QualityGate.soulScope. |
| §8.5 `SubscriptionPlan.tenants[].quotaShare` | Compliance sub-contract may surface per-soul `tenantQuotaShare` for §7.3 Eρ₆ scoring. |
| §8.6 `WorktreePool` per-soul opt-in | Out of scope; pool config is infra, contract is per-soul declaration. |
| §8.7 `DatabaseBranchPool` shared+RLS default | Compliance sub-contract may declare `requiresTenantPhysicalIsolation: true`, locking the §8.7 trigger checklist outcome at the type level. |
| §8.8 Operator role platform-scoped | No interaction; operator is platform-level. |

The Substrate Contract does not duplicate §8 — it complements it by providing the per-soul authoring surface that several §8 fields read from.

---

**End of addendum.**
