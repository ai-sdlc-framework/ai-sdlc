---
id: RFC-0056
title: Composable Workflow Graph (execute pipeline as a node/edge document)
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-10-18
updated: 2026-10-18
requires: []
assumes: [RFC-0012, RFC-0050, RFC-0051, RFC-0052, RFC-0054]
requiresDocs: []
targetSpecVersion: v1alpha1
---

# RFC-0056: Composable Workflow Graph

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

1. ai-sdlc is opinionated by hard-coding. Step order, reviewer sets (an enum of
   three), `MAX_ITERATIONS = 2`, the severity rule, timers and models live in code.
   Adopters cannot reshape the graph without forking.
2. Config already claims to describe the pipeline and does not. `pipeline.yaml
   spec.stages` is never executed by pipeline-cli; `pr-lifecycle.yaml` declares
   itself normative and one of about ten key groups is read. Config that lies is
   worse than no config.
3. Three orchestrators (next-step, `executePipeline()`, the MCP step tools) run the
   same step library and have drifted; the composite path still arms the GitHub
   auto-land flag with the raw gh command (`execute-pipeline.ts:600-613`), which the
   live path forbids.
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
- `frozen` nodes cannot be changed by an override without a DEC id.

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
| `agent` | returned to the Claude session as one `spawn` instruction (today's next-step contract) | `role` resolved by `model-routing.yaml`; `fresh: true` forbids context reuse; output validated against the role's envelope schema |
| `anchor` | in process | output accepted only from code (command exit status, CI check, coverage script); the engine rejects an anchor whose impl is an agent |
| `fanout` | the engine expands `over` into at most `cap` child nodes | `expect: all`, `n`, or `quorum(k)`; the join fails closed when fewer returns arrive |
| `human` | pauses the run and writes a decision record | class (c) only; never on the default execute path |

### Edges

`from -> to` carries the whole output of `from` as `to`'s named input. `when` is a
boolean expression over upstream outputs. `loop` declares a back edge with a hard
`max`; undeclared cycles fail validation.

## Design Details

### Engine

1. Load the document from the base branch only, the existing trust rule for
   `review-config.yaml` and `model-routing.yaml`.
2. Validate: acyclic except declared loops; every `agent` output has a schema; every
   path to `ship` crosses an anchor; `frozen` nodes are byte-equal to the plugin
   default unless the change references a DEC id; `cap` and `budget` are present on
   every fanout.
3. Per call: compute the ready set (all inbound edges satisfied), run `step` and
   `anchor` nodes in process, return the first `agent` node as one spawn
   instruction. Same `--result` reply protocol as next-step today, so
   `commands/execute.md` stays a thin loop and no new permission surface opens.
4. Persist one record per node run in the existing state JSON; resume replays
   records. Include `sha256(workflow.yaml)` in the attestation leaf set (OQ-4).

### Overrides

Adopters write a document with `extends:` naming the plugin default. Allowed: add
nodes, add edges, change `with`, lower caps, change lenses, remove non-frozen
nodes. Refused: touch a frozen node, raise a cap above the plugin ceiling, remove
the last anchor on a path, declare an agent as an anchor.

### Reused pieces

`deps/dependency-graph.ts` (topological order, cycle detection),
`spec/schemas/pipeline.schema.json` stage fields (`condition`, `agent`, `harness`,
`maxBudgetUsd`, `requiresIndependentHarnessFrom`), the next-step instruction
protocol, `config-manifest` versioning (`since`, additive scaffolding).

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

## Implementation Plan (phased sketch; tasks filed after sign-off)

| Phase | Deliverable | Behaviour change |
|---|---|---|
| 1 | `{id, inputs, outputs}` metadata on each `steps/*.ts`; `cli-workflow graph` walks the current Machine and emits Mermaid and the YAML above | none; the output is the test oracle |
| 2 | `Workflow` schema in `spec/schemas`, manifest entry with `since`, rendered default; `init` scaffolds, `doctor` checks | none |
| 3 | Engine behind `AI_SDLC_WORKFLOW_ENGINE=1`; golden replay test; delete the composite path's landing call and the MCP step tools | none when the flag is off; flip the default after one green release |
| 4 | Open knobs (iteration cap, lenses, fanout cap, hygiene nodes, timers); `extends` overrides; frozen enforcement | adopter-visible |
| 5 | PR lifecycle and hierarchy tick as the second and third documents | after phase 4 has run a release |

Phase 1 has no dependencies and no behaviour change; it may be filed before sign-off.

## Open Questions

### OQ-1: Staged review placement

Today the staged diamond runs beside the full classic set and both verdicts block
(`review-finalize.ts:202-203`, DEC-0149), while RFC-0052 calls it "shadow".
Options: (a) staged replaces the code/test lens, security stays beside; (b) staged
is sampled one in N and never blocks; (c) keep both at full cost.

### OQ-2: Expression grammar for `when`

Reuse `stage.condition` as-is, or a minimal `field op literal` grammar with no
function calls? Leaning minimal.

### OQ-3: The frozen set

Proposed: `aggregate` (severity rule), `ship` (never land, lease-only push), every
anchor, attestation signing. Anything else?

### OQ-4: Document hash in the attestation

Leaf or envelope field? Either changes verify-core and the v6 schema; may warrant a
v7 or a new leaf type.

### OQ-5: Daemonizing dispatch and executors

Audit finding 11 (LLM sessions looping over deterministic CLI calls) is a
prerequisite for phase 5 but independent of phases 1 to 4. Separate RFC, or a
section here?

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
| v0.1 | 2026-10-18 | Draft from the workflow graph audit; five Open Questions, none resolved. |

## References

- Workflow graph, audit and proposal: https://claude.ai/artifact/WDYWRxGSnYUUn7cy8GphWZ
- RFC-0012 (pipeline steps as tools), RFC-0050 (model routing), RFC-0051 (session
  hierarchy), RFC-0052 (staged review), RFC-0054 (PR lifecycle).
- Kopadze, "Graph Engineering explained" (fake-edge test, diamond, fresh-context
  checker, anchors, silent node failure).
