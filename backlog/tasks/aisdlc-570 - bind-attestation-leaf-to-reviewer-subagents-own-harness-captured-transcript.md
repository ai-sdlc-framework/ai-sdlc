---
id: aisdlc-570
title: >-
  Bind attestation leaf to the reviewer subagent's own harness-captured
  execution transcript (DEC-0012 opt-a)
status: To Do
priority: medium
labels:
  - attestation
  - proof-of-execution
  - adoption
dependencies:
  - aisdlc-568
---

## Description

Follow-up to [[aisdlc-568]] (verdictClass, DEC-0012 opt-b, shipped). DEC-0012's
other option — **opt-a** — remains open:

> Bind the leaf hash to the harness's own session-transcript file instead of
> the subagent-writable `.jsonl` the reviewer agent body currently writes via
> Bash. Requires resolving how a coordinator-invoked subagent's own harness
> transcript is located deterministically per invocation (varies by harness,
> may not exist in headless/CI dispatch).

`node pipeline-cli/bin/cli-decisions.mjs show DEC-0012` has the full escalation
record, including why opt-b (not opt-a) was picked as the immediate fix:
opt-b is schema + verifier only and does not depend on harness internals that
vary by CLI/version and do not exist for CI dispatch. Opt-a is the stronger,
harness-coupled anchor that AISDLC-568's own Acceptance Criteria originally
asked for (its first bullet, deliberately left unchecked and reworded to
point here — see AISDLC-568's final state in `backlog/completed/`).

## Why this still matters

AISDLC-568's `verdictClass` field (opt-b) is a same-process/session
**heuristic**: it correctly downgrades the common case (a coordinator running
the reviewer's prescribed Bash steps itself, without spawning a subagent) to
`self-authored`, but it does NOT stop a *deliberately adversarial* coordinator
with full repo Bash/Write access from also fabricating the
`SubagentStart`-hook marker file that heuristic relies on
(`.ai-sdlc/subagent-sessions/<agent-id>.json` — see
`pipeline-cli/src/attestation/verdict-class.ts`). Binding the leaf hash to
something the coordinator cannot forge without actually spawning the
subagent — the subagent's own harness-captured execution transcript, if one
exists and is locatable — closes that remaining gap.

## Scope

1. Investigate whether Claude Code (and other supported harnesses — Codex,
   Copilot per the multi-harness reviewer roster) exposes a deterministic,
   per-invocation path to a subagent's own auto-captured execution transcript
   (distinct from the Bash-written `.ai-sdlc/transcripts/<task>/<reviewer>.jsonl`
   this framework writes today). Document per-harness availability, including
   the CI/headless-dispatch case where no such artifact may exist at all.
2. If a reliable per-harness signal exists: bind the leaf's `transcriptHash`
   to that artifact (or an additional hash field alongside the existing one)
   so a coordinator that never spawns a real subagent cannot produce a
   passing `independent`-tier leaf even if it fabricates every file it has
   write access to.
3. If NO reliable signal exists for one or more supported harnesses: document
   that gap explicitly (do not silently degrade `verdictClass` semantics for
   those harnesses) and propose the next-best mitigation — this may mean
   opt-a stays partial/harness-scoped rather than universal.
4. Update RFC-0042, the whitepaper, and `verdict-class.ts`'s honest-limits
   documentation to reflect whatever ships (or to record that opt-a was
   investigated and found infeasible, if that's the outcome).

## Acceptance Criteria

- [ ] Per-harness investigation documented (Claude Code, Codex, Copilot at
      minimum) — which harnesses expose a coordinator-unforgeable,
      deterministic transcript artifact per subagent invocation.
- [ ] Where a signal exists: leaf hashing bound to it; a coordinator that
      only writes files (transcript + marker) cannot produce a passing
      `independent`-tier leaf without an actual harness-level subagent spawn.
- [ ] Where no signal exists: documented explicitly, `verdictClass` semantics
      for that harness unchanged (still opt-b's heuristic, not silently
      upgraded).
- [ ] Docs (RFC-0042, whitepaper, verdict-class.ts) updated to reflect the
      new/narrowed honest-scope statement.
- [ ] Hermetic tests covering the harness(es) where a signal exists.

## Pre-work required

This is a design + feasibility investigation before implementation — the
per-harness transcript-location mechanism is not yet known and may differ
significantly across Claude Code / Codex / Copilot. Do not proceed to
implementation without first confirming the mechanism exists for at least
one harness; if none do, this task's outcome may be "documented as
infeasible, closed with no code change" rather than a shipped feature.
