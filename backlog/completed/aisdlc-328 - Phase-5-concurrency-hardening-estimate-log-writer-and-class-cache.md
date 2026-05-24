---
id: AISDLC-328
title: 'Phase-5 concurrency hardening — estimate log writer + class cache (RFC-0016 prerequisite)'
status: Done
assignee: []
created_date: '2026-05-16 14:00'
labels:
  - framework-gap
  - rfc-0016
  - phase-5-blocker
  - concurrency
dependencies:
  - AISDLC-280
priority: high
blocked:
  reason: "RFC-0016 is Ready for Review (not yet Signed Off); operator-authorized Phase-5 prerequisite hardening per PR #498 round-1 review decision (2026-05-16). No OQs are blocked by or constrain this work — the concurrency contract is documented in §10.1."
references:
  - pipeline-cli/src/estimation/log-writer.ts
  - pipeline-cli/src/estimation/cache.ts
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
---

## Bug

PR #498 (AISDLC-280, RFC-0016 Phase 2) round-1 code review identified two concurrency races in the estimate log writer + class cache. Both are LATENT today (cli-orchestrator runs `maxConcurrent: 1`) but WILL activate in Phase 5 when the orchestrator raises concurrency or when a scripted parallel-estimation sweep is added. Filed as a Phase-5 prerequisite (RFC-0016 Phase 5 per §13 Implementation Plan, RFC-0016) so the hardening lands before the activation surface.

## Race 1: `captureEstimate` runIndex TOCTOU (log-writer.ts:173)

`captureEstimate` reads the entire log to count existing same-hash rows (`readExistingLog` → `countRunsForHash`), then `appendFileSync`. Two simultaneous invocations for the same `taskId` + `estimateInputHash` both read `0` existing rows, both write `runIndex: 1`. Phase 3 calibration groups rows by `runIndex` to identify ensemble samples; duplicate `runIndex=1` rows produce a false low-variance signal and undercount actual variance.

## Race 2: `assignClassCached` last-writer-wins (cache.ts:148)

`readCache` (full read) → mutate in-memory map → `writeCache` (full overwrite). Two concurrent calls for different tasks A and B both read the file before either writes. Winner's entry persists, loser's is evicted; subsequent lookups miss and re-run the assigner unnecessarily.

## Acceptance criteria

- [x] **Lock or rotate scheme for log writer runIndex** — either (a) take exclusive flock on the log file across read+append, OR (b) rotate `runIndex` to a strictly-monotonic discriminator (e.g. `${timestampMs}-${pid}`) so concurrent writes never collide. Document the chosen approach inline.
- [x] **Lock or atomic-merge for class cache** — either (a) flock on cache file across read+write, OR (b) atomic-merge pattern (read → mutate → write to tmp → rename → re-read to verify). Choose the simpler one given dogfood-scale parallel dispatch volumes.
- [x] **Concurrency tests** — add hermetic tests that spawn N parallel `captureEstimate` / `assignClassCached` calls and assert no row/entry loss + no runIndex collisions. Use `Promise.all` with a tmp filesystem; no need for real subprocess concurrency.
- [x] **Document under RFC-0016 §6.x** what the chosen mechanism is, so Phase 5 implementers know the contract.

## Out of scope

- Adding distributed-lock support (e.g. cross-machine flock). Single-machine concurrency is the only target for dogfood; cross-machine is a Phase 6+ surface.
- Migrating to a real KV store (sqlite, etc.). The JSONL log + JSON cache file model is sufficient; only the concurrency semantics need hardening.

## Source

Surfaced during PR #498 round-1 code review (2026-05-16). Both findings flagged as MAJOR but latent until Phase 5. Operator decision: ship PR #498 with the latent bugs documented, fix here as Phase-5 prerequisite. Hash-collision MAJOR finding from the same review was a false positive — code already uses NUL separator (`${title}\\0${description}`), reviewer misread Read tool's space-rendering of NUL bytes.
