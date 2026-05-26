---
id: AISDLC-429.1
title: 'Phase 1: Document Copilot CLI execution path and identify invocation grammar gaps'
status: Done
labels:
  - rfc-0012
  - copilot
  - phase-1
  - documentation
  - scoping
parentTaskId: AISDLC-429
dependencies: []
assumes:
  - RFC-0012
references:
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/runtime/spawners/codex-harness.ts
  - docs/operations/codex-execution-path.md
priority: high
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The parent AISDLC-429 proposes a `CopilotHarnessAdapter` mirroring the AISDLC-202.2 `CodexHarnessAdapter` shape. Before any adapter code lands, the GitHub Copilot CLI's invocation grammar needs to be mapped against RFC-0012 Step 0-13 the same way AISDLC-202.1 mapped Codex. Specifically: how does the `copilot` CLI accept a system prompt + user prompt, what's the response shape, can it run a multi-step coding loop unattended, and what (if anything) does the CLI surface as a structured return value the adapter can normalise to `DeveloperReturn` / reviewer-verdict JSON?

Without that map, the Phase 2 adapter would be guessing at the bridge contract.

## Goal

Produce a written design that lists every Step 0-13 stage, the primitive the adapter will use from the `copilot` CLI for that stage, and either (a) the confirmed invocation grammar, (b) the proposed adapter normalisation if the CLI's output needs reshaping, or (c) "no equivalent — needs upstream change or workaround." This is paper-only scoping work; no code changes ship in this sub-task.

## Implementation notes

The output should be a new operator-doc page `docs/operations/copilot-execution-path.md`, parallel in structure to the existing `docs/operations/codex-execution-path.md`. Format should make per-step decisions reviewable in isolation so Phase 2 can be parallelised across them.

Reference points to incorporate:
- Compare the `copilot` CLI's session/agent-dispatch model to Codex `spawn_agent` and Claude Code's plugin `Agent` tool. Document the model fit + any contract mismatches.
- Document how reviewer verdict JSON would be returned — if the CLI does not emit structured JSON natively, document the prompt-side instruction the adapter must inject to elicit the canonical `{approved, findings, summary, harness:'copilot'}` envelope.
- Identify any auth / billing constraints the adapter must surface (e.g. the operator's Copilot subscription tier — Business / Enterprise / Pro+ — may gate which agents are available).
- Note any subprocess-wrapping gotchas (TTY requirements, env var passthrough) that the default `subprocessCopilotSpawnAgent()` bridge needs to handle.

The document should explicitly NOT prescribe code; that's Phase 2's job.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 New doc `docs/operations/copilot-execution-path.md` maps RFC-0012 Steps 0-13 to `copilot` CLI primitives and clearly marks any Tier 1 deviations from Claude Code Agent dispatch.
- [x] #2 Each Step is annotated with one of: "no change needed (uses shared deterministic primitives)", "needs Copilot adapter (proposed shape: ...)", or "blocked / needs upstream change in Copilot CLI".
- [x] #3 Document lists the chosen `copilot` CLI invocation grammar that Phase 2's `subprocessCopilotSpawnAgent()` bridge will use, plus the per-`SubagentType` system prompt strategy (built-in defaults vs. operator-injected full plugin-agent bodies).
- [x] #4 Document lists any open questions that block Phase 2 dispatch (if any); the dev sub-agent for this Phase 1 task MUST escalate per CLAUDE.md "Subagent Governance — OQ-resolution prohibition" rather than resolving them inline.
- [x] #5 The document is reviewable as a standalone PR — does not depend on Phase 2 or Phase 3 work.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Mirror the structure of `docs/operations/codex-execution-path.md` exactly so reviewers comparing the two execution paths can spot deviations quickly. If the Copilot CLI's session model is too different to fit the same table layout, prefer adding a "harness comparison" callout rather than restructuring the codex doc retroactively.
<!-- SECTION:NOTES:END -->
