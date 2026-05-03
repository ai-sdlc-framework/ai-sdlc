---
id: AISDLC-169.4
title: 'Phase 4: Observability hooks'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0015
  - phase-4
  - observability
  - events
  - cli-status
milestone: m-3
dependencies:
  - AISDLC-169.3
parent_task_id: AISDLC-169
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - pipeline-cli/src/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0015. Ship the full observability surface: the canonical `events.jsonl` schema (Phase 1-3 staked individual entries; Phase 4 codifies the contract), the `cli-status --orchestrator` view (RFC §7.2), the per-project `OrchestratorConfig` YAML wiring (Q7), and the optional Slack push for `needs-human-attention` (Q1 layer C). Estimated 1 week.

The contract for downstream consumers (a future web dashboard, replication via inotify → SSE, etc.) is "the file exists, it's append-only, it's schema-stable" per RFC §7.3. This phase makes that promise enforceable.

## Open-question resolutions implemented in this phase

- **Q1 (human-attention surface, layer C):** Slack push to a configured webhook when the orchestrator labels a PR `needs-human-attention`. Backed by the `events.jsonl` consumer (no separate code path) — the Slack push is a tail-and-filter on the event stream. Optional per `OrchestratorConfig.slackWebhookUrl`.
- **Q7 (per-project failure-budget overrides):** `.ai-sdlc/orchestrator-config.yaml` carries `failureBudgets: { SecretScanBlocked: { budget: 2, escalateImmediately: false }, ... }`. Same convention as RFC-0011's `dor-config.yaml`. Phase 2 ships the in-memory budget representation; Phase 4 wires the YAML loader + schema validation + per-project override merge logic.

## Components

- **Canonical `events.jsonl` schema** (RFC §7.1): JSON Schema published at `spec/schemas/orchestrator-events.v1.schema.json`. Defines all 13 event types: `OrchestratorTickStart`, `OrchestratorTickEnd`, `WorkerDispatch`, `WorkerStateTransition`, `RemediationApplied`, `RemediationFailed`, `WorkerParked`, `WorkerCompleted`, `OrchestratorAwaitingExternal`, `OrchestratorStuckCandidate`, `EnvHookSkipped`, `AttestationStaleAfterRebase`, `MergeQueueStuck` — plus the entries Phase 1-3 already stake (`UnknownFailureMode`, `AutoMergeFlagSet`, `OrchestratorIdleNoWork`, `OrchestratorIdleWaitingForOffPeak`, `OrchestratorBlockedByDependency`, `OrchestratorBlockedByDor`, `FilterTrace`).
- **Event writer module** (`ai-sdlc-plugin/orchestrator/events.ts`): single append-only writer to `$ARTIFACTS_DIR/_orchestrator/events.jsonl`. Atomic per-event write (one fs append per event line). Validates each event against the schema before write; refuses to write malformed events (defensive — bugs in handlers shouldn't corrupt the stream).
- **`cli-status --orchestrator` view** (RFC §7.2): renders four panels — workers table (id, task, state, age, current stage), candidate queue (next 5 with composite scores), recent transitions (last 20 events), burn-down (subscription window utilization per RFC-0010 §14.4). Reads `$ARTIFACTS_DIR/_orchestrator/state.json` + `workers/<id>.state.json` + `events.jsonl` (tail).
- **`OrchestratorConfig` YAML loader**: reads `.ai-sdlc/orchestrator-config.yaml`; validates against `.ai-sdlc/schemas/orchestrator-config.v1.schema.json`; merges per-project overrides on top of the §5.1 defaults. Schema covers `tickIntervalSec`, `maxConcurrent` (RFC-0010 default override), `failureBudgets[mode]`, `slackWebhookUrl` (Q1 layer C), `externalDepClearanceFile` (Phase 3's manual-clearance signal source).
- **Slack push consumer** (Q1 layer C): a tail process on `events.jsonl` that filters for `needs-human-attention` label-add events and posts to the configured webhook. Lives in `ai-sdlc-plugin/orchestrator/slack-push.ts`; configurable via `OrchestratorConfig.slackWebhookUrl` (omit to disable).
- **Dashboard mock**: a fixture-driven end-to-end test that loads a recorded `events.jsonl` and asserts the documented dashboard render shape (workers table rows, recent transitions, burn-down) — this proves the schema is sufficient for downstream consumers per RFC §11 Phase 4 acceptance.

## Schema additions

- `spec/schemas/orchestrator-events.v1.schema.json` — canonical event-stream schema (13+ event types from §7.1 + the staked-out additions).
- `.ai-sdlc/schemas/orchestrator-config.v1.schema.json` — per-project config schema.
- `pipeline-cli/docs/orchestrator-events.md` — documentation page for downstream-consumer authors.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Canonical events.jsonl schema published at `spec/schemas/orchestrator-events.v1.schema.json` covering the 13 RFC §7.1 event types plus the entries staked by Phase 1-3 (`UnknownFailureMode`, `AutoMergeFlagSet`, `OrchestratorIdleNoWork`, `OrchestratorIdleWaitingForOffPeak`, `OrchestratorBlockedByDependency`, `OrchestratorBlockedByDor`, `FilterTrace`)
- [ ] #2 Event writer at `ai-sdlc-plugin/orchestrator/events.ts` is the single append-only writer; atomic per-event append; validates each event against the schema before write and refuses to write malformed events
- [ ] #3 `cli-status --orchestrator` view (RFC §7.2) renders the four panels: workers table, candidate queue (next 5 with composite scores), recent transitions (last 20 events), burn-down (subscription window utilization per RFC-0010 §14.4)
- [ ] #4 Q7 per-project config: `.ai-sdlc/orchestrator-config.yaml` loaded on orchestrator startup; validated against `.ai-sdlc/schemas/orchestrator-config.v1.schema.json`; per-project `failureBudgets[mode]` overrides merge on top of §5.1 defaults; same convention as RFC-0011's `dor-config.yaml`
- [ ] #5 Q1 layer C Slack push: tail process on events.jsonl filters for `needs-human-attention` label-add events and posts to `OrchestratorConfig.slackWebhookUrl` (omit to disable). No separate code path — Slack push is a consumer of the existing event stream
- [ ] #6 Dashboard mock fixture: loads a recorded `events.jsonl` and asserts the documented dashboard render shape — proves schema sufficiency for downstream consumers per RFC §11 Phase 4 acceptance
- [ ] #7 Documentation page `pipeline-cli/docs/orchestrator-events.md` describes the schema, the per-event-type semantics, the append-only contract, and the recommended consumer pattern (tail + filter)
- [ ] #8 Hermetic tests cover the event writer (atomic append, schema validation, refusal on malformed event), the `cli-status --orchestrator` view (each panel renders correctly from a fixture state file), the YAML loader (default + per-project override merge), and the Slack push consumer (filter + post on label-add fixture event)
- [ ] #9 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
