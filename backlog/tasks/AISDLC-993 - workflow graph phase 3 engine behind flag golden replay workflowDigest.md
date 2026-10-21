---
id: AISDLC-993
title: 'Workflow graph phase 3: engine behind `AI_SDLC_WORKFLOW_ENGINE=1`, golden replay test, `workflowDigest` envelope field, delete the composite landing call and MCP step tools'
status: To Do
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

- [ ] With `AI_SDLC_WORKFLOW_ENGINE=1` the golden replay test produces the same instruction sequence as the Machine for every recorded fixture, including the `CHANGES_REQUESTED` loop at its cap and a reviewer fan-out with a missing return (join fails closed).
- [ ] The engine refuses a document not loaded from the base branch, an agent declared as anchor, a path to `ship` crossing no anchor, and an undeclared cycle; each refusal has a test.
- [ ] A `gating: false` node's verdict never reaches `aggregate`, is written to the comparison ledger with `gating: false`, and `sample: 1/2` runs it on half the fixture PRs with the skip recorded.
- [ ] `workflowDigest` is optional in the v6 schema; `verify-core.mjs` accepts the 576 existing envelopes unchanged, accepts a new envelope with a correct digest, refuses a wrong digest, and refuses engine records with no digest; `scripts/verify-attestation.mjs` and `check-attestation-sign.sh` exclusion lists are unchanged or changed together.
- [ ] `execute-pipeline.ts` contains no raw gh arming call; the MCP `pipeline_step_*` tools are removed from the plugin manifest and docs; `spec.stages` use logs one deprecation warning.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
