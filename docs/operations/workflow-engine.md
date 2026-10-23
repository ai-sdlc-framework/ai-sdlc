# Workflow engine (RFC-0056 phase 3)

`AI_SDLC_WORKFLOW_ENGINE=1` routes `ai-sdlc-pipeline next-step` through the workflow engine
(`pipeline-cli/src/workflow/engine.ts`, host in `execute-host.ts`). Unset, or any other value,
the Machine in `next-step/next-step.ts` runs exactly as before. The default flips in a follow-up
after one green release.

## What the engine does

- Loads `.ai-sdlc/workflow.yaml` from the base branch only (`git show <base>:...`, the
  `review-config.yaml` rule). A document that exists only in the working tree is ignored; with
  no document on the base branch the built-in default (`cli-workflow graph`) runs. The base ref
  is `origin/main`, or `AI_SDLC_WORKFLOW_BASE_REF`.
- Refuses, before any node runs: a document not loaded from the base branch, an agent declared as
  an anchor, a path to `ship` that crosses no anchor, an undeclared cycle, an unknown `impl`, and
  a fan-out whose `expect` is not `all` (a missing reviewer return fails the join closed).
- Per call: computes the ready set over a Kahn order, runs `step` and `anchor` nodes in process,
  returns the first `agent` or `fanout` node as one spawn instruction (the same `--result` reply
  protocol as the Machine).
- Persists one record per node run in the state JSON under `workflow.records`; a resume replays
  them. The loop `max` on an edge is the cap on developer passes (the Machine's iteration cap);
  when it is spent the run opens the PR flagged `needs-human-attention`.

## Non-gating (shadow) nodes

An `agent` node with `gating: false` (RFC-0056 OQ-1) runs beside the gating reviewers, but its
report is set aside before the join and `aggregate`, and is appended to the comparison ledger
(`<state>.files/workflow-comparison-ledger.jsonl`) with `gating: false`. `sample: 1/N` (or `N`)
runs the node when the PR number is a multiple of N (the task number when no PR exists yet);
otherwise the skip is recorded on the node and in the ledger.

## Attestation

`sign-v6` adds `workflowDigest: { path, sha256, baseSha }` to the envelope when the run state
(`--workflow-state`, or `AI_SDLC_WORKFLOW_STATE`, which the engine sets) holds engine records.
`verify-core.mjs` recomputes the digest from `baseSha` when the field is present, and refuses an
envelope whose run state shows engine records but no digest. A run on the built-in default records
`path: builtin:execute-task`, and the verifier then requires that `baseSha` holds no document.
Envelopes without the field verify unchanged. The three path-exclusion lists
(`PATCH_ID_EXCLUSIONS`, `ATTESTATION_PATH_EXCLUSIONS`, `PATCH_ID_EXCLUSIONS_FALLBACK`) are unchanged:
`.ai-sdlc/workflow.yaml` stays inside the reviewed patch.

## Gate for the default flip

`pipeline-cli/src/workflow/replay.test.ts` drives both paths over the fixtures in
`pipeline-cli/test/fixtures/workflow/replay/` and asserts identical instruction sequences, exit
codes and collaborator calls. Add a fixture for every Machine behaviour before flipping the flag.

## Removed with this phase

- The MCP `pipeline_step_*` tools (`next-step` is the one orchestrator).
- `pipeline.yaml spec.stages` and `stages[].condition` are deprecated: still accepted for one
  release, with one warning per process when a Pipeline sets them.

## Overlays and the frozen set (RFC-0056 phase 4)

A document with `metadata.extends: ai-sdlc/execute-task@<version>` is applied over the plugin
default (`workflow/overlay.ts`). Allowed: add nodes and edges, change `with` (for example
`plan.with.lenses`, which must keep `security`; without `staged` the staged review is off), lower
caps and `loop.max`, remove non-frozen nodes (a removed mid-chain node is bridged). Refused, each
message `<rule>: <what>; enforcer: <file>`: touching a frozen node, a fanout `cap` or loop `max`
above the plugin ceiling (`REVIEW_FANOUT_CAP`, `DEFAULT_MAX_ITERATIONS`), loosening `expect`,
removing the last anchor before `ship`, an agent as an anchor.

The frozen list is `FROZEN_SET`; a test asserts every cited enforcer file exists. A frozen entry
changes only when `metadata.decisions: [DEC-NNNN]` names ids that resolve in the catalog on the
base branch (never the working tree); the last-anchor rule has no such override. Full documents
without `extends` are checked against the default the same way. Promoting the staged lens or a
`gating: false` node to gating is a tightening, accepted with the authorizing reference
(RFC-0052 OQ-2) logged. `pr-lifecycle.yaml` is read from the base branch like the other configs.
