---
id: RFC-0052
title: Staged Review Pipeline (deterministic, structural, judgment, plan, execute, synthesize)
status: Approved
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-10-01
updated: 2026-10-01
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0012, RFC-0042, RFC-0043, RFC-0046, RFC-0049, RFC-0050]
requiresDocs:
  - operator-runbook
deferredDocs: true
deferredDocsDeadline: '2026-12-15'
---

# RFC-0052: Staged Review Pipeline

**Status:** Signed Off (2026-10-01, Engineering + Operator) — **all 3 Open Questions
resolved via operator rubric walkthrough.** Resolutions: **(OQ-1)** the v1 staged pipeline carries all three
remits (Fable plans, Sonnet executes, Fable synthesizes) and the standalone Opus
`security-reviewer` runs beside it as a per-PR head-to-head; whichever side finds what
the other missed triggers a re-evaluation, and the record picks the winner; **(OQ-2)**
during the comparison the three-reviewer set keeps gating and the staged pipeline runs
as shadow on every trusted PR; once 50 compared PRs show 95 percent act-band precision
the staged verdict and the Opus security verdict become the gates and the code and
test reviewers retire; **(OQ-3)** one transcript leaf per model-running stage with an
additive `stage` field. Phase tasks AISDLC-672 to AISDLC-679.

## Summary

Replaces the three parallel reviewer agents with one review pipeline that assigns each
kind of work to the cheapest thing that can do it. Code does what code can decide
(diff facts, changed symbols, callers, coverage of changed lines). The judgment layer
(RFC-0049) classifies what the diff touches and how risky each hunk is. The strongest
available model then writes a short review plan from that risk map and the task's
acceptance criteria. Cheaper models execute the plan's probes in parallel (read, trace,
run, compare) and return evidence. The strong model reads the evidence and writes the
verdict. The existing verdict envelope, aggregation, attestation and iteration loop are
unchanged; the pipeline is a third reviewer set, `staged`, beside `three` and
`code-test-merged`, selectable per repository and promotable only on replay evidence.

## Motivation

### What the three-reviewer design costs and what it finds

Three reviewers each load the diff and the files it touches, and each applies one
remit. From the transcript data gathered for RFC-0050 (2026-06-12 to 2026-09-30):

| Reviewer | Calls | Cache write | Cache read |
| --- | ---: | ---: | ---: |
| `ai-sdlc:code-reviewer` | 2,312 | 10.5M | 175M |
| `ai-sdlc:test-reviewer` | 1,981 | 8.2M | 153M |
| `ai-sdlc:security-reviewer` (Opus) | 1,033 | 11.5M | 75M |

Nearly all of that is reading, not judging. The Opus security reviewer, the one role
where the strongest model is deliberately paid for, spends most of its tokens on file
reads any model could do and reaches its judgment in a few turns at the end. Since
AISDLC-483, code and test review default to the Codex variants (Codex plan billing),
so the Claude-token cost of review today is mostly the security reviewer plus the
wrapper calls; the reading is still done three times.

The AISDLC-616 reviews ledger holds 30 review cycles. No reviewer blocked on any of
them. Finding overlap between reviewers is low (code/test 16%, code/security 21%,
test/security 14%), so the three are not redundant; they each produce different
non-blocking findings and approve. Thirty cycles with zero blocks cannot show that
three reviewers catch more than one, because none caught a defect at all. In the same
period, the two review-stage errors that mattered (the `cli-merge-if-eligible` arming
bypass in AISDLC-663.5 and the false `dor.stage-b` premise in AISDLC-636) were found by
executors reading consumer code, not by the fan-out.

### The allocation is inverted

The strongest model is best at two things in a review: deciding where to look, and
deciding what the evidence means. It is no better than a cheaper model at reading a
file, following a call chain or running a test, and it is far more expensive per token
of context. The three-reviewer design gives the strongest model all of the reading and
the cheapest models none of the judgment.

