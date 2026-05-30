---
id: AISDLC-480
title: 'feat: surface dispatched-session decisions to the Decision Catalog (async escape hatch for AskUserQuestion + blocked OQs)'
status: To Do
assignee: []
created_date: '2026-05-30 09:12'
labels:
  - dispatch
  - decision-catalog
  - observability
  - parallelism
  - rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 2026-05-30 code audit found the Decision Catalog (RFC-0035, cli-decisions.mjs, default-ON via AI_SDLC_DECISION_CATALOG) is NOT wired to receive decisions from dispatched Claude Code sessions. Evidence: grepping for `cli-decisions add` across ai-sdlc-plugin/commands/execute.md and pipeline-cli/src/steps/ returns zero matches. The developer subagent's escalation contract (developer.md hard rule eight) returns prUrl:null plus a notes field; that notes field is a dead-letter box — an operator must manually read it and run `cli-decisions add` by hand.

Worse: a detached session (a tmux pane or a `claude -p` worker) that hits AskUserQuestion hangs indefinitely, because interactive /ask only works with an attached operator session. The Decision Catalog was the intended async escape hatch for exactly this case, and it is currently unwired. This blocks safe unattended parallel dispatch: a worker can stall silently with no operator-visible signal.

Goal: when a dispatched session (native background-Agent dispatch OR a tmux/claude-p worker) encounters a decision point (a blocking open question, a scope-creep choice, or an AskUserQuestion-class question), it creates a Decision Catalog record via `cli-decisions add` instead of hanging or silently dead-lettering into a PR comment. The record routes to the operator asynchronously; the session either continues with a documented assumption or fails cleanly while emitting the catalog reference.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [ ] AC-1: The developer-subagent escalation path (prUrl:null plus notes) ALSO creates a Decision Catalog entry via `cli-decisions add` (or a library equivalent) carrying the taskId, the RFC/open-question reference, and the available options, so escalations appear in `cli-decisions list` rather than only in a PR comment.
- [ ] AC-2: A detached or non-interactive session that would otherwise call AskUserQuestion routes the question to the Decision Catalog as an async decision record and fails cleanly (non-zero exit, with the decision id printed in its output) rather than hanging.
- [ ] AC-3: The integration is mechanism-agnostic: it works for native background-Agent dispatch, the tmux execute-parallel path, and claude-p workers.
- [ ] AC-4: The Decision Catalog record schema captures enough context to resume work: taskId, decision summary, options, source (which session and worktree), and a stable decision id.
- [ ] AC-5: Hermetic tests cover three cases — escalation creates a catalog record; a non-interactive AskUserQuestion routes to the catalog and fails cleanly; no catalog write occurs when AI_SDLC_DECISION_CATALOG is off.
- [ ] AC-6: Docs: update the relevant runbook under docs/operations/ describing how dispatched-session decisions surface and how the operator answers and resumes them.

<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The implementation extends the existing cli-decisions.mjs entry point (pipeline-cli/src/cli/decisions.ts). Per AISDLC-298, dispatched sessions never self-resolve open questions — they route each one to the catalog for an operator decision. The orchestrator-tick.md skill body (around line 670) already describes Decision Catalog filing, but today only as a manual operator step; this task makes the dispatched session itself the producer.
<!-- SECTION:NOTES:END -->

## References

- spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
- spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
- spec/rfcs/RFC-0011-definition-of-ready-gate.md
- pipeline-cli/src/cli/decisions.ts
- ai-sdlc-plugin/commands/execute.md
- ai-sdlc-plugin/agents/developer.md
- AISDLC-298
