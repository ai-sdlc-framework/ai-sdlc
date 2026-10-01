---
id: AISDLC-650.1
title: >-
  RFC-0050 Part A: fold the Codex ingester into cli-usage ingest and harden its limit-event and total-only paths
status: To Do
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
  - pipeline-cli/src/cli/usage-codex.ts
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
- [ ] `cli-usage ingest` ingests Codex sessions, and re-running it writes no new records or limit events.
- [ ] Two concurrent ingests and a backfill produce no duplicate limit observations.
- [ ] A total-only session first ingested mid-session ends with the final total in the ledger.
- [ ] A direct report with a contended usage lock returns within a short bound and the runner result is unchanged.
- [ ] An oversized session file or line is skipped without exhausting memory, with a test.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