The framework already states the right order for evaluation: deterministic first,
structural second, judgment third, generative last (RFC-0029 Principle 2, extended by
RFC-0049). Review is the one evaluation that still starts at the generative rung.

### What already exists

- The verdict envelope, Step 8 aggregation and the Step 9 iteration loop
  (`pipeline-cli/src/steps/08-aggregate-verdicts.ts`, `09-iterate.ts`).
- Reviewer-set selection from the base branch (`pipeline-cli/src/steps/reviewer-set.ts`,
  AISDLC-617), with `three` and `code-test-merged`.
- The incremental review gate (AISDLC-142): unchanged content skips review, small
  deltas review the delta only.
- Transcript leaves per reviewer, Merkle attestation and independence tiers
  (RFC-0042, RFC-0046; `pipeline-cli/src/attestation/`).
- The AST gate for untrusted PRs (`pipeline-cli/src/pipeline/ast-gate.ts`, RFC-0043),
  the dependency graph (`cli-deps`), patch coverage.
- Judgments from RFC-0049: `review.routing`, `review.finding-grounding`,
  `dev.ac-coverage`, `triage.injection-screen`, `complexity.factors`.
- The reviewer replay harness (RFC-0050, AISDLC-655) and the reviews ledger
  (AISDLC-616), which together can score a reviewer configuration against known
  outcomes without touching a live PR.

## Goals

1. One review that reads the diff and its context once.
2. The strongest model used only for planning and synthesis, on bounded inputs.
3. Mandatory probes that no plan can remove, so a plan-driven review cannot look
   away from something.
4. Every finding grounded in evidence a probe produced, with the probe cited.
5. The same verdict envelope, aggregation, attestation and iteration loop as today.
6. Adoption decided by replay evidence against the known-defect corpus, under the
   relax-class bar, never by assertion.

## Non-Goals

- Changing what a verdict looks like, how verdicts aggregate, or how iteration works.
- Changing the untrusted-PR path (RFC-0043). In v1 the staged pipeline runs only on
  trusted `sourceKind` work; untrusted PRs keep the existing sets.
- Removing the three-reviewer set. It remains available and remains the default until
  the staged set is promoted.
- Replacing the incremental gate. The pipeline runs on whatever diff the gate hands it.
- A new attestation scheme. Stages produce leaves in the existing format.

## Proposal

### 1. Stages

```
diff ─► 0 deterministic ─► 1 structural ─► 2 judgment ─► 3 plan ─► 4 execute ─► 5 synthesize ─► verdict
         (code)             (code)         (RFC-0049)    (strong)   (cheap, parallel)   (strong)
```

**Stage 0, deterministic (code, no model).** Diff statistics; file classes by path
(source, test, config, workflow, docs, lockfile, migration); whether each changed
source file has a changed test; secret-pattern scan; dependency-manifest and
workflow changes; the task's acceptance criteria; results the developer already
produced (build, test, lint, format, patch coverage).

**Stage 1, structural (code, no model).** Changed symbols per file; callers and
callees of changed symbols from the dependency graph; test files that exercise changed
symbols; patch-coverage lines; for a diff that touches schemas, the consumers of the
schema. Output: a per-hunk record with these facts attached.

**Stage 2, judgment (RFC-0049, one request per diff where the state budget allows).**
Per hunk: Nouls for authentication or authorization, state or persistence,
concurrency, input handling, error handling, behaviour change without a test change;
a Score for change risk. Across the diff: `dev.ac-coverage` per acceptance criterion,
`triage.injection-screen` over the diff text, `review.routing`. Output: the **risk
map**, a ranked list of hunks with their facts and probabilities. Everything the
judgment layer abstains on is marked `unjudged` and treated as high risk.

