---
id: RFC-0026
title: Exploration Workstream Pattern
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-03
updated: 2026-05-03
targetSpecVersion: v1alpha1
requires: [RFC-0011, RFC-0015, RFC-0024]
requiresDocs: []
---

# RFC-0026: Exploration Workstream Pattern

**Status:** Draft (initial seed; structure may shift)
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io
**Created:** 2026-05-03
**Target Spec Version:** v1alpha1
**Depends on:** RFC-0011 (DoR gate), RFC-0015 (autonomous orchestrator), RFC-0024 (emergent capture)
**Anchor:** [VISION.md §5](../../VISION.md) — exploration-mode gap

> The bold-status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

## 1. Summary

The Decision Engine ([VISION.md §1](../../VISION.md)) frontloads decisions through the DoR gate so the autonomous orchestrator can execute deterministically. This works beautifully when the operator already knows what needs to be built — every "open question" can be resolved upfront because the unknowns are bounded.

But the framework's organizing thesis breaks for **exploration workstreams**: spikes, research investigations, prototype-driven prior-art surveys, "what would it take to add X?" feasibility studies. In these workstreams, **the goal is to discover what we don't know** — the unknowns aren't bounded, and asking the operator to "list all open questions upfront" produces either fake answers (operator guesses) or paralysis (operator can't list questions about unknowns they haven't surfaced yet).

Today, exploration work either gets **shoehorned into the execution flow** (operator writes a fake DoR-passing issue, framework runs the orchestrator, output is "this didn't actually answer the research question") OR **bypasses the framework entirely** (operator does the spike in a side branch, never captures findings, learnings rot).

This RFC defines a first-class **exploration workstream type** with its own lifecycle, DoR exemptions, time-boxing rules, and a clean **crystallization handoff** back to standard execution when the unknowns become knowns. Captures from exploration (per RFC-0024) are first-class — the entire point of an exploration is to convert unknowns into capturable findings.

## 2. Motivation

### 2.1 The DoR gate is the right gate for execution, the wrong gate for exploration

The DoR gate (RFC-0011) enforces: "every open question is resolved, every AC is testable, every dependency is declared." That's exactly right when the operator knows what the work is. It's exactly wrong when the operator is trying to figure out what the work IS.

Concrete examples of exploration that fails the standard DoR gate today:

- **"How long would it take us to support PostgreSQL streaming replication?"** — operator can't list ACs because the answer determines the scope
- **"What's the right embedding model for our use case?"** — operator can't write tests because the evaluation rubric is itself part of the discovery
- **"Can we use OpenShell sandbox isolation for the orchestrator?"** — operator can't declare dependencies because the integration surface is unknown
- **"What's an industry-leading dependency-graph layout algorithm?"** — operator can't pre-decide which algorithm to implement before reviewing options

In each case, forcing DoR compliance produces dishonest issues that pass the gate but don't really execute against well-framed contracts.

### 2.2 Exploration outputs have different shapes than execution outputs

Execution work produces code, tests, docs — concrete artifacts that ship. Exploration work produces:

- **Findings** — "after evaluating X, Y, Z, we recommend X because [reasons]"
- **Prototypes** — throw-away code that demonstrates feasibility but isn't production-ready
- **Architecture Decision Records (ADRs)** — explicit "we chose X for these reasons" decisions
- **New open questions** — exploration often surfaces deeper unknowns that need their own exploration
- **Crystallized issues** — concrete tasks that CAN now pass DoR, derived from the exploration's findings

Today, the framework has no first-class home for these outputs. Findings get scattered across PR descriptions; prototypes get committed to main and become tech debt; ADRs get written informally and lost; new open questions surface in conversation and evaporate.

### 2.3 Exploration is unbounded by default — that's a budget problem

Without explicit time-boxing, exploration work absorbs unbounded operator + AI time. The cost-asymmetry argument (VISION.md §2) flips: in exploration, the operator's time IS the limiting resource, and the AI's contribution is "explore the option space faster than the operator could alone."

Exploration must therefore have:

