---
id: AISDLC-896
title: 'fix(hierarchy): mark-ready flips task PRs ready on the repository''s own PR check workflow when the repo has no CodeQL'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [hierarchy, reliability, velocity, adopters]
dependencies: []
references:
  - pipeline-cli/src/hierarchy/mark-ready.ts
  - pipeline-cli/src/hierarchy/operational.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/next-step/ship.ts
  - .ai-sdlc/agent-role.yaml
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Context

Request from the ai-sdlc-io planner session on 2026-10-14 (ai-sdlc-io DEC-0008). Private repositories on the GitHub Free plan have no CodeQL. Verified in `pipeline-cli/src/hierarchy/mark-ready.ts`:

- Only drafts whose body matches `WAITS_FOR_CODEQL_RE` (L25) are considered (L93).
- `analyzeState` (L51-63) looks only at checks whose name matches `/analyze/i`; with no such check the state is `pending` forever, so `gh pr ready` (L119-124) never runs. Nothing can configure the check name (search of `pipeline-cli/src` and `.ai-sdlc/*.yaml`: no "no CodeQL" or "private repo" setting exists).
- Task PRs are always opened as drafts (`steps/11-push-and-pr.ts:406`, `next-step/ship.ts:420`, AISDLC-218).

**Five-step review (requirements first).** Requirement questioned: "a task PR stays draft until CodeQL is clean". The requirement is "until the repository's security and PR checks are clean"; CodeQL is one possible check, not the definition. Delete: the hard-coded `/analyze/i` match as the sole signal. Simplify: one `readyChecks` list in governance (default the Analyze match), with a fallback to the repository's own PR checks when no such check exists. Accelerate: drafts in CodeQL-less repos flip on the first green run instead of never. Automate: deterministic check-name matching, no model call.

## Fix

1. `agent-role.yaml` governance: add `readyChecks:` (list of check-name patterns, default `['/analyze/i']`) and `readyChecksFallback: repo-pr-checks` (default), so that when no check in the list exists on the PR after its first completed run, the PR is treated as ready when every check in `statusCheckRollup` is SUCCESS and none is pending.
2. `mark-ready.ts`: replace `analyzeState` with `readyState(checks, policy)`: `failed` on any failure among matched (or, on fallback, all) checks; `pending` while any is pending or nothing has run yet; `clean` otherwise. Detect "repo has no CodeQL" once per tick via `gh workflow list` (no CodeQL workflow and no Analyze check), cached for the tick.
3. Opt-in alternative: `governance.openTaskPrsReady: true` makes Step 11 and `ship.ts` omit `--draft`; default stays `false` (AISDLC-218 unchanged for this repo).
4. Docs: `docs/operations/cli-hierarchy.md` mark-ready section; `docs/operations/release-and-plugin-reference.md` governance keys.
5. Tests: repo with CodeQL unchanged; repo without CodeQL flips on green PR checks; one failing check holds; `openTaskPrsReady` omits `--draft`.

## Acceptance Criteria

- [ ] #1 In a repo without CodeQL, a draft task PR whose PR check workflow is green is flipped ready on the next tick.
- [ ] #2 In a repo with CodeQL, behaviour is unchanged (flip only when Analyze checks are clean).
- [ ] #3 `governance.openTaskPrsReady: true` opens task PRs ready from Step 11 and `ship.ts`; default remains draft.
- [ ] #4 Unit tests cover AC #1-#3; no change to this repository's `.ai-sdlc/agent-role.yaml` defaults.

**Velocity impact.** Positive: every task PR in a CodeQL-less adopter repo is stuck in draft today; after this, none is. This repo's behaviour is unchanged.

Authority: class (a) (configurable, reversible; this repo keeps CodeQL gating). Operator instruction 2026-10-14 ("do them all").

Notes: the acceptance criteria were delivered in code but never ticked; the schema and docs gap (`governance.openTaskPrsReady`) is closed by AISDLC-1149.
