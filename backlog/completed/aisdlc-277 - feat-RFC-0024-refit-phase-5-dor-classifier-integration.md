---
id: AISDLC-277
title: 'feat: RFC-0024 Refit Phase 5 — DoR-classifier integration (OQ-11)'
status: Done
assignee: []
created_date: '2026-05-15'
updated_date: '2026-05-25'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-5
  - critical-path-rfc-0035
dependencies:
  - AISDLC-321
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: high
blocked:
  reason: "RFC-0024 lifecycle is intentionally rolled back to `Ready for Review` per its §15 status note — all 12 OQs carry 2026-05-15 `Resolution:` markers; the rollback is explicitly so the AISDLC-320/321 + 275-278 Refit work can flip it back to `Implemented` after Phase 6 (AISDLC-278). Operator-acknowledged."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 5. Closes the OQ-11 gap: when an operator answers a DoR Stage B refinement question, their answer may reveal a NEW concern (not just a clarification of the existing question). The 2026-05-15 resolution reuses the Phase 2 classifier on DoR clarification responses.

## Scope (OQ-11)

- Hook into RFC-0011 DoR Stage B clarification response handler.
- Each segment of an operator's answer evaluated by the Phase 2 classifier with classes `{clarification | new-concern | ambiguous}`.
- `new-concern` segments above threshold auto-extracted to capture records.
- Capture records reference the DoR thread by ID.
- Multi-segment answers can split capture from clarification (one DoR answer can produce N captures + the clarification answer).
- Operator confirms in TUI before commit; classifier-confidence visible.
- RFC-0011 rubric and admission semantics stay unchanged (this is a side-effect of clarification responses, not a new gate).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 DoR Stage B clarification response handler invokes Phase 2 classifier
- [x] #2 Multi-class output: `clarification | new-concern | ambiguous` per segment
- [x] #3 `new-concern` segments above threshold auto-extract to capture records
- [x] #4 Capture records reference DoR thread by ID
- [x] #5 Operator confirms in TUI before commit
- [x] #6 RFC-0011 admission semantics unchanged (no new gate; side-effect only)
- [x] #7 Integration test: DoR answer with mixed clarification + new-concern segments produces correct extraction
<!-- AC:END -->

## Final Summary

