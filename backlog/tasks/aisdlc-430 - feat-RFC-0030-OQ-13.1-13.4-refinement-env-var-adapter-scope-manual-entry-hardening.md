---
id: AISDLC-430
title: 'feat: RFC-0030 OQ-13.1+13.4 re-walkthrough refinement — env-var-only adapter scope + manual-entry anti-gaming (rate limit, evidenceUrl, share metric)'
status: To Do
assignee: []
created_date: '2026-05-26'
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
- [ ] #1 v1 adapter list explicitly enumerated in code + spec; OAuth-required adapters refuse to register with a documented "wait for credential-mgmt RFC" Decision
- [ ] #2 `adapter-credential-not-configured` Decision emitted when env var is missing
- [ ] #3 `adapter-credential-rejected` Decision emitted when env var present but auth call fails
- [ ] #4 Pipeline continues with remaining valid adapters in both failure modes
- [ ] #5 Manual-entry rate limit (default 10/day per operator) enforced at signal-entry CLI; per-org `manualEntry.dailyCapPerOperator` override respected
- [ ] #6 `Decision: manual-signal-rate-limit-exceeded` emitted above cap; operator-escalation path documented in runbook
- [ ] #7 Optional `evidenceUrl` field on manual signals; preserved through pipeline + visible in audit export
- [ ] #8 Manual-share quality metric computed rolling 7d; `Decision: manual-signal-share-elevated` emitted when sustained >30%
- [ ] #9 Unit + integration tests cover all paths (env-var-not-configured / rejected / valid; rate-limit cap / under-cap; evidenceUrl-present / absent; quality-metric threshold crossing)
<!-- AC:END -->