**Stage 3, plan (strongest model, bounded input).** Input: the risk map, the diff
summary (file list, hunk headers, the top-ranked hunks in full up to a token budget),
the acceptance criteria, and the **baseline checklist**. Output: a review plan, JSON
validated against `review-plan.v1.schema.json`: an ordered list of probes, each with
an id, a type (`read`, `trace`, `run`, `compare`, `search`), a target (files, symbols,
a command from an allowlist, or a question), the question the probe answers, and the
hunks it covers. The planner may add probes and reorder. It cannot remove a baseline
probe, and a plan whose coverage leaves a hunk ranked above the risk threshold
unprobed is rejected and re-requested once, then falls back to probing every such
hunk with the baseline `read` probe.

**Stage 4, execute (cheaper model, parallel, read-only).** Each probe runs as a
subagent with the tools its type needs: `read` and `search` get read-only file access;
`trace` gets the dependency graph; `run` may execute only commands from the repo's
allowlist (the test runner, lint, typecheck, a script named in the plan from a fixed
set); `compare` gets two revisions. A probe returns evidence: observations, excerpts
with file and line, commands run with their exit status and relevant output, and the
probe's own answer to its question with a confidence word. Evidence is size-bounded
per probe and in total. Executors cannot edit, push, or call a model of their own
choosing. The default executor model is Sonnet; where the Codex harness is available
and the task is trusted, executors may run there, which costs no Claude tokens.

**Stage 5, synthesize (strongest model, bounded input).** Input: the risk map, the
plan, the evidence bundle, the acceptance criteria, and the three remits (code, tests,
security) stated in full. Output: the existing verdict envelope (`approved`,
`findings[]` with severity, file, line and message, `summary`,
`promptInjectionDetected`), with one addition inside each finding: `evidence`, the
probe ids and excerpts it rests on. A finding with no evidence reference is dropped
before aggregation and logged. `review.finding-grounding` runs on the result as it
does today.

**Stage 6, verdict.** Step 8 aggregates as today. The staged set produces one verdict
where the three-reviewer set produced three; aggregation already handles a set of one
(AISDLC-617 produces two).

### 2. The baseline checklist

A fixed list the plan always contains, versioned with the pipeline:

- For every changed source file: read the hunks in context and the file's changed
  tests, or record that no test changed.
- For every hunk ranked above the risk threshold: a `read` probe on the hunk and a
  `trace` probe on its callers.
- Security, regardless of ranking: any hunk Stage 2 marked for authentication,
  authorization, input handling, secrets, shell or path handling, dependency
  manifests or workflows gets the security probe set (the checks the
  `security-reviewer` agent lists today, as probes).
- Tests: a `run` probe for the test runner over the changed test files, and a
  `compare` probe between the acceptance criteria and the test names and assertions.
- Acceptance criteria: one `compare` probe per criterion the `dev.ac-coverage`
  judgment marked likely uncovered.
- Scope: a `search` probe for files changed outside the task's declared references.

The checklist is the answer to coverage bias: the plan decides what to look at
*beyond* this, never instead of it.

### 3. Trust boundaries

- The diff is untrusted text (RFC-0043). `triage.injection-screen` runs over it in
  Stage 2; a positive result sets `promptInjectionDetected` on the verdict and the
  planner is told which hunks were flagged. The planner's and synthesizer's prompts
  restate the output contract after the diff, as the reviewer agents do today.
- The baseline checklist and the security probe set are code, not prompt text. A
  steered planner cannot remove them.
- Executors are read-only and tool-restricted. The command allowlist is read from the
  base branch.
- In v1 the staged set is eligible only for trusted `sourceKind` work. The RFC-0043
  path for external PRs is unchanged.

### 4. Models and cost

| Stage | Model | Input size | Why |
| --- | --- | --- | --- |
| 3 plan | `fable` (OQ-1); `opus` where Fable is unavailable | risk map + summary, capped | Deciding where to look is the judgment worth paying for |
| 4 execute | `sonnet`, or Codex plan where available | one probe's targets | Reading and running is not model-sensitive |
| 5 synthesize | same as plan | evidence bundle, capped | Deciding what evidence means is the other judgment worth paying for |