- **Explicit time budget** — operator commits "I'll invest N hours / N days into this"
- **Explicit budget escalation** — when the budget runs out, the exploration either crystallizes (we learned enough), pauses (we need more time), or terminates (we learned this isn't worth pursuing)
- **No silent over-spend** — the framework refuses to keep exploring past the budget without operator re-confirmation

### 2.4 Exploration captures should feed the Decision Engine

The output of a healthy exploration is a set of **decisions the operator now feels qualified to make**. Those decisions should flow directly into the standard execution path: the exploration's findings become the open-question answers for the next round of execution issues.

Today, this handoff is manual and lossy. The operator finishes a spike, then has to manually translate findings into new issues, often weeks later when context has decayed. The pattern needs a clean **crystallization handoff** — exploration outputs auto-populate the next round of execution issues' DoR refinement.

## 3. Goals

1. **First-class exploration workstream type** — alongside execution, with its own lifecycle states
2. **DoR exemptions tailored to exploration** — bypass open-questions-resolved-upfront, keep type-of-work + ownership + budget
3. **Explicit time-boxing** — every exploration has a budget; over-spend requires operator re-confirmation
4. **Output artifact contract** — findings, prototypes, ADRs, new open questions all have schemas
5. **Crystallization handoff** — exploration findings flow into execution-issue DoR refinement
6. **Capture integration** — RFC-0024 captures from exploration are first-class signals (the whole point)
7. **No leak into production** — exploration prototypes are clearly marked, never executed by the orchestrator as production work
8. **Adopter-safe defaults** — exploration time budgets default to small (e.g., 1 day) so operators don't accidentally commit to large investments

## 4. Non-goals

1. **Not a research-paper publishing platform** — exploration findings are operator-internal, not public output
2. **Not a multi-week research project manager** — explorations are bounded; multi-month research is its own thing
3. **Not a prototype incubator** — prototypes that prove worth go into a NEW execution issue (post-crystallization), not "graduate" the exploration directly to production
4. **Not a replacement for code-as-spec exploration** — adopters can still spike in side branches outside the framework if they prefer; this RFC adds an option, not a mandate
5. **Not a way to bypass the Decision Engine** — exploration FEEDS the Decision Engine; it doesn't bypass it

## 5. Workstream type taxonomy

The framework recognizes three workstream types:

### 5.1 `execution` (default; today's flow)

The operator knows what needs to be built. DoR gate applies fully. Orchestrator dispatches. Standard pipeline.

### 5.2 `exploration` (new in this RFC)

The operator is trying to discover what needs to be built (or whether to build it at all). DoR gate exempts the open-questions-resolved-upfront check; other DoR rules apply. Time-boxed. Outputs are findings + ADRs + new open questions + (optionally) crystallized execution issues.

### 5.3 `iteration` (also new; lighter-weight exploration)

A shipped feature is in production; the operator has data showing it doesn't quite work; they need to refine. Sits between execution and exploration: the contract is partially known (the existing feature), but the open questions are emergent (what to change). Iteration uses the standard DoR with a `parentExecution: <task-id>` field; the parent provides context the new ACs don't have to re-derive.

The taxonomy is fixed enum at the framework level — adding new workstream types requires an RFC update.

## 6. Exploration workstream lifecycle

An exploration task moves through these statuses (separate from the standard `Draft → To Do → In Progress → Done`):

```
[Drafting] → [Approved] → [Exploring] → [Crystallizing] → [Done]
                              ↓
                        [BudgetExceeded]
                              ↓
                  [Reapproved | Paused | Terminated]
```

| Status | Meaning |
|---|---|
| `Drafting` | Operator is writing the exploration brief (the "what we're trying to learn" + budget) |
| `Approved` | Brief is complete; operator has approved the budget; ready to start |
| `Exploring` | Active work; operator + AI agents collaborating; outputs accumulating |
| `BudgetExceeded` | Time budget consumed; framework refuses to do more work without operator re-confirmation |
| `Reapproved` | Operator extended the budget; back to Exploring |
| `Paused` | Operator deferred re-confirmation; exploration is on hold (no auto-progression) |
| `Terminated` | Operator decided not to extend; exploration ends with whatever findings exist |
| `Crystallizing` | Findings are stable; operator is converting them into execution issues |
| `Done` | Crystallization complete; exploration is closed |

The `Crystallizing` status is the on-ramp to standard execution — outputs feed the next round of execution issues' DoR refinement (§9).

## 7. Exploration brief schema

Every exploration starts with a brief — a structured artifact that replaces the standard issue body. Schema in `spec/schemas/exploration-brief.v1.schema.json`:

```jsonc
{
  "id": "AISDLC-NNN",
  "workstreamType": "exploration",
  "question": "Can we use OpenShell sandbox isolation for the orchestrator?",
  "context": "We've been hitting issues with worktree isolation under concurrent runs. OpenShell offers sandbox-per-process. Need to assess feasibility + cost.",
  "budget": {
    "durationDays": 3,
    "maxAgentTokens": 500000,
    "operatorTimeHours": 8
  },
  "successCriteria": [
    "Concrete recommendation (yes/no/conditional) with reasoning",
    "Identified trade-offs vs current worktree-only approach",
    "If yes: rough integration plan (not implementation)"
  ],
  "outOfScope": [
    "Production implementation",
    "Performance benchmarking against current orchestrator at scale"
  ],
  "owner": "dominique@reliablegenius.io",
  "stakeholders": ["alex@reliablegenius.io"],
  "createdAt": "2026-05-03T18:00:00Z",
  "approvedAt": null,
  "explorationStartedAt": null
}
```

The brief is **decisive about what's NOT being decided**: `outOfScope` is required and acts as the explicit boundary. Without it, exploration creep is the default failure mode.

## 8. DoR exemption rules

The DoR gate (RFC-0011) is modified for `workstreamType: exploration` tasks:

| DoR rule | Standard execution | Exploration exemption |
|---|---|---|
| Title clarity | Required | Required |
| Description present | Required | Required (becomes brief.context) |
| Acceptance criteria ≥ 1 | Required | Replaced by `successCriteria` (rougher format) |
| Open questions resolved | Required | **EXEMPT** — discovering questions IS the work |
| Dependencies declared | Required | Required (exploration may have prerequisites — e.g., "API access to X") |
| Type-of-work classified | Required | Required (auto-set to "exploration") |
| Owner identified | Required | Required (the exploration owner is non-delegable) |
| Cost estimate | Required | Replaced by `budget` (richer format) |
| Stakeholders signed off | Required | Required (someone besides the owner approved the budget) |

Stage B refinement reviewer (RFC-0011 Phase 2b) uses a different prompt for exploration tasks:

- Doesn't ask "what about edge case X?" (premature)
- Asks "what would invalidate the success criteria?" (frame the failure mode)
- Asks "what's out of scope that an over-eager AI might do anyway?" (catch creep upfront)
- Asks "if you discover this should be a multi-month investment, what's the early signal?"

## 9. Time-boxing + escalation

The orchestrator (RFC-0015) and operator agents track exploration budget consumption:

- **Wall-clock days** — counted from `explorationStartedAt`; framework warns at 80% consumed, blocks new agent dispatches at 100%
- **Agent tokens** — counted across all subagents working on the exploration (tracked via the existing cost-governance ledger)
- **Operator time hours** — operator self-reports via `cli-explore log-time --hours N`; soft gate (warning, not block)

When ANY axis hits 100%:

1. Status auto-flips to `BudgetExceeded`
2. Orchestrator stops dispatching subagents on this task
3. Operator TUI surfaces as a high-urgency Blocker with three actions:
   - **Reapprove** — extend budget (must specify new budget; operator confirms knowingly)
   - **Pause** — set aside; can resume later via Reapprove
   - **Terminate** — close exploration with whatever findings exist; status → Done; surfaces the findings for crystallization

This is the **explicit budget escalation** that prevents silent over-spend.

## 10. Output artifact contract

Every exploration accumulates outputs in `<repo-root>/explorations/<task-id>/`:

```
explorations/aisdlc-180/
├── brief.json                     # the exploration brief (§7)
├── findings.md                    # operator + agent narrative findings
├── adrs/
│   ├── 001-postgres-streaming.md  # architecture decision records
│   └── 002-snapshot-format.md
├── prototypes/                     # throw-away code, clearly marked
│   ├── streaming-poc/
│   └── README.md                   # "PROTOTYPE — NOT FOR PRODUCTION"
├── crystallized-issues.md          # links to execution issues derived from findings
└── audit.jsonl                     # all events: who/what/when (agent dispatches, operator decisions, budget consumption)
```

Schemas:

- `brief.json` — exploration-brief.v1.schema.json (§7)
- `adrs/*.md` — ADR template per [Michael Nygard's pattern](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions.html); operator-friendly markdown
- `audit.jsonl` — append-only event log; same schema as `events.jsonl` but exploration-scoped

Prototype directories are flagged via a `prototype.json` manifest that the framework refuses to auto-include in any production deploy / publish step.

## 11. Crystallization handoff

When the operator (or the framework) decides the exploration has yielded actionable findings, status flips to `Crystallizing`. The operator works through:

1. Open `crystallized-issues.md`
2. For each finding that has converged, draft an **execution issue** (workstreamType: execution) with:
   - Title derived from the finding
   - Description quoting the relevant ADR
   - Open questions pre-filled (the exploration's findings ARE the open-question answers)
   - Dependencies on the exploration task (so the audit trail is preserved)
3. Run the new issue through standard DoR refinement (now genuinely answerable)
4. Mark the exploration `Done` once all crystallized issues are filed

A `cli-explore crystallize <task-id>` command automates step 2 — creates draft execution issues from the findings file with metadata pre-populated. The operator refines, but doesn't start from scratch.

## 12. Captures during exploration are first-class

Per RFC-0024, captures with `triage: tbd` are normally surfaced as decision-pending blockers. During exploration, captures are NOT blockers — they're **the expected output**. The exploration's `audit.jsonl` accumulates captures; the operator triages at the end (during `Crystallizing`), not continuously.

Captures with `triage: new-task` during exploration auto-populate the `crystallized-issues.md` candidate list; the operator promotes (or rejects) during crystallization.

This composes cleanly with RFC-0024 — exploration is just a context where capture-velocity is high and triage is batched.

## 13. Integration

### 13.1 With RFC-0011 (DoR gate)

DoR gate reads `workstreamType` and applies the appropriate rule set (§8). The Stage B refinement reviewer's prompt is exploration-aware.

### 13.2 With RFC-0015 (autonomous orchestrator)

Orchestrator's pre-dispatch filter chain skips exploration tasks UNLESS the operator explicitly opts in via `cli-orchestrator dispatch --task <id> --workstream exploration`. Default-skip is critical — exploration is operator-driven, not autonomous.

When opted-in, orchestrator dispatches subagents in "exploration mode": the developer subagent's prompt includes the exploration brief (not standard ACs), and the success criterion is "produce findings + capture surfaced questions," not "ship code."

### 13.3 With RFC-0024 (emergent capture)

Captures are first-class per §12. The capture's `evidence` field can reference exploration artifact paths.

### 13.4 With RFC-0023 (operator TUI)

A new TUI mode key `x` opens an "Explorations" view: list of active explorations, budget burn-down per axis, recent ADRs, capture velocity, button to crystallize.

### 13.5 With RFC-0025 (framework quality monitoring)

Failures during exploration runs are classified normally. Operators may use exploration to investigate framework bugs — `framework-bug` captures during exploration are particularly valuable signal.

## 14. Implementation phases

| Phase | Scope | Estimated effort |
|---|---|---|
| 1 — Schemas + brief authoring | exploration-brief.v1.schema.json, ADR template, prototype manifest, `cli-explore init <task-id>` | 4 days |
| 2 — DoR exemption rules | DoR gate reads workstreamType; Stage B reviewer exploration-aware prompt | 4 days |
| 3 — Time-boxing + escalation | Budget tracking, status transitions, BudgetExceeded escalation, operator confirmation flow | 1 week |
| 4 — Output artifact directory + audit | explorations/<id>/ scaffolding, audit.jsonl writer, prototype manifest enforcement | 4 days |
| 5 — Crystallization tooling | `cli-explore crystallize`, integration with task_create for derived execution issues | 4 days |
| 6 — TUI + orchestrator integration | TUI explorations view, orchestrator opt-in dispatch path | 1 week |
| 7 — Soak + corpus + promotion | Operator dogfood explorations on real questions, hybrid promotion runbook | 2 weeks soak + 3 days runbook |

Total: ~5–6 weeks wall-clock; sequenced after RFC-0024 (capture pattern is the substrate for findings) and RFC-0011 (DoR gate is the integration point).

## 15. Feature flag

`AI_SDLC_EXPLORATION_WORKSTREAMS=experimental`. When unset, `cli-explore init` exits with a "not enabled" message + pointer to the promotion runbook. Phase 7 promotion drives default-on.

## 16. Open questions

These need operator walkthrough before Lifecycle: Draft → Ready for Review.

**OQ-1 — Default budget:** What's the right default for `budget.durationDays` when not specified? Recommendation: 1 day — small enough to force explicit re-approval for substantial investments, large enough to do meaningful work.

**OQ-2 — Crystallization required to close:** Can an exploration close as `Done` WITHOUT producing crystallized issues (i.e., the answer was "this isn't worth pursuing")? Recommendation: yes, but the brief's `successCriteria` must include a "negative result" criterion at the start so the operator can't retroactively claim "we discovered we shouldn't" without having framed it.

**OQ-3 — Iteration vs Exploration boundary:** When does refining a shipped feature count as iteration (RFC stays in execution-with-parent) vs exploration (genuine unknowns)? Recommendation: iteration when ≥80% of the new ACs are answerable now; exploration when <80%. Soft heuristic; operator decides on edge cases.

**OQ-4 — Multi-operator exploration:** Can two operators jointly own an exploration? Recommendation: v1 = single owner; multi-owner is a follow-up RFC if demand emerges.

**OQ-5 — Exploration of explorations:** Can an exploration spawn child explorations (e.g., "this exploration surfaced a sub-question worth exploring")? Recommendation: yes, with `parentExploration: AISDLC-X` field; parent's budget does NOT auto-extend to children.

**OQ-6 — Prototype-to-production promotion:** Strict §10 says prototypes never go to production directly. But sometimes a "prototype" is actually production-ready. How does the operator promote? Recommendation: explicit `cli-explore promote-prototype <task-id> <subdir>` which (a) requires operator confirmation, (b) creates a NEW execution issue for the production-ization, (c) DOES NOT auto-publish the prototype dir — it's a starting point for the new execution issue.

**OQ-7 — Captures during exploration: when to triage:** §12 says triage is batched at crystallization. But what if a capture surfaces a `framework-bug` (RFC-0025)? Should that be batched too? Recommendation: framework-bug captures route immediately (don't batch) since they're the framework's problem, not the operator's exploration problem.

**OQ-8 — Budget unit for AI tokens:** Is `maxAgentTokens` the right unit, or should it be USD-cost (more comparable across providers)? Recommendation: both — track both axes; primary display is whichever the operator's `costGovernance` config prioritizes.

**OQ-9 — Timestamp granularity for budget consumption:** Wall-clock from `explorationStartedAt` could be unfair if the operator pauses overnight. Should weekends / paused intervals count? Recommendation: only count wall-clock when the exploration is in `Exploring` status (paused intervals don't count); operator self-pauses via `cli-explore pause`.

**OQ-10 — Findings markdown vs structured:** §10 has `findings.md` as free-form markdown. Should it be structured (sections required: Background, Options Considered, Recommendation, Trade-offs)? Recommendation: provide a template via `cli-explore init` but don't enforce structure — operators ARE the readers, let them shape.

**OQ-11 — Exploration outputs in version control:** `explorations/` is committed to the repo by default. Some operators may want it gitignored (sensitive research). Recommendation: default to committed (transparency); operator can override per-repo via `.ai-sdlc/exploration-config.yaml`.

**OQ-12 — Crystallization auto-suggestion threshold:** Should the framework analyze `findings.md` content (e.g., embedding similarity to known DoR-passing issues) to suggest crystallized issues, or rely fully on operator? Recommendation: v1 = operator-driven; auto-suggestion is a follow-up enhancement once we have corpus data.

## 17. Sign-off

Per `project_team_roles.md`:

| Owner | Role | Status | Date |
|---|---|---|---|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ⏳ Pending walkthrough | — |
| Alexander Kline | Product Lead | ✅ Signed v0.1 | 2026-05-04 |

Lifecycle: Draft → Ready for Review (after OQ walkthrough) → Signed Off (after all owners sign).

## 18. References

- [VISION.md](../../VISION.md) §5 (exploration gap) — anchoring philosophy
- [RFC-0011 — Definition of Ready Gate](RFC-0011-definition-of-ready-gate.md) — DoR exemption rules integration
- [RFC-0015 — Autonomous Pipeline Orchestrator](RFC-0015-autonomous-pipeline-orchestrator.md) — opt-in dispatch path for exploration
- [RFC-0023 — Operator TUI](RFC-0023-operator-tui-pipeline-monitoring.md) — Explorations view
- [RFC-0024 — Emergent Issue Capture + Triage Pattern](RFC-0024-emergent-issue-capture-and-triage.md) — captures-as-output substrate
- [RFC-0025 — Framework Quality Monitoring](RFC-0025-framework-quality-monitoring.md) — framework-bug captures during exploration

## 19. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-05-03 | dominique@reliablegenius.io | Initial draft seed; 12 open questions |
