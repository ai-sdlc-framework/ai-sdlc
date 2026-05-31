# Variant Deprecation Runbook

**Document type:** Operator runbook
**RFC:** [RFC-0017 §6.3 + OQ-3](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md)
**Audience:** Soul DID authors (Design Authority), Engineering reviewers, operators

---

## Overview

Variant deprecation is the process of removing a declared Variant from a Soul DID while ensuring existing work items that reference the variant have a migration path. The lifecycle has three phases:

| State | Trigger | Decision emitted | Pipeline impact |
|---|---|---|---|
| `declared` | Deprecation announced; removal date set | `variant-deprecation-declared` | None (logged) |
| `approaching` | Within approaching window of removal date | `variant-deprecation-approaching` | Surfaced in operator batch review |
| `consumers-pending` | Removal date passed; work items still reference variant | `variant-removal-consumers-pending` | Variant enters degraded mode; migration tasks emitted |

All Decisions route through RFC-0035 G0 — **the pipeline never halts**. Consumers that have not migrated enter a degraded mode where the variant remains accessible but emits migration-urgency signals.

---

## Default configuration

```yaml
# .ai-sdlc/variant-config.yaml
variant:
  lifecycle:
    deprecationWindowDays: 30          # OQ-3: default 30d (internal-config cadence)
    routing:
      onDeclared: log-catalog-no-interrupt
      onApproaching: operator-batch-surface
      onConsumersPending: degraded-mode-and-migration-tasks
```

**Per-Soul override:** Set `spec.variantConfig.lifecycle.deprecationWindowDays` in the Soul DID to override the org default (e.g. 60d for large adopters needing a slower migration cadence).

---

## Deprecation procedure

### Step 1: Announce deprecation

Add a `deprecatedAt` timestamp and `removalDate` to the variant in the Soul DID:

```yaml
variants:
  - id: small-utility
    # ... existing fields ...
    deprecatedAt: "2026-06-01T00:00:00Z"
    removalDate: "2026-07-01T00:00:00Z"    # 30d from now (org default)
    deprecationReason: >
      Migrating to consolidated 'municipal' variant that covers both small
      and medium municipalities. Consumers should switch to spry-engage/municipal.
```

Commit and push. The deprecation lifecycle engine emits `variant-deprecation-declared` to the Decision Catalog immediately on the next pipeline tick.

### Step 2: Communicate to consumers

The Decision Catalog entry surfaces in the next operator batch review. The operator should:

1. Identify all work items with `targetedVariants: [.../variant:small-utility]` in their spec
2. Notify relevant work item owners (by team convention — no automated notification yet)
3. Set a migration milestone

A sweep query to find consumers:

```bash
# Find all open work items targeting the deprecated variant
grep -r "small-utility" backlog/tasks/ --include="*.yaml" --include="*.md" -l
```

### Step 3: Approaching window

When the removal date is within the `approachingWindowDays` threshold (default 7d), the engine emits `variant-deprecation-approaching`. This surfaces as an operator batch review item with higher urgency.

If the migration window needs to be extended, update `removalDate` in the Soul DID:

```yaml
removalDate: "2026-08-01T00:00:00Z"    # Extended from July 1 to August 1
```

Commit and push. The lifecycle engine re-evaluates and transitions back to `declared` state.

### Step 4: Handle consumers at removal date

If consumers still reference the variant when `removalDate` passes, the engine emits `variant-removal-consumers-pending` and enters **degraded mode**:

- The variant remains accessible but emits migration-urgency signals per admission tick
- `VariantMigrationTask` records are created for each pending consumer
- The Decision Catalog entry escalates to the next batch review with the consumer list

**Operator action:** For each `VariantMigrationTask`, update the work item's `targetedVariants` to reference the replacement variant (or remove `targetedVariants` entirely to fall back to soul-aggregate scoring).

### Step 5: Hard removal

Once all consumers have migrated (zero `targetedVariants` references to the deprecated variant in open work items):

1. Remove the variant entry from the Soul DID's `variants[]`
2. Confirm `grep -r "variant-id-here" backlog/tasks/` returns no hits
3. Commit and push

The system emits a `VariantRemoved` event per RFC-0008 event taxonomy on the next pipeline tick.

---

## Troubleshooting

### "Consumers still referencing after migration"

Check for closed / completed work items that still carry `targetedVariants`:

```bash
grep -r "variant-id-here" backlog/completed/ --include="*.yaml" --include="*.md"
```

Completed work items do not block hard removal — only _open_ work items do. The lifecycle engine only scans `backlog/tasks/`.

### "Removal date keeps resetting to approaching"

If `removalDate` is being auto-updated by a script or CI tool, the approaching window may fire repeatedly. Check your backlog automation for date-update logic that conflicts with the deprecation window.

### "Pipeline shows degraded mode but no migration tasks"

The migration task generator requires `consumersStillReferencing` to be populated by the variant loader. If you see `degradedMode: true` but no migration tasks, the variant loader may not have scanned open work items yet. Run a manual scan:

```bash
node pipeline-cli/bin/cli-variant-lifecycle.mjs scan-consumers \
  --soul spry-engage --variant small-utility
```

---

## Related resources

- [RFC-0017 §6.3 Migration path](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md)
- [RFC-0017 OQ-3 resolution](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md)
- [Declaring Variants tutorial](../tutorials/12-declaring-variants.md)
- [Variant Pattern Promotion Runbook](variant-pattern-promotion.md)
