---
id: AISDLC-133
title: >-
  Pre-push hook: auto-sign attestation when verdict files exist (remove from LLM
  responsibility)
status: Done
assignee: []
created_date: '2026-05-02 00:43'
labels:
  - infrastructure
  - attestation
  - hooks
  - automation
  - follow-up
milestone: m-3
dependencies: []
references:
  - .husky/pre-push
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - ai-sdlc-plugin/commands/execute.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Per the 2026-05-01 design discussion: anything mechanical + deterministic should be a hook/workflow, not the LLM. Attestation signing is purely deterministic once verdicts exist; LLM has no judgment to add but currently drives all 13 finalize steps.

**The pre-push hook reads the per-worktree active-task sentinel + verdict file + signs**:

```bash
# .husky/pre-push (added below existing checks)
WT_ROOT=$(git rev-parse --show-toplevel)
if [ -f "$WT_ROOT/.active-task" ]; then
  TASK_ID=$(cat "$WT_ROOT/.active-task")
  VERDICT_FILE="/tmp/review-verdicts-${TASK_ID}.json"
  HEAD_SHA=$(git rev-parse HEAD)
  ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/${HEAD_SHA}.dsse.json"
  if [ -f "$VERDICT_FILE" ] && [ ! -f "$ATT_FILE" ]; then
    echo "[pre-push] auto-signing attestation for $TASK_ID against HEAD $HEAD_SHA"
    node "$WT_ROOT/ai-sdlc-plugin/scripts/sign-attestation.mjs" \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "${AI_SDLC_ITERATION_COUNT:-1}"
    git add .ai-sdlc/attestations
    git commit --no-verify -m "chore: auto-sign attestation [pre-push hook]"
    echo "[pre-push] hook added an attestation commit; re-run git push to send it"
    exit 1
  fi
fi
```

The `exit 1 + re-push` pattern is the standard "hook added a commit, push again" idiom. Operator/LLM just runs `git push` twice.

**Removes 3 of 13 steps from /ai-sdlc execute's LLM-driven sequence**: sign-attestation invocation + commit + iteration-count tracking.

**Open design questions for the hook implementation** (resolve in the PR):
1. **Verdict file location**: `/tmp/` is ephemeral; if operator's session restarts, verdicts lost. Move to `<worktree>/.ai-sdlc/verdicts/` so they survive?
2. **Re-push UX**: `exit 1 + re-push` is operator-confusing. Alternative: amend the previous commit silently (changes commit SHA without operator noticing). Or display very clear stderr message.
3. **Iteration count source**: env var `AI_SDLC_ITERATION_COUNT` only works if the reviewer harness sets it; default to 1 otherwise.
4. **Coverage gate ordering**: pre-push currently runs coverage check first; signing should be AFTER coverage passes (no point signing a failing build). Wire after coverage check.

**Composes with RFC-0015 §5.1** (failure playbook) — this hook is the "deterministic mechanism" pattern that RFC-0015 advocates for the orchestrator's failure modes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `.husky/pre-push` extended with the auto-sign block (positioned after existing coverage gate)
- [x] #2 Hook detects per-worktree `.active-task` sentinel (per AISDLC-81); falls through gracefully when sentinel absent (chore PRs, ad-hoc commits)
- [x] #3 Hook reads verdict file from agreed location (decide /tmp/ vs `<worktree>/.ai-sdlc/verdicts/` in the PR per Q1)
- [x] #4 Hook is idempotent: skips if `.ai-sdlc/attestations/<head-sha>.dsse.json` already exists at current HEAD
- [x] #5 Hook output makes the re-push requirement obvious (decide silent-amend vs explicit re-push UX)
- [x] #6 /ai-sdlc execute slash command updated: Step 10 (sign attestation) becomes a no-op call to git push, since the hook handles it
- [x] #7 CLAUDE.md updated under "Testing" or new "Hooks" section documenting the auto-sign behaviour
- [x] #8 Test: dispatch any task end-to-end via /ai-sdlc execute, verify attestation lands without explicit sign-attestation invocation
- [x] #9 AI_SDLC_SKIP_ATTESTATION_SIGN=1 env-var escape for cases where signing must be deferred (e.g. operator hand-resigning later)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Pre-push hook auto-signs DSSE attestations when verdicts exist (per-worktree sentinel + verdict file + idempotent on existing envelope). Removes 1 of 13 finalize steps from /ai-sdlc execute's LLM responsibility. Hook lives in `scripts/check-attestation-sign.sh`, wired via `.husky/pre-push` AFTER coverage gate.

## Iteration history
- **Round 1** (commit `a3772e5`): all 9 ACs met; 7 files; 12/12 hook tests pass. Reviews: code APPROVED with 2 MAJORS (Step 11 push-loop in execute.md inferred success from `git ls-remote | grep -q $BRANCH` instead of capturing exit code — silently masked real failures + grep was unanchored substring match). Test 0c/0M/0m/3s. Security delayed (re-dispatched after session crash).
- **Inline fix** (commit force-pushed): replaced ls-remote+grep heuristic with direct `LAST_PUSH_RC=$?` exit-code check + clarifying comments per reviewer's exact suggestion. Avoids both majors with a 5-line edit.
- **Round 2 reviews** (post-inline-fix): code 0c/0M/4m/2s; security 0c/0M/2m/3s. APPROVED.

## Verification
- Workspace tests + 12 hook end-to-end tests pass; coverage clean
- 3 reviews APPROVED post-inline-fix
- Skip-CI-marker regression-guard present (covers all 5 forbidden tokens)

## Follow-up (defer to small tasks)
- AI_SDLC_SIGN_ATTESTATION_CMD docs-vs-code: add a test-mode sentinel guard so prod doesn't honor a stray operator export
- Idempotency check: parse the .dsse.json shape (not just file-existence) to defeat empty-file griefing
- Verdict-file shape validation in signer: assert ≥3 reviewers, all approved, no critical findings
- TASK_ID regex validation in hook (defensive)
- pickStageBGates auto-pass exclusion direct unit test (carry-over from 115.5 review minor)
- /ai-sdlc dor-recheck slash command shipping (carry-over from 115.5 forward-reference)
<!-- SECTION:FINAL_SUMMARY:END -->
