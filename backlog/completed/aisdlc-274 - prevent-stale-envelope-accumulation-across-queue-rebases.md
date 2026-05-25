---
id: AISDLC-274
title: >-
  Prevent stale-envelope accumulation across queue rebases (signer + hook +
  verifier)
status: Done
assignee: []
created_date: '2026-05-15 13:35'
labels:
  - framework-gap
  - attestation
  - merge-queue
  - operator-friction
dependencies: []
priority: high
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - scripts/check-attestation-sign.sh
  - scripts/verify-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
drift_log:
  - date: '2026-05-25'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      docs/operations/merge-queue-rebase-recovery.md
    resolution: flagged
drift_checked: '2026-05-25'
---

## Bug

When a PR is queue-rebased AND manually re-signed across multiple iterations (the common case for any PR that touches a shared-churn file like `spec/rfcs/README.md`), stale envelope files accumulate in `.ai-sdlc/attestations/`. Each rebase shifts the parent SHA, so the previously-added envelope filename (e.g. `6c22456e.dsse.json`) no longer maps to any commit on the branch. Re-signing adds a NEW envelope without removing the old one. After 2-3 rebase rounds the branch has multiple orphan envelope files.

The verifier walks every envelope on the PR diff and tries `git rev-parse <filename>^{object}` for each. Multiple cascading "fatal: Not a valid commit name" errors surface. The verifier eventually falls through to v4-hash matching but reports a misleading `contentHashV4 mismatch` even when the most-recent envelope IS current.

Surfaced on PR #481 (AISDLC-270, RFC-0025 quality monitoring) on 2026-05-15. Three queue-rebase rounds + three operator re-signs accumulated three orphan envelopes; verifier failed with `contentHashV4 mismatch` despite the latest envelope being valid. Manual recovery required: `git reset --soft HEAD~2`, delete both orphans, fresh-sign at the actual code HEAD, force-push as a single chore commit. ~30 minutes of operator debugging that should have been zero.

## Why it keeps happening

Three independent gaps:

1. **Signer is additive, not replacing.** `ai-sdlc-plugin/scripts/sign-attestation.mjs` writes a new envelope file but doesn't clean up envelopes added by previous commits in the same PR. Each sign accumulates.

2. **Pre-push hook treats "envelope at HEAD exists" as "no work needed".** `scripts/check-attestation-sign.sh` skips auto-sign when ANY envelope file exists at HEAD, regardless of whether its filename matches `git rev-parse HEAD~1`. After a rebase the existing envelope is stale but the hook can't tell.

3. **Verifier emits the wrong error.** `scripts/verify-attestation.mjs` doesn't detect the accumulated-orphans pattern — it surfaces `contentHashV4 mismatch` (which sounds like the freshly-signed v4 is wrong) when the actual problem is that multiple orphan envelope files are confusing the SHA→commit mapping path.

## Acceptance criteria

- [x] **Signer enforces single-envelope-per-PR invariant.** Modify `ai-sdlc-plugin/scripts/sign-attestation.mjs` so that before writing the new envelope it scans `git diff --name-only --diff-filter=A origin/main..HEAD -- .ai-sdlc/attestations/` and deletes every prior envelope file added by the PR. After each sign the PR's diff contains exactly one envelope. Add a unit test in `ai-sdlc-plugin/scripts/sign-attestation.test.mjs` (or new test file) that signs twice in a row against the same HEAD and asserts the second sign deletes the first envelope.

- [x] **Pre-push hook detects stale envelope + auto-re-signs.** Modify `scripts/check-attestation-sign.sh`: when an envelope file exists at HEAD but its filename (the SHA portion before `.dsse.json`) does not equal `git rev-parse HEAD~1`, treat as stale → remove it + sign fresh instead of no-op'ing. Add a hermetic test (`scripts/check-attestation-sign.test.mjs` already exists) covering the rebase-stale case.

- [x] **Verifier emits actionable error on orphan envelopes.** Modify `scripts/verify-attestation.mjs`: detect when 2+ envelope files exist on the PR diff, OR when any envelope's SHA-mapping fails (`git rev-parse <name>^{object}` errors). Surface a specific error message naming the orphan files + showing the operator the exact recovery command (`rm <orphans>; git commit --amend --no-edit; node ai-sdlc-plugin/scripts/sign-attestation.mjs --review-verdicts ...`). Replaces the cascading "fatal: not a valid commit name" + misleading "contentHashV4 mismatch" output with one clear sentence. Test in `scripts/verify-attestation.test.mjs` (or equivalent) covering the orphan-envelope detection branch.

