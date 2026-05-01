# Design System Operator Runbook

**Audience:** the design system maintainer and the AI-SDLC pipeline operator
who together own the day-to-day operation of a `DesignSystemBinding`
governed under [RFC-0006](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md).
**Companion to:** [`docs/operations/operator-runbook.md`](operator-runbook.md)
(general AI-SDLC pipeline operations) and the
[design system tutorial](../tutorials/design-system-getting-started.md)
(initial setup).

This runbook is the operating manual that picks up after Phase 3 of the
RFC-0006 §15 migration plan, when the binding is in `hard-mandatory`
enforcement and your team is depending on the gates not to misfire.

---

## What this role owns

The design system operator is the human counterpart to the `engineeringAuthority`
and (when configured) `sharedAuthority` principals declared in the binding's
`stewardship` block (RFC-0006 §5.3). Specifically:

- **Sync schedule and conflict resolution** — adjusting `tokens.sync.schedule`
  and `tokens.sync.conflictResolution` based on observed pipeline noise.
- **Visual baseline maintenance** — flushing stale baselines, approving
  intentional baseline updates, and checking for drift between Storybook and
  the published instance.
- **Token compliance calibration** — tuning `compliance.coverage.minimum` /
  `target` based on observed agent behavior, and curating the
  `compliance.disallowHardcoded` rule set.
- **Catalog health** — keeping the Storybook MCP endpoint authenticated and
  the manifest fresh.
- **Design review SLA** — measuring how long design reviews are actually
  taking and feeding that back into the binding's `timeout` / `onTimeout`
  configuration.

The operator does **not** approve token schema changes, baselines, or design
review verdicts. Those belong to the `designAuthority` principals (RFC-0006 §5.3
default scope). The operator owns the plumbing; the design lead owns the
decisions.

---

## Operating cadence

```
DAILY      • Check design-review queue depth (target: < 5 pending)
           • Glance at token sync events (any failures since yesterday?)
           • Acknowledge any cross-namespace MCP audit log entries
           Time: 5–10 min
```

```
WEEKLY     • Review the week's visual regression false-positive rate
           • Audit `tokenSchemaBreakingChange` events — were any deferred?
           • Re-check `designReview.averageReviewTime` against SLA
           Time: 30 min
```

```
MONTHLY    • Rotate Storybook MCP bearer tokens (RFC-0006 §16.3 default TTL: 24h
             via JIT, but humans hold escape-hatch tokens — rotate those)
           • Audit `compliance.coverage.minimum` against actual coverage; raise
             if you have headroom
           • Calibrate `cascadeThreshold` based on observed cascade sizes
           Time: 1–2 hours
```

```
AS-NEEDED  • Approve `pinnedVersion` bumps when design lead applies a breaking
             token migration (RFC-0006 §5.5)
           • Resolve `manualResolutionTimeout` escalations (token sync conflicts
             that no human triaged within `PT48H`)
           • Refresh visual baselines after a deliberate platform redesign
           • Onboard a new platform extension binding (web → +iOS)
```

---

## Event triage reference

The orchestrator surfaces design system events alongside the general event
stream documented in `docs/operations/operator-runbook.md`. The events below
are specific to RFC-0006 governance.

