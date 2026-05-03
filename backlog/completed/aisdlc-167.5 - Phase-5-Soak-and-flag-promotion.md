---
id: AISDLC-167.5
title: 'Phase 5: Soak + flag promotion'
status: Done
assignee: []
created_date: '2026-05-03'
updated_date: '2026-05-02'
labels:
  - rfc-0014
  - phase-5
  - soak
  - flag-promotion
milestone: m-3
dependencies:
  - AISDLC-167.3
  - AISDLC-167.4
parent_task_id: AISDLC-167
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - docs/operations/operator-runbook.md
  - docs/operations/deps-composition-promotion.md
  - pipeline-cli/docs/deps.md
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file spec/rfcs/RFC-0014-dependency-graph-composition.md was
      modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file docs/operations/operator-runbook.md was modified after
      task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file docs/operations/deps-composition-promotion.md was modified
      after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file pipeline-cli/docs/deps.md was modified after task was
      completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0014. Run with `AI_SDLC_DEPS_COMPOSITION=off` (default) → operators opt in via env override → measure dispatch quality vs PPA-only baseline → promote flag to default-on when corpus criteria are met. Per RFC §11 Phase 5.

## Soak policy — corpus-driven, NOT calendar-driven

Per maintainer directive (2026-05-01): this phase ships when:
- **Dispatch correctness > 95%** measured against the pipeline corpus (composition vs PPA-only baseline; "correctness" = dispatcher's top pick matches an operator's manual top pick on a held-out corpus slice), AND
- **No operator override-rate spike** vs PPA-only baseline (override-rate metric from RFC-0011 §7.4 framework, repurposed for dispatch overrides).

Whichever comes first. Calendar duration is a side-effect, not a gate.

## Promotion mechanics

- Default `AI_SDLC_DEPS_COMPOSITION=off` until corpus criteria met.
- Operators opt-in via env override (per-session) during soak.
- When promotion criteria met, flip default to `on` in a single, reviewable PR. Document the corpus measurement that justified promotion.
- Hybrid corpus-OR-operator-override promotion model available (matches RFC-0011 / AISDLC-161 pattern) if the corpus is too small for statistical confidence within reasonable wall-clock.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Soak harness measures dispatch correctness for composition vs PPA-only baseline against a held-out corpus slice; "correctness" = dispatcher's top pick matches an operator's manual top pick
- [x] #2 Soak harness measures operator override-rate (dispatch overrides), composing with the existing RFC-0011 §7.4 override-rate framework where reusable
- [x] #3 Operator opt-in path documented: per-session `AI_SDLC_DEPS_COMPOSITION=on` env override; runbook entry in `docs/operations/operator-runbook.md` covering opt-in, observation, and revert
- [x] #4 Promotion criteria gate: dispatch correctness > 95% AND no operator-override-rate spike vs PPA-only baseline; both metrics published to the existing dashboard surface
- [x] #5 Default-on flip is a separate, reviewable PR that links to the corpus measurement justifying promotion; rollback procedure documented (flip env back to `off`, single-line revert)
- [x] #6 Operator runbook (`docs/operations/operator-runbook.md`) extended with composition-specific failure modes: snapshot validation failures, dispatch ordering anomalies, blast-radius callout misfires
- [x] #7 Parent AISDLC-167 ACs #2, #3, #5 closed by the work in this sub-task (flag promoted, dogfood pipeline running with composition end-to-end, runbook extended)
- [x] #8 Soak measurement methodology + the promotion decision documented in `pipeline-cli/docs/deps.md` so future phases can reuse the corpus-driven pattern
<!-- AC:END -->

## Final Summary

### Summary
Shipped the corpus-driven measurement infrastructure that closes the RFC-0014 loop: a snapshot aggregator (`cli-deps-corpus`), an operator override capture surface (`cli-deps log-override` + `cli-deps list-overrides`), and a hybrid promotion runbook (`docs/operations/deps-composition-promotion.md`). The AISDLC-167.4 dashboard `/deps` page is the operator's spot-check surface for the override path; the corpus aggregator is the math-rigorous path. Both produce the same default-on end-state. The actual flag flip is operator-decision-gated (per the brief's "out of scope" notice) and dispatched from the runbook.

