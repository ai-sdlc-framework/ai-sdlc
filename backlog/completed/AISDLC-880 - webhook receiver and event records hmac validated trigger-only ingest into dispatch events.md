---
id: AISDLC-880
title: 'feat(dispatch): webhook receiver and event records - HMAC-validated, trigger-only, idempotent ingest into .ai-sdlc/dispatch/events/'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, phase-1, dispatch, webhook, trust-sensitive]
dependencies: [AISDLC-829]
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - reference/src/adapters/webhook-server.ts
  - orchestrator/src/webhook-manager.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/dispatch/types.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Context

RFC-0054 OQ-1 (webhook first, poll as the fallback reconciler), OQ-8 (local only) and OQ-10 (the payload is a trigger, never a fact), all resolved 2026-10-14. The RFC's common section fixes the event record: a file in `.ai-sdlc/dispatch/events/` named by the idempotency key `<repo>#<pr>@<headSha>:<event-kind>:<delivery-or-updatedAt>`, containing only fields GitHub supplied, create-if-absent, replays are no-ops. A reusable HMAC-validating receiver exists in `reference/src/adapters/webhook-server.ts` with `orchestrator/src/webhook-manager.ts` wiring a secret provider; nothing in dispatch uses it. AISDLC-829 (amended) builds the reconciler that consumes these records; this task builds the producer.

## Fix

**Five-step review (requirements first).** Requirement questioned: "the receiver must understand GitHub payloads". No: after signature validation it stores five fields and wakes the reconciler; every fact is re-read over REST. Deleted: nothing yet (the poll's deletion is AISDLC-883). Simplified: one record format shared by webhook and reconciler. Accelerated: the reconciler runs within seconds of a PR event instead of at the next tick. Automated last: `cli-hierarchy up` starts the receiver with the roster.

1. `cli-hierarchy webhook up|down|status` (pipeline-cli): starts the receiver from `reference/src/adapters/webhook-server.ts` on a configured local port, secret from `AI_SDLC_WEBHOOK_SECRET` (never a file in the repo), validates `X-Hub-Signature-256`, rejects unsigned or mismatched deliveries with 401 and no record.
2. Ingest: for `pull_request`, `check_suite`, `check_run`, `workflow_run`, `status` and `pull_request_review` events, write the event record (repo, pr, headSha, kind, deliveryId, receivedAt) create-if-absent; a replay returns 200 and writes nothing. No other payload field is persisted or read.
3. Wake: after a record is written, debounce by `(pr, headSha)` for a short window (default 5 s) and then touch the reconciler's wake file (the mechanism AISDLC-829 defines); the receiver never classifies or acts.
4. Tunnel: document the supported forwarders (`gh webhook forward` for development, a named tunnel for daily use) in `docs/operations/cli-hierarchy.md`; the receiver itself binds to localhost only.
5. `cli-hierarchy up` starts the receiver when `AI_SDLC_WEBHOOK_SECRET` is set and reports it in `status`; absence of the secret is not an error (poll-only mode).

## Acceptance Criteria

- [x] A delivery with a valid signature produces exactly one record file with the five fields and nothing else; a replay of the same delivery id produces no second file and returns 200.
- [x] A delivery with a missing or wrong signature returns 401 and writes nothing (test with a forged body).
- [x] Five check-run deliveries for one head within the debounce window cause one wake.
- [x] The receiver binds to 127.0.0.1 only; `cli-hierarchy status` shows `webhook: up` with the port when running and `webhook: off (no secret)` otherwise.
- [x] No code path in the receiver reads a payload field other than the five recorded ones (reviewer AC; grep of the handler).

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`; a local end-to-end with `gh webhook forward` against a test PR.

## Out of scope

Classification, actions, `landing/` records (AISDLC-829); deleting the pollers (AISDLC-883); any CI-side component (OQ-8: local only).
