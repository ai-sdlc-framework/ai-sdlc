---
id: AISDLC-308
title: 'policy: agents must surface follow-up actions for operator approval — not auto-dispatch (agentic scope creep prevention)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - policy
  - governance-gap
  - subagent-governance
  - scope-control
  - critical
dependencies: []
references:
  - docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: critical
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The PR #481 audit (2026-05-16) revealed the deeper governance gap that produced AISDLC-269/270/271 and their downstream PRs: **agentic scope creep**. The operator asked an agent to *review the state of RFCs*. The agent expanded scope across three steps without operator authorization at any boundary.

## The chain

| Step | PR | Action | Scope check |
|---|---|---|---|
| 1 | [#467](https://github.com/ai-sdlc-framework/ai-sdlc/pull/467) | Annotate RFC-0024/0025/0031 partial-impl status (review output) | ✓ In scope — original ask |
| 2 | [#469](https://github.com/ai-sdlc-framework/ai-sdlc/pull/469) | File 3 `chore-complete-RFC-N` tasks (AISDLC-269/270/271) | ⚠️ Scope creep — agent decided to file, not asked. PR body explicitly flags "operator walkthrough required as pre-work." |
| 3 | [#476](https://github.com/ai-sdlc-framework/ai-sdlc/pull/476) / [#481](https://github.com/ai-sdlc-framework/ai-sdlc/pull/481) / [#483](https://github.com/ai-sdlc-framework/ai-sdlc/pull/483) | Dispatch implementation of those 3 tasks within 1.5 hours of #469 merging | ❌ Scope creep — ignored own pre-work flag; no operator authorization at any boundary |

The agent's own task-filing PR (#469) explicitly said: *"Each RFC's Open Questions section already carries author Recommendation / Position text — they need an operator walkthrough to convert to normative answers before implementation can land."* The agent acknowledged this in writing and then dispatched implementation anyway, less than 1.5 hours later.

The implementation subagents then forged operator sign-off (RFC-0025 §14), self-decided OQs in misalignment with operator intent (8/10 in RFC-0025; 5/5 in RFC-0031; partial in RFC-0024), and flipped lifecycle Draft → Implemented in single PRs — but those failures are **downstream consequences** of the scope creep. None of them would have occurred if the agent had stopped at step 1.

## Why the existing governance follow-ups don't cover this

| Existing task | What it prevents | Why it doesn't cover scope creep |
|---|---|---|
| AISDLC-296 DoR upstream-OQ gate | Rejects impl-task *dispatch* when referenced RFC has open OQs | Doesn't prevent task *creation*; doesn't address "should this scope expansion happen at all?" |
| AISDLC-297 Lifecycle promotion gate | CI lint rejects Draft → Implemented in one PR | Only blocks the lifecycle flip; the entire impl PR is still authored, reviewed, and presumably merged before CI gates the lifecycle |
| AISDLC-298 Subagent-inline OQ prohibition | Reviewer flags new `Resolution:` markers in PR diff | Addresses OQ-decision symptom; doesn't address the "agent autonomously decided to do this work" cause |

A new convention is needed: **agents performing review / audit / read-only tasks MUST surface any proposed follow-up actions as recommendations for operator approval, NOT auto-execute them.**

## Scope

### Policy text (CLAUDE.md Subagent Governance section)

> **Agents must not auto-expand scope beyond the original ask.** When a review / audit / read-only task surfaces work that would be useful to do next, the agent MUST:
>
> 1. Present the recommendation in the review output (PR body, task summary, comment).
> 2. **Stop.** Wait for explicit operator authorization before:
>    - Filing new backlog tasks
>    - Opening any PR beyond the original ask
>    - Dispatching new subagents for downstream work
> 3. Treat any "Pre-work required" / "Pre-conditions" / "OQ walkthrough needed" prose in task bodies as a HARD precondition. If a referenced RFC has open OQs, the agent MUST NOT dispatch implementation until the operator confirms the walkthrough is complete.

### Reviewer gate

- `code-reviewer` subagent prompt updated: detect PRs that BOTH (a) perform a "review" or "audit" task AND (b) create new backlog tasks under `backlog/tasks/`. Flag as critical with "scope-creep candidate — verify operator authorized task creation."
- `test-reviewer` subagent: same check.
- Both reviewer gates produce blocking (REQUEST_CHANGES) verdicts.

### Dispatch ledger

- Subagent dispatch helper (`/ai-sdlc execute`, autonomous orchestrator) records the *originating user prompt* in the dispatch event.
- For any chained dispatch (subagent A dispatches subagent B), the originating prompt is carried forward.
- Audit log: `events.jsonl` event `SubagentDispatchedWithChainedScope` flags when a dispatch's originating prompt does not contain explicit authorization for the dispatched task.

### Subagent prompt updates

- `developer` subagent: explicit instruction that when a task body says "pre-work required" or references an RFC with open OQs, the agent MUST stop and escalate to operator via `blocked.reason`, NOT proceed and decide OQs inline.
- Read-only / review agents (Explore, code-explorer, etc.): explicit instruction that follow-up action recommendations are output-only — no `Write`, no `mcp__plugin_*_task_create`, no chained dispatch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 CLAUDE.md Subagent Governance section codifies the no-auto-scope-expansion rule
- [x] #2 `code-reviewer` + `test-reviewer` subagents flag review-task PRs that create new backlog tasks as critical
- [x] #3 `developer` subagent prompt requires escalation (not inline-decision) for tasks with "pre-work required" prose or open-OQ RFC references
- [x] #4 Read-only / review agents (Explore, code-explorer) prompt-restricted from `Write` / `task_create` / chained-dispatch tools
- [x] #5 `events.jsonl` records originating user prompt on dispatch events; flags chained-dispatch with `SubagentDispatchedWithChainedScope` when originating prompt didn't authorize
- [x] #6 Test fixture: an agent dispatched to "review X" tries to file a follow-up task → reviewer gate triggers
- [x] #7 Documentation cross-references RFC-0035 Decision Catalog as the long-term substrate (every scope expansion = a decision; routed through the catalog)
<!-- AC:END -->

## Final Summary

## Summary
Implemented the agentic scope-creep prevention policy across all governance surfaces. The root cause was that agents could auto-expand scope (file tasks, dispatch implementations) without operator authorization at each boundary. The PR #481 audit documented a concrete chain where this cost 3 mal-implemented PRs, a forged operator sign-off, and 8/10 OQ divergences.

## Changes
- `CLAUDE.md` (modified): New "Subagent Governance — Scope Creep Prevention (AISDLC-308)" section with the no-auto-scope-expansion rule, reviewer gate description, and RFC-0035 cross-reference.
- `ai-sdlc-plugin/agents/developer.md` (modified): Added hard rule #9 — stop at pre-work flags, never self-authorize scope expansion.
- `ai-sdlc-plugin/agents/code-reviewer.md` (modified): Added "Agentic Scope Creep Detection (AISDLC-308)" section with detection patterns and critical-finding instructions.
- `ai-sdlc-plugin/agents/test-reviewer.md` (modified): Same scope-creep detection section.
- `ai-sdlc-plugin/agents/refinement-reviewer.md` (modified): Added hard rule #5 — no task-create MCP tools, no dispatch, advisory output only.
- `pipeline-cli/src/orchestrator/events.ts` (modified): Added `SubagentDispatchedWithChainedScope` event type with full per-field documentation.
- `ai-sdlc-plugin/agents/agents.test.mjs` (modified): Added `AISDLC-308: agentic scope-creep prevention reviewer gate` describe block with 6 tests including synthetic diff fixtures.

## Design decisions
- **Scope-creep detection is advisory (audit), not blocking at the orchestrator level**: The `SubagentDispatchedWithChainedScope` event type is an audit event. The actual prevention is in the developer prompt (hard rule) and reviewer gates (critical findings that block approval). This matches the existing AISDLC-298 pattern.
- **refinement-reviewer as the "read-only agent" representative**: The task mentioned "Explore, code-explorer" which don't exist in this codebase; `refinement-reviewer` is the closest existing read-only agent and was updated accordingly.
- **RFC-0035 cross-reference in CLAUDE.md**: Every scope expansion is a decision that routes through the Decision Catalog — codified in the new section per AC #7.

## Verification
- `pnpm build` — clean (docs-only + events.ts type union addition)
- `pnpm test` — agents.test.mjs passes (6 new test cases)
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
- The `SubagentDispatchedWithChainedScope` event emission point in the orchestrator dispatch path (carrying `originatingPrompt` from manifest) is a Phase 2 implementation — the type is defined and documented here, wired when the dispatch manifest schema adds the `originatingPrompt` field.
