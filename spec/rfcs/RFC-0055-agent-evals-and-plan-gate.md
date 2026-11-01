---
id: RFC-0055
title: Continuous Agent Evals and the Committed Plan Gate
status: Under Review
lifecycle: Ready for Review
author: 'Dominique Legault'
created: 2026-10-16
updated: 2026-11-01
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0041, RFC-0042, RFC-0048, RFC-0049, RFC-0050, RFC-0051, RFC-0052, RFC-0053]
requiresDocs: []
---

# RFC-0055: Continuous Agent Evals and the Committed Plan Gate

**Status:** Under Review
**Lifecycle:** Ready for Review (v0.2, 2026-11-01: all 8 Open Questions resolved with the operator through the full rubric; own `cli-evals` runner reusing the RFC-0050 replay plumbing, layered golden plus mined corpus with quarantine, Sonnet reviewer as plan-acceptance rung 3 with the planner only on a second reject, evals gate promoted by a recorded bar on golden-case flips for agent-shaping PRs only, plan committed at `.ai-sdlc/plans/` with a PR-body summary, `planGate` report then enforce by decision, incident proposals in the operator digest, reviewers see a labelled plan plus computed drift)
**Author:** Dominique Legault (drafted by the planner session on the operator's 2026-10-16 mandate)
**Created:** 2026-10-16
**Updated:** 2026-11-01
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
first-pass approvals and the ten most recent failures. The corpus is layered
(OQ-2): about ten `golden` cases owned by the planner role are the only ones that
ever gate; `mined` cases enter by proposal and planner review. A case that fails two
consecutive nightly runs with no agent-shaping change between them is tagged
`quarantined` and leaves the gate and the delta until re-admitted (the
`flaky-tests.yml` rule applied to cases).

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
`cli-evals mine --sha <red main sha>` write a case skeleton from the verdict or the
failed main-health run; the planner fills `expect`. Every `failed` or
`iteration-exhausted` verdict (with its resume note) and every red main sha the
dispatch tick routes to the planner adds a "Proposed eval cases" row carrying the
exact `mine` command to the decisions operator digest (`cli-decisions
operator-digest`); nothing auto-creates (OQ-7). v0.1 said "dispatch digest" and
"main-health issue": neither exists (the only digest is the operator digest, and
AISDLC-929 removed the `[main-health]` issue in favour of routing the red sha).

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
3. Fallthrough (OQ-3): a Sonnet reviewer subagent distinct from the developer. A
   first reject blocks and allows one rewrite; a second reject escalates to the
   planner session via the board (never `AskUserQuestion`, away rule). The sentinel
   records the accepting rung (`by: deterministic | judgment | reviewer | planner`)
   so the report period shows how often each rung fires.

**Drift.** When the review prompts are built (Step 7), `plan-diff drift` = files in
the diff not in `## Files` plus files in `## Files` not in the diff, as a count and a
ratio, is computed by code and handed to the reviewers as a fact; Step 8 records it
in the verdict and the RFC-0050 scorecard. Reviewers receive the plan as a labelled
"Developer plan" section after the acceptance criteria, with the rule that an
unplanned file is a major finding unless the developer justified it and that an
`## Out of scope` entry contradicting an AC is a finding (OQ-8). Drift is never a
block in v1.

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
tags: [mined, incident] # golden | mined | incident | quarantined (OQ-2)
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

Verdict record (RFC-0041, `spec/schemas/dispatch-verdict.v1.schema.json`, root is
`additionalProperties: false` so this is a schema change) gains optional `plan: {
accepted: { by: deterministic | judgment | reviewer | planner, at }, wouldBlock: n,
drift: { missing: n, extra: n, ratio } }`. Scorecard record gains `planDrift`.

`agent-role.yaml` gains `spec.build.planGate: off | report | enforce` (a new `build`
key in `spec/schemas/agent-role.schema.json`; default `report` for this repo once
Phase 2 lands, `off` for adopters until they opt in). In `report` mode the hook
writes would-block events to the usage directory and the verdict and blocks nothing
(OQ-6).

`.ai-sdlc/plans/` is added to the three patch-id exclusion lists
(`pipeline-cli/src/attestation/patch-id.ts`,
`pipeline-cli/attestation-core/verify-core.mjs`, `scripts/check-attestation-sign.sh`)
and to their lockstep test (OQ-5).

### Behavioral changes

- `/ai-sdlc execute` Step 5 (build dev prompt) passes the plan path and the gate
  mode; Step 8 (aggregate verdicts) records plan drift.
- `enforce-plan-gate.js` is registered beside `enforce-blocked-actions.js`; it is a
  no-op outside a task worktree (no `.active-task`) and when `planGate: off`.
- `ai-sdlc-gate.yml` gains an `agent-shaping` group in `detect` (none exists today
  for `CLAUDE.md`, agents, commands, hooks or skills) and an `agent-evals` job
  gated on it, report-only, outside the `pr-ready` rollup until promoted (OQ-4).
- Step 11 injects a one-line plan summary (first line of `## Approach`, `## Files`
  count) into the PR body (OQ-5).
- `cli-decisions operator-digest` gains a "Proposed eval cases" section (OQ-7).

### Migration path

Phase 0 ships the corpus format and the runner with no triggers. Phase 1 adds the
nightly run and the report-only PR job. Phase 2 ships the plan artifact and the gate
in `report` mode (the hook logs, does not block). Phase 3 flips `enforce` and
promotes `ai-sdlc/evals` into the rollup, each by one recorded class (b) decision
once its bar is met: for the gate, at least 50 dispatched tasks in `report` mode
with rung-1 acceptance and would-block rates recorded (OQ-6); for the evals status,
at least 30 nightly runs with golden-set flake under 2% per case, scope agent-shaping
PRs only, block only on a golden case flipping outside its noise band (OQ-4).

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

Each was decided with the operator through the decision rubric on 2026-11-01. The
original question text is kept; the **Resolution** block under each records the
choice, the research, the refinement over v0.1 and the counter-argument. A
substrate survey preceded the walkthrough: no evals, plan or gate code exists; the
RFC-0049 judgment layer, the RFC-0050 ledger and replay, and the RFC-0052 staged
review (advisory under DEC-0149) are shipped.

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

**Resolution (2026-11-01, full rubric): own runner (`cli-evals`) driving the
production `/ai-sdlc execute` path per case, reusing the RFC-0050 Part B replay
plumbing; `claude plugin eval` deferred, not adopted.** Industry research: promptfoo,
Braintrust and OpenAI Evals all separate a frozen input set from a pluggable runner
and let graders be code, model or human; `claude plugin eval` runs harness suite
files in a sandbox with harness-defined graders and no worktree, dispatch or
external reviewer verdicts. **Substrate surfaced by the walkthrough:** RFC-0050 Part
B already ships `replay-sandbox`, `replay-git`, `replay-corpus` and `replay-report`
(`pipeline-cli/src/usage/`); it replays rather than regenerates, so it is the
plumbing, not the runner. **Refinement over v0.1:** option (d) is narrowed; a second
runner is a later decision taken only when a concrete command or skill smoke need
appears, so no tool of unproven fit is owned on a guess. **Counter-argument:** "real
execution per case is the expensive path; replay gives most of the signal free and
prompt changes are rare." Rebuttal: eleven agent-shaping PRs in one week is not
rare, and replay cannot show that a changed developer prompt produces a different
diff; cost is bounded by `budgetUsd` and the PR subset. **Selected over (a) and (c)
because neither can grade a changed developer prompt against the real reviewers, and
over (d) because deferring avoids a second runner of unproven fit.**


### OQ-2: Corpus composition and live cost

*Options:* (a) mined from real verdicts only; (b) hand-authored golden cases only;
(c) layered as RFC-0053 OQ-5: golden gate plus mined breadth; (d) mined plus every
failed verdict automatically.
*Trade-offs:* mined cases are real and drift with the repo; golden cases are stable
and narrow; automatic failures risk a corpus of flakes.
*Recommendation:* (c), with failures proposed not auto-added. Counter-argument: the
golden set needs an owner and a threshold, as RFC-0053 found.

**Resolution (2026-11-01, full rubric): layered corpus, about ten planner-owned
`golden` cases that alone ever gate plus `mined` breadth entering by proposal, with a
quarantine rule.** Industry research: Google's TAP and Meta's test infrastructure
keep a small owned regression set beside a larger churning one; promptfoo and
Braintrust tag cases and gate only on a tagged subset; RFC-0053 OQ-5 chose the same
layering for the retrieval corpus (Signed Off; AISDLC-778 still To Do); the repo's
`flaky-tests.yml` quarantines after two failures on one HEAD. **Substrate surfaced:**
today's 38 verdicts hold 14 failures that share one tooling cause (the step-11
non-fast-forward bug), so "every failed verdict" would seed 14 copies of a fixed bug.
**Refinement over v0.1:** quarantine is specified: a case failing two consecutive
nightly runs with no agent-shaping change between them is tagged `quarantined` and
leaves the gate and the delta until re-admitted; the run halts at the corpus
`budgetUsd` and reports partial; size 20 to 50. **Counter-argument:** "the golden set
needs an owner and a threshold, and RFC-0053's golden set has sat unimplemented for
three weeks; layered corpora stall." Rebuttal: the stall is prioritisation, not
design, and the alternative is a gate baseline that moves every time the repo does;
the owner is the planner role, named here. **Selected over (a) because a drifting
baseline cannot gate, over (b) because it misses the long tail, and over (d) because
the live failure set shows how fast auto-add duplicates one bug.**


