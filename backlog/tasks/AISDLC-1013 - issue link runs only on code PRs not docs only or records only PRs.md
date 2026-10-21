---
id: AISDLC-1013
title: >-
  issue-link runs only on PRs that touch the code base; docs-only and records-only PRs skip it
status: In Progress
assignee: []
created_date: '2026-10-21'
labels:
  - ci
  - velocity
  - root-cause
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - scripts/is-docs-only-changeset.mjs
  - scripts/issue-link-decision.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator ruling, 2026-10-21 18:40Z).** The `ai-sdlc/issue-link` job of `ai-sdlc-gate.yml` runs on every pull request and takes `ai-sdlc/pr-ready` down when it fails. Today a decision-record filing PR (two append-only event files under `.ai-sdlc/_decisions/`) went red because the job checked out the PR's base sha, which predated the backlog task file the title referenced; a rerun replays the same base, so the planner had to rebuild the branch to get a fresh event. The issue-first rule exists so that code changes trace to an issue or task. A docs-only or records-only PR changes no code, so the check has nothing to guard there and only adds a failure mode on the filing lane. The operator ruled: issue-link runs only on PRs that affect the code base.

**Five-step review (requirements first).**
1. Requirement questioned: "every PR links an issue or task". Narrowed to: every PR that changes code links an issue or task. Docs and records (RFCs, `docs/`, `backlog/`, `.ai-sdlc/_decisions/`) are the traceability artifacts themselves.
2. Delete: the issue-link run on docs-only and records-only changesets.
3. Simplify: reuse the existing `detect` job classification (`docs_only`, `records_only`, computed by `is-docs-only-changeset.mjs`, AISDLC-484/867); no second classifier. The job already has `needs: detect`; add the two output conditions to its `if:`, the same shape `lint` and `build-test` use. `alls-green` already treats a skipped job as success in the rollup (AISDLC-879).
4. Accelerate: filing PRs (tasks, decisions, RFC walkthroughs) no longer fail on a base older than the task file they name; no rebuild round-trip.
5. Automate: nothing new; the gate workflow is the automation. Add the case to `quality-gate.md`'s table of per-class jobs.

**Assumption.** "Docs only" in the ruling covers both gate classes that contain no code: `docs-only` and `records-only`. If the operator wants records-only PRs still checked, drop that condition; it is one token.

**Velocity impact.** Positive: removes one red on every filing PR whose base is behind main; no governance control loosened for code PRs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `issue-link` in `ai-sdlc-gate.yml` has `if: github.event_name == 'pull_request' && needs.detect.outputs.docs_only != 'true' && needs.detect.outputs.records_only != 'true'`
- [ ] #2 The `ai-sdlc/pr-ready` rollup passes on a docs-only PR and on a records-only PR with no issue reference and no `ci:no-issue-required` label (skipped issue-link counts as success), verified on the task's own PR plus the next filing PR
- [ ] #3 A code PR without an issue reference, task reference or bypass label still fails `issue-link` (workflow test or the existing `issue-link-decision.test.mjs` unchanged and green)
- [ ] #4 `docs/operations/quality-gate.md` lists issue-link among the jobs skipped for docs-only and records-only changesets
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm test` (workflow lint and `scripts/issue-link-decision.test.mjs`)
- `pnpm lint && pnpm format:check`
