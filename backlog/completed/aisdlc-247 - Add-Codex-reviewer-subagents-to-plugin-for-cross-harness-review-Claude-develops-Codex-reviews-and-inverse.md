---
id: AISDLC-247
title: >-
  Add Codex reviewer subagents to plugin for cross-harness review (Claude
  develops, Codex reviews — and inverse)
status: In Progress
assignee: []
created_date: '2026-05-09 17:30'
updated_date: '2026-05-10 14:57'
labels:
  - enhancement
  - plugin
  - subagents
  - codex
  - harness
  - dogfood
dependencies: []
references:
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-202.2 shipped the Codex `HarnessAdapter` at the orchestrator/library level — the pipeline-cli now knows how to spawn `codex` for stages declared with `harness: codex`. But the plugin's reviewer subagents (`ai-sdlc:code-reviewer`, `ai-sdlc:test-reviewer`, `ai-sdlc:security-reviewer`) are still hardcoded to run as Claude subagents via the Agent tool. When a slash-command body or orchestrator session calls `Agent(subagent_type='ai-sdlc:code-reviewer', ...)`, Claude is the only harness available.

Operator's vision (2026-05-09): "Claude Code develops, Codex reviews — and Codex develops, Claude Code reviews. If we can do both workflows simultaneously, we get lots of throughput."

This requires Codex variants of the reviewer subagents so the dispatcher can pick which harness reviews based on which harness implemented (RFC-0010 §13.10 independence enforcement: `requiresIndependentHarnessFrom: [implement]`).

## Proposed design

### New plugin agents

Add three new agent files under `ai-sdlc-plugin/agents/`:
- `code-reviewer-codex.md`
- `test-reviewer-codex.md`
- (Defer security-reviewer-codex pending operator decision — Opus is the current standard for security per `feedback_subagent_model_selection.md`; Codex equivalent may not match the reasoning depth)

Each new agent's body shells out to `codex chat` (or whatever Codex CLI's review-mode invocation is — verify against AISDLC-202.2's adapter implementation) instead of being a native Claude subagent. The frontmatter declares `harness: codex` so the plugin's MCP layer routes correctly.

### Identical I/O contract with Claude versions

The agent's input prompt and output JSON envelope shape must match the existing `code-reviewer.md` and `test-reviewer.md` exactly (so callers don't have to branch on harness):

```json
{
  "approved": true|false,
  "summary": "string",
  "findings": [{"severity": "critical|major|minor|suggestion", "file": "path", "line": N, "message": "string"}]
}
```

### Bidirectional dispatch convention

The convention for the slash command body / orchestrator caller (initially manual, eventually automated by AISDLC-202.3):
- If implement was Claude → review with `*-codex` variants
- If implement was Codex → review with the existing `*-reviewer` (Claude) variants

This satisfies the RFC-0010 §13.10 "no harness reviews its own output" property without needing the full HarnessAdapter independence-enforcement framework to ship first.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 #1 `ai-sdlc-plugin/agents/code-reviewer-codex.md` agent exists, frontmatter declares `harness: codex`, body invokes Codex CLI with the diff + review prompt and parses the JSON envelope
- [ ] #2 #2 `ai-sdlc-plugin/agents/test-reviewer-codex.md` ditto for test review
- [ ] #3 #3 Both agents return the SAME JSON envelope shape as their Claude counterparts (so callers can swap harnesses without changing parsing logic)
- [ ] #4 #4 Agents are listed in plugin documentation (`ai-sdlc-plugin/README.md` or governance skill)
- [ ] #5 #5 Manual smoke test: spawn `code-reviewer-codex` against a recent merged PR's diff; verify the envelope shape and at least basic finding plausibility
- [ ] #6 #6 Operator runbook entry at `docs/operations/cross-harness-review.md` documenting when to use which variant, the bidirectional convention, and the cost/latency tradeoffs vs Claude reviewers
- [ ] #7 #7 `feedback_subagent_model_selection.md` memory file updated to note codex variants as alternatives for code/test review (security stays on Opus pending separate evaluation)

## Composes with / unblocks

- **AISDLC-202.2** (Codex harness adapter at orchestrator level — already merged) — this task adds the subagent-level surface that callers actually use
- **AISDLC-202.3** (attestation harness context + finalization via MCP task_complete) — once shipped, the orchestrator can automatically pick reviewer harness based on implementer harness; this task makes that automation possible by providing the Codex variants
- **RFC-0010 §13.10** (independence enforcement via `requiresIndependentHarnessFrom: [implement]`) — once both directions exist as agents, the orchestrator can enforce the no-self-review property mechanically
- Throughput multiplier: with both directions wired, the orchestrator can dispatch 2 PRs in parallel (one Claude-implements/Codex-reviews + one Codex-implements/Claude-reviews) without cross-saturating either subscription's quota

## Open questions

- Does Codex CLI support the same prompt-with-stdin-diff invocation pattern as `claude --print`, or does it need a different orchestration (file-based handoff, explicit chat session)?
- How should the agent handle Codex auth failures? (Same fallback pattern as Claude's `--print`: surface the error in the envelope's summary, mark `approved: false`?)
- Should the operator be able to override the reviewer harness per-PR via a flag, or is the bidirectional convention always automatic?

## References

- `ai-sdlc-plugin/agents/code-reviewer.md` (existing Claude variant — copy structure)
- `ai-sdlc-plugin/agents/test-reviewer.md` (existing Claude variant)
- `backlog/completed/aisdlc-202.2 - *.md` (Codex adapter implementation reference)
- `spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md` §11.3, §13.6, §13.10 (harness routing + independence design)
- Operator's vision 2026-05-09: "If we can do both workflows simultaneously then we can get lots of throughput"
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #8 #1 ai-sdlc-plugin/agents/code-reviewer-codex.md exists, declares harness: codex, invokes Codex CLI
- [ ] #9 #2 ai-sdlc-plugin/agents/test-reviewer-codex.md ditto for test review
- [ ] #10 #3 Same JSON envelope shape as Claude counterparts
- [ ] #11 #4 Plugin docs list the new agents
- [ ] #12 #5 Manual smoke test against a recent PR diff verifies envelope + plausibility
- [ ] #13 #6 Operator runbook documents bidirectional convention + cost/latency tradeoffs
- [ ] #14 #7 Memory file updated to note codex variants as alternatives
<!-- SECTION:ACCEPTANCE:END -->
<!-- AC:END -->