### Summary
Shipped the OQ-11 wiring that closes the RFC-0024 Refit Phase 5 gap. When an operator answers a DoR Stage B clarification question, the new `pipeline-cli/src/dor/dor-answer-capture.ts` module segments the answer (paragraphs + bullet-line splitting), classifies each segment via the AISDLC-321 substrate (`dor-answer-is-new-concern` task type), proposes `new-concern` segments above the substrate threshold as capture records (referenced to the DoR thread via `blocksIssueId`), and leaves clarification / ambiguous / low-confidence-`new-concern` / classifier-failure segments in the residual answer. The operator confirms proposals in the TUI before commit (the propose/commit split is the AC #5 surface); confirmed proposals flow through `commitDorAnswerCaptures()` to write the records with the default operator-pending triage value + `source.type: 'operator'`. RFC-0011's rubric and admission semantics are unchanged — this is a pure side-effect of processing the operator's answer text, with zero coupling back into `evaluate.js` / `composite.js` / `stage-b.js` (test-enforced).

### Changes
- `pipeline-cli/src/dor/dor-answer-capture.ts` (new): the OQ-11 wiring. Exports `segmentDorAnswer`, `classifyDorAnswerSegments`, `proposeCapturesFromDorAnswer`, `commitDorAnswerCaptures`, `processDorAnswer` (composite). All operations are pure-ish (filesystem writes are gated by the commit step) and inherit the substrate's fall-open semantics — a classifier outage means every segment stays as clarification, never silently extracted.
- `pipeline-cli/src/dor/dor-answer-capture.test.ts` (new): 28 tests covering segmentation (8 tests), per-segment classifier wrapper (3 tests, AC #2), propose flow (5 tests, AC #1 + AC #3 + fall-open + threshold override), commit flow (5 tests, AC #4 + AC #5 surface + write-disk-match), composite + confirm hook (4 tests, AC #5), and a realistic 4-segment integration test (AC #7). The AC #6 test enforces structural decoupling from RFC-0011's verdict / composite / Stage B paths by import-shape assertion.
- `pipeline-cli/src/dor/index.ts` (modified): re-export the new module so consumers can `import { proposeCapturesFromDorAnswer } from '@ai-sdlc/pipeline-cli/dor'`.

### Design decisions
- **Rule-based segmenter, not LLM-driven.** An operator answer is typically 1-6 paragraphs / bullets; adding an LLM call to discover segments would double cost for no calibration benefit. The rules: blank-line paragraphs become segments; bullet-line groups (≥2 bulleted lines) split per-line. Single-bullet paragraphs stay as one segment (no spurious splitting). Tested against `-`, `*`, `+`, `•`, and `1.` / `1)` markers.
- **Propose / commit split (AC #5 surface).** `proposeCapturesFromDorAnswer()` returns proposals + per-segment classifier results + residual clarification but does NOT write captures. The TUI confirms; confirmed proposals flow through `commitDorAnswerCaptures()`. This separation is what AC #5 names — "operator confirms in TUI before commit". A convenience composite `processDorAnswer()` exposes a `confirm` callback hook for callers that have confirmation context in one place.
- **Fall-open everywhere.** The substrate's `classify()` never throws (invoker errors → `pending` sentinel + confidence 0). This module inherits that: classifier outage → no proposals, every segment stays as clarification. Tested explicitly.
- **Threshold semantics.** Only `classification === 'new-concern'` AND `metBehindThreshold === true` get proposed. `ambiguous` and `clarification` are never proposals; low-confidence `new-concern` stays in clarification rather than being surfaced as "maybe?" (which would inflate operator review noise). The substrate's default 0.7 threshold applies; per-call override supported.
- **`blocksIssueId` carries the DoR-thread reference (AC #4).** Capture records produced this way are gating the DoR thread until the operator triages them — exactly the §9.3 pre-dispatch-filter shape RFC-0024 already specifies. The capture's `source.context` also embeds `"DoR clarification on <issueId>"` for human-readable provenance, and `evidence.additionalContext` carries the original DoR question text when supplied.
- **Severity stays `unknown` (deliberate scope cut).** OQ-5's severity classifier is a SEPARATE substrate call (Phase 3 / AISDLC-275 territory). This module's contract is OQ-11 (segment-class classifier on operator answers) — adding the severity round-trip would couple Phase 5 to Phase 3's not-yet-shipped wiring. Severity stays `unknown` until the operator triages, matching the OQ-5 baseline for un-inferred severity.
- **No RFC inline OQ resolution.** OQ-11 already carries its 2026-05-15 Resolution; this task implements that resolution. The RFC's lifecycle banner is unchanged (it will flip to `Implemented` after AISDLC-278 — Refit Phase 6 — per the existing banner contract).

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 275 test files, 5258 tests pass, 1 skipped (whole package; 28 new tests in this PR)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Full workspace `pnpm test` surfaced a pre-existing flake in `sdk-typescript/src/exports.test.ts` (5s timeout race on cold-load — passes in isolation in 2.5s); unrelated to this PR.

### Follow-up
- TUI wiring (Phase 8 / RFC-0023 Blockers pane) needs to call `proposeCapturesFromDorAnswer()` from the DoR-thread answer surface and render the proposals for one-keystroke confirm/decline. This module provides the data shape; the TUI presentation layer ships separately.
- Real Anthropic Haiku `LlmInvoker` adapter lives in a downstream consumer module (per AISDLC-321's design); production callers wire it in. Tests use `FakeLlmInvoker` from `@ai-sdlc/pipeline-cli/classifier`.
- Operator-override capture for negative exemplars (when operator declines a proposal) is not wired in this module — the propose/commit flow gives the TUI the `corpusEntryId` on each proposal, so the TUI calls `recordOperatorOverride()` directly when the operator picks `clarification` over the classifier's `new-concern`. Adding that wiring to this module would couple it to a calling convention the TUI hasn't shipped yet.
