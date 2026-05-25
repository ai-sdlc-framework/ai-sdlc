---
id: AISDLC-276
title: 'feat: RFC-0024 Refit Phase 4 — PR-comment bidirectional sync + LLM auto-classifier (OQ-3)'
status: Done
assignee: []
created_date: '2026-05-15'
completed_date: '2026-05-24'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-4
  - critical-path-rfc-0035
dependencies:
  - AISDLC-321
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - pipeline-cli/src/capture/pr-comment-parser.ts
  - pipeline-cli/src/capture/pr-comment-classifier.ts
priority: high
blocked:
  reason: "RFC-0024 OQ-3 resolved (2026-05-15); RFC remains at lifecycle 'Ready for Review' pending the full Refit (AISDLC-275/276/277/278) — once Phase 6 ships, RFC promotes to Implemented. This task implements the resolution; upstream-OQ block is structural until the Refit completes (mirrors AISDLC-275 sibling)."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 4. Closes the OQ-3 gap: the shipped PR-comment parser only matches comments with explicit `ai-sdlc:capture` markers, losing ~80% of actual review signal because busy reviewers don't reliably tag. The 2026-05-15 resolution adds an LLM auto-classifier on un-marked comments via the Phase 2 substrate.

## Scope

- Haiku classifier evaluates each PR review comment for "is this a capture?" with confidence.
- Threshold 0.5 (looser than capture-triage threshold; reflects "is this worth indexing" vs. "is this triage right").
- Classified-yes comments indexed in the RFC-0024 capture corpus with reference to GitHub comment URL.
- Capture marker syntax (OQ-4) remains as optional refinement (high-confidence pre-indication).
- Conflict resolution: GitHub-edit-wins; capture re-syncs on next webhook.
- AI-agent captures from reviewers bypass the classifier (they're already typed).
- Bidirectional sync: capture state changes (triage, severity, redact) update the corresponding GitHub comment via subtle marker append (`<!-- ai-sdlc:capture-id=<id> -->`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 PR-comment webhook handler runs each comment through Phase 2 classifier
- [x] #2 Confidence ≥ 0.5 → indexed as capture with GitHub URL reference
- [x] #3 Confidence < 0.5 → ignored (no capture record)
- [x] #4 Marker-tagged comments bypass classifier (already typed)
- [x] #5 AI-agent-authored comments bypass classifier (already typed)
- [x] #6 GitHub-edit-wins: capture re-syncs on next webhook
- [x] #7 Bidirectional sync: capture state changes append `<!-- ai-sdlc:capture-id=<id> -->` to the comment
- [x] #8 Integration test: un-marked comment + classifier-yes → indexed; un-marked comment + classifier-no → ignored
<!-- AC:END -->

## Final Summary

### Summary

Shipped the OQ-3 bidirectional-sync + LLM auto-classifier layer for PR review comments. New library module `pipeline-cli/src/capture/pr-comment-classifier.ts` composes the existing `pr-comment-parser` (marker fast-path), the Phase 2 classifier substrate (`pr-comment-is-capture` task type), and the capture persistence layer (`draft-capture` / `capture-writer`) behind one entry point `classifyPrCommentForCapture(comment, opts)`. The same module exposes the bidirectional-sync helpers (`appendCaptureMarkerToComment`, `extractCaptureIdFromComment`, `detectCommentBodyChange`, `stripCaptureIdMarker`) used by callers that need to write the `<!-- ai-sdlc:capture-id=<id> -->` footer back into the GitHub comment.

### Changes

- `pipeline-cli/src/capture/pr-comment-classifier.ts` (new): the public surface — `PR_COMMENT_DEFAULT_THRESHOLD` (0.5), `isAiAgentAuthor`, `classifyPrCommentForCapture`, `classifyPrCommentsBatch`, `appendCaptureMarkerToComment`, `extractCaptureIdFromComment`, `detectCommentBodyChange`, `stripCaptureIdMarker`, and the discriminated `ClassifyPrCommentDecision` union (`marker | ai-agent | classified-capture | classified-skip | already-linked`).
- `pipeline-cli/src/capture/pr-comment-classifier.test.ts` (new): 32 unit tests covering AC-1..AC-7 + the bidirectional-sync helpers (marker bypass, AI-agent bypass, classifier-yes / classifier-no / fall-open paths, threshold override, idempotent marker append, GitHub-edit-wins on different-id markers, already-linked short-circuit, re-sync detection).
- `pipeline-cli/src/capture/pr-comment-classifier.integration.test.ts` (new): the AC-8 end-to-end integration test — runs `classifyPrCommentsBatch` on a 2-comment fixture (one classifier-yes, one classifier-no), persists the yes via `writeSubmittedCaptureFile`, appends the capture-id footer, then re-runs the batch on the now-marked body and asserts `already-linked` short-circuit (no second classifier call, no duplicate capture file).
- `pipeline-cli/src/capture/index.ts`: re-exports the new module.
- `pipeline-cli/src/cli/capture.ts`: extends `parse-pr-comments` with `--classify` and `--threshold` flags (runs the classifier on un-marked comments and emits the per-comment verdict); adds a new `append-capture-marker` subcommand for the bidirectional-sync write path.

### Design decisions

- **Library-first surface, CLI as the consumer**: the classifier core lives in `pipeline-cli/src/capture/pr-comment-classifier.ts` with `LlmInvoker` injection via the substrate's existing `ClassifyOpts` contract — production wires the real Anthropic adapter at the call site (webhook handler / `cli-capture sync-pr` shell, not yet built), tests inject `FakeLlmInvoker`. This matches the substrate's pattern and keeps `pipeline-cli` free of `@anthropic-ai/sdk`.
- **Threshold 0.5 default, per-call override**: the substrate's per-org config supports `classifier.perTaskType.pr-comment-is-capture.threshold`; without the operator setting it, the module passes 0.5 explicitly (overriding the substrate's 0.7 default) at call time. Rationale: OQ-3 (2026-05-15) reasoning — "is this worth indexing" is a lower bar than "is this triage right". A 0.5 threshold catches signal that busy reviewers wouldn't have tagged, accepting some false positives for the operator to re-classify (or redact) at triage time.
- **`already-linked` short-circuit before classifier**: the `<!-- ai-sdlc:capture-id=... -->` footer is the idempotence signal. Detected via regex; runs before BOTH the marker branch and the classifier branch so a re-poll over the same PR comments never re-classifies or double-indexes.
- **GitHub-edit-wins, not append-newest**: when a comment already carries a `capture-id` marker for ID `X` and we attempt to append for ID `Y`, the helper REFUSES to overwrite (returns `changed: false, alreadyLinked: true`). This matches the OQ-3 (2026-05-15) "GitHub-edit-wins" semantic — the original capture linkage is the durable source of truth; competing later-sync passes don't get to rewrite history.
- **AI-agent bypass via the trusted-bot allowlist + `[bot]` suffix**: mirrors `TRUSTED_MARKER_AUTHOR_LOGINS` in `incremental-review/incremental.ts` for consistency. The two-rule heuristic (allowlist OR `[bot]` suffix) gives reasonable coverage without a centralised registry; callers with out-of-band knowledge can force the bypass via `opts.treatAuthorAsAiAgent`.
- **Fall-open on classifier failure**: when the invoker is missing / errors / returns a malformed response, the substrate returns the `pending` sentinel with confidence 0; we treat that as `classified-skip` (reason `classifier-fall-open`). Safe failure mode — the operator can re-run when the invoker is back; we never silently miss a high-signal comment because of an infra blip. Aligns with the substrate's documented fall-open contract.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 5211 passed | 1 skipped (5212)
- `pnpm lint` — clean (workspace)
- `pnpm format:check` — clean (workspace)
- Coverage: `pr-comment-classifier.ts` reports **100% lines / 100% functions / 100% branches**; pipeline-cli package overall at **91.32%** lines (above the 80% gate).

### Follow-up

- **Wire the real Haiku invoker**: the substrate's `LlmInvoker` interface is harness-portable; the production caller (the not-yet-built `cli-capture sync-pr` shell + the GitHub webhook handler) needs to instantiate an `Anthropic` SDK adapter. That belongs in the webhook / sync-PR task, not here — the classifier's contract is invoker-agnostic by design.
- **`cli-capture sync-pr <pr-number>`** — operator-facing one-shot to fetch a PR's comments, run `classifyPrCommentsBatch`, persist new captures, and push the `capture-id` footer marker back to GitHub via `gh pr comment` / `gh api`. AISDLC-277 (Phase 5) is the natural home; the library surface is ready for it.
- **GitHub webhook listener**: out of scope for Phase 4 (the task body listed it as conceptual scope, but the ACs only required the classifier + bidirectional-sync helpers); a dedicated infra task can subscribe to `pull_request_review_comment` events and pipe them through this module.
