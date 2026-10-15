---
id: AISDLC-898
title: 'fix(dor): Gate 3 resolves only frontmatter references and dependencies; a task id in body prose is not a reference'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [dor, velocity, filing, gate]
dependencies: []
references:
  - pipeline-cli/src/dor/gates/gate-3-references.ts
  - pipeline-cli/src/dor/resolvers/index.ts
  - docs/operations/dor-ingress-gate.md
priority: high
dispatchable: true
---

## Context

On 2026-10-14 seven filing PRs (the docs-cleanup trio, the landing pair 894/895, 897 and 866) sat red on `ai-sdlc/pr-ready` for the whole day with the same line: `Gate 3: reference(s) failed to resolve: <id> (no backlog file matches <id>)`. Each task body explains in one sentence how the work is split between sibling tasks that were filed in parallel. Gate 3 (`pipeline-cli/src/dor/gates/gate-3-references.ts`) calls `extractReferences` over the whole body; step 5 of that extractor (`pipeline-cli/src/dor/resolvers/index.ts`, the backlog-id match) turns every id in prose into a resolve-or-block reference. Two siblings that mention each other can never land first, so the pair is deadlocked until a person edits one body. `cli-file` passed the same tasks locally because the sibling files existed in the author's worktree, so the author only learns about it from CI.

The dependency semantics already live in frontmatter: `dependencies:` is enforced by Gate 7, and `references:` is resolved by Gate 3 as file existence. A prose mention carries no requirement; a sentence such as "the companion task deletes the retired runbooks" is explanation, not a dependency.

**Five-step review (requirements first).** Requirement questioned: "every task id mentioned anywhere in a task must resolve to a file on main before the task is ready". The requirement that survives is "every dependency the task declares must exist", and that is the frontmatter. Deleted: the backlog-id prose extraction from Gate 3's reference set (the extractor keeps the kind only if another consumer still uses it). Simplified: one place declares inter-task relations, the frontmatter; prose is free text. Accelerated: parallel filing of related tasks lands in any order, no re-filing round. Automated: a test with two task bodies naming each other passes Gate 3 and a missing `dependencies:` entry still fails Gate 7.

Authority: class (b), a DoR gate is loosened; the decision record for this task is filed alongside it (scope `issue:AISDLC-898`) and the task proceeds only on the option recorded on `main`.

## Fix

1. `pipeline-cli/src/dor/gates/gate-3-references.ts`: filter `extracted` so references of the backlog-id kind are excluded from `allRefs`. Frontmatter `references:` (file paths) and `dependencies:` (Gate 7) are unchanged.
2. If the extractor's backlog-id kind has no remaining consumer after step 1, delete that extraction step and its tests (dark-code gate); otherwise leave it.
3. Tests (`gate-3-references.test.ts`): a body that names a task id with no backlog file passes Gate 3; a body with a broken file path or RFC id still blocks; the AC-checklist stripping is unchanged.
4. `docs/operations/dor-ingress-gate.md`: one sentence under Gate 3 stating that task ids in prose are not resolved, and that inter-task relations go in `dependencies:`.
5. After this lands, the seven red filing PRs need only a CI re-run (rebase onto main via `cli-file rebase`), no body edits.

## Acceptance Criteria

- [ ] #1 A task whose body mentions a task id with no matching backlog file passes Gate 3.
- [ ] #2 A task with a broken file path or RFC id in its body still fails Gate 3 with the existing message.
- [ ] #3 A task whose `dependencies:` names a missing task still fails Gate 7.
- [ ] #4 `docs/operations/dor-ingress-gate.md` states the rule.
- [ ] #5 The seven filing PRs red on 2026-10-14 pass the DoR readiness job after a rebase with no body edit.

**Velocity impact.** Positive: removes a deadlock that held seven PRs for a day and would recur on every parallel filing of related tasks; no new rule, one fewer check.
