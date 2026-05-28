---
id: AISDLC-430
title: 'feat: RFC-0030 OQ-13.1+13.4 re-walkthrough refinement — env-var-only adapter scope + manual-entry anti-gaming (rate limit, evidenceUrl, share metric)'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-26'
updated_date: '2026-05-27'
labels:
  - rfc-0030
  - signal-ingestion
  - re-walkthrough-refinement
  - adapter-framework
  - anti-gaming
dependencies: []
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: medium
blocked:
  reason: "RFC-0030 lifecycle is 'Ready for Review' but all 5 §13 OQs are RESOLVED via the v0.3 re-walkthrough (2026-05-26); this task is a per-OQ refinement filed by the operator after the re-walkthrough — operator-acknowledged."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.1 (adapter credentials) + OQ-13.4 (manual signal entry). Lands on top of shipped Phase 1 + Phase 4 substrate (AISDLC-343, AISDLC-346 in `backlog/completed/`).

## Scope (RFC-0030 §13.1 + §13.4 v0.3 refinements)

### OQ-13.1: Env-var-only v1 adapter scope + dual Decision routing

- **Explicit v1 adapter list (env-var-based only)**: `signal-source-manual` (no auth), `signal-source-support-ticket` (Zendesk PAT via env var), `signal-source-in-app-feedback` (API key), `signal-source-community-thread` (Discord-bot-token / Slack-bot-token).
- **OAuth-required adapters defer to future credential-mgmt RFC**: full Salesforce / HubSpot integrations, Zendesk-with-OAuth-scopes — NOT shipped here; pipeline gracefully skips them.
- **Two distinct Decisions** (replace single `adapter-credential-invalid` from v0.2):
  - `adapter-credential-not-configured` — env var missing → emit setup task; pipeline continues with remaining valid adapters
  - `adapter-credential-rejected` — env var present but auth call failed → emit rotation task; pipeline continues
- Adapter discovery at pipeline-load: probe `isAvailable()` per registered adapter; classify failures into the two Decision types; emit accordingly.

### OQ-13.4: Manual-entry anti-gaming hardening

Layered on top of shipped RFC-0022 OQ-2 audit-trail pattern (forced `attestedBy` + auto-filled `attestedAt` from git committer):

- **Per-operator rate limit** at signal-entry CLI: default 10 manual signals per operator per UTC day; per-org configurable via `manualEntry.dailyCapPerOperator`. Above cap → `Decision: manual-signal-rate-limit-exceeded` → operator can escalate via batch review.
- **Optional `evidenceUrl` field** on manual signals (call recording, ticket URL, transcript link). When present, audit trail materially stronger. When absent, attested observation stands but is flagged in quality metric.
- **Manual-share quality metric**: rolling 7d compute `manualSignals / totalSignals`; when >30% sustained → `Decision: manual-signal-share-elevated` (warning, not block — surfaces architectural anti-pattern that pipeline is acting as data-entry tool, not automated demand-detection).
- Unit tests + integration tests for rate-limit enforcement, evidenceUrl preservation through pipeline, quality-metric calculation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 v1 adapter list explicitly enumerated in code + spec; OAuth-required adapters refuse to register with a documented "wait for credential-mgmt RFC" Decision
- [x] #2 `adapter-credential-not-configured` Decision emitted when env var is missing
- [x] #3 `adapter-credential-rejected` Decision emitted when env var present but auth call fails
- [x] #4 Pipeline continues with remaining valid adapters in both failure modes
- [x] #5 Manual-entry rate limit (default 10/day per operator) enforced at signal-entry CLI; per-org `manualEntry.dailyCapPerOperator` override respected
- [x] #6 `Decision: manual-signal-rate-limit-exceeded` emitted above cap; operator-escalation path documented in runbook
- [x] #7 Optional `evidenceUrl` field on manual signals; preserved through pipeline + visible in audit export
- [x] #8 Manual-share quality metric computed rolling 7d; `Decision: manual-signal-share-elevated` emitted when sustained >30%
- [x] #9 Unit + integration tests cover all paths (env-var-not-configured / rejected / valid; rate-limit cap / under-cap; evidenceUrl-present / absent; quality-metric threshold crossing)
<!-- AC:END -->

## Final summary

### Summary

Ships the RFC-0030 §13.1 + §13.4 v0.3 re-walkthrough refinements end-to-end. Adds the explicit env-var-based v1 adapter set (with the new `signal-source-in-app-feedback` adapter joining support-ticket / community-thread / manual) per RFC-0030 §13.1, enforces the dual `adapter-credential-not-configured` vs `adapter-credential-rejected` Decision routing, and refuses OAuth-needing adapters at registration with an `adapter-requires-credential-mgmt-rfc` Decision per RFC-0030 §13.1. Hardens manual-entry against gaming per RFC-0030 §13.4 via per-operator UTC-day rate limit (default 10/day), optional `evidenceUrl` audit-link field, and a rolling 7-day manual-share quality metric that fires `manual-signal-share-elevated` above 30%. All four acceptance behaviours covered by 30+ new unit + integration tests plus an end-to-end pipeline integration test.

### Changes