The models are routing cells (`review-planner`, `review-executor`,
`review-synthesizer`) in RFC-0050's table, so they are measured and routed like any
other role. The cost hypothesis, to be measured: the diff and files are read once by
cheap executors instead of three times by reviewers, and the strongest model sees a
few thousand tokens twice instead of the whole context once. Whether the staged set
finds more is the quality hypothesis; section 6 says how both are tested.

### 5. Attestation (OQ-3)

Each stage that runs a model produces a transcript and a leaf in the existing format:
one for the planner, one per executor probe, one for the synthesizer. Leaves gain an
additive `stage` field (`plan`, `execute`, `synthesize`) and the executor leaves carry
zero findings and `verdictApproved: false` by construction; only the synthesizer leaf
carries the verdict. Independence tiers are computed per leaf as today, and the set's
tier is the weakest leaf, as RFC-0046 specifies. `reviewerName` for the set is
`staged-review`; the reviews ledger gains the matching role so AISDLC-616 analysis
treats a staged verdict like any other.

### 6. Adoption: head-to-head in shadow, then the relax bar (OQ-1, OQ-2)

Retiring the code and test reviewers is a relax-class change under RFC-0049 and
RFC-0050: it promotes only on the corpus path (at least 50 compared items, act-band
precision at least 95 percent), with no override path. The comparison the operator
asked for produces those items on live work.

1. **Shadow head-to-head.** On every trusted PR the three-reviewer set runs and gates
   exactly as today. The staged pipeline also runs, with all three remits, and its
   verdict is logged beside the three verdicts and compared per case: findings only
   the staged set raised, findings only a standalone reviewer raised, and agreement.
   The security comparison is reported on its own: staged findings against the Opus
   `security-reviewer`'s on the same PR. A case where either side finds a blocking
   issue the other missed is flagged for the operator's re-evaluation.
2. **Replay** (`cli-usage replay --set staged`, AISDLC-655 extended to reviewer sets)
   runs the same comparison over the known-defect and clean corpus built from the
   reviews ledger, so the record is not limited to PRs that happen to arrive.
3. **Switch.** When 50 compared PRs show the bar, the staged verdict and the Opus
   security verdict become the gates, and the code and test reviewers retire; the
   repository records `reviewerSet: staged` on its base branch citing the evidence
   file, through the proposal and approval route RFC-0050 defines.
4. **Security merge.** The standalone security reviewer retires only when the
   security comparison shows the staged pipeline's security recall at least equal on
   the same items; that is a second switch with its own evidence, and the operator
   chooses the winner.

## Design Details

### Schema Changes

- New: `spec/schemas/review-plan.v1.schema.json` (plan), `review-evidence.v1.schema.json`
  (probe evidence), `review-risk-map.v1.schema.json`.
- `reviewer-set` accepts `staged`; `.ai-sdlc/review-config.yaml` gains
  `staged.executorCommandAllowlist`, `staged.riskThreshold`, `staged.maxProbes`,
  `staged.evidenceBudgetTokens`.
- Transcript leaf: additive `stage`; verdict finding: additive `evidence`.
- Reviews ledger: role `staged`.

### Behavioral Changes

None unless a repository selects `reviewerSet: staged` or a shadow share. The
three-reviewer set remains the default.

### Migration Path

Additive. The first live use follows the operator task in the implementation plan.

## Backward Compatibility

Not a breaking change. Existing envelopes, leaves and ledgers validate unchanged; the
new fields are optional.

## Alternatives Considered

### Alternative 1: Keep three reviewers, route each to a cheaper model

Saves tokens, keeps triple reading, and keeps the strongest model out of the two
places it earns its cost. It is what RFC-0050's routing can already do and is not
exclusive with this RFC.

### Alternative 2: One reviewer with all three remits (AISDLC-617, extended to security)

Reads once, but one model does reading, judging and writing in one context, so the
strongest model is still paying for the reading, and nothing prevents it from skipping
a remit. The baseline checklist and the plan/evidence split exist to close that.

