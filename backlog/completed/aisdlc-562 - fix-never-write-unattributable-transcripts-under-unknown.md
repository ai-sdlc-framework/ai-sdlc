---
id: AISDLC-562
title: >-
  fix(attestation): never write an unattributable transcript under UNKNOWN —
  fail loudly or refuse
status: To Do
assignee: []
labels:
  - adoption
  - attestation
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - pipeline-cli/bin/cli-attestation.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adopter report, 2026-08-16: one of only two reviewer transcripts in the repo is
filed under the literal task id `UNKNOWN`. The framework could not resolve which
task the review belonged to, **wrote the transcript anyway, and surfaced
nothing**.

This reproduced independently in the ai-sdlc repo itself on 2026-08-14/16.
Reviewer subagents running against `.worktrees/aisdlc-557/` and
`.worktrees/aisdlc-559/` had no `.active-task` sentinel, so all three wrote to
`.ai-sdlc/transcripts/UNKNOWN/`, silently overwriting each other's files across
successive review rounds. It was visible only because reviewers happened to
mention the path in their reports. So this is not adopter-specific
misconfiguration — it is the default outcome whenever the sentinel is absent,
which is the normal state for any reviewer run not launched by
`/ai-sdlc execute`.

Why it matters beyond tidiness: **an attestation that cannot be attributed to a
task is indistinguishable from one that can.** The v6 envelope binds transcript
hashes into a Merkle tree; if the transcript a leaf points at is a shared
`UNKNOWN/` file that a later, unrelated review overwrote, the evidence chain
silently describes the wrong review. Two runs writing the same path is not a
naming inconvenience, it is evidence destruction.

### Scope

- Refuse to write a transcript that cannot be attributed to a task, with an
  error naming what was missing (`.active-task` sentinel,
  `AI_SDLC_ACTIVE_TASK_ID`) and how to supply it.
- If a fallback path must exist at all, it must be per-run unique so two runs
  can never collide, and it must be loudly marked unattributable — never a
  shared directory that later runs silently clobber.
- Audit whether any existing `UNKNOWN/` transcript was ever hashed into a
  signed envelope in this repo, and say so plainly in the PR either way.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 A reviewer run with no resolvable task id fails with a named,
      actionable error instead of writing to `UNKNOWN/`
- [ ] #2 No code path can write two different runs to the same transcript path
- [ ] #3 The failure names both the sentinel and the env-var remedy
- [ ] #4 Existing `.ai-sdlc/transcripts/UNKNOWN/` content in this repo is
      audited for inclusion in any signed envelope, with the finding stated
      explicitly in the PR body
- [ ] #5 Hermetic tests cover the no-sentinel and the collision cases
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reproduced in-repo, not merely reported: see the reviewer outputs on PRs #962
and #965, which each note "no `.active-task` sentinel exists in this worktree,
so `UNKNOWN` was used". Three reviewer roles across three rounds all targeted
the same three filenames.

Fits the same pattern as AISDLC-556 and AISDLC-560: the framework degrades
silently in the direction that looks like success. The correct default for a
provenance mechanism is to refuse.
<!-- SECTION:NOTES:END -->
