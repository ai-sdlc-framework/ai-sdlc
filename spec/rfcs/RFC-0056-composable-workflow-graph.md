---
id: RFC-0056
title: Composable Workflow Graph (execute pipeline as a node/edge document)
status: Signed Off
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-10-18
updated: 2026-10-20
requires: []
assumes: [RFC-0012, RFC-0050, RFC-0051, RFC-0052, RFC-0054]
requiresDocs: []
deferredDocs: true
deferredDocsDeadline: 2026-12-31
targetSpecVersion: v1alpha1
---

<!-- ai-sdlc:lifecycle-jump-approved-by:deefactorial reason:operator resolved all five OQs with the full rubric and signed Engineering and Operator in the 2026-10-20 walkthrough; Ready for Review is skipped because the same operator is author, engineering and operator authority -->

# RFC-0056: Composable Workflow Graph

**Status:** Signed Off, v0.3 (2026-10-20). All five Open Questions resolved with the
full rubric: staged review is a non-gating shadow node with a `sample` knob (OQ-1);
`when` reuses the `@ai-sdlc/reference` expression grammar (OQ-2); the frozen set is the
code-backed list plus the fanout join rule (OQ-3); the document digest is an optional v6
envelope field (OQ-4); the operator-dispatch role is retired by its own RFC-0057, which
phase 5 requires (OQ-5). Engineering and Operator signed 2026-10-20; phase tasks
AISDLC-993 to 995 filed with this revision.

## Summary

Express the execute pipeline as a node/edge document (`kind: Workflow`) that a small
deterministic engine runs, instead of the hand-written state machine in
`pipeline-cli/src/next-step/next-step.ts`. Steps stay TypeScript; order, fan-out,
loops, caps and model roles become data read from the base branch. The default
document reproduces today's graph exactly, so adoption is a no-op until an adopter
overrides it.

The graph, the audit that motivates this RFC, and the proposal are published at
https://claude.ai/artifact/WDYWRxGSnYUUn7cy8GphWZ (five figures, sixteen findings
with file and line citations).

## Motivation

1. ai-sdlc is opinionated by hard-coding. Step order, the reviewer-set mode (an
   enum of three: `three`, `code-test-merged`, `staged`; `steps/reviewer-set.ts:97`),
   `MAX_ITERATIONS = 2` (`next-step.ts:107`, duplicated as `DEFAULT_MAX_ITERATIONS`
   in `steps/09-iterate.ts:37`), the severity rule (`steps/08-aggregate-verdicts.ts:54`),
   timers and models (`dispatch/reviewer-harness.ts:58-113`, beside
   `model-routing.yaml`) live in code. Adopters cannot reshape the graph without
   forking.
2. Config already claims to describe the pipeline and does not. `pipeline.yaml
   spec.stages` is never executed by pipeline-cli (the orchestrator looks single
   stages up by name); `pr-lifecycle.yaml` declares itself normative and one of its
   nine `spec` key groups is read by code (`loopGuard.maxSameHeadActions`), a second
   (`noTaskBranchPrefixes`) by CI. Config that lies is worse than no config.
3. Three orchestrators (next-step, `executePipeline()` in
   `pipeline-cli/src/execute-pipeline.ts`, the MCP `pipeline_step_*` tools) run the
   same step library and have drifted; the composite path still arms the GitHub
   auto-land flag with the raw gh command (`execute-pipeline.ts:600-613`), which the
   live path forbids. The same raw call sits in `cli/resume-from-draft.ts:135,596`
   and `orchestrator/reconcile.ts:931`; those sites are fixed by a task outside this
   RFC.
4. Enterprise adopters need bounded spend with an auditable shape: static topology,
   dynamic width inside declared caps, anchors on every path to ship. Claude Code's
   dynamic workflows give width without shape; a graph document gives both.

## Goals

- One engine, one step library, one graph document per loop.
- The graph is reviewable in a PR diff and attestable (hash of the document in the
  DSSE envelope).
- Every agent node declares a role; the model comes from `model-routing.yaml`
  (RFC-0050).
- Fan-out nodes declare `over`, `cap` and `expect`; a missing return fails the join.
- `anchor` nodes carry non-LLM truth; validation refuses a graph where a path to
  `ship` crosses no anchor.
- `frozen` nodes cannot be changed by an override without a decision record already
  on `main` (a record in an unmerged PR is not authority; CLAUDE.md, Decision
  authority).

