# Hand review path — post-rebase review round (planner note, 2026-10-12)

Use as the `--note` of `cli-dispatch resume --task-id <ID> --pr <N>` for a task whose
rebase changed the patch-id (check-attestation-sign finds no leaves at the current
patch-id). Substitute <id> (lower-case task id, e.g. aisdlc-799) and <ID> (AISDLC-799).
Authority: DEC-0142 (planner record on main), template at docs/operations/hand-review-path.md; DEC-0141 for AISDLC-755.

Review-round resume, hand path. Do NOT call `next-step` (fresh state machine; it
always restarts at spawn-developer) and do NOT run a developer pass: the work is
done and was approved before the rebase. In .worktrees/<id>:
1. Commit any uncommitted envelope deletions the hook made (chore). Existing local
   attestation chore commits are fine; the pre-push squash hook collapses them.
2. Spawn code-reviewer, test-reviewer and security-reviewer yourself via the Agent
   tool, Claude-native (AI_SDLC_REVIEWER_HARNESS=claude; Codex quota is out until
   2026-10-25), on `git diff origin/main...HEAD`, prompts as /ai-sdlc execute Step 7
   builds them (pipeline_step_7_build_review_prompts). If next-step or the planner
   produced fewer than three, run the missing ones by hand.
3. Write the verdicts to .ai-sdlc/verdicts/code-reviewer-<id>.json,
   test-reviewer-<id>.json, security-reviewer-<id>.json; aggregate to <id>.json
   (pipeline_step_8_aggregate_verdicts).
4. Any critical/major finding: fix with the developer agent, re-review. Otherwise continue.
5. `cli-attestation emit-leaf` for each reviewer at the current patch-id.
6. Commit the decision log and review artifacts; two-call lease push of your own
   branch `HEAD:refs/heads/<branch>` from the worktree; check-attestation-sign signs
   from the verdicts + leaves (re-run `git push` if it asks).
7. Flip the PR ready; write the verdict.
If check-attestation-sign still refuses, report its exact reason line and park — no new DEC.
