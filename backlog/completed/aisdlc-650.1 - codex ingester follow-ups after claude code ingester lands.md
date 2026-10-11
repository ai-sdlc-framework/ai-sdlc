---
id: AISDLC-650.1
title: >-
  RFC-0050 Part A: fold the Codex ingester into cli-usage ingest and harden its limit-event and total-only paths
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - orchestrator
  - codex
dependencies:
  - AISDLC-650
  - AISDLC-649
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/usage/codex-ingester.ts
  - pipeline-cli/src/cli/usage.ts
  - orchestrator/src/usage/direct-usage.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Codex ingester shipped with its own `cli-usage-codex` entry because the Claude Code
ingester and `cli-usage ingest` had not landed. This task finishes the integration and
closes the minor gaps the reviews of that change found.

1. **Fold in.** Run the Codex ingester from `cli-usage ingest` alongside the Claude Code
   one, then retire the standalone `cli-usage-codex` bin or keep it as a thin alias.
   Wire Codex ingestion into the same session-end and session-start triggers and the
   orchestrator tick that the Claude Code ingester uses.
2. **Limit events are not idempotent.** `limit-events.jsonl` is appended without the
   usage lock and without a dedup key, so two concurrent ingests, a crash between the
   append and the cursor write, or a backfill duplicate observations. Append under the
   lock with the cursor write in the same critical section, or key each observation
   (session, offset, window) and dedupe. Share the helper with the Claude Code ingester.
3. **Total-only sessions go stale.** A session that reports only a total is recorded once
   under a fixed call id, so a mid-session ingest leaves a partial total. Record it only
   once the session looks finished, or key the call id on the total's value.
4. **Direct reporter blocking.** The direct reporters run synchronously inside async
   runner paths, and the usage lock waits by blocking for up to 20 seconds. Use a short
   lock timeout for direct reports, or queue them off the hot path.
5. **Smaller items.** Cap the size of a Codex session file and of a single line before
   parsing. Say in a comment that every Codex cache write maps to the five-minute
   cache-write class, and that the cursor deliberately advances past invalid records or
   change it to retry them. Confirm no other package exercises the runners without
   `AI_SDLC_USAGE_DIR` set to a temporary directory.

Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`, section A2. Do not
edit that RFC's Open Questions.

## Acceptance Criteria
- [x] `cli-usage ingest` ingests Codex sessions, and re-running it writes no new records or limit events.
- [x] Two concurrent ingests and a backfill produce no duplicate limit observations.
- [x] A total-only session first ingested mid-session ends with the final total in the ledger.
- [x] A direct report with a contended usage lock returns within a short bound and the runner result is unchanged.
- [x] An oversized session file or line is skipped without exhausting memory, with a test.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`cli-usage ingest` now also ingests Codex sessions; the standalone `cli-usage-codex` bin is removed. Limit events go through one shared, key-deduplicated log under the usage lock. Total-only sessions are recorded once quiet for 15 minutes. Session files (256 MiB) and lines (4 MiB) are capped. Direct reports wait at most 200ms for the usage lock.

## Changes
- `pipeline-cli/src/usage/limit-event-log.ts` (new): shared locked, keyed limit-event append used by both ingesters.
- `pipeline-cli/src/usage/codex-ingester.ts` (modified): bounded line reader, size caps, deferral of unfinished total-only sessions, comments on cache-write class and cursor semantics.
- `pipeline-cli/src/cli/usage.ts` (modified): runs Codex ingest after Claude Code ingest; `--sessions-dir`.
- `pipeline-cli/src/cli/usage-codex.ts`, `pipeline-cli/bin/cli-usage-codex.mjs` (deleted).
- `orchestrator/src/usage/direct-usage.ts`, `reference/src/usage/{fs-lock,store,types}.ts` (modified): short lock wait for direct reports.

## Design decisions
- **Dedup key over same-critical-section cursor write**: simpler and idempotent under crash and backfill.
- **Deleted the bin rather than aliasing it**: session hooks and the orchestrator tick already call `cli-usage ingest`.

## Verification
- `pnpm build` - clean
- `pnpm test` - passes except 2 pre-existing failures in `pipeline-cli/src/tui/use-terminal-dimensions.test.tsx` (fail on clean main)
- `pnpm lint` - clean
- `pnpm format:check` - clean
- `pnpm dark-code:check` - clean
- code-reviewer and security-reviewer approved

## Follow-up
- declined: dedup reads only the first 8 MiB of limit-events.jsonl (reviewers' minor finding); revisit if the log grows past that.
<!-- SECTION:FINAL_SUMMARY:END -->