- `orchestrator/src/signal-ingestion/types.ts` (modified): new Decision types (`AdapterCredentialNotConfiguredDecision`, `AdapterCredentialRejectedDecision`, `AdapterRequiresCredentialMgmtRfcDecision`, `ManualSignalRateLimitExceededDecision`, `ManualSignalShareElevatedDecision`); `requiresOAuth` field on `SignalSourceAdapter`; `evidenceUrl` field on `RawSignal`; expanded `SignalFetchResult.decisions` union.
- `orchestrator/src/signal-ingestion/errors.ts` (modified): new error classes `AdapterCredentialNotConfigured`, `AdapterCredentialRejected`, `AdapterRequiresCredentialMgmtRfc`, `ManualSignalRateLimitExceeded`.
- `orchestrator/src/signal-ingestion/registry.ts` (modified): `register()` now returns `null | AdapterRequiresCredentialMgmtRfcDecision` (refuses OAuth adapters); `fetchSignalsFromAvailableAdapters` maps the new error classes to their distinct Decision shapes; legacy `adapter-credential-invalid` preserved for backward compat.
- `orchestrator/src/signal-ingestion/adapters/in-app-feedback.ts` (new): env-var-based in-app-feedback adapter (`SIGNAL_IN_APP_FEEDBACK_API_KEY`), with `credentialNotConfigured` / `credentialRejected` test seams.
- `orchestrator/src/signal-ingestion/adapters/support-ticket.ts` (modified): adds env-var probing (`SIGNAL_ZENDESK_PAT`, optional `probeEnvVar` opt-in, custom envVarName), plus `credentialNotConfigured` / `credentialRejected` test seams. Legacy `credentialInvalid` preserved.
- `orchestrator/src/signal-ingestion/adapters/community-thread.ts` (modified): same env-var probing pattern (`SIGNAL_COMMUNITY_BOT_TOKEN`).
- `orchestrator/src/signal-ingestion/adapters/manual.ts` (modified): per-operator UTC-day rate-limit enforcement, `evidenceUrl` preserved verbatim, `effectiveDailyCap` + `countForOperatorOnDate` test helpers, exported `utcDateKey` helper, dual ctor signature (back-compat array vs new options object).
- `orchestrator/src/signal-ingestion/manual-share-metric.ts` (new): rolling-window `computeManualShareMetric()` + `defaultIsManualSignal` heuristic + min-population suppression + `manual-signal-share-elevated` Decision construction.
- `orchestrator/src/signal-ingestion/config.ts` (modified): new `ManualEntryConfig` + `ManualEntryQualityMetricConfig` shape; defaults added to `DEFAULT_SIGNAL_INGESTION_CONFIG` (10/day cap, evidenceUrl optional, 7d window @ 30% threshold); `signal-source-in-app-feedback` added to default adapter list; per-field YAML resolver with bounds-checked threshold (0..1).
- `orchestrator/src/signal-ingestion/index.ts` (modified): exports for all new types, errors, adapters, helpers, env-var-name constants.
- `orchestrator/src/signal-ingestion/oq-13-1-13-4.test.ts` (new): 30+ unit + integration tests covering all 9 ACs.
- `orchestrator/src/signal-ingestion/signal-ingestion.test.ts` (modified): default-registry assertion now expects 4 adapters including in-app-feedback.
- `orchestrator/src/signal-ingestion/governance-events.test.ts` (modified): default-adapter-list assertion updated to include in-app-feedback.
- `spec/rfcs/RFC-0030-signal-ingestion-pipeline.md` (modified): §5 adapter table now lists env-var credential model + v1 vs OAuth-deferred shipping status; §5.1 RawSignal type now includes `attestedBy`, `attestedAt`, `region`, `evidenceUrl`; SignalSourceAdapter shows `requiresOAuth?` field.
- `docs/operations/signal-ingestion.md` (modified): §2 adapter table updated (4 adapters with env var names); dual-Decision table + OAuth-refusal Decision documented; §6 manual entry workflow expanded with rate-limit + evidenceUrl + share-metric guidance and wiring example.

### Design decisions

- **Env-var probing is opt-in per-adapter via `probeEnvVar: true`** rather than a global default. Existing in-memory test fixtures (`new SupportTicketSignalSourceAdapter({ signals: [...] })`) keep working without env-var setup. Production deployments flip `probeEnvVar` explicitly. Rationale: hundreds of existing test sites benefit from the back-compat default; production has a single bootstrap site to set the flag.
- **Legacy `adapter-credential-invalid` Decision preserved** so older adapter implementations that haven't migrated to env-var probing don't suddenly emit no Decision. The new Decisions are additive.
- **Manual-share metric is a pure observer** (no mutation; no Decision emission inside the registry). Caller decides where in the pipeline to invoke it (likely orchestrator-tick post Phase-4 aggregation). Keeps the metric loosely coupled and testable.
- **Min-population suppression (default 5 total signals)** prevents the share-elevated Decision from firing on tiny populations (e.g. 1 manual / 1 total = 100% would be a false alarm). Tunable per-deployment via `minPopulation`.
- **`dailyCapPerOperator: 0` disables rate limiting** entirely (operator opt-out for fully-trusted environments). Default of `10` matches RFC-0030 §13.4 v0.3 reasoning.

### Verification

- `pnpm --filter @ai-sdlc/orchestrator build` — clean
- `pnpm --filter @ai-sdlc/orchestrator test` — 188 files / 4092 passed / 1 skipped
- `pnpm lint` — clean (eslint)
- `pnpm format:check` — clean (prettier)

### Follow-up

- Wire `computeManualShareMetric()` into the orchestrator tick once the Phase-4 aggregator step exists (currently the helper is exposed as a library function; the orchestrator-side call site is intentionally not added by this task — that's an orchestrator wiring task, not an OQ-13.4 refinement task).
- Future credential-management RFC (to be filed) will own the OAuth-needing adapters that this task refuses per RFC-0030 §13.1 (`adapter-requires-credential-mgmt-rfc` Decision is the breadcrumb).
- Future `cli-signals add` TTY-friendly CLI surface for manual signal entry (tracked as a follow-up to AISDLC-348; this task ships the programmatic surface + anti-gaming layers).
