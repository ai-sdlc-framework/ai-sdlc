---
id: AISDLC-821
title: >-
  Push-only resume: when a task already holds an approved verdict, the resume rebases, builds, signs and pushes without a developer or reviewer round
status: Done
assignee: []
created_date: '2026-10-12'
labels:
  - pipeline
  - dispatch
  - cost
dependencies: []
references:
  - pipeline-cli/src/dispatch/resume.ts
  - pipeline-cli/src/dispatch/board.ts
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/commands/execute.md
priority: critical
dispatchable: true
---

## Description

Filed under the DEC-0127 drain exception (a new PR only to land existing PRs). Operator instruction 2026-10-12: "file it".

Every `cli-dispatch resume` today re-runs the whole pipeline: the developer subagent, then the three reviewers, then sign and push. During the 2026-10-11/12 PR drain most resumes were mechanical: the code was done and the reviews had approved, and the run was only needed to rebase, rebuild `dist`, re-sign the envelope and push. AISDLC-814 took 5 full runs, AISDLC-819 3, AISDLC-807 and 820 2 each; the extra runs failed on unbuilt dist at push, a refused lease push, or an unformatted envelope, after the code was finished. About 20 open PRs still wait for exactly such a resume (bucket A re-signs: AISDLC-799, 742, 631.6, 773, 711, 713, 695, 556, and the short-form PRs). At roughly one developer round plus three reviewer rounds per resume, this is the single largest token cost of the drain (operator: 66% to 73% of the weekly budget for three executor-landed PRs).

**Five-step review (requirements first).**
1. Requirement questioned: "a resume re-runs dev and reviewers" was set by nobody; it is the absence of a mode in `resumeDone` and the executor command, which always re-enter at Step 5. The review requirement itself (RFC-0010, three reviewers before sign) stays: reviews already ran on this content and the verdict file records it.
2. Delete: the developer round and the reviewer round from a resume whose worktree already holds an approved verdict for the task. Nothing else is deleted; no hook or gate is loosened. The pre-push `check-attestation-sign.sh` already re-signs from an existing verdict file without a reviewer round (AISDLC-810), so this mode asks the pipeline to do what the hook already permits.
3. Simplify: one flag, `cli-dispatch resume --pr <n> --note <text> --push-only`, recorded on the manifest (`resumeMode: push-only`) and printed in the `RESUMED TASK` block. The executor reads it and runs: `git fetch origin && git rebase origin/main` (mechanical only; a conflict ends the run with outcome `failed` naming the files), build `reference`, `orchestrator` and `pipeline-cli`, `pnpm lint` and `pnpm format:check` (format drift is fixed with `pnpm format` and committed as `style:`), then the existing Step 10 sign from the existing verdict and transcript leaves, Step 11 lease push from the executor's own session (not a subagent), `gh pr ready`, verdict.
4. Accelerate: the push-only run has no model calls except the executor's own turn; expected minutes instead of an hour.
5. Automate: none beyond the flag; dispatch chooses the mode from the planner's note.

Refusals (fail closed): the flag is refused when the worktree has no `.ai-sdlc/verdicts/<task-id-lower>.json`, when that verdict is not an approval, or when the verdict's content hash or patch-id no longer matches the branch content after the rebase (then the executor falls back to a normal resume and says so in its status line). A push-only run never writes a new verdict file and never bypasses any `AI_SDLC_SKIP_*` gate.

Velocity impact: positive; it removes four subagent rounds from every mechanical resume and lets the drain finish within budget. Governance impact: none; reviews, attestation and hooks are unchanged, and a content change after approval is caught by the verdict/patch-id check and falls back to a full run.

## Acceptance Criteria

- [ ] AC-1: `cli-dispatch resume --pr <n> --note <text> --push-only` returns the task to the queue with `resumeMode: push-only` on the manifest; the `RESUMED TASK` block printed by `executor-start` shows the mode. Without the flag nothing changes.
- [ ] AC-2: On a push-only resume the executor runs no developer subagent and no reviewer subagent; it rebases, builds the three packages, runs lint and format checks, signs from the existing verdict file and transcript leaves, lease-pushes from its own session, and writes the verdict.
- [ ] AC-3: The mode is refused, and the run proceeds as a normal resume with a line saying why, when the verdict file is missing, is not an approval, or no longer matches the branch content after the rebase.
- [ ] AC-4: A rebase conflict ends the push-only run with outcome `failed` and the conflicting files in the verdict note; nothing is force-resolved.
- [ ] AC-5: Hermetic tests cover the flag, the manifest field, each refusal case and the conflict case; the executor and execute command docs describe the mode in one paragraph each.
- [ ] AC-6: The PR body names the five steps above and confirms no hook, gate, reviewer requirement or `AI_SDLC_SKIP_*` default changed.

## Notes

Dependents during the drain: the bucket-A re-sign resumes and the short-form PR resumes listed in the planner handoff are to be resumed with `--push-only` once this lands.