### OQ-3: Plan acceptance fallthrough authority

*Options:* (a) deterministic only, abstain means accept; (b) deterministic then
RFC-0049 judgment, abstain means accept; (c) (b) then a Sonnet reviewer subagent;
(d) (b) then the planner session via the board.
*Trade-offs:* (a) is fastest and weakest; (c) costs a model call per fallthrough; (d)
adds planner latency and a human-in-the-loop that the away rule forbids as a
question.
*Recommendation:* (c) in v1, measured; (d) never for routine tasks. Counter-argument:
if rung 1 passes 95% of plans, (a) is enough and (c) is dark code.

**Resolution (2026-11-01, full rubric): rung 1 deterministic, rung 2 the RFC-0049
judgment layer when configured, rung 3 a Sonnet reviewer subagent distinct from the
developer; the planner only on a second reject, via the board.** Industry research:
Kubernetes admission webhooks choose `failurePolicy` per control; Gerrit's +2 and
GitHub required reviews protect "a different identity decides", and self-approval is
the classic weak spot; Anthropic's playbook has the plan read by a reader that is
never the writer. **Substrate surfaced:** the judgment layer is in code with `act |
escalate | abstain` bands but is off without configuration (`AI_SDLC_JUDGMENT`), so
option (b) collapses to (a) for every adopter. **Refinement over v0.1:** a first
reviewer reject blocks and allows one rewrite; a second reject escalates to the
planner via the board (never `AskUserQuestion`); the sentinel records `by:
deterministic | judgment | reviewer | planner` so the report period shows rung
frequency. **Counter-argument:** "if rung 1 accepts 95% of plans, rung 3 is dark
code; ship (a) and add rungs when the data says so." Rebuttal: a rung that fires on
the fallthrough is exercised, and abstain-means-accept makes a malformed plan
indistinguishable from an accepted one, so OQ-8 drift is measured against noise.
**Selected over (a) and (b) because abstain-means-accept makes the gate advisory,
and over (d) because a person in the routine path contradicts Goal 6.**


