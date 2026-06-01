# Substrate Contract

**Document type:** Informative / Adopter-facing  
**RFC:** [RFC-0028 — Engineering-Axis Substrate Enforcement](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md)  
**Operator runbook:** [docs/operations/substrate-contract.md](../operations/substrate-contract.md)  
**Tutorial:** [docs/tutorials/13-authoring-substrate-contract.md](../tutorials/13-authoring-substrate-contract.md)

---

## What is a Substrate Contract?

A **Substrate Contract** is a typed JSON configuration file — one per Soul DID — that your shared substrate code reads from at runtime. Instead of branching on soul identifiers inside shared code (`if (soulId === 'professional') { ... }`), the substrate reads configuration values from the contract and behaves differently based on data, not conditionals.

This is the Engineering vertex's answer to a fundamental multi-soul platform question: how do you keep the substrate generic while supporting per-soul behavior?

```
Without Substrate Contracts:            With Substrate Contracts:
─────────────────────────────           ─────────────────────────────
if (soulId === 'consumer') {            // substrate reads from contract:
  cooldown = 300_000;                   cooldown = contract.spec.fields
} else if (soulId === 'pro') {           .find(f => f.name === 'observerCooldownMs')
  cooldown = 60_000;                     .defaultFallback;  // generic
}
// ↑ AST scan target (RFC-0009 §7.2)   // ↑ AST scan passes
```

The soul-specific conditional on the left is what RFC-0009 §7.2's AST scan detects as drift. The data-driven pattern on the right is what the Substrate Contract makes possible.

---

## When to use Substrate Contracts

Use Substrate Contracts when:

- Your platform serves **multiple Soul DIDs** with different compliance regimes, cadences, or agent membership — and you want to enforce those differences at authoring time rather than hoping runtime checks catch them.
- You want the CI gate to **catch structural violations before they ship** (wrong director, phantom Soul registration, compliance lock bypass) rather than discovering them via runtime errors or audit.
- You need **auditable traceability** from each Soul DID's behavior back to an explicit contract field with a declared consumer and default.

Substrate Contracts are **not required** by the framework — they are an optional pattern that any multi-soul adopter may apply.

---

## How Substrate Contracts differ from RFC-0009 Schema Invariants

RFC-0009 §3 specifies **Substrate Invariants** — named constraints ALL souls must honor (no soul-specific conditionals in the substrate, cross-soul isolation rules, provenance rules). RFC-0009 §7.2 specifies how those invariants are detected at runtime.

Substrate Contracts are the **authoring-time companion** to RFC-0009:

| RFC-0009 (runtime enforcement) | Substrate Contracts (authoring-time enforcement) |
|---|---|
| AST scan detects soul conditionals AFTER code lands | CI integrity gate catches declared violations BEFORE code lands |
| Embedding-distance detection catches semantic convergence over time | Type-registry detection catches cross-file invariant violations at CI |
| Cross-soul provenance audits catch cross-boundary work | Director ∈ council assertion catches authority leaks in contracts |
| §7.1 Eρ₅ scoring gates runtime execution | Compliance lock assertions prevent vulnerable-Soul regression at authoring |

The two systems are complementary — RFC-0009's runtime rules catch what contracts cannot see (third-party adapters, semantic convergence); contracts catch what runtime rules cannot see (declared mis-registration, pre-ship compliance lock bypass).

> **See also:** RFC-0009 §3 includes a "See also: RFC-0028" pointer explaining this authoring-time companion relationship. RFC-0009 §7.2 includes a "See also: RFC-0028" pointer for the fourth detection mechanism.

---

## The four required sub-contracts

Every production Substrate Contract composes at least four sub-contracts. Think of sub-contracts as orthogonal concerns — each describes one dimension of the Soul's configuration:

**Council / Roster** — who belongs to the Soul. Declares the director and council member agent IDs. The CI gate verifies the director is in the council (Assertion 4: no cross-soul authority leaks).

**Proactive / Cadence** — when the substrate acts. Declares timing values like `observerCooldownMs` and `cadenceMinIntervalDays`. These are canonical `evolving` fields — they tune operational behavior, not Soul identity.

**Compliance** — what compliance regime this Soul operates under. Declares the vulnerability audience flag and categorical locks. The CI gate verifies that any Soul declaring `vulnerableAudience: true` also carries `requiresVulnerableAudienceLockout: true` (Assertion 3: no compliance lock bypass).

**Cross-Soul Policy** — how this Soul participates in multi-soul scoring. Declares `crossSoulPolicy.scoringRule` (`min` / `weighted-traffic` / `weighted-revenue` / `max`), which maps to RFC-0009 §5.2 `crossSoulScoringRule`.

---

