# Tutorial 13: Authoring a Substrate Contract

**Prerequisite:** Read [docs/concepts/substrate-contract.md](../concepts/substrate-contract.md) for the conceptual overview.  
**RFC:** [RFC-0028 — Engineering-Axis Substrate Enforcement](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md)  
**Operator runbook:** [docs/operations/substrate-contract.md](../operations/substrate-contract.md)

---

## What you will build

By the end of this tutorial you will have:

1. A `substrate-contracts/` directory with a valid `SubstrateContract` for one Soul DID.
2. A `tessellation.json` soul-membership config that enables CI Assertion 2.
3. A `marker-registry.json` marker SSOT that enables CI Assertion 5.
4. All 5 CI integrity gate assertions passing.
5. An understanding of how to classify field `identityClass` values.

**Time estimate:** 30 minutes for a minimal contract; 1–2 hours for a production-grade contract.

---

## Step 1 — Create the directory structure

```bash
mkdir -p substrate-contracts
```

Three files live in this directory:

| File | Purpose |
|---|---|
| `substrate-contracts/<soulId>.json` | One per Soul DID — the Substrate Contract |
| `substrate-contracts/tessellation.json` | Soul membership set (enables CI Assertion 2) |
| `substrate-contracts/marker-registry.json` | Shared SSOT marker registry (enables CI Assertion 5) |

---

## Step 2 — Create `tessellation.json`

This file lists every Soul DID registered on your platform. The CI gate's Assertion 2 checks that every contract's `soulId` appears here (phantom-Soul DID detection — the §4.2 concrete catch from the reference platform).

```json
{
  "souls": ["consumer", "professional", "enterprise"]
}
```

The structured form (`{ "spec": { "souls": [...] } }`) is also accepted.

---

## Step 3 — Create `marker-registry.json`

This file is your shared SSOT for substrate marker keys. CI Assertion 5 verifies that every marker key a contract declares (`spec.markerKeys[]`) appears here.

```json
{
  "markers": [
    "pii-consent-required",
    "high-trust-session",
    "vulnerable-audience-restricted"
  ]
}
```

If you have no marker keys yet, create the file with an empty `markers` array — this allows Assertion 5 to run cleanly on contracts that declare no `markerKeys`.

---

## Step 4 — Scaffold a minimal contract

Create `substrate-contracts/consumer.json`:

```json
{
  "apiVersion": "ai-sdlc/v1alpha1",
  "kind": "SubstrateContract",
  "metadata": { "name": "consumer" },
  "spec": {
    "soulId": "consumer",
    "council": {
      "director": "agent-director-001",
      "agentIds": ["agent-director-001", "agent-member-002", "agent-member-003"]
    },
    "compliance": {
      "vulnerableAudience": false
    },
    "crossSoulPolicy": {
      "scoringRule": "min"
    },
    "fields": [
      {
        "name": "observerCooldownMs",
        "namedConsumer": "orchestrator/src/substrate/cadence.ts#getCooldown",
        "defaultFallback": "Platform default 300000ms when absent",
        "identityClass": "evolving"
      },
      {
        "name": "cadenceMinIntervalDays",
        "namedConsumer": "orchestrator/src/substrate/cadence.ts#getMinInterval",
        "defaultFallback": "Platform default 7 days when absent",
        "identityClass": "evolving"
      }
    ]
  }
}
```

Key points:
- **Filename = `soulId`**: `consumer.json` contains `"soulId": "consumer"`. These must match (Assertion 1).
- **Director in council**: `agent-director-001` appears in both `council.director` AND `council.agentIds[]` (Assertion 4).
- **`vulnerableAudience: false`**: Assertion 3 only fires on vulnerable-audience Souls. Non-vulnerable Souls skip it.
- **`fields[]`**: Operational cadence fields — both classified as `"evolving"` (correct per canonical taxonomy).

---

## Step 5 — Run the CI integrity gate

```bash
node scripts/check-substrate-contract.mjs
```

Expected output (clean):

```
[substrate-contract] Checked 1 contract(s). Failures: 0
[substrate-contract] All assertions passed ✓
```

Or via the test suite:

```bash
pnpm test:substrate-contract-gate
```

---

## Step 6 — Add a compliance sub-contract for a vulnerable-audience Soul

Now add a second Soul — a vulnerable-audience Soul. Create `substrate-contracts/children.json`:

```json
{
  "apiVersion": "ai-sdlc/v1alpha1",
  "kind": "SubstrateContract",
  "metadata": { "name": "children" },
  "spec": {
    "soulId": "children",
    "council": {
      "director": "agent-director-children-001",
      "agentIds": [
        "agent-director-children-001",
        "agent-safety-reviewer-002"
      ]
    },
    "compliance": {
      "vulnerableAudience": true,
      "locks": {
        "requiresVulnerableAudienceLockout": true
      }
    },
    "crossSoulPolicy": {
      "scoringRule": "min"
    },
    "fields": [
      {
        "name": "requiresVulnerableAudienceLockout",
        "namedConsumer": "orchestrator/src/substrate/compliance.ts#assertVulnerableAudienceLock",
        "defaultFallback": "Absent = gate bypass, which FAILS CI — this field is required on vulnerable Souls",
        "identityClass": "core",
        "complianceLockKind": "boolean"
      },
      {
        "name": "observerCooldownMs",
        "namedConsumer": "orchestrator/src/substrate/cadence.ts#getCooldown",
        "defaultFallback": "Platform default 300000ms when absent",
        "identityClass": "evolving"
      }
    ]
  }
}
```