### OQ-4: When does `ai-sdlc/evals` gate

*Options:* (a) never, report-only forever; (b) after N report-only runs with a stable
baseline, gate on "any case regresses from pass to fail"; (c) gate on an aggregate
first-pass-rate drop above a threshold; (d) gate only agent-shaping PRs, never code
PRs.
*Recommendation:* (b) scoped as (d), promoted by one recorded decision. Counter-
argument: a single flaky case then blocks prompt fixes; needs the flake policy from
`flaky-tests.yml`.

**Resolution (2026-11-01, full rubric): report-only until a recorded promotion bar
is met, then gate agent-shaping PRs only, blocking only on a `golden` case flipping
pass to fail outside its noise band.** Industry research: Chromium and Android perf
sheriffs gate on regressions beyond a per-benchmark noise band, not on a raw flip;
Google keeps a test in the blocking set only below a flake rate of about 1.5%;
promptfoo and Braintrust CI integrations comment by default and fail only on an
explicit threshold; DEC-0149 kept the staged review advisory until "50 PRs at 95%
precision". **Substrate surfaced:** `detect` in `ai-sdlc-gate.yml` has no path group
for `CLAUDE.md`, agents, commands, hooks or skills, so the agent-shaping filter is
net-new. **Refinement over v0.1:** the bar is fixed now as the shape of the later
class (b) decision: at least 30 nightly runs on `main`, golden-set flake under 2% per
case, band computed from that history; the aggregate first-pass drop (option c) is a
PR comment, never the gate. **Counter-argument:** "a single flaky case then blocks
prompt fixes, and the flake policy is per-test and manual, so the band is a promise."
Rebuttal: the OQ-2 quarantine removes a case after two unexplained failures, the band
exists because the bar requires the history, and a pinned case can be rerun.
**Selected over (a) because an ungated signal is advisory, over (c) alone because a
per-case flip is the signal the corpus exists to produce, and over (d) because code
PRs rarely change agent behaviour and the nightly run catches those that do.**