### Alternative 3: Strong model plans and executes, no cheap stage

Removes the coordination overhead but puts the reading back on the expensive model.
The split is the point.

### Alternative 4: Judgment layer only, no generative review

Jev cannot write a finding or follow a call chain. Stages 0 to 2 narrow the search;
they cannot finish it.

### Alternative 5: Ship it as the default on the strength of the argument

Rejected by the project's own rules. A review change that costs less is a relax-class
change and promotes on evidence, and the replay harness exists to produce that
evidence without risking a live PR.

## Implementation Plan

Eight phase tasks. AISDLC-672 and 673 have no dependencies within this RFC.

- **AISDLC-672 — risk map.** Stages 0 to 2: deterministic facts, structural facts, the
  judgment request, the `review-risk-map` schema. Depends on the RFC-0049 judgments it
  uses (637, 638, 639 shipped or in flight).
- **AISDLC-673 — plan schema and baseline checklist.** `review-plan` schema, the
  checklist as code, plan validation and coverage rejection, the command allowlist.
- **AISDLC-674 — planner and synthesizer agents.** Prompts, bounded inputs, output
  contracts, the `evidence` field on findings, grounding drop rule. Depends on 672,
  673.
- **AISDLC-675 — executor probes.** Read-only tool-restricted probe subagents per
  type, evidence schema and budgets, parallel fan-out, Codex-harness option.
  Depends on 673.
- **AISDLC-676 — `reviewerSet: staged` wiring.** Reviewer-set resolution, Step 7
  integration, Step 8 as a set of one, transcript leaves with `stage`, ledger role.
  Depends on 674, 675.
- **AISDLC-677 — head-to-head shadow and replay.** The staged pipeline as shadow on
  every trusted PR beside the gating set, the per-case comparison record with the
  security comparison on its own, flagged cases for re-evaluation, and
  `cli-usage replay --set`. Depends on 676 and RFC-0050's AISDLC-655.
- **AISDLC-678 — docs.** Operator runbook for the staged set, its config and the
  promotion route. Depends on 676.
- **AISDLC-679 — comparison window and switch decision.** Operator-only,
  non-dispatchable: run the head-to-head over at least 50 trusted PRs, review the
  flagged cases, run the replay, and decide the two switches (code and test
  reviewers; security). Depends on 677.

## Open Questions

**OQ-1 — Does security review join the pipeline in v1, or stay a separate stage?**
The staged pipeline carries the security probe set in its baseline checklist and the
security remit in synthesis. AISDLC-617 kept the security reviewer separate on
purpose, and the diff is untrusted.

**Resolution (2026-10-01, operator variant of the rubric): both.** The v1 staged
pipeline carries all three remits, with Fable planning, Sonnet executing and Fable
synthesizing, and the standalone Opus `security-reviewer` keeps running beside it as a
per-PR head-to-head. When either side finds a blocking issue the other missed, the
case is flagged and the operator re-evaluates; the accumulated record chooses the
winner. Industry research: the AISDLC-616 ledger holds 30 cycles with no blocks from
any reviewer, so there is no measurement of what the standalone security reviewer
catches; the staged pipeline's security probes are code and cannot be dropped by a
steered planner, while its synthesis remit is prompt text. **Refinement over the
author's hybrid (code and tests staged, security standalone):** running the full
staged pipeline from day one is what makes the security comparison possible; a
code-and-tests-only pipeline would have produced no security data to compare.
**Counter-argument:** "Two security reviews per PR is the most expensive possible
v1." Rebuttal: the comparison is the product; the cost is bounded by the switch
described in OQ-2 and ends when a winner is chosen. **Selected over the author's hybrid** because
it yields the evidence sooner, **and over folding security in without a comparison**
because it keeps the known-good check in force throughout.

**OQ-2 — In v1, what gates the merge while the two run side by side?** Union gating
from day one, the existing set gating with the staged pipeline in shadow, or the
staged set gating alone?

