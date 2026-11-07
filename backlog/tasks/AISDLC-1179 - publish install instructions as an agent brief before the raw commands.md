---
id: AISDLC-1179
title: 'Publish the install as an agent brief a user pastes into Claude Code, with the raw commands second'
status: To Do
assignee: []
created_date: '2026-11-04'
labels:
  - install
  - onboarding
  - docs
dependencies: []
references:
  - docs/getting-started/onboarding.md
  - docs/tutorials/08-claude-code-plugin.md
priority: medium
dispatchable: true
dispatchableReason: 'Narrowed to AC-4 and re-dispatched 2026-11-07 by operator ruling (decision rubric, planner session).'
---

## Description

**Source.** Install friction report from the ai-sdlc-io planner session, 2026-11-04, relayed as operator-approved. Operator confirmed this task for dispatch in the ai-sdlc planner session on 2026-11-04.

**Problem.** The install is a command list, so a user runs each command in turn and stops at the first error.

**Change.** Write the install as one prose brief that a user pastes into Claude Code or another agent. It tells the agent:
- what to install;
- how to verify each step;
- what to do when a step fails. The known failure modes are a partial plugin cache install, a missing `@ai-sdlc/reference`, a keyring that was never initialised, and doctor warnings.

The agent then runs the sequence and resolves issues as they come up. The docs show this brief first and the raw commands second.

If AISDLC-1178 lands first, the brief targets the shorter path. It does not wait for 1178.

## Ruling 2026-11-07 (operator, decision rubric)

Option A. The one proof that the brief works was never run; the AC's end state is a passing doctor, a binary machine check an executor can produce, and the script becomes a reusable first-run smoke at the brief level. Counter-argument: an agent grading its own onboarding brief is circular; rebutted because the AC measures doctor, not prose quality. Chosen over operator time and over waiving.

## Remaining scope (AC-4 only)

AC-1 to AC-3 landed in #2354. What remains: an executor creates a fresh temporary git repository, runs the published brief (the standalone file from AC-3) through a non-interactive Claude Code session (`claude -p`, with the exact invocation documented: flags, working directory, how the brief text is passed, any permission mode), captures the `ai-sdlc doctor` output at the end, records the invocation and the doctor output in the PR body, and leaves the script under `scripts/` (for example `scripts/smoke-install-brief.sh`) so the run can be repeated against a later brief. The script never writes outside the temporary repository and never needs a key or a secret; a doctor that does not pass is reported as the result, with the failing checks, not patched around.

## Acceptance Criteria

- [x] AC-1 (done in #2354): `docs/getting-started/onboarding.md` opens with a copyable agent brief that names each install step, its verification, and the recovery for each of the four failure modes above.
- [x] AC-2 (done in #2354): The raw command list follows the brief, unchanged in meaning.
- [x] AC-3 (done in #2354): The brief is also kept as a standalone file that the ai-sdlc-io site can link to or embed, at a stable path stated in the PR body.
- [ ] AC-4: Running the brief in a fresh non-interactive Claude Code session (`claude -p`) on a fresh temporary repo reaches a passing `ai-sdlc doctor`. The PR body records the exact invocation and the doctor output, and the script that performs the run is committed under `scripts/`.
