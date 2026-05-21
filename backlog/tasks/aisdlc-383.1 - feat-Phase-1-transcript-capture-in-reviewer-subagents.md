---
id: AISDLC-383.1
title: 'feat(attestation): RFC-0042 Phase 1 — transcript capture in reviewer subagents'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - phase-1
  - attestation
parentTaskId: AISDLC-383
dependencies: []
priority: high
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
---

## Scope (RFC-0042 Phase 1)

Add structured transcript capture to each reviewer subagent. Every prompt, every assistant turn, every tool invocation, every tool result emitted to a transcript file at `.ai-sdlc/transcripts/<task-id>/<reviewer-name>.jsonl`.

Per RFC-0042 §Design Layer 1, transcripts are **gitignored**. Operator retains for 90 days by default (per OQ-1 resolution) at `~/.ai-sdlc/transcripts/` or operator-configured remote URL (OQ-5).

### Deliverables

1. Reviewer subagent definitions (`ai-sdlc-plugin/agents/{code,test,security}-reviewer.md` + `-codex` variants) updated to:
   - Capture full conversation transcript including all tool calls
   - Write to `.ai-sdlc/transcripts/<task-id>/<reviewer-name>.jsonl` (JSONL: one event per line)
   - Include the PR diff verbatim in the prompt (so transcript captures it for content-plausibility checks later)
2. `.gitignore` entry for `.ai-sdlc/transcripts/`
3. Hermetic test: spawn a reviewer subagent against a fixture diff, assert transcript file exists + is structurally well-formed JSONL + includes prompt + at least one assistant response
4. CLI: `cli-attestation transcripts list [<task-id>]` to show captured transcripts (operator inspection)

### Acceptance criteria

- [ ] #1 All 5 reviewer agent definitions emit transcripts to `.ai-sdlc/transcripts/<task-id>/<reviewer-name>.jsonl`
- [ ] #2 `.gitignore` excludes `.ai-sdlc/transcripts/`
- [ ] #3 Transcript JSONL is well-formed: one event per line, includes `{role, content, timestamp}` and tool-call events
- [ ] #4 Hermetic test in `pipeline-cli/src/attestation/transcript-capture.test.ts` (or equivalent location) covers happy path + missing-prompt edge case
- [ ] #5 `cli-attestation transcripts list <task-id>` lists captured transcripts with counts (events, tokens, bytes)
- [ ] #6 Operator runbook docs/operations/transcript-management.md created — explains retention policy, GC, remote storage opt-in
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- Merkle leaf index (deferred to AISDLC-383.2)
- v6 envelope schema (deferred to AISDLC-383.3)
- CI verification (deferred to AISDLC-383.4)

## Source

RFC-0042 §Design Layer 1 + OQ-1 (90-day retention) + OQ-5 (local default + opt-in remote URL).
