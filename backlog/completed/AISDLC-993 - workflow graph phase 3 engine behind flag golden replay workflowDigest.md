---
id: AISDLC-993
title: 'Workflow graph phase 3: engine behind `AI_SDLC_WORKFLOW_ENGINE=1`, golden replay test, `workflowDigest` envelope field, delete the composite landing call and MCP step tools'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - rfc-0056
  - phase-3
  - pipeline-cli
  - attestation
dependencies:
  - AISDLC-992
references:
  - spec/rfcs/RFC-0056-composable-workflow-graph.md
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/attestation-core/verify-core.mjs
  - spec/schemas/attestation-envelope-v6.schema.json
  - pipeline-cli/src/deps/dependency-graph.ts
priority: high
dispatchable: true
---

## Description

RFC-0056 phase 3 (Signed Off 2026-10-20). The engine runs the document; the flag keeps the default off for one release.

**Scope.**
1. `pipeline-cli/src/workflow/engine.ts`: loads `.ai-sdlc/workflow.yaml` from the base branch only (the `review-config.yaml` rule); validates with the phase 2 validator plus a Kahn topological sort over `deps/dependency-graph.ts` cycle detection; per call computes the ready set, runs `step` and `anchor` nodes in process, returns the first `agent` node as one spawn instruction under the existing `--result` reply protocol, and persists one record per node run in the existing state JSON so resume replays records. A `gating: false` agent node's output is excluded from every join and from `aggregate` and is appended to the comparison ledger; `sample: 1/N` skips the node on PRs where `prNumber % N != 0`, recording the skip (OQ-1).
2. `AI_SDLC_WORKFLOW_ENGINE=1` routes `next-step` through the engine; unset, the Machine runs as today. A golden replay test drives both paths over the recorded fixtures and asserts identical instruction sequences.
3. Attestation (OQ-4): `attestation-envelope-v6.schema.json` gains the optional top-level `workflowDigest: { path, sha256, baseSha }`; `sign-v6` fills it when the engine ran; `verify-core.mjs` recomputes the digest from `baseSha` when the field is present and refuses an envelope whose state JSON shows engine records but no digest. Envelopes without the field verify unchanged. The three copies of the path-exclusion lists stay in lockstep (AISDLC-618) and `workflow.yaml` is a trust-chain path already (`review-scope-core.mjs` prefix `.ai-sdlc/`).
4. Delete: the composite path's landing call in `execute-pipeline.ts` (the raw gh arming call the live path forbids) and the MCP `pipeline_step_*` tools; `pipeline.yaml spec.stages` and `stages[].condition` are removed from the schema with a warn-on-use fallback for one release.
5. Behaviour change: none with the flag off. The default flips in a follow-up after one green release (RFC-0056 §Implementation Plan).

**Five-step review (requirements first).**
1. Requirement questioned: do three orchestrators need to exist? No; the engine plus the live `next-step` contract serve every caller.
2. Delete: the composite landing call, the MCP step tools, `spec.stages`.
3. Simplify: one engine, one record shape per node run, one spawn protocol.
4. Accelerate: resume replays persisted node records instead of restarting the run.
5. Automate: the golden replay test is the gate for the flag flip.

## Acceptance Criteria

- [x] With `AI_SDLC_WORKFLOW_ENGINE=1` the golden replay test produces the same instruction sequence as the Machine for every recorded fixture, including the `CHANGES_REQUESTED` loop at its cap and a reviewer fan-out with a missing return (join fails closed).
- [x] The engine refuses a document not loaded from the base branch, an agent declared as anchor, a path to `ship` crossing no anchor, and an undeclared cycle; each refusal has a test.
- [x] A `gating: false` node's verdict never reaches `aggregate`, is written to the comparison ledger with `gating: false`, and `sample: 1/2` runs it on half the fixture PRs with the skip recorded.
- [x] `workflowDigest` is optional in the v6 schema; `verify-core.mjs` accepts the 576 existing envelopes unchanged, accepts a new envelope with a correct digest, refuses a wrong digest, and refuses engine records with no digest; `scripts/verify-attestation.mjs` and `check-attestation-sign.sh` exclusion lists are unchanged or changed together.
- [x] `execute-pipeline.ts` contains no raw gh arming call; the MCP `pipeline_step_*` tools are removed from the plugin manifest and docs; `spec.stages` use logs one deprecation warning.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Design decisions
The engine is `pipeline-cli/src/workflow/engine.ts` (generic: base-branch load, refusals, ready set, loop cap, non-gating nodes, ledger) with the execute host in `execute-host.ts` (the Machine's collaborators as step implementations). Choices: (1) A loop edge's `max` is the cap on developer passes, which equals the Machine's `maxIterations`; at the cap the run opens the PR flagged for a human, as the Machine does. (2) The plugin default document now carries `anchors: [aggregate]` (step 8 is code), so it passes the ship-crosses-an-anchor rule and the scaffold the init writes is runnable. (3) A bare `APPROVED` on the right of a `when` is an enum literal: the engine's evaluation context defines `APPROVED` and `CHANGES_REQUESTED` (the follow-up the phase 2 summary asked for). (4) `sample` accepts `N` or `1/N`; with no PR yet the task number is the key and the record says so. (5) A run on the plugin default records `workflowDigest.path = builtin:execute-task`; the verifier requires that the base holds no document. The state file the engine sets in `AI_SDLC_WORKFLOW_STATE` is how the pre-push signer and the local verifier see the run. (6) `execute-pipeline.ts` already used `armViaGate`; it has no raw gh arming call, so nothing was deleted there. (7) The comparison ledger is `<state>.files/workflow-comparison-ledger.jsonl`; no ledger existed.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
