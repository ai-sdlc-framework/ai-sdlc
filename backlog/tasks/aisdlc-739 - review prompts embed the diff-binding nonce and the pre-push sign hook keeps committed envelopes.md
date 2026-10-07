---
id: AISDLC-739
title: >-
  review prompts embed the diff-binding nonce and the pre-push sign hook keeps committed envelopes
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - governance
dependencies: []
references:
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/cli/attestation.ts
  - ai-sdlc-plugin/scripts/check-attestation-sign.sh
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two defects. (a) The Step 7 review-prompt builder does not embed the diff-binding nonce, so reviewers run outside the executor come out self-authored unless the caller appends `[[ai-sdlc-nonce: N]]` by hand and calls emit-leaf with `--agent-id --nonce --project-dir <session root> --claude-session-id`.

(b) The pre-push attestation-sign hook deletes a valid committed attestation envelope from the working copy as "stale (rebase cycle)". Fix is to `git checkout` the file instead of deleting it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The Step 7 prompt builder embeds `[[ai-sdlc-nonce: N]]` in every review prompt (test).
- [ ] A reviewer run outside the executor using that prompt and emit-leaf is not classified self-authored.
- [ ] The pre-push sign hook restores a committed envelope with `git checkout` instead of deleting it (test).
- [ ] The working copy still has the committed envelope after a rebase-cycle push.