## The `identityClass` annotation

Every field in a Substrate Contract must carry `identityClass: "core"` or `identityClass: "evolving"`. This annotation controls what kind of rescoring fires when the field changes:

- **`core`** — changing this field is a Soul pivot event. Full re-scoring fires. Use for fields that define who the Soul is: compliance locks, regime declarations, the director, the `complianceFloor` lock.
- **`evolving`** — changing this field is normal operational tuning. Admission re-score only. Use for operational cadence, scoring tuning weights, similarity thresholds, quota quantities.

Getting `identityClass` wrong in the `core` direction causes false-positive Soul pivots — a similarity-threshold adjustment triggers full re-scoring at 100x the cost. Getting it wrong in the `evolving` direction misses actual Soul pivots. The canonical taxonomy lives in `orchestrator/src/substrate/identity-class.ts`.

Novel fields not yet in the taxonomy default to `"core"` (conservative). Promotion to `"evolving"` requires an RFC amendment with Design + Engineering sign-off.

---

## The CI integrity gate

When you add or modify Substrate Contracts, the CI gate at `scripts/check-substrate-contract.mjs` (wired into `pnpm test:substrate-contract-gate`) runs 5 deterministic assertions:

1. **Registry key matches `soulId`** — filename must match `spec.soulId`.
2. **`soulId` in soul-membership set** — every registered Soul must appear in `tessellation.json`.
3. **Compliance locks inviolable on vulnerable Souls** — `vulnerableAudience: true` requires `requiresVulnerableAudienceLockout: true`.
4. **Director in council** — `council.director` must be in `council.agentIds[]`.
5. **Marker keys in SSOT registry** — all `spec.markerKeys[]` entries must appear in `marker-registry.json`.

The gate is a **hard pre-push gate** — assertion failure blocks the push with exit code 1. It emits a `substrate-structural-drift-detected` Decision (severity HIGH) to the RFC-0035 Decision Catalog for operator routing.

Fresh adopters with no `substrate-contracts/` directory see:

```
[substrate-contract] No substrate contracts found — cold-start (no-op)
```

The gate activates automatically as contracts are added.

---

## Statistical drift: the runtime complement

The CI gate covers authoring-time structural violations. At runtime, PPA's `SoulDriftDetected` event (rolling 30-day coherence mean < 0.4 or stddev > 0.15, sustained for 3 sprints) surfaces **statistical drift** — divergence between the Soul's contracted intent and its actual runtime behavior.

Unlike structural drift, statistical drift is **non-blocking**: it routes to the RFC-0035 Decision Catalog as a `soul-statistical-drift-detected` G0 non-blocking Decision for operator batch review. Three reconciliation paths are available: confirm as legitimate evolution, confirm as violation and file a fix, or defer to the next review window.

During the **cold-start period** (first 30 days), statistical detection is inactive — structural detection is the sole defense. See [docs/operations/substrate-contract.md §5](../operations/substrate-contract.md#section-5--cold-start-period).

---

## Schema and type primitives

**JSON schema:** `spec/schemas/substrate-contract.v1.schema.json` — declares the `SubstrateContractField` shape with the `identityClass` discriminant.

**TypeScript type primitives** in `orchestrator/src/substrate/identity-class.ts`:
- `LockedBoolean = true` — boolean locks typed as `true` literal; assigning `false` fails at compile time.
- `BoundedNumericCap` — discriminated union for numeric caps that may only decrease; `assertTightenedCap()` catches loosening at authoring time.
- `TightenedCategorical<Parent, Child>` — template-literal type for categorical inheritance; the child must be a strict subset of the parent union.

These primitives enforce RFC-0028 §6 (tightening-only inheritance) at the TypeScript type system level — child Soul DIDs cannot loosen `core` locks.

---

## Quick start

See [docs/tutorials/13-authoring-substrate-contract.md](../tutorials/13-authoring-substrate-contract.md) for a step-by-step walkthrough.

---

## Related

- [RFC-0028 §3 — Substrate Contract Pattern](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md#3-substrate-contract-pattern)
- [RFC-0009 §3 — Substrate Invariants](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md)
- [RFC-0009 §7.2 — Drift Detection Rules](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md)
- [RFC-0035 — Decision Catalog](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) (Decision routing for drift events)
- [Glossary: Substrate Contract](../../spec/glossary.md#substrate-contract)
- [Glossary: identityClass](../../spec/glossary.md#identity-class)
- [Glossary: Structural Drift](../../spec/glossary.md#structural-drift)
- [Glossary: Statistical Drift](../../spec/glossary.md#statistical-drift)
- [Glossary: Type-Registry Layer Detection](../../spec/glossary.md#type-registry-layer-detection)
