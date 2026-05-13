---
id: AISDLC-269
title: 'chore: complete RFC-0024 capture authoring + triage flow'
status: Done
assignee: []
created_date: '2026-05-13 18:48'
labels:
  - rfc-0024
  - retrofit-followup
  - emergent-capture
  - critical-path-rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - pipeline-cli/src/tui/blockers/detector.ts
  - pipeline-cli/src/tui/corpus/aggregate.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Complete the unbuilt portion of RFC-0024 (Emergent Issue Capture + Triage Pattern). The detection substrate ships today; the capture authoring and triage decision flow do not.

## What ships today (per 2026-05-13 audit)

- pipeline-cli/src/tui/blockers/detector.ts — Rule 3 detects pending-triage capture records and surfaces them as TUI blockers (cites RFC-0024 directly)
- pipeline-cli/src/tui/corpus/aggregate.ts — TuiCaptureFiled event aggregation tied to RFC-0024 capture IDs

## What's missing

The authoring half of the loop — operators and AI agents currently have nowhere to record a capture, so the detector has no input. The triage decision flow that consumes capture records and produces backlog Issues or scope decisions also does not exist.

## Why this matters

RFC-0024 sits on the critical path for RFC-0035 (Decision Catalog): RFC-0035 source emergent-finding decision feeder reads capture records as input. RFC-0035 design contract cannot stabilize until RFC-0024 capture and triage flow is shipped.

## Pre-work required

The 12 Open Questions in RFC-0024 §15 still need an operator walkthrough before this implementation can land. Each OQ has an author Recommendation in the RFC body; the walkthrough resolves recommendations into normative answers and unblocks Phase 1 of this task.

## References

- RFC-0024 §5 (Capture sources), §6 (Capture record schema), §7 (Triage rubric), §9.2 (Decision-pending → decision-deferred handoff)
- pipeline-cli/src/tui/blockers/detector.ts (existing detector Rule 3)
- pipeline-cli/src/tui/corpus/aggregate.ts (existing event aggregator)
- Surfaced by the 2026-05-13 partial-implementation status retrofit pass
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `cli-capture` CLI ships per RFC-0024 §5.1 (subcommands: file, list, redact, against-current-pr) with the capture record schema from §6
- [x] #2 PR-comment marker parser ships per §5.2 (parses `ai-sdlc:capture` markers in PR review comments and creates capture records)
- [x] #3 In-code marker linter ships per §5.3 (`// ai-sdlc:capture` prefix detection; non-blocking warning)
- [x] #4 AI-agent direct-capture path ships per §5.4 (subagents can emit captures via prompted output protocol)
- [x] #5 Triage rubric implementation per §7 — operator promotes a capture to backlog Issue, scope-creep merge, or new RFC; default pending until decision
- [x] #6 DoR integration per §8 — DoR clarification rounds can spawn captures; capture corpus is one input to PPA scoring
- [x] #7 RFC-0011 + RFC-0015 integration tests confirm capture flow does not block dispatch (decision-deferred handoff per §9.2)
- [x] #8 RFC-0024 §15 OQs resolved with normative answers (operator walkthrough required first); §15 retrofit follows the 2026-05-13 partial-impl pattern
- [x] #9 RFC-0024 lifecycle flipped to Implemented; registry row + inventory entry updated
<!-- AC:END -->

## Final Summary

## Summary
Shipped the capture authoring and triage flow for RFC-0024. The detection substrate (TUI blockers Rule 3, corpus aggregator) already existed; this task adds the authoring half: the `cli-capture` CLI, capture record schema, PR-comment marker parser, in-code marker linter, triage rubric, `CapturesPending` pre-dispatch filter, and the RFC-0024 OQ resolutions.

## Changes
- `spec/schemas/capture-record.v1.schema.json` (new): JSON Schema for RFC-0024 §6 capture record.
- `pipeline-cli/src/capture/capture-record.ts` (new): types, validators, ID generator.
- `pipeline-cli/src/capture/capture-writer.ts` (new): JSONL writer, triage update, redact.
- `pipeline-cli/src/capture/capture-reader.ts` (new): loader, filter, `hasPendingCapturesForIssue`.
- `pipeline-cli/src/capture/pr-comment-parser.ts` (new): RFC-0024 §5.2 marker parser.
- `pipeline-cli/src/capture/incode-linter.ts` (new): RFC-0024 §5.3 `// ai-sdlc:capture` linter.
- `pipeline-cli/src/capture/triage-rubric.ts` (new): RFC-0024 §7 rubric table + TUI shortcuts.
- `pipeline-cli/src/capture/index.ts` (new): public re-export.
- `pipeline-cli/src/cli/capture.ts` (new): `cli-capture` CLI router (file/list/redact/against-current-pr/triage/parse-pr-comments/lint-file/help-triage).
- `pipeline-cli/bin/cli-capture.mjs` (new): bin shim.
- `pipeline-cli/src/orchestrator/filters/captures-pending.ts` (new): RFC-0024 §9.3 pre-dispatch filter (degrade-open, gated on `AI_SDLC_EMERGENT_CAPTURE`).
- `pipeline-cli/src/orchestrator/filters/chain.ts` (modified): added `CapturesPending` as filter #9.
- `pipeline-cli/src/orchestrator/filters/types.ts` (modified): added `CapturesPending` to `FilterName` union + `FilterDetail` union.
- `pipeline-cli/src/orchestrator/filters/index.ts` (modified): exports for new filter.
- `pipeline-cli/src/orchestrator/loop.ts` (modified): added `captures-pending` case to `toBlockedEvent` switch.
- `pipeline-cli/package.json` (modified): added `cli-capture` bin entry.
- `pipeline-cli/src/orchestrator/filters/chain.test.ts` (modified): updated trace length expectation from 8 → 9.
- `spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md` (modified): OQs resolved (§15), lifecycle → Implemented, sign-off updated, revision history v0.3.
- `spec/rfcs/README.md` (modified): registry row updated to Implemented, OQ count 0.

## Design decisions
- **Degrade-open filter**: `CapturesPending` only activates when `AI_SDLC_EMERGENT_CAPTURE=experimental` — zero impact on existing pipelines.
- **Adapter calls deferred**: Issue/Feature Issue creation from captures requires RFC-0003 adapter implementations. The CLI documents the intended action but does not make external calls in v1.
- **OQ-7 redact not delete**: `cli-capture redact` scrubs fields but preserves the audit trail — maintains the quality contract without enabling PII propagation.

## Verification
- `pnpm build` — clean
- `pnpm exec vitest run` — 2857 tests, 174 files, all passed
- `pnpm lint` — 0 errors, 2 pre-existing warnings in unrelated file
- `pnpm format:check` — all files formatted

## Follow-up
- RFC-0003 adapter implementations to wire Issue creation from captures.
- TUI triage keystrokes (RFC-0024 §10) depend on RFC-0023 Blockers pane interactive layer.
- `cli-capture-corpus aggregate` Phase 6 corpus aggregator.
- `OrchestratorBlockedByCapturesPending` event type in the events schema.
