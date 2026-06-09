---
id: AISDLC-527
title: >-
  fix(orchestrator): harden pipeline for local-only repos — guard git remote,
  ABAC write-perms, and AgentResult.filesChanged
status: In Progress
assignee: []
labels:
  - bug
  - adopter-experience
  - ci:no-issue-required
dependencies: []
priority: high
references:
  - orchestrator/src/execute.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
External contributor (GitHub #870) hit three separate mid-pipeline crashes when running the orchestrator against a **local-only git repo** (no remote) with a **minimal/default config**. Each is an unguarded access that throws on the non-happy-path. Grouped here because they share a theme (defensive guards for local-only / minimal-config use) and are all small.

Three guards to add:

1. **git remote/fetch crash (no try/catch).** `git fetch origin` (and any other remote op) throws and crashes the whole pipeline when the repo has no `origin` remote. Wrap remote operations so a missing remote degrades gracefully (skip the fetch/push with a clear log line, as the `push` step already does "gracefully skipped (local)") instead of aborting the run. Locate the remote op(s) in the orchestrator run path (e.g. around the fetch/push steps in `orchestrator/src/execute.ts` and any git helper it calls).

2. **ABAC check crashes on default autonomy levels.** The ABAC/permissions check does `currentLevel.permissions.write.length` assuming `write` is always an array, but default/minimal autonomy configs do not define it → `Cannot read properties of undefined (reading 'length')`. Guard with a nullish check / default to empty array before `.length`/iteration. Find the ABAC check in the orchestrator (autonomy-policy / permissions evaluation).

3. **`result.filesChanged` can be undefined.** The orchestration wrapper does not always pass through every `AgentResult` field, so a downstream consumer reading `result.filesChanged` (e.g. the max-files guardrail / validate-output) crashes on `undefined`. Ensure `filesChanged` is passed through (or defaulted to `[]`) in the orchestration wrapper so downstream reads are safe.

Each guard needs a hermetic regression test (no-remote repo, minimal-config autonomy level, AgentResult missing filesChanged). These are the contributor's patches #6, #7, #8.

Scope: `orchestrator/` only. These are defensive guards — do not change happy-path behavior (real remote + full config must behave exactly as before).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 git remote operations (fetch/push) no longer crash the pipeline when the repo has no remote — they degrade gracefully with a clear log line; a hermetic test covers the no-remote case
- [ ] #2 the ABAC/permissions check no longer throws on default/minimal autonomy configs where `permissions.write` is undefined (nullish-guarded / defaulted); a hermetic test covers the minimal-config case
- [ ] #3 `AgentResult.filesChanged` is passed through (or safely defaulted to `[]`) by the orchestration wrapper so downstream consumers don't crash on undefined; a hermetic test covers the missing-field case
- [ ] #4 happy-path behavior (real remote + full config) is unchanged
- [ ] #5 pnpm build + pnpm -F @ai-sdlc/orchestrator test + lint + format:check pass
<!-- AC:END -->