| Event                          | Severity  | Meaning                                                                      | Response                                                                                                                                              |
| ------------------------------ | --------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TokensSynced`                 | Info      | A scheduled or triggered sync completed                                      | None. Audit signal only.                                                                                                                              |
| `TokenSchemaBreakingChange`    | Critical  | Adapter detected a breaking change exceeding `versionPolicy`                 | Page the design lead. The orchestrator is blocking all affected pipelines until they apply the migration atomically (RFC-0006 §5.5).                  |
| `TokenDeletionProposed`        | Warning   | An agent or sync proposed a deletion                                         | Escalate to design lead. The deletion is hard-blocked until they approve via §12.3's flow.                                                            |
| `DesignReviewTimeout`          | Warning   | A design review gate exceeded its `timeout`                                  | If `onTimeout: pause`, the pipeline is paused — check whether the design lead is overloaded; consider raising the SLA or adding a backup reviewer.    |
| `ConflictResolutionEscalated`  | Error     | A `manual` token conflict hit `manualResolutionTimeout` (default `PT48H`)    | The orchestrator is escalating to `escalateTo` principals. Confirm the escalation reached them; consider switching to `code-wins` for low-risk paths. |
| `MCPAuthFailure`               | Error     | Storybook MCP endpoint rejected an agent token                               | Check the JIT credential rotation log. If this is recurring, the bearer scope may be misconfigured (`manifest:read` is the minimum agent scope).      |
| `BaselineCaptureFailed`        | Warning   | Visual regression runner failed to capture a baseline                        | Usually a transient Playwright/Storybook flake. If it persists, the story may have a runtime error — check the Storybook deploy.                      |
| `CrossNamespaceCatalogAccess`  | Info      | An agent in namespace `A` queried a catalog in namespace `B`                 | Confirm that the cross-namespace `AdapterBinding` is intentional (RFC-0006 §16.3). If not, revoke the binding.                                        |

---

## Common operations

### Rotating MCP bearer tokens

The Storybook MCP endpoint authenticates with bearer tokens scoped to specific
operations (RFC-0006 §16.3). Agent tokens are JIT-rotated by the orchestrator
on a 24-hour TTL by default. Human/operator tokens used for ad-hoc debugging
are NOT rotated automatically.

```bash
# Rotate the operator-held bearer token
pnpm ai-sdlc design-system rotate-mcp-token \
  --binding acme-design-system \
  --scope manifest:read \
  --ttl 24h
```

The new token is printed once. Update your local credential store. The old
token continues to validate until its TTL expires.

### Approving a token migration

A `TokenSchemaBreakingChange` event fires when the design lead ships a major
release. The migration is atomic — there is no dual-write period (RFC-0006
§5.5). Operator role:

1. Confirm the design lead intends to migrate (not a misclassified value
   change).
2. Open the migration PR. The agent will rewrite all affected token
   references in a single commit.
3. After CI passes, advance `tokens.versionPolicy` and (if pinned)
   `tokens.pinnedVersion` in the binding.
4. Re-deploy. The block on affected pipelines lifts automatically once the
   binding's reported schema version matches the new release.

### Refreshing visual baselines after a deliberate redesign

When the design team intentionally re-themes a component family, the visual
regression gate will (correctly) fail every story in that family. To refresh
baselines without bypassing the gate:

```bash
pnpm ai-sdlc design-system approve-baselines \
  --binding acme-design-system \
  --story-pattern "Forms/*" \
  --approver design-lead
```

The approver MUST be a principal in the binding's `designAuthority` scope.
The approval is recorded in the audit log along with the baseline diff hash.
Operators cannot self-approve baselines (RFC-0006 §16.2).

### Tuning `cascadeThreshold` and review SLA

Two settings drift over time as the system matures:

- **`cascadeThreshold`** (the design impact review trigger). If the design
  lead is rubber-stamping every 5-component cascade, raise it to 10 or 15.
  If small cascades are slipping through with surprises, lower it.
- **`designReview.timeout`** (default `PT48H`). Measure
  `designReview.averageReviewTime` from the binding's `status` block over the
  last 4 weeks. If reviews take 8 hours on average, leave the timeout at 48
  to absorb spikes. If the average is creeping toward the timeout, you have
  a reviewer-capacity problem, not a configuration problem — escalate.

---

## When to ask the design lead, not the operator

Some changes require `designAuthority` approval per RFC-0006 §5.3 — operators
MUST NOT make them unilaterally:

- Any change to `compliance.disallowHardcoded` rules (what counts as a
  violation is a design judgment).
- Any change to `tokenSchema` (token additions, removals, renames).
- Approval of a visual regression baseline.
- Any change to `designToolAuthority` (this is a re-org-level decision).
- Change to `sync.conflictResolution` from `manual` to `code-wins` or
  `design-wins`.

Bring those to the design lead with a specific recommendation; do not unblock
the binding by editing them yourself.

---

## See also

- [RFC-0006 Design System Governance Pipeline](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md) —
  full normative spec, including the addendum on AI-driven design review.
- [Design system tutorial](../tutorials/design-system-getting-started.md) —
  how to author the binding in the first place.
- [Adapter authoring](adapter-authoring.md) — implementing a custom
  `DesignTokenProvider`, `ComponentCatalog`, or `VisualRegressionRunner`.
- [General operator runbook](operator-runbook.md) — non-design-system
  operator responsibilities.
