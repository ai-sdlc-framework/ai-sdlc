---
id: AISDLC-354
title: 'fix(orchestrator): pipeline error propagation + PR auto-promote-to-ready + gh PATH detection'
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - orchestrator
  - pipeline-friction
  - operator-ergonomics
  - critical
dependencies: []
priority: critical
references:
  - pipeline-cli/src/cli/resume-from-draft.ts
  - pipeline-cli/src/steps/03-setup-worktree.ts
  - pipeline-cli/src/orchestrator/loop.ts
---

## Three related pipeline UX bugs hit during 282/286/323 finalization (2026-05-17)

All three blocked operator from understanding pipeline state. Grouping because the fixes touch the same error-propagation + state-detection paths.

## Bug 1 — `re-push failed: unknown error` swallows real stderr

**Symptom**: `runResumeFromDraft` returns `{ok: false, outcome: 'failed', reason: 're-push failed: unknown error'}` when the post-review push fails. Actual stderr from the failed git/hook command is lost.

**Repro**: hit on all 3 of AISDLC-282/286/323 resume runs. Operator had to manually retry the push to see the real error (which turned out to be the verdict-shape mismatch — separate bug, AISDLC-355).

**Fix**: in `runResumeFromDraft`'s push step, capture stderr + tail of stdout from the runner. Include in the `reason` field. Same pattern AISDLC-327 (#500) applied to the Codex bridge ("don't silently return empty output").

## Bug 2 — PR auto-promote-to-ready never fires

**Symptom**: even when all 3 reviewers return `approved: true` (real verdicts, no synthetic criticals), the orchestrator opens PRs as DRAFT. Operator must manually `gh pr ready <num>` + `gh pr merge <num> --auto`.

**Repro**: PR #511 #512 #514 #516 all opened as DRAFT despite final-verdict APPROVED.

**Fix**: in the orchestrator's Step 11/12 (open PR + arm auto-merge), after sign+push when `aggregatedVerdict.decision === 'APPROVED'`, auto-promote ready + arm auto-merge. Already exposed as `gh pr ready` + `gh pr merge --auto` — just need the orchestrator to invoke them.

## Bug 3 — `gh` PATH not propagating to Node subprocess runner

**Symptom**: `detectDraftPrForBranch` shells out to `gh pr list ...` via the Node runner. When the Node process's `PATH` env doesn't include `/opt/homebrew/bin` (e.g. when invoked from a Claude Code Bash tool subshell that inherited a minimal env), `gh` is not found → runner returns `code !== 0` → function returns `null` → resume-from-draft reports `hasDraftPr: false` even though the PR exists.

**Repro**: ran `node pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-286 --resume-from-draft --spawner claude --run` from Claude Code Bash → `hasDraftPr=false` despite PR #512 being open. Workaround: `PATH="/opt/homebrew/bin:$PATH" node ...`.

**Fix**: in `pipeline-cli/src/runtime/exec.ts` (or wherever the runner lives), augment the spawned PATH with common locations (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`) automatically. Or accept `GH_BIN` env override that the runner uses directly.

## Acceptance criteria

- [ ] **Bug 1**: `runResumeFromDraft` includes actual stderr from failed push in `reason`. Test: simulate a push that fails with a known error string; assert the error string appears in the returned envelope.
- [ ] **Bug 2**: orchestrator auto-promotes PR to ready + arms auto-merge when `aggregatedVerdict.decision === 'APPROVED'`. Test: dispatch a task with mock approving reviewers; assert PR ends in `ready=true, autoMerge=enabled` state.
- [ ] **Bug 3**: runner augments PATH with `/opt/homebrew/bin` + `/usr/local/bin` automatically. Test: spawn a child with a minimal env; confirm `gh` resolves via the augmented PATH. Alternative: add `GH_BIN` env override + use it in `detectDraftPrForBranch`.

## Source

Operator session 2026-05-17 finalizing AISDLC-282/286/323 via `--resume-from-draft --spawner claude` after the AISDLC-351 parser fix landed.
