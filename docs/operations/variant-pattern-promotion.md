# Variant Pattern Promotion Runbook

**Audience:** AI-SDLC operators (specifically: whoever is managing the RFC-0017 In-Soul Variant
Pattern rollout). This runbook covers two distinct promotion concerns:

1. **Pattern default-on flip** — flipping the Variant Pattern from opt-in (experimental) to the
   standard adopter surface, following the RFC-0014 / RFC-0015 hybrid-promotion convention.
2. **Cardinality activation** — the follow-on RFC path for activating the `cardinality`
   field (`primary | secondary | experimental`) when adopter demand reaches threshold.

---

## Part 1: Pattern default-on flip

The In-Soul Variant Pattern ships behind normal adopter DoR gates (RFC-0011). The pattern is
"available" once RFC-0017 reaches `Implemented` lifecycle. The "default-on flip" in this context
means: updating the framework's `ai-sdlc init` scaffold, documentation, and adopter-facing
messaging to treat Variants as the standard model for homogeneous-substrate multi-audience souls
(not an advanced feature).

### Promotion criteria

The pattern is ready for default-on promotion when ALL of the following are true:

| Criterion | How to verify |
|---|---|
| InternalAdopter three-product validation complete (RFC-0017 §11) | AISDLC-437 merged + `products.test.ts` green; §11 practitioner validation gates met (Mo's condition discharged) |
| No `VariantInheritanceViolation` regressions on the InternalAdopter suite | `pnpm --filter @ai-sdlc/orchestrator test -- --testPathPattern variant` green |
| Cross-variant aggregation scoring produces better-justified scores than soul-aggregate | Spot-check: run admission composite on 3+ real work items targeting InternalAdopter variants; score narratives are defensible |
| Engineering vertex confirms substrate is genuinely shared across all variants | RFC-0017 §11 criterion #4: substrate-sharing review Decision resolved with `approve` |
| No open Critical/Major findings in last reviewer pass on RFC-0017 implementation PRs | Check PR review verdict files |

**Both paths are equivalent once criteria are met.** The corpus path is rigorous on accuracy;
the override path relies on operator judgment when corpus is sparse.

| Path | When to use |
|---|---|
| **Corpus path** | ≥3 adopters have run variant declarations through the full admission pipeline with no `VariantInheritanceViolation` regressions |
| **Override path** | InternalAdopter validation complete + operator has personally spot-checked admission scoring on 3+ real work items |

This mirrors the [`adopter-authoring-promotion.md`](adopter-authoring-promotion.md) /
[`orchestrator-promotion.md`](orchestrator-promotion.md) hybrid-promotion convention.

### Promotion procedure

1. Verify all promotion criteria are met (see table above)
2. Update `spec/rfcs/RFC-0017-in-soul-variant-pattern.md` frontmatter:
   ```yaml
   lifecycle: Implemented
   ```
3. Update `ai-sdlc init` scaffold template (`scripts/templates/variant-config.yaml`) to include
   the default variant-config block
4. Update the framework README / adopter onboarding guide to mention Variants as a first-class
   surface (not an advanced feature)
5. File the promotion PR with:
   - `docs:` conventional commit type
   - Reference to RFC-0017 and AISDLC-437 verification evidence
   - PR body must link to the spot-check results or corpus tally

---

## Part 2: Cardinality activation (follow-on RFC path)

The `cardinality` field (`primary | secondary | experimental`) is reserved in the RFC-0017 schema
and **ignored at runtime in v1**. Activation is gated by the OQ-8 Decision Catalog mechanism.

### How the activation gate works

Each adopter request to activate cardinality functionality emits a
`variant-cardinality-activation-request` Decision to the catalog. The Stage A counter tracks
distinct adopters (deduplicated — one signal per adopter, not per variant). When the count
reaches **2 distinct adopters**, the Decision auto-promotes to operator batch review.

This mirrors the RFC-0036 OQ-6 first-party-adapter graduation pattern.

### Operator actions at threshold

When you see a `variant-cardinality-activation-request` Decision in operator batch review with
`promotedToOperatorReview: true`:

1. **Read the requesting adopters' rationales** (listed in the Decision record)
2. **Assess whether the use cases are additive** — i.e., do they require the same
   `primary | secondary | experimental` semantics, or are they asking for different things?
3. **If additive:** File a follow-on RFC for cardinality activation:
   - Reference RFC-0017 §5.2 `cardinality` RESERVED field
   - Reference OQ-8 resolution as the motivation
   - Specify concrete semantics for `primary`, `secondary`, and `experimental`
   - Include migration path for existing variant declarations (adding `cardinality` is additive)
4. **If divergent:** File separate Decisions to clarify each adopter's specific need before
   committing to a cardinality semantic
5. **Answer the Decision** in the catalog:
   ```bash
   node pipeline-cli/bin/cli-decisions.mjs answer \
     --decision-id DEC-NNNN \
     --option "file-follow-on-rfc" \
     --rationale "2 distinct adopters with aligned use cases; filing RFC-00XX"
   ```

### What the follow-on RFC should include

- `cardinality: primary` — the canonical / default variant for the soul's audience
- `cardinality: secondary` — a supported but non-default specialization
- `cardinality: experimental` — an exit ramp for variants under evaluation (OQ-3 option)
- Lifecycle transitions: how variants move between cardinality states (operator-driven, not
  schema-enforced)
- Admission scoring: whether cardinality changes scoring weights (likely no — variant's
  `designImperatives` + `targetAudience` already carry the scoring intent)
- Migration path: existing variant declarations without `cardinality` are treated as `primary`

### Tracking the counter

To see the current cardinality activation request state:

```bash
node pipeline-cli/bin/cli-decisions.mjs list \
  --scope "rfc:RFC-0017" \
  --kind "variant-cardinality-activation-request"
```

---

## Related resources

- [RFC-0017 In-Soul Variant Pattern](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md) — §5.2 RESERVED field + OQ-8
- [RFC-0035 Decision Catalog](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) — G0 non-blocking routing
- [Variant Deprecation Runbook](variant-deprecation.md)
- [Declaring Variants tutorial](../tutorials/12-declaring-variants.md)