Also add `"children"` to `tessellation.json`:

```json
{
  "souls": ["consumer", "professional", "enterprise", "children"]
}
```

Re-run the gate:

```bash
node scripts/check-substrate-contract.mjs
```

```
[substrate-contract] Checked 2 contract(s). Failures: 0
[substrate-contract] All assertions passed ✓
```

### What would fail (for illustration)

If you remove the compliance lock:

```json
"compliance": {
  "vulnerableAudience": true
  // locks missing
}
```

The gate outputs:

```
::error::Assertion 3 FAIL (compliance lock missing): Soul "children" declares vulnerableAudience=true
  but spec.compliance.locks.requiresVulnerableAudienceLockout is absent

[substrate-contract] 1 assertion failure(s) detected.
Decision: substrate-structural-drift-detected (severity HIGH)
```

---

## Step 7 — Classify `identityClass` for a compliance-lock field

When you add a categorical compliance lock field, it must be `"core"`. Here is the classification guide:

| Field | `identityClass` | Why |
|---|---|---|
| `requiresVulnerableAudienceLockout` | `"core"` | Categorical compliance lock — changing it IS a Soul pivot |
| `requiresTenantPhysicalIsolation` | `"core"` | Categorical compliance lock |
| `complianceFloor` | `"core"` | RFC-0028 §6 tightening-only lock |
| `director` / `orchestratorAgentId` | `"core"` | Changing the director IS a Soul-level event |
| HIPAA / PCI-DSS / SOC2 posture | `"core"` | Compliance regime declarations |
| `observerCooldownMs` | `"evolving"` | Operational cadence — tuning, not identity |
| `cadenceMinIntervalDays` | `"evolving"` | Operational cadence |
| `bidDiversityWeight` | `"evolving"` | Scoring tuning weight |
| `clustering.similarityThreshold` | `"evolving"` | Similarity threshold |
| `tenantQuotaShare` | `"evolving"` | Quota quantity |
| A novel field | `"core"` (default) | Conservative; promote via RFC amendment if evidence warrants |

The canonical taxonomy is in `orchestrator/src/substrate/identity-class.ts` (`CORE_BUCKET`, `EVOLVING_BUCKET`, `CANONICAL_FIELD_CLASSIFICATIONS`).

---

## Step 8 — Add substrate marker keys (optional)

If your substrate uses marker registration, add `spec.markerKeys[]` to your contract. Every key must appear in `marker-registry.json`:

```json
"spec": {
  "soulId": "children",
  "markerKeys": ["vulnerable-audience-restricted", "high-trust-session"],
  ...
}
```

If a key does not appear in the registry, Assertion 5 fails:

```
::error::Assertion 5 FAIL (substrate contamination): Soul "children" declares unknown marker key(s):
  [high-trust-session] — not in SSOT registry [vulnerable-audience-restricted]
```

Fix: add `"high-trust-session"` to `marker-registry.json#markers[]`.

---

## Step 9 — Run the full test suite

Before pushing:

```bash
pnpm test:substrate-contract-gate
```

To run as part of the full pipeline:

```bash
pnpm build && pnpm test && pnpm lint && pnpm format:check
```

The gate also runs in the pre-push hook (`.husky/pre-push` chain). If the gate fails, the push is blocked and the Decision Catalog records a `substrate-structural-drift-detected` entry for operator routing.

---

## Step 10 — Operating during cold-start

For the **first 30 days** after a new Soul DID is deployed, statistical drift detection is inactive. The detector returns `status: "calibrating"` and emits no Decisions. Structural detection (the CI gate) is your sole defense during this window.

What to do during cold-start:

1. Keep the CI gate clean — fix structural violations immediately.
2. Do not expect `soul-statistical-drift-detected` Decisions — their absence is correct.
3. Populate `tessellation.json` and `marker-registry.json` before deploying contracts so Assertions 2 and 5 have data to check.

After 30 days, statistical detection activates automatically. See [docs/operations/substrate-contract.md §5](../operations/substrate-contract.md#section-5--cold-start-period).

---

## What's next

- **Read the operator runbook** for remediating assertion failures: [docs/operations/substrate-contract.md](../operations/substrate-contract.md)
- **Promote a field from `core` to `evolving`**: [docs/operations/substrate-contract.md §6](../operations/substrate-contract.md#section-6--promotion-runbook)
- **Reconcile a statistical drift Decision**: [docs/operations/substrate-contract.md §4](../operations/substrate-contract.md#section-4--reconciling-statistical-drift-decisions)
- **Full RFC**: [RFC-0028](../../spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md)
- **Conformance test suite**: `scripts/check-substrate-contract.conformance.test.mjs`