### OQ-5: Where the plan artifact lives

*Options:* (a) committed in the PR at `.ai-sdlc/plans/<task-id>.md`; (b) a PR body
section only; (c) a board record (`.ai-sdlc/dispatch/plans/`) not in the PR; (d)
(a) plus a PR body summary.
*Trade-offs:* (a) gives the audit trail and plan-diff drift from git alone but adds a
file to every PR (patch-id exclusions, AISDLC-618 lockstep); (b) is invisible to
`git`; (c) separates plan from code.
*Recommendation:* (a), added to the three patch-id exclusion lists. Counter-argument:
every PR grows a file that reviewers must learn to ignore.

**Resolution (2026-11-01, full rubric): committed at `.ai-sdlc/plans/<task-id>.md`,
added to the three patch-id exclusion lists, plus a one-line PR-body summary
injected by Step 11.** Industry research: ADRs and the Rust and Python RFC processes
keep the design artifact in the repo beside the code; PR bodies and commit trailers
rot and are invisible to `git log` and `git blame`; the playbook commits the plan.
**Substrate surfaced:** the signer (`patch-id.ts`), verifier (`verify-core.mjs`) and
pre-push (`check-attestation-sign.sh`) lists already exclude `.ai-sdlc/reviews/`,
attestations, transcript leaves, `backlog/` and the decisions log, with a lockstep
test, so one more directory is a known, tested change; `.ai-sdlc/**` writes are
blocked only for untrusted runs, which are outside the gate's scope. **Refinement
over v0.1:** the summary is the first line of `## Approach` plus the `## Files` count,
generated by Step 11 so no prompt rule is needed. **Counter-argument:** "every PR
grows a file reviewers must learn to ignore, in an already crowded `.ai-sdlc/`."
Rebuttal: reviewers already ignore `.ai-sdlc/reviews/` and `backlog/completed/`
moves, and the precedent is exactly this shape. **Selected over (b) because the gate
runs before any PR exists, and over (c) because drift and audit need the plan in the
same commit as the diff.**


### OQ-6: Gate enforcement mode and scope

*Options:* (a) hook blocks from day one for every task; (b) `report` first, then
`enforce` by decision; (c) enforce only above a size or risk class (file budget,
`riskClass`); (d) prompt-only.
*Recommendation:* (b), with (c) considered when the report shows where drift
concentrates. Counter-argument: `report` mode is exactly the advisory posture the
playbook warns against.

