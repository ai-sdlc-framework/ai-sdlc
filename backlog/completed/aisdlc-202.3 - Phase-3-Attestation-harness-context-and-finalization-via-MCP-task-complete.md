---
id: AISDLC-202.3
title: 'Phase 3: Attestation harness context and finalization via MCP task_complete'
status: Done
assignee: []
created_date: '2026-05-05 20:15'
labels:
  - rfc-0012
  - codex
  - phase-3
  - attestation
  - integration
parentTaskId: AISDLC-202
dependencies:
  - AISDLC-202.2
  - AISDLC-203
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - pipeline-cli/src/steps/10-finalize.ts
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Two integration points need work for Codex runs to land cleanly:

1. **Attestation harness context.** The DSSE envelope written by the sign-attestation script today implicitly assumes a Claude Code harness. For Codex-signed runs, the envelope should record the actual harness (and version) used to produce the verdicts, so verifier-side trust decisions can distinguish.

2. **Codex finalization via MCP `task_complete`.** Today's Codex workflow manually writes the completed task file in the worktree without deleting the original from `backlog/tasks/`. AISDLC-203 establishes that finalization must use the shared MCP `task_complete` step. This phase wires that into the Codex execution path so the bug class is closed on the Codex side as soon as 203's fix lands.

## Goal

- Sign-attestation script records `harness: { name, version }` in the envelope payload (or signed claims), populated by the calling adapter.
- Verifier (`verify-attestation` workflow / verifier code) accepts harness-tagged envelopes and surfaces the harness in the verification log.
- Codex execution path's Step 10 finalization invokes the same MCP `task_complete` shared step the Claude Code path uses (the same step blessed by AISDLC-203's fix).

## Implementation notes

This phase is gated on AISDLC-203 because the MCP `task_complete` integration relies on whatever atomic-move semantics 203 establishes. Don't ship this before 203 to avoid duplicate-fix churn.

The harness-context fields should be additive — older envelopes without the field must still verify (treat absence as "claude-code, unspecified version" for backward compat).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Attestation envelope payload includes a `harness: { name, version }` field populated by the calling adapter.
- [ ] #2 Verifier accepts envelopes both with and without the new harness field (back-compat preserved); verification log surfaces the harness when present.
- [ ] #3 Codex execution path's Step 10 finalization invokes the shared MCP `task_complete` step (same path used by Claude Code execution after AISDLC-203 lands).
- [ ] #4 Regression test asserts a Codex-run task ends up in exactly one backlog location (`backlog/completed/`), with no duplicate in `backlog/tasks/`.
- [ ] #5 Operator runbook explains how to interpret harness field in verification logs.
- [ ] #6 New code reaches 80%+ patch coverage.
<!-- AC:END -->
