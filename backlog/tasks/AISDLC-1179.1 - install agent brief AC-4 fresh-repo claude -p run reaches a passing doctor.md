---
id: AISDLC-1179.1
title: >-
  Install agent brief AC-4: a scripted fresh-repo `claude -p` run of the published brief reaches a passing `ai-sdlc doctor`
status: To Do
assignee: []
created_date: '2026-11-08'
labels:
  - install
  - onboarding
  - docs
  - smoke
dependencies:
  - AISDLC-1179
references:
  - docs/getting-started/install-agent-brief.md
  - docs/getting-started/onboarding.md
  - backlog/tasks/AISDLC-1179 - publish install instructions as an agent brief before the raw commands.md
priority: medium
dispatchable: true
dispatchableReason: 'Carries the AC-4 remainder of AISDLC-1179, re-dispatched by operator ruling 2026-11-07 (decision rubric, Option A). The parent id is taken on the dispatch board (#2354 landed), so the remainder runs under its own id.'
---

## Description

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
- [ ] #1 A script under `scripts/` creates a fresh temporary repo, runs the standalone brief through `claude -p`, then runs `ai-sdlc doctor` there and exits with doctor's pass/fail.
- [ ] #2 The PR body records the exact `claude -p` invocation (flags, cwd, how the brief is passed, permission mode) and the full `ai-sdlc doctor` output of one passing run.
- [ ] #3 The script has a unit test covering its argument handling and its exit-code mapping without invoking `claude` (the real run is the PR-body evidence, not a CI test).
- [ ] #4 Parent task AISDLC-1179 is moved to `backlog/completed/` with AC-4 ticked in the same PR.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- The executor runs on the operator's Claude Code subscription; `claude -p` inherits it. Document the permission mode used (`--permission-mode bypassPermissions` is acceptable inside the temporary repo only).
- Keep the temporary repo under `mktemp -d`; remove it on exit unless `--keep` is passed.
- Hook-spawned process rule (AISDLC-1129) does not apply: the script is not a git hook, but state in the PR body that it is run from a shell, not from a hook, and that it unsets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` before `git init`.
<!-- SECTION:NOTES:END -->
