---
id: AISDLC-615
title: Single cli-attestation `finalize` wrapper for a main-session dispatch (LOW-7)
status: To Do
priority: low
labels:
  - attestation
  - dx
created: 2026-09-14
---

## Context

LOW-7 from the local-trades LT-595 report: for a main-session (non-orchestrator)
dispatch, producing a valid attestation by hand is fiddly and multi-step —
resolve each reviewer's harness `agentId` → `subagents/agent-<id>.jsonl`, persist
the transcript to `.ai-sdlc/transcripts/<task>/<reviewer>.jsonl`, `emit-leaf` per
reviewer, then `sign` and `verify`. This compounded with HIGH-2/MED-5 (now fixed
by AISDLC-610) and with the transcript-routing scatter observed when multiple
worktrees are active. A single wrapper would collapse the sequence and reduce
per-PR error.

## Scope

- Add a single `cli-attestation finalize` (name settled) subcommand that, given a
  task id + the three reviewer transcript sources (or auto-discovers them) +
  head SHA, runs: persist → emit-leaf (×3) → sign-v6 → verify, and reports the
  patch-id + status. Idempotent and safe to re-run.
- Should reuse the AISDLC-610 patch-id resolution so emit and sign agree.
- Consider a `--transcripts-dir` override to handle the multi-worktree
  transcript-routing scatter (transcripts landing under a sibling worktree's
  sentinel) that currently forces manual `find`+copy at sign time.

## Acceptance Criteria

- [ ] AC-1: One command takes a task id (+ transcript inputs / head SHA) and
      produces a committed-ready valid v6 envelope (persist→emit→sign→verify),
      printing patch-id + `status=valid`.
- [ ] AC-2: Idempotent re-run; clear error if a transcript/verdict is missing.
- [ ] AC-3: Hermetic tests; build/test/lint clean; docs note in the attestation
      runbook.

## References

Adopter report local-trades LT-595 (LOW-7). Builds on the AISDLC-610 patch-id (merged)
lockstep (merged). Related: the multi-worktree transcript-routing scatter noted
during the AISDLC-609/610/611 reconciles.
