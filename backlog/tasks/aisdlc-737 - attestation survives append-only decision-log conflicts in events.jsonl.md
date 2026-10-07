---
id: AISDLC-737
title: >-
  attestation survives append-only decision-log conflicts in events.jsonl
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - governance
dependencies:
  - AISDLC-719
references:
  - .ai-sdlc/_decisions/events.jsonl
  - ai-sdlc-plugin/scripts/verify-attestation.mjs
  - pipeline-cli/src/cli/attestation.ts
  - pipeline-cli/src/decisions/event-log.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A same-file conflict in the append-only decision log `.ai-sdlc/_decisions/events.jsonl` between concurrent PRs invalidates a PR's attestation and forces a full re-review, even though resolving the conflict only means keeping both sides.

Fix direction: exclude that file from the attestation subject, or merge by append in the patch-scoped verifier so an append-only conflict resolved by keeping both sides does not change the content hash.

Sequencing: builds on the decision-log append-conflict fix listed under dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The attestation subject excludes `.ai-sdlc/_decisions/events.jsonl`, or the patch-scoped verifier merges it by append.
- [ ] A conflict on that file resolved by keeping both sides leaves a valid attestation valid (test).
- [ ] A real change to any other file still invalidates the attestation (test).
- [ ] Tampering with existing lines of the log is still detected, or the exclusion is documented as covered elsewhere.
