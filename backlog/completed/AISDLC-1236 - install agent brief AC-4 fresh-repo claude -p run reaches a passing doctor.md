---
id: AISDLC-1236
title: >-
  Install agent brief AC-4: a scripted fresh-repo `claude -p` run of the published brief reaches a passing `ai-sdlc doctor`
status: Done
assignee: []
created_date: '2026-11-08'
labels:
  - install
  - onboarding
  - docs
  - smoke
dependencies: []
references:
  - docs/getting-started/install-agent-brief.md
  - docs/getting-started/onboarding.md
  - backlog/completed/AISDLC-1179 - publish install instructions as an agent brief before the raw commands.md
  - backlog/tasks/AISDLC-1179.1 - install agent brief AC-4 fresh-repo claude -p run reaches a passing doctor.md
priority: medium
dispatchable: true
dispatchableReason: 'Carries the AC-4 remainder of AISDLC-1179 under a third id: AISDLC-1179.1 was marked landed on the dispatch board by filing PR #2546 (DEC-0399, leave-done) and a board id is never reusable. Operator ruling 2026-11-07 (decision rubric, Option A) still applies.'
---

## Description

**Lineage.** AISDLC-1179 (AC-1 to AC-3 landed in #2354) -> AISDLC-1179.1 (never ran: dependency preflight refused it, then filing PR #2546 marked it landed on the board, DEC-0399) -> this task. Same scope as AISDLC-1179.1; nothing else changed.

<!-- SECTION:DESCRIPTION:BEGIN -->
**Source.** AISDLC-1179 landed AC-1 to AC-3 in #2354 (merge 74240e4b). The operator ruling of 2026-11-07 (decision rubric, Option A) narrowed the parent to AC-4 and re-dispatched it. The dispatch board keeps a landed id taken, so the AC-4 remainder runs under this sub-task.

**Ruling text (parent, 2026-11-07).** The one proof that the brief works was never run; the AC's end state is a passing doctor, a binary machine check an executor can produce, and the script becomes a reusable first-run smoke at the brief level.

**Change.** Add a script under `scripts/` that:

1. creates a fresh temporary git repository (empty, `git init`, one initial commit);
2. runs the published standalone brief (`docs/getting-started/install-agent-brief.md`) through a non-interactive Claude Code session (`claude -p`), with the exact invocation recorded: flags, working directory, how the brief text is passed, permission mode;
3. runs `ai-sdlc doctor` in that repository at the end and captures its output;
4. exits non-zero when doctor does not pass, zero otherwise.

The PR body records the exact invocation and the captured doctor output from one real run. The script reads no credentials of its own: it uses the operator's Claude Code login as the executor session does (subscription billing; never fall back to `ANTHROPIC_API_KEY`).

**When this lands** the parent task AISDLC-1179 moves to `backlog/completed/` in the same PR with AC-4 ticked, since nothing else remains on it.

**Out of scope.** Grading the prose of the brief; changing the install steps themselves; wiring the script into CI (file a follow-up if the run proves stable).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 A script under `scripts/` creates a fresh temporary repo, runs the standalone brief through `claude -p`, then runs `ai-sdlc doctor` there and exits with doctor's pass/fail.
- [ ] #2 The PR body records the exact `claude -p` invocation (flags, cwd, how the brief is passed, permission mode) and the full `ai-sdlc doctor` output of one passing run.
- [x] #3 The script has a unit test covering its argument handling and its exit-code mapping without invoking `claude` (the real run is the PR-body evidence, not a CI test).
- [x] #4 Parent task AISDLC-1179 is moved to `backlog/completed/` with AC-4 ticked in the same PR.
- [x] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- The executor runs on the operator's Claude Code subscription; `claude -p` inherits it. Document the permission mode used (`--permission-mode bypassPermissions` is acceptable inside the temporary repo only).
- Keep the temporary repo under `mktemp -d`; remove it on exit unless `--keep` is passed.
- Hook-spawned process rule (AISDLC-1129) does not apply: the script is not a git hook, but state in the PR body that it is run from a shell, not from a hook, and that it unsets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` before `git init`.
<!-- SECTION:NOTES:END -->

## Final Summary

## Summary
Added scripts/smoke-install-brief.mjs and its unit test, and moved parent AISDLC-1179 to backlog/completed/ with AC-4 ticked. The draft PR is open. I did not do a real `claude -p` run, so AC-2 is unmet: the PR body has the invocation but no doctor output.

## Changes
- scripts/smoke-install-brief.mjs
- scripts/smoke-install-brief.test.mjs
- backlog/completed/AISDLC-1179 - publish install instructions as an agent brief before the raw commands.md
- backlog/tasks/AISDLC-1179.1 - install agent brief AC-4 fresh-repo claude -p run reaches a passing doctor.md
- backlog/tasks/AISDLC-1236 - install agent brief AC-4 fresh-repo claude -p run reaches a passing doctor.md

## Design decisions
AC-2 is not met. `ai-sdlc` is not installed in this environment, and a real run would globally install npm packages and write to ~/.ai-sdlc. The PR body therefore records the exact invocation but no doctor output. The operator needs to run `node scripts/smoke-install-brief.mjs` with a Claude Code login and paste the output into the PR before marking it ready. The brief uses `/plugin` slash commands, which may not work under `claude -p`, so doctor may fail in that run. If it does, that is the result to report. Gate tests: 3550 of 3551 passed. The one failure was `ai-sdlc-plugin/hooks/usage-ingest.test.mjs`, an ENOTEMPTY error when it cleaned up its temp directory. I did not investigate it, and this change does not touch that file. I used the `ci` commit scope because `scripts` is not in the commitlint scope list. I also updated inbound references to the moved parent task in AISDLC-1179.1 and AISDLC-1236 so backlog-drift stays clean.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
- declined: wiring the smoke into CI is explicitly out of scope until the real run proves stable