- [x] **Documentation update.** `docs/operations/merge-queue-rebase-recovery.md` covers the manual recovery procedure (left over from before this fix). Update it to note that AC #1 + #2 should make manual recovery unnecessary in normal flow, and AC #3's clearer error message is the safety net when something breaks.

- [x] **Test the full loop end-to-end.** Integration test that simulates: sign at SHA X → push → simulated queue rebase to SHA Y (rewrite + force-update local) → re-push without manual cleanup → verify the new sign succeeded with single envelope (AC #1) OR was triggered by the hook (AC #2), and the verifier reports success (AC #3 negative path).

## Out of scope

- Changes to the verifier's v4-hash computation itself. The v4 hash is correct; the problem is the surrounding envelope-enumeration logic.
- Changes to AISDLC-273's `--resume-from-draft` / `--rework-pr` paths (PR #489 in flight). Those address a different gap (resuming a partially-completed pipeline) and don't touch envelope-cleanup semantics.
- Changing the chore-commit pattern itself (sign at code-commit + chore-commit-on-top). That's a deeper refactor that would also fix this but at much higher cost.

## Source

Hit during 2026-05-15 dispatch wave fixing PR #481 (AISDLC-270). Operator quote after the manual recovery: *"how can we prevent this from happening in the future?"* Three independent fixes proposed; operator: *"file all three in the same backlog task"*.

## Final Summary

### Summary

Shipped a 3-layer fix preventing stale DSSE envelope accumulation across queue rebases. The signer now enforces a single-envelope-per-PR invariant by deleting prior envelopes before writing a new one. The pre-push hook detects stale envelopes (filename SHA != HEAD~1) and auto-removes them. The verifier now surfaces an actionable error message with the exact recovery command instead of the misleading `contentHashV4 mismatch` when orphan envelopes are detected.

### Changes

- `ai-sdlc-plugin/scripts/sign-attestation.mjs` (modified): Before writing new envelope, scans `git diff --name-only --diff-filter=A origin/main..HEAD -- .ai-sdlc/attestations/` and deletes all prior PR-added envelopes.
- `ai-sdlc-plugin/scripts/sign-attestation.test.mjs` (modified): Added AISDLC-274 test that signs twice, confirms second sign deletes first envelope; also added missing codex agent variants to test fixture AGENT_FILES.
- `scripts/check-attestation-sign.sh` (modified): Added Step 4c stale-envelope detection — scans PR-added envelopes via git diff, removes any whose filename SHA is neither HEAD_SHA nor HEAD_PARENT_SHA.
- `scripts/check-attestation-sign.test.mjs` (modified): Added AISDLC-274 test for hook stale-envelope removal path.
- `scripts/verify-attestation.mjs` (modified): Added `detectOrphanEnvelopes()` helper + early orphan detection in `runVerifier()` that surfaces actionable error with recovery command.
- `scripts/verify-attestation.test.mjs` (modified): Added `detectOrphanEnvelopes` import, AISDLC-274 unit tests for orphan detection, and end-to-end orphan-error test; also fixed pre-existing AISDLC-252 test failure by adding codex agent variants to `AGENT_FILES` (fixed 37 previously-failing tests).
- `docs/operations/merge-queue-rebase-recovery.md` (modified): Added AISDLC-274 section documenting the 3-layer fix, when manual recovery is still needed, and updated Related section.

### Design decisions

- **Signer uses `git diff --diff-filter=A`**: Only deletes envelopes ADDED by this PR (not pre-existing ones from merged work), using `..` (two-dot) range for completeness vs `origin/main..HEAD`.
- **Hook uses HEAD~1 as the canonical bind point**: The envelope should be named after the dev commit (HEAD~1 before the chore commit lands), so if the filename != HEAD~1, it's stale.
- **Verifier uses `rev-parse --verify <sha>^{object}`**: Cheap way to check if a SHA is resolvable in the local repo without requiring a full walk.
- **Verifier shows recovery command inline**: Operator sees the exact `rm` + `sign-attestation.mjs` invocation needed without consulting docs.

### Verification

- `pnpm build` — clean
- `pnpm test` — exit code 0
- `pnpm lint` — 0 errors
- `pnpm format:check` — all files formatted

### Follow-up

- AISDLC-258 (`IGNORE list applied verifier-side` test) has a pre-existing failure unrelated to this task — the `pnpm-lock.yaml` ignore path is not working correctly in the test fixture. Filed for future fix.
