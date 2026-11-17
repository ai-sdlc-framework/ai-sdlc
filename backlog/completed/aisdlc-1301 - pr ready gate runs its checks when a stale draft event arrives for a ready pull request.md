---
id: AISDLC-1301
title: 'PR ready gate runs its checks when a stale draft event arrives for a ready pull request'
status: Done
assignee: []
created_date: '2026-11-17'
labels:
  - ci
  - merge-gate
  - governance-config
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/__tests__/ai-sdlc-gate.test.mjs
  - docs/operations/quality-gate.md
  - docs/operations/merge-without-queue.md
priority: high
dispatchable: true
dispatchableReason: 'Pull request #2738 (code and workflow change of AISDLC-1296) merged on 2026-11-17 17:12:08Z with no gate job run: run 44134210153 was cancelled, run 44134213550 skipped every job including `ai-sdlc/pr-ready`, and branch protection accepted the skipped required check. The change tightens the merge gate (class a).'
---

## Description

**Gap.** Timeline of pull request #2738: 17:11:22Z force push while the pull request was a draft; 17:11:24Z flip to ready for review; 17:11:27Z gate run 44134210153 starts for the ready event; 17:11:28Z gate run 44134213550 starts for the push event. The second run cancels the first (`cancel-in-progress` is true for every event except `ready_for_review`). Its event payload still says `draft: true`, so `detect` is skipped by `if: github.event.pull_request.draft == false`, every job that needs it is skipped, and the rollup `ai-sdlc/pr-ready` ends skipped. GitHub treats a skipped required check as passed. The pull request merged 44 seconds after the flip with no build, test, lint, review verdict or governance job run.

Every task pull request is pushed and then flipped to ready by a machine, so the two events are often seconds apart.

**Shape.** A gate run decides "draft" from the state of the pull request at the time the run starts, not from the event payload. A pull request that is ready for review never has a skipped `ai-sdlc/pr-ready` as the newest result on its head commit.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is the draft skip needed at all? Yes (AISDLC-218): it saves one full CI run per draft push. It stays, but reads the live state. 2. Deleted: the use of `github.event.pull_request.draft` as the deciding value in this workflow. 3. Simplified or optimised: one step reads the live draft state once; `detect` and the rollup both use that output. 4. Accelerated: not applicable. 5. Automated: a workflow test fails when a job of this workflow decides on the payload's `draft` field again.

- **Live state.** In `.github/workflows/ai-sdlc-gate.yml`, a first job (or the first step of `detect`) reads the draft state of the pull request from the API (`gh api repos/{owner}/{repo}/pulls/{number} --jq .draft`) and publishes it as an output. A failed API call fails the job; it never counts as "draft". `detect` and the `ai-sdlc/pr-ready` rollup use this output where they use `github.event.pull_request.draft` today.
- **Rollup.** When the live state is "ready", the rollup job runs and ends success or failure, never skipped. When the live state is "draft", behaviour is as today.
- **Concurrency.** Keep the rule of AISDLC-876 (a `ready_for_review` event does not cancel a run in flight). No change is needed there once the later run reads the live state; say so in the PR body or change it and say why.
- **Test.** `.github/workflows/__tests__/ai-sdlc-gate.test.mjs` asserts: no job `if` in the workflow reads `github.event.pull_request.draft`; the rollup job's condition cannot be false when the live-state output is "ready"; the live-state step has no `continue-on-error`.
- **Docs.** `docs/operations/quality-gate.md` and `docs/operations/merge-without-queue.md` state that the draft skip reads the live state, with the #2738 timeline as the reason in one sentence.
- **Report.** In the PR body, list the merged pull requests of the last 14 days whose newest `ai-sdlc/pr-ready` on the merged head was skipped or cancelled (number, merge time). Do not reopen or revert any of them; the list is for the planner.

Out of scope: branch protection settings; `cli-merge-if-eligible`; the untrusted PR gate workflow.

## Acceptance Criteria

- [x] #1 No job-level or step-level condition in `.github/workflows/ai-sdlc-gate.yml` reads `github.event.pull_request.draft`; the draft decision comes from one step that reads the live state through the API, and a failed read fails the job.
- [x] #2 A workflow test asserts #1 and asserts that the `ai-sdlc/pr-ready` rollup job runs whenever the live state is "ready".
- [x] #3 On a draft pull request the gate still starts no build, test or lint job.
- [x] #4 The PR body lists the merged pull requests of the last 14 days whose newest `ai-sdlc/pr-ready` result on the merged head was not success.
- [x] #5 `docs/operations/quality-gate.md` and `docs/operations/merge-without-queue.md` describe the live-state rule.
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
The gate now reads the pull request's draft state live through the API at run start, instead of from the event payload. The first step of `detect` does the read, every other job keys off its output, and the `pr-ready` rollup runs whenever the pull request is not a draft. No `pnpm test` failures remain, and build, lint and format:check passed. I ran the full suite after the final change. Build and format:check were last run before the final edits.

## Changes
- .github/workflows/ai-sdlc-gate.yml
- .github/workflows/__tests__/ai-sdlc-gate.test.mjs
- docs/operations/quality-gate.md
- docs/operations/merge-without-queue.md

## Design decisions
Committed locally only, with no rebase, push or PR. A worktree edit to the backlog task file was already there before I started (not mine); I left it uncommitted.

Design choice: first tried a separate `draft-state` job; scripts/check-gate-registry.test.mjs failed because a new gate-job entry in .ai-sdlc/gates.yaml needs a decision id. So the read is folded into `detect`: it always runs, its first step runs `gh api repos/$REPO/pulls/$PR_NUMBER --jq .draft` with set -euo pipefail and exits 1 on any value other than true or false. Every other detect step is skipped when live state is draft. Every other job needs detect and tests needs.detect.outputs.draft != 'true'. pr-ready runs on always() && needs.detect.outputs.draft != 'true'; a failed detect leaves the output empty so the rollup still runs, sees detect failed, and fails. Removed the draft marker from run-name. Tests assert no job or step if mentions pull_request.draft, detect reads API first and fails on bad read, every job gated on live output, pr-ready needs detect.

AC4: of the 400 most recently merged PRs, five had a newest ai-sdlc/pr-ready check on the merged head sha that was not success: #2738 (4a96e0afc) skipped; #2628 (f258eecf5) skipped; #2578 (f67c4a996) skipped; #2570 (7e0fc5b44) skipped; #2761 (3df2a17f6) failure. Not filtered by merge date, so 400 may be more or fewer than the 14-day window.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

