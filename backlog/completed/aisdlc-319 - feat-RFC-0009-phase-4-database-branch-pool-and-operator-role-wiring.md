---
id: AISDLC-319
title: 'feat: RFC-0009 Phase 4.4 — DatabaseBranchPool shared+RLS default + Operator role platform-scoping wiring'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-16'
updated_date: '2026-05-25'
labels:
  - rfc-0009
  - tessellated-did
  - phase-4
  - infrastructure
dependencies:
  - AISDLC-315
references:
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: medium
blocked:
  reason: "RFC-0009 lifecycle is Ready for Review (all 13 OQs resolved v3.4, 2026-05-04). Phase 4.4 wires resolved OQ-10 (Operator platform-scoped) + OQ-11 (DatabaseBranchPool shared+RLS default + trigger checklist). Operator-acknowledged via continued Phase-4 dispatch (sibling AISDLC-315/317/318 already shipped against the same RFC under identical lifecycle posture)."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4.4 of RFC-0009. Bundles two small wiring tasks: DatabaseBranchPool default + Operator role scoping. Per OQ-10 + OQ-11 resolutions.

## Scope (RFC-0009 §10 Phase 4, §8.7 DatabaseBranchPool + §8.8 Operator role)

### DatabaseBranchPool (OQ-11 resolution)

- Default = shared+RLS per §8.7.
- `init` wizard walks the trigger checklist for per-soul opt-in:
  - Regulatory hard requirement
  - Customer contract requirement
  - Operator security review
- RFC-0022 (Compliance Posture) declarations drive the gate automatically when adopters use it.
- Per-soul opt-in upgrades pool to per-soul-branch when any trigger fires.

### Operator role wiring (OQ-10 resolution)

- Confirm Operator role is **platform-scoped, not tessellated**.
- No soul-vertex Operator field shipped (explicit OQ-10 outcome).
- Existing AgentRole + platform-Operator wiring preserved.

## Why bundled

Both are small operator-touchable wiring tasks (config schema + init wizard prompts). Combining them into one task is more efficient than two separate small PRs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 DatabaseBranchPool default = shared+RLS per §8.7
- [x] #2 `init` wizard walks the 3-trigger checklist (regulatory / contract / operator review)
- [x] #3 RFC-0022 declarations drive gate automatically when adopter has them
- [x] #4 Per-soul opt-in upgrades pool to per-soul-branch when any trigger fires
- [x] #5 Operator role confirmed platform-scoped per OQ-10; no soul-vertex Operator field shipped
- [x] #6 Test coverage: default shared+RLS / trigger-fires-per-soul-upgrade / Operator-stays-platform-scoped
<!-- AC:END -->

## Final Summary

### Summary
Phase 4.4 of RFC-0009 lands the RFC-0009 §8.7 / OQ-11 trigger checklist on top of the existing RFC-0022 compliance-posture wiring, and pins RFC-0009 §8.8 / OQ-10 (Operator role is platform-scoped) at the schema + type level. The init wizard now walks the full 3-trigger checklist (regulatory → derived from declared regimes via RFC-0022; customer-contract → operator yes/no; operator-security-review → operator yes/no), upgrading `DerivedGates.databaseBranchPool` from `shared-with-rls` to `per-shard` when ANY trigger fires. The Triad type + DID schema lock the Fractal Triad to `{design, engineering, product}` with `additionalProperties: false`, structurally precluding a soul-vertex Operator field.

### Changes
- `orchestrator/src/cli/commands/init-features.ts` (modified):
  - New exports: `Oq11TriggerKind`, `Oq11TriggerAnswers`, `Oq11TriggerChecklistResult`, `applyOq11TriggerChecklistUpgrade(inputGates, answers)`, `describeOq11Trigger(kind)`.
  - `ComplianceStepResult` gains `oq11Triggers: Oq11TriggerKind[]`.
  - `runComplianceStep()` (interactive path) adds two yes/no prompts after regime selection: customer-contract + operator-security-review (both default `false`). On trigger fire, applies the upgrade and surfaces the rationale in the wizard summary alongside the regime-derived rationale.
  - `--yes` / non-TTY path passes through with `oq11Triggers: []` and unchanged baseline (shared-with-rls).
