# Tutorial 12: Declaring Variants

**Document type:** Informative tutorial
**RFC:** [RFC-0017 — In-Soul Variant Pattern](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md)
**Estimated time:** 20 minutes

---

## Overview

This tutorial walks through declaring Soul Variants on an existing Soul DID using the InternalAdopter reference implementation as the working example. By the end, you will have:

1. Added `variants[]` to a Soul DID
2. Tagged a work item with `targetedVariants`
3. Verified admission scoring routes through the variant's design intent
4. Confirmed inheritance enforcement catches a compliance escape attempt

---

## Prerequisites

- A configured AI-SDLC project (`ai-sdlc init` complete)
- An existing Soul DID (see [RFC-0009](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md))
- Familiarity with the [Variant concept](../concepts/variants.md)

---

## Step 1: Assess the boundary

Before declaring a Variant, confirm it belongs in the variant space — not as a separate Soul.

Checklist:
- [ ] Does the variant share the same **compliance regime** (WCAG level, regulatory posture, data retention)?
- [ ] Does the variant share the same **substrate** (event bus, schema, tenant model)?
- [ ] Is it the same **product face** — both operator and adopter perceive this as one product with audience-specific flavors?

If all three are yes, proceed. If any is no, create a separate Soul.

**Example:** spry-engage serves municipal government. Small utilities (1–50 staff) and large municipalities (51–5000 staff) share the same WCAG 2.1 AA floor and the same Postgres + Redis substrate. They are the same product face from the operator's perspective. Variants are the right model.

---

## Step 2: Declare variants on the Soul DID

Open your Soul DID file (typically in your project's `souls/` directory). Add a `variants[]` block under `spec`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: spry-engage
spec:
  # ... existing Soul DID fields ...
  variants:
    - id: small-utility
      targetAudience:
        segments: [municipal-small, water-district-small]
        sizeRange: { minStaff: 1, maxStaff: 50 }
      designOverrides:
        colorPaletteOverlay: "small-utility-warm"
        densityProfile: "comfortable"
        typographyScale: "large-print"
        motionProfile: "reduced"
        radiusProfile: "rounded"
      complianceFloor: inherit    # MUST be "inherit" — schema enforces this
      designImperatives:
        - "low-tech-fluency-tolerance"
        - "single-task-focus-per-screen"

    - id: enterprise
      targetAudience:
        segments: [municipal-large, regional-utility]
        sizeRange: { minStaff: 51, maxStaff: 5000 }
      designOverrides:
        colorPaletteOverlay: "enterprise-cool"
        densityProfile: "compact"
        typographyScale: "default"
        motionProfile: "full"
        radiusProfile: "default"
      complianceFloor: inherit
      designImperatives:
        - "bulk-operation-efficiency"
        - "multi-tab-workflow-tolerance"
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string (kebab-case) | yes | Unique within the soul |
| `targetAudience` | object | yes | Mirrors Soul DID `targetAudience` schema (Sα₁ input) |
| `designOverrides` | object | no | Closed enum (see [concepts/variants.md](../concepts/variants.md)) |
| `complianceFloor` | `"inherit"` | yes | Must be `"inherit"` — no other value allowed |
| `designImperatives` | string[] | no | Additive over soul-level; variant wins on same dimension |
| `cardinality` | reserved | no | v1 ignores; present for future lifecycle extension |

### Vendor-prefix design overrides

The `designOverrides` fields are a closed framework enum. If you need an adopter-specific override, use a vendor reverse-DNS prefix:

```yaml
designOverrides:
  colorPaletteOverlay: "small-utility-warm"
  acme.com/accessibilityProfile: "wcag-aa-plus"
```

---

## Step 3: Validate the Soul DID schema

Run schema validation to confirm the variant declarations are schema-valid:

```bash
node pipeline-cli/bin/cli-validate.mjs --resource spry-engage.yaml
```

Expected output:
```
✓ spry-engage.yaml: valid (2 variants declared; complianceFloor: inherit on all)
```

If you see a validation error, common causes:
- `complianceFloor` set to anything other than `"inherit"` — change it to `inherit`
- `id` not in kebab-case — use only `[a-z][a-z0-9-]*`
- `designOverrides.densityProfile` set to an invalid enum value — use `compact | comfortable | spacious`
- Nested `variants[]` inside a variant (OQ-2: schema-enforced flat) — flatten to the soul level

---

## Step 4: Declare a variant-targeted work item

When a work item is specific to one audience segment, tag it with `targetedVariants` using the path-style URI format:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: WorkItem
metadata:
  name: small-utility-onboarding-improvement
spec:
  title: "Improve onboarding flow for small utility operators"
  targetedSouls: [spry-engage]
  targetedVariants:
    - "did:platform-x:soul:spry-engage/variant:small-utility"
```

The `targetedVariants` format is: `did:{method}:{platform}:soul:{soul-id}/variant:{variant-id}`.

A work item without `targetedVariants` continues to score at soul scope — backward-compatible.

---

## Step 5: Verify admission scoring routes through the variant

Run the admission composite for the work item:

```bash
node pipeline-cli/bin/cli-admit.mjs --work-item small-utility-onboarding-improvement.yaml
```

Observe the scoring breakdown:
- **Sα₁ source:** `small-utility.targetAudience` (not soul-aggregate)
- **Sα₂ source:** `small-utility.designImperatives` UNION `spry-engage.designImperatives`
- **Cκ, Eρ_n, Dπ_n:** soul-level (unchanged)

Compare with the soul-aggregate score (remove `targetedVariants`, re-run). You should see a higher Sα₁ score — the small-utility variant's narrow audience definition makes audience resonance sharper.

---

## Step 6: Test inheritance enforcement

Try adding a locked field to a variant:

```yaml
variants:
  - id: test-violation
    targetAudience: { segments: [test] }
    complianceFloor: inherit
    complianceRegimes:         # LOCKED — this will be rejected
      - { regime: HIPAA }
```

Run validation:

```bash
node pipeline-cli/bin/cli-validate.mjs --resource spry-engage.yaml
```

Expected error:
```
✗ spry-engage.yaml: VariantInheritanceViolation
  variant "test-violation" declares locked field "complianceRegimes"
  Variants cannot override inherited fields. See RFC-0017 §5.3.
```

This confirms the inheritance enforcement is working. Remove `complianceRegimes` from the variant.

---

## Step 7: Trigger Engineering review Decision

Per RFC-0017 OQ-7, every new variant declaration triggers an Engineering review via the Decision Catalog. This happens automatically when the Soul DID is submitted for review. You can also trigger it explicitly:

```bash
node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "Engineering substrate-cost review: spry-engage/small-utility variant" \
  --scope "rfc:RFC-0017" \
  --option "approve:Substrate shared; no new cost" \
  --option "block:New layout engine required"
```

The review is **non-blocking** — it routes through RFC-0035 G0 (pipeline continues). The Decision is surfaced in the next operator batch review.

---

## Next steps

- Read the [Variant Deprecation Runbook](../operations/variant-deprecation.md) to manage variant lifecycle
- Review the [Variant Pattern Promotion Runbook](../operations/variant-pattern-promotion.md) for the default-on flip procedure
- See [RFC-0017 §11](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md) for the full InternalAdopter practitioner validation plan