## Non-Goals

- Replacing step implementations or agent prompts.
- Collapsing hierarchy, execute and PR lifecycle into one document. They become
  three documents, in phases.
- Letting the model author topology at run time. Width inside a `fanout` node is
  the only dynamic element, and it is capped.

## Five-step pass (DEC-0090 order)

1. **Question.** Does staged review need to gate (OQ-1)? Does the dispatch loop
   need a model? Does DoR stage B need to exist? These are decided before any
   engine work.
2. **Delete.** Two of three orchestrators and the composite path's landing call;
   dead nodes; config keys that are declared and unread.
3. **Simplify.** One routing table for every agent node; one coverage number; the
   reviewer lens list as an array.
4. **Accelerate.** Hygiene steps (sweep, sync-parent) out of the per-task path;
   verification as code in step 6; gh reads centralized in the reconciler.
5. **Automate.** The engine, behind a flag, with a golden replay test.

## Proposal

### Document

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Workflow
metadata: { name: execute-task, extends: ai-sdlc/execute-task@<plugin-version> }
spec:
  nodes:
    validate:  { kind: step,   impl: validate-task }
    deps:      { kind: step,   impl: deps-preflight }
    branch:    { kind: step,   impl: compute-branch }
    worktree:  { kind: step,   impl: setup-worktree }
    develop:   { kind: agent,  role: developer, budget: { turns: 120 } }
    verify:    { kind: anchor, impl: run-commands,
                 with: { commands: [pnpm build, pnpm test, pnpm lint] } }
    select:    { kind: step,   impl: select-reviewers,
                 with: { lenses: [correctness, security] } }
    review:    { kind: fanout, over: select.reviewers, cap: 4, expect: all,
                 node: { kind: agent, role: "${item.role}", fresh: true } }
    aggregate: { kind: step,   impl: aggregate-verdicts, frozen: true }
    ship:      { kind: step,   impl: ship, frozen: [never-land] }
  edges:
    - validate -> deps -> branch -> worktree -> develop -> verify
    - verify -> select -> review -> aggregate
    - { from: aggregate, to: develop, when: decision == CHANGES_REQUESTED, loop: { max: 2 } }
    - { from: aggregate, to: ship,    when: decision == APPROVED }
  anchors: [verify, ci.pr-ready]
  budget: { maxUsd: 6, maxAgents: 8 }
