---
id: AISDLC-991
title: 'Workflow graph phase 1: step metadata and `cli-workflow graph` emits the current Machine as Mermaid and YAML'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - rfc-0056
  - phase-1
  - pipeline-cli
dependencies: []
references:
  - spec/rfcs/RFC-0056-composable-workflow-graph.md
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/steps/09-iterate.ts
  - pipeline-cli/src/deps/dependency-graph.ts
priority: high
dispatchable: true
---

## Description

RFC-0056 phase 1 (Signed Off 2026-10-20). The execute pipeline's order, fan-out, loop cap and model roles live in the hand-written state machine in `pipeline-cli/src/next-step/next-step.ts`; nothing in the repo can print that graph, so the default `kind: Workflow` document of later phases has no oracle to be generated from or tested against.

**Scope.**
1. Each `pipeline-cli/src/steps/*.ts` exports a `{ id, inputs, outputs }` metadata object next to its implementation: `id` is the registry key the Workflow document will use as `impl`, `inputs` and `outputs` name the JSON schemas already in `spec/schemas` where one exists (`review-plan.v1`, `review-evidence.v1`, `dispatch-manifest.v1`, `backlog-task.v1`) and a local object schema otherwise.
2. A new `cli-workflow graph` command walks the current Machine (states, transitions, the `MAX_ITERATIONS` back edge, the reviewer fan-out) and emits (a) Mermaid and (b) the YAML document of RFC-0056 §Proposal, node by node, from the step metadata. The emitted YAML is the test oracle for phases 2 and 3.
3. The single `MAX_ITERATIONS` value in `next-step.ts` and `DEFAULT_MAX_ITERATIONS` in `steps/09-iterate.ts` collapse into one constant exported from one place and the graph command reads that constant.
4. Behaviour change: none. The command is read-only and nothing in the execute path imports it.

**Five-step review (requirements first).**
1. Requirement questioned: must a graph be hand-drawn to be reviewed? No; the Machine already is the graph, so the command derives it and the drawing cannot drift.
2. Delete: the duplicate iteration constant.
3. Simplify: one metadata shape per step, one command, one output format pair.
4. Accelerate: an adopter or reviewer sees the real pipeline topology in one command instead of reading `next-step.ts`.
5. Automate: a test asserts the emitted YAML matches a committed golden file so a Machine change that is not reflected in the document fails CI.

## Acceptance Criteria

- [ ] Every file under `pipeline-cli/src/steps/` that implements a pipeline step exports `{ id, inputs, outputs }` metadata and a test asserts the set of `id`s equals the set of states the Machine visits.
- [ ] `node pipeline-cli/bin/cli-workflow.mjs graph --format mermaid` and `--format yaml` print the current execute graph; the YAML has the node kinds, `when` edges, `loop: { max }` and reviewer fan-out of RFC-0056 §Proposal.
- [ ] A golden test compares the YAML output to `pipeline-cli/test/fixtures/workflow/execute-task.golden.yaml`; changing the iteration cap in code fails the test until the golden is regenerated.
- [ ] One exported iteration-cap constant remains; `grep -rn 'MAX_ITERATIONS' pipeline-cli/src` finds a single definition.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass; the dark-code gate accepts the command because `cli-workflow.mjs` imports it.
