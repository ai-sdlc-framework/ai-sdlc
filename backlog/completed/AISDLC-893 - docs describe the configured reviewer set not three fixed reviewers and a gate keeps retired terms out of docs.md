---
id: AISDLC-893
title: 'docs: pages describe the configured reviewer set, not three fixed reviewers, and a test keeps retired terms out of docs/'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [docs, docs-platform, velocity]
references:
  - docs/operations/untrusted-contributor-pr-verification.md
  - docs/operations/independence-policy.md
  - docs/operations/recovery-flows.md
  - docs/getting-started/onboarding.md
  - docs/tutorials/08-claude-code-plugin.md
  - docs/operations/reviewer-set-flag.md
  - scripts/check-claude-md-size.test.mjs
priority: medium
dispatchable: true
---

## Context

Operator request 2026-10-14: "ensure that our documentation is up to date in the docs folder". Third of three tasks (a sibling task deletes whole-subject stale files; another sibling task fixes stale orchestrator and flag sentences). This one fixes the reviewer-count claims and adds the deterministic check that keeps retired terms from returning.

Survey findings (planner, 2026-10-14). AISDLC-722 made a two-reviewer default (`correctness-reviewer` + `security-reviewer`) with the three-reviewer set available by configuration (`docs/operations/reviewer-set-flag.md`); the pages below still state three as the fixed set:

- `docs/operations/untrusted-contributor-pr-verification.md:42,476` "trusted PRs → three reviewers".
- `docs/operations/independence-policy.md:253` "the three reviewers run as…".
- `docs/operations/recovery-flows.md:129,177` "Re-runs all 3 reviewers".
- `docs/getting-started/onboarding.md:16` "three-tier reviewer fan-out"; lines 273, 343, 414 refer to the "RFC-0041 Conductor/Worker" and "The Conductor's next tick fans out three reviewer…" (Conductor retired, AISDLC-763).
- `docs/tutorials/08-claude-code-plugin.md:26,65,166` three always-on review agents ("all 3 reviewers approved").

No script checks docs currency today: `pnpm docs:check` compares trees (deleted by AISDLC-853), `pnpm rfc:check` checks RFC `requiresDocs` references, nothing checks for retired terms.

**Five-step review (requirements first).** Requirement questioned: "each page states how many reviewers run". The number is configuration; the page should say "the configured reviewer set" and point at `reviewer-set-flag.md` once. Delete: the hard-coded counts and the Conductor narrative in `onboarding.md`. Simplify: one phrase, one link, for the reviewer set across the five pages. Accelerate: nothing. Automate: `scripts/check-docs-retired-terms.test.mjs`, a `node --test` grep over `docs/` (excluding `docs/audits`, `docs/upstream-bug-reports`, `docs/whitepapers`) for a fixed list of retired tokens, with an allowlist of lines that state the retirement; wired into `pnpm test` beside `check-claude-md-size.test.mjs`. Deterministic, no model call (automation ladder rung 1).

## Fix

1. Rewrite the reviewer-count sentences in the five pages above to "the configured reviewer set (two by default: correctness and security; three with `reviewerSet: three`, see [reviewer-set-flag.md])", using the flag name and values as `docs/operations/reviewer-set-flag.md` states them. Rewrite the `onboarding.md` Conductor passages around the executor loop (`/ai-sdlc:executor`) and `cli-hierarchy`.
2. Add `scripts/check-docs-retired-terms.test.mjs`: tokens `cli-orchestrator tick`, `orchestrator-tick`, `AI_SDLC_AUTONOMOUS_ORCHESTRATOR`, `AI_SDLC_TUI`, `execute-parallel`, `dispatch-worker`, `Pattern Z`, `auto-rearm-on-dequeue.yml`, `isolated-review.yml`, `ai-sdlc-fix-ci.yml`; a line passes when it contains `retired`, `superseded`, `deleted` or `removed` within the same line; the test prints `path:line: token` for every failure. Scope: `docs/**/*.md` minus the three excluded folders. Add it to the root `test` script next to the CLAUDE.md size test.
3. Run the new test; fix any remaining line it reports in `docs/` (the two sibling docs tasks should have cleared `docs/operations`; `docs/concepts`, `docs/getting-started`, `docs/tutorials`, `docs/api-reference` have not been swept and may add a few lines). If the fix list exceeds the 15-file limit, extend the allowlist for the exact remaining lines, list them in the PR body, and name them as follow-up.

## Acceptance Criteria

- [x] No page under `docs/` (outside the three excluded folders) states a fixed reviewer count; the five pages in Context reference `docs/operations/reviewer-set-flag.md` for the set.
- [x] `docs/getting-started/onboarding.md` has no Conductor or RFC-0041 narrative; it describes the executor loop and `cli-hierarchy`.
- [x] `scripts/check-docs-retired-terms.test.mjs` exists, runs under `pnpm test`, passes on the PR, and fails (verified in its own test case against a fixture string) on a line that uses a retired token without a retirement word.
- [x] The PR body lists any line kept via allowlist with the reason.

**Velocity impact.** Positive: the gate replaces a recurring manual survey; adopters reading onboarding and tutorial 08 get the current reviewer model.

Authority: class (a) under `docs/operations/decision-authority.md` (tightening, docs and one test); operator-requested 2026-10-14.
