---
id: RFC-0055
title: Continuous Agent Evals and the Committed Plan Gate
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-10-16
updated: 2026-10-16
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0041, RFC-0042, RFC-0048, RFC-0049, RFC-0050, RFC-0051, RFC-0052, RFC-0053]
requiresDocs: []
---

# RFC-0055: Continuous Agent Evals and the Committed Plan Gate

**Status:** Draft
**Lifecycle:** Draft
**Author:** Dominique Legault (drafted by the planner session on the operator's 2026-10-16 mandate)
**Created:** 2026-10-16
**Updated:** 2026-10-16
**Target Spec Version:** v1alpha1

> This RFC presents options and a recommendation; it resolves nothing. Every
> question in the Open Questions section is routed through the decision rubric
> (`decision-rubric`, Decision Catalog RFC-0035); the answers are the operator's.

---

## Summary

Two plays from Anthropic's AI-native SDLC playbook (Test stage: "continuous evals
in CI"; Build stage: "plan mode as default") have no equivalent in this framework,
and the 2026-10-16 gap analysis ranked them first for their effect on velocity and
token cost.

**Part A, continuous agent evals.** A version-controlled corpus of real tasks that
the framework has already executed, each with deterministic graders, runs on a
schedule and whenever an agent-shaping file changes (`CLAUDE.md`, `AGENTS.md`,
`ai-sdlc-plugin/agents/**`, `ai-sdlc-plugin/commands/**`, `ai-sdlc-plugin/hooks/**`,
`ai-sdlc-plugin/hooks/lib/prompt-rules.js`, skills). The result is a per-change
delta on first-pass approval, review iterations and cost, so a prompt, hook or rule
change is measured instead of assumed. Every failed task and every main-health
incident becomes a regression case.

**Part B, the committed plan gate.** The developer agent writes a plan artifact
before its first edit; a hook blocks edits to anything else until the plan is
accepted; the plan is committed with the PR so the diff can be compared to it
(plan-diff drift). Acceptance climbs the automation ladder (DEC-0090, RFC-0049):
deterministic checks first, judgment layer second, a model or the planner last.

## Motivation

- **Prompt and hook changes are unmeasured bets.** `CLAUDE.md`, `prompt-rules.js`,
  the agent bodies and the hooks change most days (eleven PRs in the week to
  2026-10-16 touched them). The only signal that a change made the agents worse is a
  later failed task or a wasted review round, hours or days afterwards and never
  attributed to the change. The playbook's Test-stage play is exactly this
  feedback loop: 20 to 50 real tasks, run on schedule and on every change to the
  agent-shaping files.
- **Incidents do not become tests of the agents.** Incident-motivated unit tests
  exist (`check-backlog-drift-on-push`, the rm-guard gate), but they test code, not
  agent behaviour. The reenter loop-guard dead end (AISDLC-937), the decision-id
  collisions (DEC-0206/0233/0237/0241) and the push-only re-entry classified as a
  real failure (2026-10-16) are agent-and-tooling behaviours that nothing replays.
- **Rework is where the executor budget goes.** The RFC-0050 scorecard records
  `firstPassApproved` and `iterations` per task; the planner's day-to-day
  observation is that a second or third review round is the common case, and the
  developer agent's "plan" today is one progress line
  (`ai-sdlc-plugin/agents/developer.md`, workflow step 1) that nothing reads or
  checks. The playbook's Build-stage play makes the plan an artifact: iterate until
  it is implementable from alone, commit it, and only then edit. Its lagging metric,
  plan-diff drift, is the signal we do not have for "the agent built something other
  than what it said".
- **Adopters will ask for both.** The playbook is the reference an adopter
  evaluating this framework will read; an eval suite and a plan gate are the two
  plays they can check for in an afternoon.

## Goals

1. A reproducible eval run that reports, for a given commit, first-pass approval
   rate, mean review iterations, cost per case (RFC-0050 ledger) and a pass/fail per
   case, and the delta against the last baseline.
2. The run is triggered on a schedule and by changes to the agent-shaping paths,
   report-only first, gating later by recorded decision.
3. Every failed task verdict and every main-health incident can be turned into a
   corpus case by one command.
4. A plan artifact precedes the first edit in every dispatched task; a hook enforces
   it; the artifact lands in the PR.
5. Plan acceptance and plan-diff drift are measured per task and feed the RFC-0050
   scorecard.
6. Nothing in this RFC bypasses a hook, weakens a control, or asks a person a
   question that the automation ladder can answer.

## Non-Goals

- Replacing unit, gate or conformance tests. Evals measure agent behaviour; the
  existing suites measure code.
- Evaluating model quality in the abstract. The corpus is this project's tasks under
  this project's prompts; it ranks our changes, not vendors' models.
- A plan gate for human sessions. Plan mode in the harness already exists for the
  operator; this RFC gates the developer subagent inside `/ai-sdlc execute`.
- Any change to attestation (RFC-0042/0046/0047) or to the review verdict schema.

## Current tooling inventory

| Need | What exists | Gap |
|---|---|---|
| Real executed tasks with outcomes | `.ai-sdlc/dispatch/done/*.verdict.json` (195), `backlog/completed/`, PR history, RFC-0050 scorecard (`pipeline-cli/src/usage/scorecard.ts`) | Not replayable: no pinned base sha, no grader, no corpus format |
| Offline replay | RFC-0050 Part B reviewer replay (design, partly built) | Replays reviewers, not the developer |
| Cheap graders | RFC-0049 judgment layer (closed-set questions, shadow) | No eval-grader seam |
| Layered corpus with a golden gate | RFC-0053 OQ-5 (`evaluation.goldenRecallAt5`) | Retrieval corpus, not task corpus; the pattern is reusable |
| Scheduled runs | `ci.yml` daily, `flaky-tests.yml` daily, `main-health-monitor.yml` | None runs an agent |
| Change-triggered runs | `ai-sdlc-gate.yml` path filters | No agent-shaping path set |
| Adopter smoke | `scripts/first-run-smoke.mjs` (offline, stubbed) | Exercises install, not agent behaviour |
| Harness eval runner | `claude plugin eval` (eval suites, JSON report, sandbox, CI) | Not adopted; fit for our corpus unknown |
| Plan | `developer.md` step 1: one `[ai-sdlc-progress] plan:` line | Not an artifact, not checked, not committed |
| Edit blocking | `enforce-blocked-actions.js` PreToolUse on Write/Edit by `blockedPaths` glob | Static globs; no "until plan accepted" state |
| Plan vs diff | nothing | plan-diff drift unmeasured |

## Five-step pass (DEC-0090 order)

1. **Question the requirement.** Do we need an eval suite at all, or is the RFC-0050
   scorecard enough? The scorecard measures what happened on real tasks; it cannot
   say which change caused a shift, because every task differs. A fixed corpus holds
   the task constant and varies the prompts. Do we need a plan gate, or is a better
   developer prompt enough? Prompts are advisory (the playbook's own words on skills);
   the rework rounds we see are the evidence that advice is not holding.
2. **Delete.** Delete the ambition of a general benchmark: the corpus is this repo's
   tasks only. Delete any new verdict schema: evals reuse the existing
   `verdict.json` and scorecard records. Delete human plan review as the default:
   a person reviews a plan only when the ladder abstains.
3. **Simplify.** One corpus format (a directory per case: task file, base sha,
   grader spec). One runner command. One gate hook that reads one state file. The
   plan artifact is Markdown with a fixed heading set, no schema beyond that.
4. **Accelerate.** Run a path-selected subset on PRs (cases tagged with the paths a
   change touches), the full corpus nightly. Plan acceptance is deterministic in the
   common case and takes milliseconds.
5. **Automate last.** Incident-to-case generation and gating on the delta come after
   the report-only period has shown the measure is stable.

## Proposal

### Part A: continuous agent evals

**Corpus.** `evals/cases/<case-id>/` holds:

- `task.md`: the backlog task as dispatched (frozen copy).
- `case.yaml`: `baseSha`, `paths` (agent-shaping paths this case is sensitive to,
  for PR subset selection), `budgetUsd`, `tags` (`incident`, `golden`, `mined`),
  `expect` (the grader spec below), `origin` (task id, verdict file or incident
  issue it was mined from).
- optional `fixtures/` the task needs.

Size target 20 to 50 cases, following the playbook; start with the ten most recent
first-pass approvals and the ten most recent failures.

**Graders, on the ladder.** Deterministic first: build, test, lint and format pass;
the files touched are within the task's `references` plus an allowlist; the file
budget from `agent-role.yaml` holds; no blocked action was attempted (hook log);
every acceptance criterion is ticked; a PR body exists; the task file moved to
`backlog/completed/`. Judgment layer second (RFC-0049, closed-set): "does the diff
address AC n?" per criterion, "is the plan implementable from alone?". Model grader
last and only for cases tagged `golden`, using the staged review (RFC-0052) in
report-only mode. The three existing reviewer verdicts are the primary quality
signal, exactly as in production.

**Runner.** `cli-evals run [--subset-for <paths>] [--case <id>] [--baseline <sha>]`
creates an isolated worktree per case at `baseSha`, runs the production path
(`/ai-sdlc execute` with its real developer and reviewers) with `prUrl` capture
disabled (no push, no PR), applies the graders, records one `evals/results/<run-id>/
<case-id>.json` and a summary with the delta against the baseline run. Cost is
attributed through the RFC-0050 ledger under a dedicated `evals` billing pool.

**Triggers.** Nightly full run on `main`. On a PR that touches an agent-shaping
path: the path-selected subset, report-only, posting a summary comment and a
`ai-sdlc/evals` status that is NOT in the `pr-ready` rollup until a recorded
decision promotes it (OQ-4). Rate-limit and quota budget is a hard cap: the run
stops at `budgetUsd` for the corpus and reports partial.

**Incident to case.** `cli-evals mine --verdict <task-id>` and
`cli-evals mine --issue <main-health issue>` write a case skeleton from the verdict
or issue; the planner fills `expect`. Every `failed` verdict with a resume note
proposes a case in the dispatch digest.

**Metrics (leading / lagging).** First-pass approval rate and iterations per case
(leading); delta per change and the regression count caught before landing versus
observed in production (lagging). Reported by `cli-kpi evals`.

### Part B: the committed plan gate

**Artifact.** Before its first `Edit` or `Write`, the developer writes
`.ai-sdlc/plans/<task-id>.md` with fixed headings: `## Approach`, `## Files` (every
file it intends to touch, one per line), `## Tests` (which tests prove each AC),
`## Risks`, `## Out of scope`. The plan is committed in the PR's own diff, so the
PR carries intent, plan, diff and review findings together (the playbook's audit
trail).

**Gate.** A PreToolUse hook (`enforce-plan-gate.js`) on `Write`/`Edit`/`MultiEdit`
in a task worktree allows writes to the plan file always and to any other path only
when `.ai-sdlc/plans/<task-id>.accepted` exists. The block message names the route:
"write the plan, then run `cli-plan accept`". `accept` runs the ladder:

1. Deterministic: headings present; `## Files` non-empty and every path exists or
   is under a directory named in the task `references`; the file count is within the
   `agent-role.yaml` budget; every AC id appears under `## Tests`. Pass writes the
   `.accepted` sentinel with `by: deterministic`.
2. Judgment layer (RFC-0049) when configured: "implementable from alone?" and "does
   the plan cover AC n?" with the ledger's act band; abstain falls through.
3. Fallthrough per OQ-3: a Sonnet reviewer, or the planner session via the board
   (never `AskUserQuestion`, away rule).

**Drift.** At verdict time, `plan-diff drift` = files in the diff not in `## Files`
plus files in `## Files` not in the diff, as a count and a ratio, recorded in the
verdict and the RFC-0050 scorecard. Drift above a threshold is a reviewer finding
(major), not a block, in v1.

**Prompt.** `developer.md` step 1 becomes "write the plan file and run `cli-plan
accept`"; the rule "never edit before the plan is accepted" is one line in
`prompt-rules.js` (AISDLC-651.2), rendered into the developer and `execute` bodies.

### Velocity impact (DEC-0048)

- Part A adds no step to a task. It adds one nightly run and one report-only PR
  job on agent-shaping changes, bounded by `budgetUsd`.
- Part B adds one file write and one sub-second deterministic check per task when
  the ladder passes at rung 1. The expected gain is fewer review rounds; the RFC
  sets the measurement (iterations and drift in the scorecard) and the report-only
  period decides whether the gain is real before anything gates.
- The gate is a hook, so a developer that ignores the prompt is blocked once and
  told the route; no re-run, no escalation.

## Design Details

### Schema changes

`case.yaml`:

```yaml
id: AISDLC-937-reenter-loop-guard
origin: { taskId: AISDLC-937, verdict: .ai-sdlc/dispatch/done/AISDLC-937.verdict.json }
baseSha: 8e134abd6
paths: [ai-sdlc-plugin/agents/developer.md, ai-sdlc-plugin/hooks/lib/prompt-rules.js]
tags: [mined, incident]
budgetUsd: 4
expect:
  filesWithin: [pipeline-cli/src/hierarchy/]
  maxFiles: 6
  acceptanceCriteria: all
  firstPassApproved: true
  judgment:
    - question: 'Does the diff guard on the origin ref rather than headRefOid?'
      kind: yes-no
```

Verdict record (RFC-0041) gains optional `plan: { accepted: { by, at }, drift: {
missing: n, extra: n, ratio } }`. Scorecard record gains `planDrift`.

`agent-role.yaml` gains `spec.build.planGate: off | report | enforce` (default
`report` for this repo once Phase 2 lands, `off` for adopters until they opt in).

### Behavioral changes

- `/ai-sdlc execute` Step 5 (build dev prompt) passes the plan path and the gate
  mode; Step 8 (aggregate verdicts) records plan drift.
- `enforce-plan-gate.js` is registered beside `enforce-blocked-actions.js`; it is a
  no-op outside a task worktree (no `.active-task`) and when `planGate: off`.
- `ai-sdlc-gate.yml` gains an `agent-evals` job gated on the agent-shaping path
  filter, report-only.

### Migration path

Phase 0 ships the corpus format and the runner with no triggers. Phase 1 adds the
nightly run and the report-only PR job. Phase 2 ships the plan artifact and the gate
in `report` mode (the hook logs, does not block). Phase 3 flips `enforce` and
promotes `ai-sdlc/evals` into the rollup, each by a recorded decision after the
report-only period (OQ-4, OQ-6).

## Backward Compatibility

Additive. Adopters without `evals/` or `planGate` see no change. The verdict and
scorecard fields are optional.

## Alternatives Considered

### Alternative 1: rely on the RFC-0050 scorecard alone

Rejected as the only measure: it cannot attribute a shift to a change because the
task population moves. It stays as the production signal the corpus is calibrated
against.

### Alternative 2: prompt-only plan ("write a plan first" in `developer.md`)

Rejected as the only mechanism: the playbook itself says skills and prompts are
advisory and that critical policies get hooks. We already have the one-line plan and
the rework rounds.

### Alternative 3: a general benchmark (SWE-bench style)

Rejected: measures models, not our prompts and hooks; expensive; not this repo.

## Implementation Plan (phased sketch; tasks filed after sign-off)

- Phase 0: corpus format, `cli-evals run` with deterministic graders, ten mined
  cases, cost attribution to the `evals` pool.
- Phase 1: nightly workflow, agent-shaping path filter, report-only PR job,
  `cli-evals mine`, `cli-kpi evals`.
- Phase 2: plan artifact, `cli-plan accept` rung 1, `enforce-plan-gate.js` in
  `report` mode, drift in verdict and scorecard, `developer.md` and `prompt-rules.js`
  updates.
- Phase 3: judgment-layer graders and plan rung 2; `enforce` mode; `ai-sdlc/evals`
  into the rollup by decision; incident-to-case proposal in the dispatch digest.

## Open Questions

Each is decided with the operator through the decision rubric. Options are listed;
the recommendation is the planner's and binds nothing.

### OQ-1: Eval runner substrate

*Options:* (a) the harness's own `claude plugin eval` suites; (b) an own runner
(`cli-evals`) that drives the production `/ai-sdlc execute` path in an isolated
worktree; (c) offline transcript replay only (RFC-0050 Part B extended to the
developer); (d) (b) now with (a) adopted for the plugin's own command/skill tests
where it fits.
*Trade-offs:* (a) is maintained for us and CI-ready but may not express our
graders, worktrees and reviewers; (b) measures exactly what runs in production and
costs real tokens per case; (c) is free of model cost but cannot evaluate a changed
developer prompt (no new generation); (d) uses each where it fits at the price of two
tools.
*Recommendation:* (d), (b) for the task corpus. Counter-argument: two runners is
more surface than this team wants to maintain.

### OQ-2: Corpus composition and live cost

*Options:* (a) mined from real verdicts only; (b) hand-authored golden cases only;
(c) layered as RFC-0053 OQ-5: golden gate plus mined breadth; (d) mined plus every
failed verdict automatically.
*Trade-offs:* mined cases are real and drift with the repo; golden cases are stable
and narrow; automatic failures risk a corpus of flakes.
*Recommendation:* (c), with failures proposed not auto-added. Counter-argument: the
golden set needs an owner and a threshold, as RFC-0053 found.

### OQ-3: Plan acceptance fallthrough authority

*Options:* (a) deterministic only, abstain means accept; (b) deterministic then
RFC-0049 judgment, abstain means accept; (c) (b) then a Sonnet reviewer subagent;
(d) (b) then the planner session via the board.
*Trade-offs:* (a) is fastest and weakest; (c) costs a model call per fallthrough; (d)
adds planner latency and a human-in-the-loop that the away rule forbids as a
question.
*Recommendation:* (c) in v1, measured; (d) never for routine tasks. Counter-argument:
if rung 1 passes 95% of plans, (a) is enough and (c) is dark code.

### OQ-4: When does `ai-sdlc/evals` gate

*Options:* (a) never, report-only forever; (b) after N report-only runs with a stable
baseline, gate on "any case regresses from pass to fail"; (c) gate on an aggregate
first-pass-rate drop above a threshold; (d) gate only agent-shaping PRs, never code
PRs.
*Recommendation:* (b) scoped as (d), promoted by one recorded decision. Counter-
argument: a single flaky case then blocks prompt fixes; needs the flake policy from
`flaky-tests.yml`.

### OQ-5: Where the plan artifact lives

*Options:* (a) committed in the PR at `.ai-sdlc/plans/<task-id>.md`; (b) a PR body
section only; (c) a board record (`.ai-sdlc/dispatch/plans/`) not in the PR; (d)
(a) plus a PR body summary.
*Trade-offs:* (a) gives the audit trail and plan-diff drift from git alone but adds a
file to every PR (patch-id exclusions, AISDLC-618 lockstep); (b) is invisible to
`git`; (c) separates plan from code.
*Recommendation:* (a), added to the three patch-id exclusion lists. Counter-argument:
every PR grows a file that reviewers must learn to ignore.

### OQ-6: Gate enforcement mode and scope

*Options:* (a) hook blocks from day one for every task; (b) `report` first, then
`enforce` by decision; (c) enforce only above a size or risk class (file budget,
`riskClass`); (d) prompt-only.
*Recommendation:* (b), with (c) considered when the report shows where drift
concentrates. Counter-argument: `report` mode is exactly the advisory posture the
playbook warns against.

### OQ-7: Incident-to-case automation

*Options:* (a) manual `cli-evals mine` only; (b) every `failed` verdict proposes a
case in the dispatch digest; (c) every failed verdict and every `[main-health]`
issue auto-creates a case PR; (d) (b) plus auto-create for incidents with a decision
record.
*Recommendation:* (b). Counter-argument: proposals that nobody acts on are the same
as (a).

### OQ-8: Developer-plan interaction with the staged review (RFC-0052)

*Options:* (a) reviewers read the plan as context and flag plan-diff drift as a
finding; (b) reviewers never see the plan (independence); (c) the plan is one
risk-map input for the review planner only.
*Recommendation:* (a) for drift, (c) for ranking. Counter-argument: a reviewer that
reads the plan may anchor on it and miss what the plan missed.

## Sign-Off

| Role | Owner | Status | Date |
|---|---|---|---|
| Engineering | Dominique Legault | pending | |
| Operator | Dominique Legault | pending | |
| Product | | pending | |
| Design | | not applicable | |

## Revision History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-10-16 | Draft from the playbook gap analysis; eight Open Questions, none resolved. |

## References

- Anthropic, "The AI-native SDLC playbook" (claude.com/resources/articles/the-ai-native-sdlc-playbook): Stage 3 "Plan mode as default", Stage 4 "Continuous evals in CI".
- RFC-0049 System One Judgment Layer (graders, acceptance rung 2).
- RFC-0050 Usage Ledger (cost attribution, scorecard, reviewer replay).
- RFC-0052 Staged Review Pipeline (model grader, drift as a finding).
- RFC-0053 Just-In-Time Context Engine, OQ-5 (layered corpus with a golden gate).
- DEC-0090 five-step order; DEC-0048 velocity impact section.
- `ai-sdlc-plugin/agents/developer.md`, `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`, `pipeline-cli/src/usage/scorecard.ts`, `scripts/first-run-smoke.mjs`.