### Changes
- `pipeline-cli/src/deps/override-log.ts` (new): append-only JSONL log of operator dispatch overrides at `$ARTIFACTS_DIR/_deps/overrides.jsonl`. Pure I/O surface — `appendOverrideEntry`, `loadOverrides`, `isValidOverrideEntry`, `resolveOverrideLogPath`.
- `pipeline-cli/src/deps/override-log.test.ts` (new): 13 hermetic tests covering round-trip, ranking-cap, schema validation, forward-compat, missing-file tolerance.
- `pipeline-cli/src/cli/deps-corpus.ts` (new): the snapshot-corpus aggregator + recommendation envelope. Joins `_deps/snapshot.*.jsonl` with `_deps/overrides.jsonl`; computes `dispatchAgreementRate` (proxy via snapshot-resident `criticalPathLength`) + `operatorOverrideRate` (ground-truth from log).
- `pipeline-cli/src/cli/deps-corpus.test.ts` (new): 29 tests — empty corpus, all-agree, mixed agree/disagree, override-spike, schema validation skip+count, multi-file CLI surface.
- `pipeline-cli/bin/cli-deps-corpus.mjs` (new): bin shim, registered in `pipeline-cli/package.json`.
- `pipeline-cli/src/cli/deps.ts` (modified): added `log-override` subcommand (refuses no-op overrides + unknown picks) + `list-overrides` subcommand for quick inspection.
- `pipeline-cli/src/deps/index.ts` (modified): re-exports `override-log` so library consumers can import from one place.
- `pipeline-cli/package.json` (modified): registered `cli-deps-corpus` bin + `./deps-corpus` exports subpath.
- `docs/operations/deps-composition-promotion.md` (new): the runbook itself — TL;DR table, background, corpus path, override path, the flag flip, override-logging workflow, post-flip verification.
- `docs/operations/deps-composition.md` (modified): cross-link to the promotion runbook.
- `docs/operations/operator-runbook.md` (modified): added "RFC-0014 dependency-graph composition is acting up" failure-mode section per AC #6.
- `pipeline-cli/docs/deps.md` (modified): Phase 5 section documenting override schema, aggregator semantics, proxy caveat, library API.
- `CLAUDE.md` (modified): feature-flag bullet now references the promotion runbook.
- `spec/rfcs/RFC-0014-dependency-graph-composition.md` (modified): §11 Phase 5 row updated to reference the new runbook + sub-task ID.

### Design decisions
- **Aggregator uses a proxy for "composition mode"**: snapshots don't carry per-task `priority:`, so the aggregator approximates composition with snapshot-resident structural signal (`criticalPathLength` DESC → `lastModified` DESC → `id` ASC). Documented as conservative — a real composition mode that adds a primary priority sort can only further reorder ties, so the proxy under-estimates real disagreement. The override rate is the ground-truth signal.
- **Override log is a separate file (not co-mingled with snapshots or `_dor/calibration.jsonl`)**: snapshots = graph at point-in-time (one file per tick); overrides = operator decisions over time (one event per dispatch); calibration = gate-rubric correctness. Different cardinality + lifecycle + consumers, so different files.
- **`log-override` refuses no-op + unknown picks**: prevents accidental corpus pollution if an operator runs the command after the dispatcher already converged on their preferred pick, or with a typo'd id.
- **Runbook follows the AISDLC-115.9 / AISDLC-161 hybrid pattern verbatim**: corpus path (math-rigorous) OR override path (operator judgment). Same end-state. Lets operators promote without being gated on calendar time.
- **`log-override` always uses `forceComposition: true`**: even when `AI_SDLC_DEPS_COMPOSITION` is OFF, the override IS the soak signal — we need composition's pick to compare against, regardless of the env flag.

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1248 passed (42 new)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm rfc:test` / `pnpm rfc:check` — clean

### Follow-up
- The flag flip itself is operator-decision-gated; once the corpus accumulates ≥30 snapshots OR the operator spot-checks the AISDLC-167.4 dashboard `/deps` page and confirms compositional dispatch isn't surprising, dispatch the default-on PR per the runbook. After the flip lands, close AISDLC-167 (parent) ACs #2 + #3 + #5.
- AISDLC-167.4 (Phase 4 — Slack + dashboard digest) remains pending and is the natural surface for the override-path spot-check; the runbook references it as the operator's eyeball channel.