```

### Node kinds

| kind | runs where | contract |
|---|---|---|
| `step` | in process, from a registry keyed by `impl` | the registry entry declares input and output JSON schemas (reuse `review-plan.v1`, `review-evidence.v1`, `dispatch-manifest.v1`, `backlog-task.v1`) |
| `agent` | returned to the Claude session as one `spawn` instruction (today's next-step contract) | `role` resolved by `model-routing.yaml`; `fresh: true` forbids context reuse; output validated against the role's envelope schema; `gating: false` excludes the output from every join and `aggregate` and writes it to the comparison ledger (OQ-1); `sample: 1/N` runs the node on one PR in N (default 1) |
| `anchor` | in process | output accepted only from code (command exit status, CI check, coverage script); the engine rejects an anchor whose impl is an agent |
| `fanout` | the engine expands `over` into at most `cap` child nodes | `expect: all`, `n`, or `quorum(k)`; the join fails closed when fewer returns arrive |
| `human` | pauses the run and writes a decision record | class (c) only; never on the default execute path. A paused run still reports to the parent tier: a hold limits actions, never reporting (RFC-0051) |

Class (a) and (b) decisions are not nodes. They happen inside `agent` nodes through
`cli-decisions add` + `answer` (class (a)) or `--timebox` + `--autonomous-fallback`
(class (b)), and only the record persists; the engine never waits on them. RFC Open
Questions are outside the engine entirely: they are resolved only with the operator.

### Edges

`from -> to` carries the whole output of `from` as `to`'s named input. `when` is a
boolean expression over upstream outputs in the `@ai-sdlc/reference` policy expression
grammar (`reference/src/policy/expression.ts`: comparisons, `&&`, `||`, `!`, dotted
paths, `contains`, literals; OQ-2); validation rejects an identifier that is not a
declared output of an upstream node. `loop` declares a back edge with a hard `max`;
undeclared cycles fail validation.

## Design Details

### Engine

1. Load the document from the base branch only, the existing trust rule for
   `review-config.yaml` and `model-routing.yaml`.
2. Validate: acyclic except declared loops; every `agent` output has a schema; every
   path to `ship` crosses an anchor; `frozen` nodes are byte-equal to the plugin
   default unless the change references a decision record on `main`; `cap` and
   `budget` are present on every fanout.
3. Per call: compute the ready set (all inbound edges satisfied), run `step` and
   `anchor` nodes in process, return the first `agent` node as one spawn
   instruction. Same `--result` reply protocol as next-step today, so
   `commands/execute.md` stays a thin loop and no new permission surface opens.
4. Persist one record per node run in the existing state JSON; resume replays
   records. The envelope gains an optional `workflowDigest: { path, sha256, baseSha }`
   field beside `headSha` and `baseSha`; the verifier recomputes it from the base SHA
   when present and refuses an envelope produced with the engine on and no digest (OQ-4).

### Board, briefs and resume

A workflow run is one board manifest (RFC-0051): the brief is the unit of hand-off,
the board the unit of execution, the verdict file the unit of completion. The
engine's per-node records live in that manifest's state JSON, and a resume
(DEC-0187 re-enqueue or `reenter`) replays them from the last persisted node
instead of restarting the run. Phase 5 turns the dispatch tick into the third
document only on those terms; nothing in phases 1 to 4 touches the board format.

### Overrides

Adopters write a document with `extends:` naming the plugin default. Allowed: add
nodes, add edges, change `with`, lower caps, change lenses, remove non-frozen
nodes. Refused: touch a frozen node, raise a cap above the plugin ceiling, remove
the last anchor on a path, declare an agent as an anchor.

### Reused pieces

`deps/dependency-graph.ts` (cycle detection; it has no topological order, so the
engine adds a Kahn sort),
`spec/schemas/pipeline.schema.json` stage fields (`condition`, `agent`, `harness`,
`maxBudgetUsd`, `requiresIndependentHarnessFrom`), the next-step instruction
protocol, `config-manifest` versioning (`since`, additive scaffolding).

### What this does not solve

1. A graph in config is still a graph of prompts; node quality is the step and
   agent library's problem, not the engine's.
2. The trust-chain path list (`review-scope-core.mjs`) is versioned with the
   attestation schema, because the CI verifier re-derives the reviewer set from it.
   It is therefore not a phase 4 knob; a change to it is a schema change.
3. Staged-planner width stays model-decided inside a `fanout`; only `cap` and the
   join rule make that acceptable.

### Velocity impact (DEC-0048)

Positive. Removes two orchestrators and the per-task hygiene steps from the hot
path; makes the iteration cap and reviewer lenses tunable without a release. Cost:
one new kind, one registry, one golden test.

## Backward Compatibility

Phases 1 to 3 change no behaviour; the default document is generated from the
current state machine and a golden test asserts identical instruction sequences.
`pipeline.yaml spec.stages` is deprecated with a warn-on-use fallback for one
release, then removed.

## Alternatives Considered

- **Keep code, delete the lying config.** Honest and cheap, but adopters keep
  forking for topology changes. Phases 1 and 2 do this anyway.
- **Adopt Claude Code dynamic workflows.** Model-authored topology per run; no
  durable board, no attestation hook, no caps enforced outside the script. Fails the
  bounded-spend requirement this framework exists to meet.
- **General DAG runner.** Over-general for three small loops; adds a runtime
  dependency to a plugin that must run inside a Claude Code session.

## Implementation Plan (tasks AISDLC-993 to 994 for phases 1 to 4; AISDLC-995 for the OQ-3 fresh-context enforcer; phase 5 after RFC-0057)

| Phase | Deliverable | Behaviour change |
|---|---|---|
| 1 | `{id, inputs, outputs}` metadata on each `steps/*.ts`; `cli-workflow graph` walks the current Machine and emits Mermaid and the YAML above | none; the output is the test oracle |
| 2 | `Workflow` schema in `spec/schemas`, manifest entry with `since`, rendered default; `init` scaffolds, `doctor` checks | none |
| 3 | Engine behind `AI_SDLC_WORKFLOW_ENGINE=1`; golden replay test; `workflowDigest` envelope field and verifier check (OQ-4); delete the composite path's landing call and the MCP step tools | none when the flag is off; flip the default after one green release |
| 4 | Open knobs (iteration cap, lenses, fanout cap, hygiene nodes, timers, `sample`); `extends` overrides; frozen enforcement over the OQ-3 list | adopter-visible |
| 5 | PR lifecycle and hierarchy tick as the second and third documents; requires RFC-0057 (deterministic dispatch loop, OQ-5) | after phase 4 has run a release and RFC-0057 is Implemented |

Phase 1 has no dependencies and no behaviour change; it may be filed before sign-off.

Audit findings that are standalone defects (coverage threshold drift, verifier not
checking leaf approval, `emit-leaf` failing late, dead nodes, parent mutations in
the per-task path, model-routing holes, hard-coded leftovers, doc drift) are filed
as tasks outside this RFC and do not block it.

## Open Questions

### OQ-1: Staged review placement

Today the staged diamond runs beside the full classic set and both verdicts block
(`review-finalize.ts:202-203`: the staged verdict seeds the array the classic
verdicts join at `:231` and `:246`, all aggregated at `:334`). DEC-0149 decided the
opposite (`drop-verifier`: staged is advisory and never credited), and RFC-0052
calls it "shadow"; the blocking behaviour is a defect against a decision on `main`,
fixed by a task outside this RFC. What stays open is whether staged ever gates.
Options: (a) staged replaces the code/test lens, security stays beside; (b) staged
stays advisory and is sampled one in N. Keeping both at full cost is already ruled
out by DEC-0149.


**Resolution (2026-10-20, full rubric):** **Staged is a shadow node: `gating: false`, output
excluded from `aggregate` and written to the comparison ledger, with `sample: 1/N`
(default 1).** Substantive correction surfaced by the walkthrough: the premise above is
wrong. DEC-0149 (`drop-verifier`) says the *verifier* never credits staged leaves toward
the required reviewer set; it says nothing about Step 8, and
`docs/operations/reviewer-set-flag.md:97` documents today's blocking aggregation as
intended. The governing record is RFC-0052 OQ-2 (on `main`): shadow on every trusted PR,
non-gating, until 50 compared PRs at 95 percent precision, then staged plus Opus
security become the gates. AISDLC-677 implements the shadow flag; AISDLC-679 opens the
window. As of this date no envelope on `main` carries a staged leaf (0 of 576), so the
window has not started. Industry research: ML shadow mode (Uber Michelangelo) runs the
candidate on all traffic non-gating and promotes by a measured criterion; GitHub branch
protection separates required from advisory checks by name so promotion is a config
edit. **Refinement:** promotion to gating is a document edit (`lenses: [staged,
security]`) authorized by the RFC-0052 criterion, a tightening, class (a).
**Counter-argument:** "sampling slows the 50-PR window N times and a non-gating node is
dead spend." Rebuttal: the default is 1, so the window runs at full speed; `sample`
bounds an adopter's spend after their own window closes. **Selected over (a) replace
now** because the criterion on `main` is unmet; **over keeping additive blocking**
because it contradicts RFC-0052; **over dropping staged** because it forfeits the window.

### OQ-2: Expression grammar for `when`

Reuse `stage.condition` as-is, or a minimal `field op literal` grammar with no
function calls? Leaning minimal.


**Resolution (2026-10-20, full rubric):** **Reuse the `@ai-sdlc/reference` policy
expression grammar (`reference/src/policy/expression.ts`, `createSimpleExpressionEvaluator`),
documented in the Workflow schema and validated at load.** Substrate: `stage.condition`
(`pipeline.schema.json:116`) is a free string that nothing evaluates (dead schema); the
reference evaluator is shipped, tested, already used by the orchestrator's QualityGate
rules, and `pipeline-cli` already depends on the package. Industry research: GitHub
Actions `if:`, Tekton `when` and Argo keep the condition language closed and small for
static analysis; CEL is the heavy end and the repo's `cel-evaluator.ts` is only
CEL-like. **Refinement:** validation rejects an identifier not in the upstream node's
declared output schema (the fake-edge test); `stage.condition` is deleted with
`pipeline.yaml spec.stages`. **Counter-argument:** "a minimal `field op literal` grammar
is more honest; `&&` invites logic in YAML." Rebuttal: the first loop edge (`decision ==
CHANGES_REQUESTED && iteration < max`) is two terms, and identifier validation, not
operator count, bounds abuse. **Selected over a new minimal grammar** because one
evaluator beats two; **over CEL-like** because it is neither real CEL nor needed; **over
the free string** because it is dead schema.

### OQ-3: The frozen set

Proposed, from the audit's list of what is already right: `aggregate` (severity
rule, unanimity fail-closed), `ship` (never land, lease-only push; the audit calls
this rule `never-merge`), every anchor, attestation signing, fresh contexts proven
by hook markers, the nonce bound to the head SHA, the planner's inability to weaken
the baseline checklist, the grounding drop, one worktree per task, atomic board
claims, the reconciler loop guard, base-branch-only config loading. Anything to add
or drop?


**Resolution (2026-10-20, full rubric):** **The frozen set is the code-backed list plus
the fanout join rule; every entry cites its enforcer.** Substantive gaps surfaced:
three proposed entries have no enforcer today. Fresh contexts: hook markers prove an
agent id exists, not freshness (AISDLC-568). One worktree per task: git's "branch exists"
refusal in `steps/03-setup-worktree.ts`, not an invariant. Base-branch-only loading:
`hierarchy/pr-lifecycle-config.ts:20` reads the working tree. A frozen label with no
enforcer is the lying-config pattern of Motivation 2 applied to governance. Industry
research: GitHub rulesets and Terraform `prevent_destroy` freeze by naming a resource
backed by an enforcer outside the edited file; Kubernetes marks a field immutable only
where the API server rejects the write. **Frozen set:** `aggregate` (severity rule,
unanimity, missing reviewer is critical; `steps/08-aggregate-verdicts.ts:29`,
`review-finalize.ts:228`), `ship` (never land, lease-only push;
`hooks/enforce-blocked-actions.js`, `hooks/lib/lease-push-guard.js`,
`governance/merge-if-eligible.ts`), every `anchor`, attestation signing
(`attestation/sign-v6.ts`, `verify-core.mjs`), nonce bound to the head SHA
(`attestation/merkle.ts:286`), the baseline checklist (`review-plan/validate.ts:266`),
the grounding drop (`review-synth/ground.ts:130`), atomic board claims
(`dispatch/board.ts:15`), the reconciler loop guard (`hierarchy/reconcile.ts:228`),
base-branch-only config loading (`steps/reviewer-set.ts:46`, `routing/load-table.ts:26`;
the `pr-lifecycle.yaml` gap is closed in the phase 4 task), and the fanout join
(`expect` cannot be loosened, `cap` cannot exceed the plugin ceiling). Fresh-context and
one-worktree-per-task join the set when an enforcer exists (AISDLC-995).
**Counter-argument:** "dropping fresh-context signals it does not matter." Rebuttal: it
is stated as a task, not as a label code does not back. **Selected over the list as
written** because three entries would be labels only; **over the trust-chain minimum**
because runtime invariants with enforcers are what an override would loosen; **over
deriving the set from code** because the set must be readable in a diff.

### OQ-4: Document hash in the attestation

Leaf or envelope field? Either changes verify-core and the v6 schema; may warrant a
v7 or a new leaf type.


**Resolution (2026-10-20, full rubric):** **An optional v6 envelope field
`workflowDigest: { path, sha256, baseSha }`, required once the engine is default-on.**
Substrate: v6 leaves have no `type`; they are reviewer records distinguished by
`reviewerName` and `stage`, hashed in a fixed field order (`merkle-core.mjs:75`); three
optional leaf fields were added inside v6 without a bump (`independenceTier`,
`anchorEvidence`, `stage`) and `signerIdentity` is an optional envelope field; v6 hashes
no config file (v5 hashed `review-policy.md`). Industry research: in-toto/SLSA put build
configuration in the predicate (`invocation.configSource` with a digest), not among the
subjects; Tekton Chains records the pipeline spec digest the same way. Run configuration
is envelope metadata, like `headSha` and `baseSha`, which the verifier already trusts to
re-derive everything else. **Refinement:** the verifier recomputes the digest from the
base SHA (the `review-config.yaml` rule, `verify-core.mjs:931`) and refuses an envelope
produced with the engine on and no digest; old envelopes verify unchanged.
**Counter-argument:** "signed-but-not-Merkle-proved is weaker; v6 moved proof into
leaves." Rebuttal: leaves prove reviews happened against this code; the document digest
is a predicate, and a non-reviewer leaf breaks coverage-by-`reviewerName` and the stage
checks. **Selected over a new leaf kind** because it is a v7 in disguise; **over a v7
bump** because one optional field does not justify a flag day for 576 envelopes; **over no
hash** because a trust-chain path proves the file was reviewed, not that this run used it.

### OQ-5: Daemonizing dispatch and executors

Audit finding 11 (LLM sessions looping over deterministic CLI calls) is a
prerequisite for phase 5 but independent of phases 1 to 4. Separate RFC, or a
section here?


**Resolution (2026-10-20, full rubric, reframed with the operator):** **Retire the
operator-dispatch role in its own RFC-0057; phase 5 of this RFC requires it.** The
walkthrough reframed the question from "where is daemonizing decided" to "does the role
survive". Evidence from one afternoon of dispatch traffic: every act but one (`tick`,
`sweep`, `reconcile`, ingest, clears, re-enqueue, status relays, applying standing holds,
refusing an off-list action) was a CLI call or a policy-table check that an LLM session
typed and scheduled; the one residual was triage of a failure the reconciler's shape
classifier did not recognise, and it was forwarded to the planner with a guess. The
reconcile scheduler (`hierarchy/reconcile-scheduler.ts`, webhook-debounced plus timer)
is already a deterministic daemon covering PR reconcile only. Prior positions: RFC-0041
("the Conductor is correctly a session"), RFC-0051 Non-Goals (no headless `claude -p`,
billing). Industry research: Temporal, Argo and Airflow run the control loop as a
deterministic scheduler; incident tooling routes an unclassified event to a person with
evidence attached and turns each recurring ruling into a rule. **RFC-0057 scope:** the
scheduler runs `tick`, `sweep` and `reconcile`; escalations are board files carrying the
failure record, log tail and PR check summary; the planner is the only LLM in the
control loop and records rulings that become classifier rules; executors stay sessions
(RFC-0041 §4.1 billing). **Counter-argument:** "the planner is the scarce tier and now
reads every escalation itself." Rebuttal: status traffic becomes board state, not
messages; only the rulings reach the planner, with evidence instead of a guess.
**Selected over a section here** because it would block phases 1 to 4 on retiring a
RFC-0051 role; **over a thin forwarder session** because it keeps a model on standby
that forwarded the hard cases unchanged; **over as-is** by the automation ladder.

## Sign-Off

| Role | Owner | Status | Date |
|---|---|---|---|
| Engineering | Dominique Legault | ✅ Signed (five OQs resolved with the full rubric; phases 1 to 4 change no behaviour; phase 5 gated on RFC-0057) | 2026-10-20 |
| Operator | Dominique Legault | ✅ Signed (frozen set names its enforcers; dispatch role retirement gets its own record) | 2026-10-20 |
| Product | | pending | |
| Design | | not applicable | |

## Revision History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-10-18 | Draft from the workflow graph audit; five Open Questions, none resolved. |
| v0.3 | 2026-10-20 | OQ walkthrough with the operator, full rubric, all five resolved: OQ-1 staged as shadow node (`gating: false`, `sample`), premise about DEC-0149 corrected; OQ-2 `when` reuses the reference expression grammar with identifier validation; OQ-3 frozen set pruned to code-backed entries plus the fanout join, enforcers cited; OQ-4 `workflowDigest` optional v6 envelope field; OQ-5 reframed to retiring the operator-dispatch role, own RFC-0057, phase 5 requires it. Engineering and Operator signed; Draft to Signed Off; tasks AISDLC-993 to 995 filed. |
| v0.2 | 2026-10-20 | Planner accuracy review: DEC-0149 cited correctly in OQ-1 (option (c) dropped), RFC-0012 title, dependency-graph has no topo sort, `pr-lifecycle.yaml` 1 of 9 keys, extra raw arming sites; added class (a)/(b) handling, hold-reporting, board/brief/resume section, "What this does not solve", frozen set carried from the audit. No OQ resolved. |

## References

- Workflow graph, audit and proposal: https://claude.ai/artifact/WDYWRxGSnYUUn7cy8GphWZ
- RFC-0012 (two-tier pipeline architecture with shared core library), RFC-0050
  (usage ledger and model routing), RFC-0051 (session hierarchy), RFC-0052 (staged
  review), RFC-0054 (PR lifecycle as event-driven dispatch), RFC-0041 (Conductor as a
  session), RFC-0057 (deterministic dispatch loop, to be filed); DEC-0149 (staged
  review advisory), DEC-0187 (re-enqueue procedure); AISDLC-677/679 (staged shadow and
  comparison window).
- Kopadze, "Graph Engineering explained" (fake-edge test, diamond, fresh-context
  checker, anchors, silent node failure).