- `orchestrator/src/cli/commands/init-compliance-wizard.test.ts` (modified):
  - Stub adapter exposes `promptCalls` + scripted `promptAnswers` FIFO, falling back to per-prompt `defaultYes` when the queue is empty (so existing pre-AISDLC-319 tests continue to receive the production-default answer of `false`).
  - +23 new hermetic tests covering `applyOq11TriggerChecklistUpgrade()` (default baseline, each trigger individually, both 2+3, regulatory + customer-contract combined, monotonic, pass-through, non-mutating), `describeOq11Trigger()` (4 tests), `runComplianceStep()` OQ-11 integration (interactive baseline, walks 2 prompts, defaults false, trigger-2 upgrade, trigger-3 upgrade, regime + trigger-2 combined, log rationale, `--yes` no prompts), AC #5 Operator-platform-scoped (Triad type + DID schema `additionalProperties: false` + no `operator` key).

### Design decisions
- **No schema or runtime DatabaseBranchPool changes.** RFC-0010 §15 already defines `DatabaseBranchPool.spec` (`adapter`, `upstream`, `injection`, `lifecycle`, …) without baking a `shared-with-rls`-vs-`per-shard` mode into the resource itself. The mode is an adopter-policy decision the framework surfaces via `DerivedGates.databaseBranchPool` (set by `BASELINE_DERIVED_GATES` to `'shared-with-rls'`, lifted to `'per-shard'` by regimes via `INIT_WIZARD_REGIME_GATES` and now by the operator-declared §8.7 triggers). This avoids over-fitting the resource schema to a single policy axis and preserves backwards compat: existing `DatabaseBranchPool` YAMLs require zero migration.
- **Trigger 1 (regulatory) surfaces only when already-derived.** The function reports `'regulatory'` in `triggers` iff the input `derivedGates.databaseBranchPool` is ALREADY `per-shard` from upstream regime composition. This keeps the contract pure-functional and lets callers report all three trigger sources uniformly without double-prompting the operator on regimes they already declared in the compliance-posture step.
- **Two prompts, not three.** Trigger 1 is regime-derived (operator already answered it via the multi-select); the wizard only adds prompts for triggers 2 + 3 to avoid asking the operator the same question twice. The summary block still reports all three trigger sources by name when any fire.
- **Default `false` on both new yes/no prompts.** Matches RFC-0009 §8.7's "shared+RLS is the framework default because RLS-with-correctly-configured-policies provides logical tenant isolation that satisfies the majority of compliance and engineering requirements." The wizard prompt body explicitly tells the operator "Answer Yes only if the trigger actually applies — per-soul pools add operational complexity," cutting the false-positive rate.
- **AC #5 enforced at type + schema, not at runtime.** RFC-0009 OQ-10 (Operator platform-scoped) is a NEGATIVE invariant — "no soul-vertex Operator field." Validating this with a runtime check would be a tautology (you can't validate the absence of a field by reading it). Instead, the test asserts the Triad TypeScript interface has exactly `{design, engineering, product}` keys AND the JSON-Schema's `triad` block has `additionalProperties: false` + `required: [design, engineering, product]` + no `operator` property. Any future refactor that adds Operator to the Triad fails both the TS strict check and the schema test in one shot.
- **Stub adapter falls back to `defaultYes` instead of a fixed `true`.** Previously the test stub returned `true` for every yes/no prompt because compliance tests didn't exercise yes/no surfaces. With the new trigger prompts (default `false`), returning `true` would have flipped every existing test to `per-shard` unexpectedly. The new behavior — FIFO scripted answers, falling back to the production-default `defaultYes` — preserves test isolation while making it easy to script trigger answers in new tests.

### Verification
- `pnpm build` — clean (9 workspaces).
- `pnpm test` — clean (reference 1358 / orchestrator 3919 / pipeline-cli 5297 / dashboard 172 / ai-sdlc-plugin/mcp-server 159 / conformance/runner 24 / mcp-advisor 131 / dogfood 372 / sdk-typescript 15 — all green).
- `pnpm lint` — clean.
- `pnpm format:check` — clean.
- Targeted: `pnpm --filter @ai-sdlc/orchestrator exec vitest run init-compliance-wizard.test` → 78 tests pass (55 pre-existing + 23 new AISDLC-319 tests).

### Follow-up
- **No inline OQ resolution.** RFC-0009 OQ-10 + OQ-11 were resolved in v3.4 (2026-05-04, operator walkthrough). Phase 4.4 is wiring per the existing resolutions; nothing escalated.
- AISDLC-322 (RFC-0022 Phase 1 — compliance-posture schema + loader) ships the canonical RFC-0022 surface; the init-wizard wiring already integrates with `DerivedGates`/`BASELINE_DERIVED_GATES` from `orchestrator/src/compliance/types.ts`. No changes needed there.
- Sibling AISDLC-317 (Eτ_tessellation_drift) + AISDLC-318 (HC_cost) + AISDLC-316 (Eρ₅ compliance clearance) are the remaining RFC-0009 Phase 4 wiring tasks.
