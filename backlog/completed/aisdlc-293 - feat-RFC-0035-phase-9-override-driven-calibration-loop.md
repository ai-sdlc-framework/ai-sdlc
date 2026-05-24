---
id: AISDLC-293
title: 'feat: RFC-0035 Phase 9 — Override-driven calibration loop + pending-exemplars.yaml'
status: Done
assignee:
  - '@dominique'
created_date: '2026-05-15'
completed_date: '2026-05-24'
labels:
  - rfc-0035
  - decision-catalog
  - phase-9
  - critical-path
dependencies:
  - AISDLC-289
  - AISDLC-306
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
blocked:
  reason: "RFC-0035 OQs acknowledged (14/14 resolved 2026-05-15 operator walkthrough); precedent set by AISDLC-289 (Phase 5) which shipped under the same lifecycle 2026-05-23"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 9 of RFC-0035 Implementation Plan (§14). Closes the calibration loop via the auto-apply + override window pattern from Phase 5. Per-org configurable override window (default 24h).

## Scope

- `pending-exemplars.yaml` writer on operator override (negative exemplars)
- Silent auto-apply (no override within window) → exemplar promoted to `decision-exemplars.yaml` (positive exemplars)
- Weekly digest summarises new pending exemplars
- `cli-decisions corpus aggregate` produces aggregated training corpus
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `pending-exemplars.yaml` writer on operator override
- [x] #2 Silent auto-apply (no override within window) promotes to `decision-exemplars.yaml`
- [x] #3 Weekly digest summarises new pending exemplars
- [x] #4 `cli-decisions corpus aggregate` produces aggregated training corpus
- [x] #5 Per-org configurable override window (default 24h)
- [x] #6 Operator can re-affirm or re-classify pending exemplars via CLI
<!-- AC:END -->

## Final summary

### Summary

Shipped the RFC-0035 Phase 9 override-driven calibration loop: substrate-corpus polarity resolutions now mirror through a three-stage operator-review pipeline — substrate corpus (raw audit log, append-only) → `pending-exemplars.yaml` (review queue, mutable) → `decision-exemplars.yaml` (curated training corpus, immutable). The loop composes with the Phase 5 substrate (`pipeline-cli/src/classifier/substrate/`) and the existing decisions module without changing either's contracts. New CLI surface lives under `cli-decisions exemplars {list,sweep,affirm,reclassify,reject,promote-all,digest,paths}`; the weekly digest renders markdown with CLI hints for the operator action list.

### Changes

- `pipeline-cli/src/decisions/pending-exemplars.ts` (new): `PendingExemplar` record + reader/writer + disposition lifecycle (`affirmed` / `reclassified` / `rejected` / `pending`). Atomic rename-after-write; lenient reader (corrupt file → `[]` + warn). Idempotent on `corpusEntryId`.
- `pipeline-cli/src/decisions/decision-exemplars.ts` (new): `DecisionExemplar` curated store + promotion APIs. `promotePendingExemplar()` (single) + `promoteAllDisposedPendingExemplars()` (batch). `disposeAndOptionallyPromote()` convenience wires disposition + promotion in one call.
- `pipeline-cli/src/decisions/calibration-sweep.ts` (new): substrate-corpus → pending-exemplars mirror. Negatives-only by default; `--include-positives` opts in to bulk positive-exemplar harvesting. Back-fills `decisionId` from `stage-c-completed` events via `buildCorpusEntryToDecisionIdMap()`.
- `pipeline-cli/src/decisions/exemplars-digest.ts` (new): weekly digest builder + markdown renderer. Default 7-day window; per-task-type breakdown; oldest-pending action list with age in hours; CLI hints for operator actions.
- `pipeline-cli/src/decisions/index.ts` (modified): export the four new modules from the barrel.
- `pipeline-cli/src/cli/decisions.ts` (modified): extend the `override` command to auto-mirror the negative corpus entry into `pending-exemplars.yaml`; add a new `exemplars` subcommand group with eight subcommands.
- `pipeline-cli/src/cli/decisions.test.ts` (modified): add Phase 9 CLI integration tests (8 new cases) covering sweep / list / affirm / reclassify / reject / digest / disposition filtering / promotion.
- 4 new test files (`pending-exemplars.test.ts`, `decision-exemplars.test.ts`, `calibration-sweep.test.ts`, `exemplars-digest.test.ts`) totalling 46 new unit tests.

### Design decisions

- **Three-file calibration chain vs single file**: separate `substrate corpus` / `pending-exemplars.yaml` / `decision-exemplars.yaml` reflects three distinct lifecycles (append-only audit log / mutable review queue / immutable training corpus). Folding into one file would either trash the substrate's append-only invariant or force the operator to scroll past thousands of raw classifier calls to find override events. The three-file shape mirrors RFC-0031's `pending-revisions.yaml` → `did-revisions.yaml` pattern (Phase 9 explicitly cites RFC-0031).
- **Negatives mirrored automatically, positives behind `--include-positives`**: negative-polarity entries (operator overrides) ARE the calibration signal — surfacing all of them is correct. Positive-polarity entries are the bulk of the corpus; surfacing all of them swamps the review queue. Operators opt-in to positive batch-promotion via the explicit flag.
- **`disposeAndOptionallyPromote` convenience**: combining set-disposition + promote in one CLI call eliminates the dominant 2-command operator pattern (affirm + then promote). `--defer-promote` opts out for batch workflows. Used `--defer-promote` instead of `--no-promote` because yargs interprets `--no-foo` as `foo=false`, which collides with how `strict` parsing surfaces unknown flags.
- **`mirrorSubstrateEntry()` extension to `override` command**: the operator-driven override flow now writes BOTH the substrate corpus flip AND the pending-exemplars mirror in one atomic CLI invocation. Idempotent on `corpusEntryId` so a re-replay does not duplicate.
- **No changes to substrate `override.ts`**: Phase 9 is strictly read-only with respect to the substrate (the operator-override flip remains the substrate's job). This keeps the substrate's contract narrow and decoupled.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli` decisions module + CLI tests — 357/357 passing
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm build` (workspace) — clean

### Follow-up

- Phase 10 (TUI calibration pane integration) — RFC-0023 Phase 9 / not in this PR.
- Stage C prompt-anchoring consumer for `decision-exemplars.yaml` — will be wired in a follow-up that extends `pipeline-cli/src/classifier/substrate/task-prompts.ts` to inject curated exemplars into the `decision-recommendation` prompt template.
- The `--include-positives` sweep currently re-walks every task-type's full corpus on each invocation. For large corpora a watermark file (`pending-exemplars.lastSweepAt`) would let the sweep skip entries already considered. Defer to AISDLC-293 follow-up when corpus size justifies.