**Resolution (2026-11-01, full rubric): `report` first, `enforce` by one recorded
class (b) decision; scope every dispatched task in a task worktree, no-op
elsewhere.** Industry research: OPA Gatekeeper and Kyverno ship every policy in
`audit` or `dryrun` before `deny`; Kubernetes Pod Security Admission has explicit
`warn`, `audit`, `enforce` modes; Google's Tricorder promotes an analyzer from
show-only to blocking after a measured false-positive rate under 10%. **Substrate
surfaced:** `enforce-blocked-actions.js` is already a no-op without `.active-task`,
so the scope is free; `agent-role.yaml` has no `spec.build` key and the schema is
`additionalProperties: false`, so the mode field is a schema change; `riskClass`
exists only on judgment definitions, so option (c) has no field to read.
**Refinement over v0.1:** the exit criteria are written now: at least 50 dispatched
tasks in `report` mode, rung-1 acceptance and would-block rates recorded per task in
the verdict; option (c) is reconsidered in the same promotion decision if drift
concentrates by size. **Counter-argument:** "`report` is the advisory posture the
playbook warns against, and with OQ-4 that is two report periods; the gate does
nothing for months." Rebuttal: the plan file and drift are recorded from the first
task, only the block is deferred, and 50 tasks is about two weeks at the current
drain rate. **Selected over (a) because a defect in a new PreToolUse hook on Write
and Edit is the widest blast radius in the system, over (c) because its field and
its data do not exist yet, and over (d) as Alternative 2 already rejected it.**


### OQ-7: Incident-to-case automation

*Options:* (a) manual `cli-evals mine` only; (b) every `failed` verdict proposes a
case in the dispatch digest; (c) every failed verdict and every `[main-health]`
issue auto-creates a case PR; (d) (b) plus auto-create for incidents with a decision
record.
*Recommendation:* (b). Counter-argument: proposals that nobody acts on are the same
as (a).

**Resolution (2026-11-01, full rubric): proposals in the decisions operator digest
with the exact `cli-evals mine` command; the planner fills `expect` and files the
case; nothing auto-creates.** Industry research: Google's postmortems and
PagerDuty's incident process make "add a regression test" an owned action item, not
an automatic artifact; Sentry and Datadog turn an alert into a draft issue a person
confirms; promptfoo's add-failing-output-to-dataset is a one-click proposal.
**Substrate surfaced (two corrections to v0.1):** there is no dispatch digest; the
only digest is `cli-decisions operator-digest`
(`pipeline-cli/src/decisions/operator-digest.ts`), which already renders "PRs needing
a human" from `hierarchy/human-attention.ts`; and `main-health-monitor.yml` opens no
`[main-health]` issue since AISDLC-929, the tick routes a red sha to the planner
once. `dispatch/resume.ts` already reads `failed/<id>.verdict.json` with its resume
note, so the data source exists. **Refinement over v0.1:** the proposal section is
"Proposed eval cases" in the operator digest; sources are `failed` and
`iteration-exhausted` verdicts and red main shas; `mine` gains `--sha`.
**Counter-argument:** "proposals nobody acts on are the same as (a), and the digest
is already long." Rebuttal: the digest is read every planner session by design and
the row carries the command, so acting is one paste; if the report period shows
proposals ignored, (d)'s auto-create is the next rung and the OQ-4 promotion
decision is where it is added. **Selected over (a) because failures would stay
invisible, and over (c) because the one-bug, fourteen-failures pattern is live
evidence of the pollution it would cause.**


### OQ-8: Developer-plan interaction with the staged review (RFC-0052)

*Options:* (a) reviewers read the plan as context and flag plan-diff drift as a
finding; (b) reviewers never see the plan (independence); (c) the plan is one
risk-map input for the review planner only.
*Recommendation:* (a) for drift, (c) for ranking. Counter-argument: a reviewer that
reads the plan may anchor on it and miss what the plan missed.

