---
id: AISDLC-875
title: 'fix(attestation): the signed envelope always passes the prettier format check'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [attestation, ci, reliability]
dependencies: []
references:
  - pipeline-cli/src/attestation/format-json.ts
  - pipeline-cli/src/attestation/sign-v6.ts
  - scripts/check-attestation-sign.sh
  - .prettierignore
priority: medium
dispatchable: true
---

## Context

Source: 24h PR-drain review 2026-10-14 (planner + operator). Operator constraint: stability before unsupervised spend — fixes must be deterministic code or settings, spend zero tokens on their own, and never relaunch or drive sessions.

7 of 15 sampled gate failures in 24h were Lint & Format on unformatted `.ai-sdlc/attestations/*.dsse.json`; each costs a fix commit, a re-sign and a full gate run. A formatter already exists (`pipeline-cli/src/attestation/format-json.ts`, AISDLC-732, used by `sign-v6.ts` and `ai-sdlc-plugin/scripts/sign-attestation.mjs`), so the failing path is a writer that bypasses it (for example a re-sign or rebase path, or `scripts/check-attestation-sign.sh`); the implementer must find it. `scripts/verify-attestation.mjs` is a blocked path: read it to learn whether it depends on the envelope's exact bytes, but do not edit it.

## Fix

**Five-step review (requirements first).** Requirement questioned: should signed JSON envelopes be formatted at all? Nothing human edits them and the signature covers the payload, not the file layout. Delete: if the verifier does not depend on file bytes, add `.ai-sdlc/attestations/` to `.prettierignore` (the repo already ignores `.ai-sdlc/_decisions/events/` the same way) and drop the formatting step. Otherwise simplify: every writer goes through `format-json.ts`. Accelerate: no fix commit, re-sign or second gate run. Automate: a test fails if any writer emits an unformatted envelope.

1. Find which signing or re-sign path writes the envelope without `format-json.ts`; reproduce with `pnpm format:check` on its output.
2. Apply the delete option if the verifier does not need byte-exact files; otherwise route that writer through `format-json.ts`.
3. Add a test that signs an envelope through each writer and asserts the prettier check passes (or that the path is ignored).

## Acceptance Criteria

- [x] #1 The root cause (the writer that skips formatting) is named in the PR body.
- [x] #2 After signing through every writer, `pnpm format:check` passes on the envelope.
- [x] #3 A test covers each writer; `scripts/verify-attestation.mjs` is not changed.
- [x] #4 If `.prettierignore` is used, the PR shows the verifier does not depend on the file layout; the three-copy `PATCH_ID_EXCLUSIONS` lockstep is untouched.

## Out of scope

- Changing the envelope schema, signing keys or patch-id exclusions.
- Editing `scripts/verify-attestation.mjs`.
