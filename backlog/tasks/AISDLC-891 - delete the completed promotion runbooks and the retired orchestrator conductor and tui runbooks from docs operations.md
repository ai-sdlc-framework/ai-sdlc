---
id: AISDLC-891
title: 'docs(operations): delete the completed promotion runbooks and the retired orchestrator, Conductor and TUI runbooks, redirecting their inbound links'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [docs, docs-platform, velocity]
dependencies:
  - AISDLC-853
  - AISDLC-854
references:
  - docs/operations/README.md
  - docs/operations/orchestrator-runbook.md
  - docs/operations/orchestrator-promotion.md
  - docs/operations/operator-tui-promotion.md
  - docs/operations/dispatch-supervisor-install.md
  - docs/operations/dispatch-profiling.md
  - docs/operations/operator-runbook.md
  - docs/operations/parallel-dispatch.md
  - docs/operations/decision-catalog-promotion.md
  - docs/operations/adopter-authoring-promotion.md
  - docs/operations/embedding-substrate-promotion.md
  - docs/operations/signal-ingestion-promotion.md
  - docs/operations/untrusted-pr-gate-promotion.md
  - docs/operations/cli-hierarchy.md
  - scripts/check-rfc-docs.mjs
priority: medium
dispatchable: true
---

## Context

Operator request 2026-10-14: "ensure that our documentation is up to date in the docs folder". A survey the same day (planner session) found about 25 files under `docs/operations` that describe retired surfaces as current. After AISDLC-853 the `docs/` tree is the source the public site renders, so each of these pages is published.

This task takes the files whose whole subject is retired or finished; a sibling task fixes stale sentences in the living pages; another sibling task fixes the reviewer-count claims and adds the retired-term gate.

Whole-subject stale files:

- Retired by AISDLC-763 (RFC-0051, `cli-hierarchy` replaces the Conductor, `cli-orchestrator tick`, `/ai-sdlc orchestrator-tick`, `dispatch-worker`, `execute-parallel`, Pattern Z): `orchestrator-runbook.md` ("running `cli-orchestrator tick` / `cli-orchestrator start`"), `orchestrator-promotion.md` (promotion of `AI_SDLC_AUTONOMOUS_ORCHESTRATOR`, Conductor fan-out), `dispatch-supervisor-install.md` (Conductor `[dispatch-cost]` notice, `/ai-sdlc dispatch-worker`), `dispatch-profiling.md` (gated on `AI_SDLC_AUTONOMOUS_ORCHESTRATOR`), `operator-runbook.md` and `parallel-dispatch.md` (superseded banner, bodies still Conductor/Pattern Z).
- Retired by operator decision 2026-10-13 (TUI: no further investment; a web dashboard RFC follows): `operator-tui-promotion.md`.
- Finished promotions whose runbooks tell readers to set flags that are now default: `decision-catalog-promotion.md` (lines 186 and 285 still say `AI_SDLC_DECISION_CATALOG=experimental` while line 12 says the promotion is done), `adopter-authoring-promotion.md`, `embedding-substrate-promotion.md`, `signal-ingestion-promotion.md`, `untrusted-pr-gate-promotion.md` (all cite the orchestrator flip as a live sibling pattern).

**Five-step review (requirements first).** Requirement questioned: "keep a runbook for every feature that ever shipped". A runbook for a retired surface or a finished promotion has no reader; git history keeps the text. Delete: the twelve files above (the main step of this task). Simplify: inbound links point at the one living page for the subject (`cli-hierarchy.md` for orchestration, `decision-authority.md` or the Decision Catalog page for the catalog) instead of a "superseded, see X" banner. Accelerate: nothing. Automate: a sibling task adds the retired-term gate so these subjects cannot come back as current prose; this task only removes.

## Fix

1. Delete the twelve files listed above. For each, `grep -rl "<basename>" docs spec backlog CLAUDE.md ai-sdlc-plugin README.md` first; rewrite every inbound link to the living page for that subject (orchestration: `docs/operations/cli-hierarchy.md`; decision catalog: the catalog section of `docs/operations/decision-authority.md`; TUI: drop the link, the subject is retired). Backlog references in `backlog/completed/` task frontmatter are fixed with `npx backlog-drift fix --task <id>` so the drift gate stays green.
2. `scripts/check-rfc-docs.mjs` lists `requiresDocs` surfaces per signed-off RFC; where a deleted file is one of them, point the RFC's `requiresDocs` entry at the replacement page in the same PR (an RFC frontmatter edit, not an Open Question).
3. `docs/operations/README.md`: remove the entries for the deleted files (AISDLC-854 rebuilds the index; this task lands after it and only removes rows).
4. Where a deleted file held a still-valid procedure not present elsewhere (check `operator-runbook.md` and `parallel-dispatch.md` in particular), move that section into `cli-hierarchy.md` under its own heading before deleting; name each moved section in the PR body.
5. Files touched: at most 15 (12 deletions plus the index, `cli-hierarchy.md`, and RFC frontmatter edits count toward the limit; if the inbound-link rewrite exceeds it, leave the two superseded-banner files `operator-runbook.md` and `parallel-dispatch.md` for the sibling living-pages task and say so in the PR body).

## Acceptance Criteria

- [ ] None of the twelve files listed in Context exists on main, and `grep -rn` for each basename across `docs`, `spec`, `backlog`, `CLAUDE.md`, `ai-sdlc-plugin` and `README.md` returns no link to it.
- [ ] `npx backlog-drift check` and `pnpm rfc:check` pass on the PR.
- [ ] Any procedure moved out of a deleted file is listed in the PR body with its new heading in `docs/operations/cli-hierarchy.md`.
- [ ] `docs/operations/README.md` has no row for a deleted file.

**Velocity impact.** Positive: fewer pages for agents and readers to load and for the site to render; no agent follows a retired runbook.

Authority: class (a) under `docs/operations/decision-authority.md` (reversible via git, docs only); operator-requested 2026-10-14.