**Resolution (2026-11-01, full rubric): reviewers receive the plan as a labelled
"Developer plan" section after the acceptance criteria, with drift computed by code
and handed to them as a fact; the staged review planner gets `## Files` and
`## Risks` as one risk-map input when it runs.** Industry research: Gerrit,
Phabricator and GitHub all show the author's description to reviewers, and the
independence they protect is "a different identity decides", not blindness to
intent; Bacchelli and Bird (Microsoft, "Expectations, outcomes, and challenges of
modern code review") find understanding the rationale is the top reviewer need;
LLM-as-judge studies show framing and position bias, which argues for a separate
labelled section rather than an opening frame. **Substrate surfaced:** the live
review path is the three-reviewer set in Step 7 (task, ACs, changed files, policy,
diff; no developer output); the staged review and its planner are advisory under
DEC-0149, so option (c) alone would use the plan nowhere in production; DEC-0012 and
DEC-0013 independence rules concern reviewer identity and transcript binding, not
withheld intent. **Refinement over v0.1:** drift (missing, extra, ratio) is computed
at Step 7 from the diff and `## Files` and recorded at Step 8; the reviewer rule is
"an unplanned file is a major finding unless justified; an `## Out of scope` entry
contradicting an AC is a finding". **Counter-argument:** "a reviewer that reads the
plan anchors on it and misses what the plan missed; `## Out of scope` becomes an
excuse the reviewer accepts." Rebuttal: the ACs stay the reviewer's contract and
come first; the plan is additional evidence; the scorecard's `blockingFindings` shows
in the report period whether findings fall once the plan is shown. **Selected over
(b) because drift cannot be a finding without the plan, over (c) because the staged
planner is not on the live path, and over an opening-frame variant because it makes
the plan the spec.**

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
| v0.2 | 2026-11-01 | OQ walkthrough with the operator, full rubric per question, after a substrate survey (no evals, plan or gate code shipped; RFC-0049 judgment layer, RFC-0050 ledger and replay, RFC-0052 staged review advisory under DEC-0149 are). Lifecycle Draft to Ready for Review; sign-off in a follow-up PR, phase tasks filed with `cli-file` after it lands. OQ-1 own `cli-evals` runner on the RFC-0050 replay plumbing, `claude plugin eval` deferred. OQ-2 layered golden (about ten, planner-owned) plus mined by proposal, quarantine after two unexplained consecutive failures, halt at `budgetUsd`. OQ-3 rungs deterministic, judgment when configured, Sonnet reviewer; planner only on a second reject via the board; rung recorded in the sentinel. OQ-4 report-only until 30 nightly runs with golden flake under 2%, then one class (b) decision gates agent-shaping PRs on a golden flip outside its band; aggregate drop stays a comment; `agent-shaping` detect group is net-new. OQ-5 `.ai-sdlc/plans/<task-id>.md` committed, three patch-id exclusion lists plus lockstep test, Step 11 PR-body summary. OQ-6 `spec.build.planGate` report then enforce by decision after 50 tasks with rung-1 and would-block rates recorded; scope task worktrees only. OQ-7 proposals in the operator digest (not a dispatch digest, which does not exist) from failed and iteration-exhausted verdicts and red main shas (no `[main-health]` issue since AISDLC-929); `mine --sha`. OQ-8 labelled plan section after the ACs, drift computed at Step 7 and recorded at Step 8, unplanned file a major finding unless justified; staged planner gets Files and Risks as a risk-map input. |

## References

- Anthropic, "The AI-native SDLC playbook" (claude.com/resources/articles/the-ai-native-sdlc-playbook): Stage 3 "Plan mode as default", Stage 4 "Continuous evals in CI".
- RFC-0049 System One Judgment Layer (graders, acceptance rung 2).
- RFC-0050 Usage Ledger (cost attribution, scorecard, reviewer replay).
- RFC-0052 Staged Review Pipeline (model grader, drift as a finding).
- RFC-0053 Just-In-Time Context Engine, OQ-5 (layered corpus with a golden gate).
- DEC-0090 five-step order; DEC-0048 velocity impact section.
- `ai-sdlc-plugin/agents/developer.md`, `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`, `pipeline-cli/src/usage/scorecard.ts`, `scripts/first-run-smoke.mjs`.