**Resolution (2026-10-01, full rubric): the three-reviewer set keeps gating; the
staged pipeline runs on every trusted PR as shadow and is compared per case; once
50 compared PRs show 95 percent act-band precision, the staged verdict and the Opus
security verdict become the gates and the code and test reviewers retire.** Industry
research: under the AISDLC-630.1 definition, retiring a reviewer is reduced review and
therefore relax-class under RFC-0049 OQ-4, promotable only on the corpus path; the
head-to-head produces exactly those compared items; the code and test reviewers run
on Codex plan, so keeping them during the comparison costs no Claude tokens; union
gating is tighten-class and needs no bar. **Counter-argument:** "This delays the
saving by 50 PRs for a pipeline already judged better." Rebuttal: "judged better" is
what the ledger was built to replace with a measurement, and at the current merge
rate 50 PRs is days. **Selected over union gating from day one** because it spends
trust before evidence exists, **and over staged-alone** because it contradicts OQ-1.

**OQ-3 — Attestation granularity.** One leaf per model-running stage, one leaf per
review, or two?

**Resolution (2026-10-01, full rubric): one leaf per model-running stage (planner,
each executor probe, synthesizer) with an additive `stage` field.** Industry research:
RFC-0046 computes the independence tier per leaf and takes the set's tier as the
weakest leaf; executor probes may run on a different harness (Codex) from the planner
and synthesizer, and that is visible only with a leaf each; the Merkle tree already
handles many leaves and the verifier reads leaves, not transcripts. **Refinement:**
the reviews ledger gains one role, `staged`, whose analysis treats the synthesizer
leaf as the verdict and the other leaves as evidence of execution, so per-role counts
are unchanged. **Counter-argument:** "A dozen leaves per PR is ledger noise."
Rebuttal: counts stay per role; the leaves are what make the weakest-leaf rule true.
**Selected over one leaf per review** because a single tier would hide an unattested
probe, **and over two leaves** because a probe bundle still blends harnesses.

## References

- `pipeline-cli/src/steps/{07-build-review-prompts,08-aggregate-verdicts,09-iterate,reviewer-set}.ts`;
  `ai-sdlc-plugin/commands/execute.md` (Step 7a to 7c);
  `ai-sdlc-plugin/agents/{code,test,security,correctness}-reviewer.md`;
  `pipeline-cli/src/attestation/{merkle,reviews-ledger,reviews-analysis,verdict-class}.ts`;
  `pipeline-cli/src/pipeline/ast-gate.ts`; `pipeline-cli/src/cli/reviews.ts`.
- Reviews ledger analysis, 2026-10-01: 30 cycles, 0 blocks, overlap 14 to 21 percent.
- [[RFC-0012]] (Step 0-13 pipeline); [[RFC-0042]], [[RFC-0046]] (leaves, independence);
  [[RFC-0043]] (untrusted diffs, AST gate); [[RFC-0049]] (ladder, judgments, relax
  bar); [[RFC-0050]] (replay harness, routing cells, reviews ledger).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ✅ Signed (reads once, strongest model only at plan and synthesis, baseline checklist no plan can remove, evidence-cited findings, per-stage leaves; 2026-10-01) |
| Operator | Dominique Legault | ✅ Signed (full-remit pipeline beside the Opus security reviewer as a head-to-head; nothing retires before 50 compared PRs at 95 percent; 2026-10-01) |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-10-01 | Initial version, born `Signed Off` (Engineering + Operator). Evidence: RFC-0050 transcript data (review is mostly reading, done three times) and the AISDLC-616 ledger (30 cycles, 0 blocks, low overlap). Six stages, baseline checklist, trust boundaries, head-to-head shadow adoption under the relax bar. 3 Open Questions resolved via operator rubric walkthrough (OQ-1 as the operator's variant: full-remit staged pipeline beside the standalone Opus security reviewer). Phase tasks AISDLC-672 to AISDLC-679. Trigger: operator proposal, 2026-10-01. |
