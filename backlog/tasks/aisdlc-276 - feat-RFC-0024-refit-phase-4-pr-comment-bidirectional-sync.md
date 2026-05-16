---
id: AISDLC-276
title: 'feat: RFC-0024 Refit Phase 4 — PR-comment bidirectional sync + LLM auto-classifier (OQ-3)'
status: To Do
assignee: []
created_date: '2026-05-15'
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
priority: high
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
- [ ] #1 PR-comment webhook handler runs each comment through Phase 2 classifier
- [ ] #2 Confidence ≥ 0.5 → indexed as capture with GitHub URL reference
- [ ] #3 Confidence < 0.5 → ignored (no capture record)
- [ ] #4 Marker-tagged comments bypass classifier (already typed)
- [ ] #5 AI-agent-authored comments bypass classifier (already typed)
- [ ] #6 GitHub-edit-wins: capture re-syncs on next webhook
- [ ] #7 Bidirectional sync: capture state changes append `<!-- ai-sdlc:capture-id=<id> -->` to the comment
- [ ] #8 Integration test: un-marked comment + classifier-yes → indexed; un-marked comment + classifier-no → ignored
<!-- AC:END -->
