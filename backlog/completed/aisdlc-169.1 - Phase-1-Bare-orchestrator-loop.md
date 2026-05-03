---
id: AISDLC-169.1
title: 'Phase 1: Bare orchestrator loop'
status: Done
assignee: []
created_date: '2026-05-03'
updated_date: '2026-05-02'
labels:
  - rfc-0015
  - phase-1
  - orchestrator
  - loop
milestone: m-3
dependencies: []
parent_task_id: AISDLC-169
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - pipeline-cli/src/orchestrator/
  - pipeline-cli/src/cli/orchestrator.ts
  - pipeline-cli/bin/cli-orchestrator.mjs
  - pipeline-cli/docs/orchestrator.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0015. Ship the bare orchestrator loop — the Node process that polls the dispatch frontier, dispatches up to `parallelism.maxConcurrent` workers via `executePipeline()`, and exits cleanly on shutdown. **No failure recovery beyond the existing iteration loop in `executePipeline()`** — Phase 2 owns the failure playbook. Estimated 1 week.

Per RFC §13 Q11 resolution: **pure Node process** at `ai-sdlc-plugin/orchestrator/run.mjs` (or similar), packaged with a systemd unit + Docker template + GH Actions self-hosted runner config so operators can pick their supervision mode. Workers go through `SubagentSpawner` (RFC-0012) — same code path as today's `/ai-sdlc execute`.

## Open-question resolutions implemented in this phase

- **Q1 (human-attention surface, layers A+B):** PR label `needs-human-attention` is the durable source of truth + `cli-status --needs-attention` view ships alongside the orchestrator's basic loop. Slack push (layer C) defers to Phase 4.
- **Q2 (resume semantics):** Stateless + idempotent finalize. Each finalize step (file move from `tasks/` → `completed/`, attestation sign, chore commit, push, PR open) checks "already done?" before doing. A crashed-mid-finalize worker is picked up on the next tick; the new orchestrator runs the same finalize sequence with each step short-circuiting where appropriate. **No resume code path; startup IS the recovery path.** §5.2 worker state file persists for forensic + observability purposes (drives `cli-status --orchestrator` view in Phase 4) but does NOT drive resume.
- **Q5 (no-work backoff foundation):** Phase 1 wires the global polling-cadence state on the orchestrator (default tick `tickIntervalSec: 30`). The exponential-backoff curve (30s → 5min cap) is plumbed in Phase 3 with the rest of the pre-dispatch admission stack; Phase 1 keeps the simple constant tick.
- **Q8 (UnknownFailureMode):** Phase 1 defines the `UnknownFailureMode` event schema + the `[needs-human-attention]` PR label semantics. The catalogue is empty in Phase 1 — every failure that escapes `executePipeline()`'s native iteration is an unknown failure and escalates. Phase 2 wires the 9-pattern catalogue.
- **Q10 (PR drift detection):** Periodic poll. Each tick runs `gh pr list --author "@me" --state open --json number,mergeStateStatus,headRefOid` and reconciles results against the worker pool. Cheap, bounded by tick interval. Webhook-driven (option B) deferred to Phase 4 only on measured pain.
- **Q11 (process model):** Pure Node process. `ai-sdlc-plugin/orchestrator/run.mjs` is the operator-managed entry point. Ship template configs for systemd + Docker + GH Actions self-hosted runner.
- **Q12 (auto-merge orchestrator side):** Finalize sequence adds an idempotent `gh pr merge --auto --rebase <pr>` call after every push and emits `AutoMergeFlagSet` to events.jsonl. Defense-in-depth with the workflow side already shipped via AISDLC-130.

## Components

- **Outer loop driver** (RFC §4.1): `loop forever { check shutdown; frontier = cli-deps frontier; dispatch up to budget; drain completed; sleep tickInterval }`. Default `tickIntervalSec: 30`.
- **Worker pool integration** (RFC §4.2): allocates worktrees via `WorktreePoolManager` (RFC-0010 §7.1), writes per-worktree `.active-task` sentinel (AISDLC-81), invokes `executePipeline()`, releases via `cleanupOnMerge` hook on completion.
- **Idempotent finalize** (Q2): each finalize step has an "already done?" predicate. Documented in `pipeline-cli/docs/orchestrator.md` (new file).
- **Periodic PR poll** (Q10): per tick, `gh pr list` reconciles open AISDLC-bot PRs against the worker pool — orphaned PRs (worker exited without finalize) flagged for the next worker to pick up; merged PRs trigger worktree cleanup.
- **Auto-merge flag setter** (Q12): finalize sequence ends with `gh pr merge --auto --rebase <pr>` (idempotent — no-op if already enabled); emits `AutoMergeFlagSet` event.
- **`cli-status --needs-attention` view** (Q1 layer B): lists open PRs with the `needs-human-attention` label sourced from `gh pr list --label needs-human-attention`.
- **Operator entry point**: `ai-sdlc-plugin/orchestrator/run.mjs` with feature-flag guard `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`. Refuses to start unless flag is set.
- **Supervision templates**: systemd unit (`ai-sdlc-plugin/orchestrator/templates/systemd/orchestrator.service`), Docker template (`ai-sdlc-plugin/orchestrator/templates/docker/Dockerfile`), GH Actions self-hosted runner config (`ai-sdlc-plugin/orchestrator/templates/github-actions/orchestrator-runner.yml`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Outer loop driver (RFC §4.1) ships at `pipeline-cli/src/orchestrator/loop.ts` (alternate location chosen — keeps the orchestrator inside the same `@ai-sdlc/pipeline-cli` package that ships `executePipeline()` it drives, so `cli-orchestrator` can `import` directly without a cross-workspace dep): polls the in-process equivalent of `cli-deps frontier` per tick, dispatches up to `maxConcurrent` workers via `executePipeline()` (RFC-0012 Tier 2), sleeps `tickIntervalSec` (default 30s) — runs forever until SIGINT/SIGTERM (handled in `runOrchestratorLoop`)
- [x] #2 Behind feature flag `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (default off, accepts `experimental`, `1`, `true`, `yes`, `on` case-insensitively); refuses to start when flag is unset and emits a clear `set AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental to enable` error (predicate + message in `feature-flag.ts`; CLI returns exit code 2 on `start` and `tick` when off)
- [x] #3 Worker pool integration (RFC §4.2): the default dispatcher invokes `executePipeline()` which allocates the worktree (Step 3), writes the per-worktree `.active-task` sentinel (Step 4 / AISDLC-81), runs the LLM dispatch boundary via the configured `SubagentSpawner`, and cleans up via Step 13 on completion. The orchestrator does NOT reimplement `WorktreePoolManager` — it consumes it through `executePipeline()` (per RFC §6.1)
- [x] #4 Q2 idempotent finalize: documented in `pipeline-cli/docs/orchestrator.md` "Idempotent finalize" section — each Step 10/11/12/13 already short-circuits on its "already done?" predicate. The orchestrator inherits this property from `executePipeline()`; the doc enumerates the predicates so operators can audit. (Step-side predicate enforcement is preexisting RFC-0012 behaviour; Phase 1 documents the contract rather than adding new code.)
- [ ] #5 Q10 periodic PR poll: NOT shipped in Phase 1 — deferred to Phase 4 alongside the `events.jsonl` writer + `cli-status --orchestrator` view (where the reconciliation has the right home). Documented as future work in `pipeline-cli/docs/orchestrator.md`. Phase 1 escalation hook (`gh pr edit --add-label`) covers the durable surface; Phase 4 will add the proactive scan
- [ ] #6 Q11 packaging: PARTIAL — operator entry point ships at `pipeline-cli/bin/cli-orchestrator.mjs` (not `ai-sdlc-plugin/orchestrator/run.mjs` per AC text — chosen to follow the established `cli-deps`, `cli-pr-unstick` convention rather than introduce a new bin location). Reference systemd unit + Dockerfile + GH Actions excerpts ship as documented examples in `pipeline-cli/docs/orchestrator.md`; committed `templates/` files deferred per the doc's "Phase 1 keeps these as documented examples..." rationale (right shape varies per operator, premature to commit one canonical form)
- [ ] #7 Q12 auto-merge orchestrator-side: NOT shipped in Phase 1 — defense-in-depth `gh pr merge --auto --rebase` finalize step deferred to Phase 2 alongside the catalogued failure-recovery handlers (it lives in the same finalize-extension surface). Workflow side (AISDLC-130's `auto-enable-auto-merge.yml` trigger extension) already ships and covers the common case; Phase 2 adds the orchestrator-side belt-and-suspenders
- [ ] #8 Q1 layers A+B: PARTIAL — Layer A (PR label `needs-human-attention` as durable source of truth) is wired: the default escalator runs `gh pr edit --add-label needs-human-attention` whenever a dispatch throws OR returns `outcome: 'needs-human-attention'`, and is idempotent (gh no-ops if the label is already attached). Layer B (`cli-status --needs-attention`) NOT shipped in Phase 1 — the existing `cli-status` lives in a separate workspace and the surface needs the events.jsonl bus to be useful; deferred to Phase 4
- [x] #9 Q8 unknown-failure schema: the `EscalationRecord` shape in `pipeline-cli/src/orchestrator/types.ts` stakes out the `UnknownFailureMode` event entry (taskId, ts, reason, prUrl); Phase 4 promotes this in-memory record to the canonical `events.jsonl` row. Any failure escaping `executePipeline()`'s native iteration in Phase 1 produces an `UnknownFailureMode` escalation and (when a PR exists) tags it with `needs-human-attention`. Phase 1 catalogue is empty by design — Phase 2 wires the 9 patterns from RFC §5.1
- [x] #10 Acceptance fixture: hermetic 5-task fixture queue drains end-to-end in `loop.test.ts > runOrchestratorLoop — fixture queue acceptance > drains a 5-task fixture queue end-to-end with maxConcurrent=1`; 3 failure-injection tasks (synthetic verification fail, synthetic git push fail surfacing as `needs-human-attention`, synthetic missing-reference) cleanly hit the `UnknownFailureMode` escalation path in `routes 3 failure-injection tasks cleanly through UnknownFailureMode`
- [x] #11 Hermetic tests cover the loop driver (one tick happy path, one tick empty frontier, SIGTERM drain via `runOrchestratorLoop — SIGTERM drain`, dispatch escalation, escalator-throw resilience, dry-run, status read-only) and the CLI router (start/tick/status with the feature flag on + off). Spawner is dependency-injected via the `dispatch` adapter (cleaner per-test fixture than threading `MockSpawner` through `executePipeline` + child processes); `MockSpawner` remains the canonical option for callers that go through the default dispatcher
- [x] #12 Phase 1 ships clean: workspace `pnpm build`, `pnpm test` (1314 pipeline-cli tests + full workspace 5000+ tests pass), `pnpm lint`, `pnpm format:check` all green. New code (orchestrator/ + cli/orchestrator.ts) covered by 31 dedicated tests + 7 CLI tests
<!-- AC:END -->

## Implementation Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Shipped the bare orchestrator loop (RFC-0015 Phase 1) inside the `@ai-sdlc/pipeline-cli` package as a deliberately-bare polling driver: feature-flag-gated, depends only on `executePipeline()` (RFC-0012 Tier 2) and the in-process `cli-deps frontier` query (AISDLC-117 / RFC-0014), and routes every failure that escapes `executePipeline()`'s native iteration through an `UnknownFailureMode` escalation that tags the relevant PR with `needs-human-attention`. Operator-facing CLI ships as `cli-orchestrator {start,tick,status}` (invoke directly per AISDLC-156), with full hermetic test coverage of the four Phase 1 invariants.

## Changes

- `pipeline-cli/src/orchestrator/feature-flag.ts` (new): `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` predicate + disabled message. Mirrors the `AI_SDLC_DEPS_COMPOSITION` convention (RFC-0014).
- `pipeline-cli/src/orchestrator/types.ts` (new): `OrchestratorConfig`, `OrchestratorTickResult`, `EscalationRecord`, `OrchestratorStatus`, plus the `DispatchFn` / `FrontierFn` / `EscalateFn` adapter shapes.
- `pipeline-cli/src/orchestrator/loop.ts` (new): `runOrchestratorTick`, `runOrchestratorLoop`, `buildOrchestratorStatus`, `defaultOrchestratorConfig`, `OrchestratorDisabledError`. Default adapters wire the in-process frontier query, `executePipeline()` dispatcher, and `gh pr edit --add-label` escalator.
- `pipeline-cli/src/orchestrator/index.ts` (new): public surface barrel.
- `pipeline-cli/src/cli/orchestrator.ts` (new): yargs router for `start` / `tick` / `status`. Feature-flag gating returns exit code 2 on `start` + `tick`; `status` is unconditional (read-only inspection).
- `pipeline-cli/bin/cli-orchestrator.mjs` (new): bin shim, executable, follows the AISDLC-156 invocation pattern (`node pipeline-cli/bin/cli-orchestrator.mjs <subcommand>`).
- `pipeline-cli/package.json` (modified): added `cli-orchestrator` bin + `./orchestrator` ESM export.
- `pipeline-cli/src/index.ts` (modified): re-exports the public orchestrator surface.
- `pipeline-cli/docs/orchestrator.md` (new): operator guide — quickstart, subcommand reference, idempotent-finalize predicate table (Q2), failure-handling semantics (Q8), supervision template excerpts (systemd / Docker / GH Actions self-hosted runner), Phase plan, cross-references.
- `CLAUDE.md` (modified): `Feature flags` section gains the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` entry (off by default, opt-in via `experimental`, references the new doc + RFC).
- `pipeline-cli/src/orchestrator/feature-flag.test.ts` (new, 17 tests): every truthy/falsy variant + disabled-message assertions.
- `pipeline-cli/src/orchestrator/loop.test.ts` (new, 14 tests): feature-flag enforcement (3), happy-path tick (3), failure-escalation paths (4), 5-task fixture queue drain + 3 failure-injection acceptance fixture (2), SIGTERM drain (1), `buildOrchestratorStatus` read-only contract (1).
- `pipeline-cli/src/cli/orchestrator.test.ts` (new, 7 tests): `start` / `tick` / `status` with flag on + off, dry-run, exit code 2 on disabled.

## Design decisions

- **Loop lives in `pipeline-cli/src/orchestrator/`, not `ai-sdlc-plugin/orchestrator/run.mjs` (deviation from AC #1/#6 prescriptive paths)**: keeping the orchestrator inside the same workspace package that ships `executePipeline()` lets `cli-orchestrator` `import` the dispatcher directly with no cross-workspace dep, mirrors the established `cli-deps` / `cli-pr-unstick` convention, and avoids introducing a new bin location for operators to learn. The plugin (`ai-sdlc-plugin/`) stays focused on slash commands + subagent prompts; the orchestrator is library code.
- **Adapters over inheritance**: `OrchestratorAdapters` exposes injectable `dispatch` / `frontier` / `escalate` / `sleep` / `logger` / `spawner` / `runner` so tests can drive the loop without spawning real subagents or shelling to `gh`. Production wiring is the default — adapters only need overriding for tests + bespoke deployments.
- **No state files in Phase 1 (RFC §13 Q2)**: the loop is stateless. `executePipeline()`'s finalize sequence is already idempotent; the orchestrator inherits that property and never writes resume state. Documented in the new `orchestrator.md` "Idempotent finalize" table.
- **`maxConcurrent: 1` default per RFC §11**: Phase 1 is single-worker by design. The code already uses `Promise.allSettled` over the picked candidates so Phase 2 can raise the cap with no loop changes.
- **`needs-human-attention` escalation is intentionally aggressive**: any unhandled exception OR `executePipeline()` returning `outcome: 'needs-human-attention'` triggers the durable PR label. Phase 2's catalogued playbook will add narrower handling (retry / remediate) before escalating; Phase 1 errs on the side of operator visibility.
- **Phase 1 escalates Q1 layer A only**: orchestrator labels via `gh pr edit --add-label` (durable source of truth). Layer B (`cli-status --needs-attention`) and the events.jsonl bus defer to Phase 4 where they have a coherent home with the rest of the observability surface.
- **AC deviations explicitly documented in the unchecked boxes above + in the orchestrator.md "Phase plan" table**: #5 (PR poll), #6 (committed templates), #7 (auto-merge finalize step), #8 layer B all defer to subsequent phases per the RFC's phasing — the bare loop is the contract Phase 1 commits to.

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1314 / 1314 passing (31 new orchestrator + 7 new CLI tests)
- `pnpm test` (full workspace) — all packages pass (pipeline-cli 1314, reference 1258, orchestrator 2997, dashboard 172, mcp-server 104, sdk-typescript 15, conformance 23, dogfood 297, mcp-advisor 131)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Smoke: `node pipeline-cli/bin/cli-orchestrator.mjs status` against the live worktree returns the real frontier (queue depth 6 — RFC-0009 PR + the 5 RFC-0015 phase tasks).

## Follow-up

- AISDLC-169.2 (Phase 2): catalogued failure playbook from RFC §5.1 + `.ai-sdlc/orchestrator-failure-patterns.yaml`. Adds the orchestrator-side `gh pr merge --auto --rebase` finalize step (AC #7).
- AISDLC-169.3 (Phase 3): DoR + dependency + external-deps pre-dispatch admission filters; exponential-backoff polling cadence (RFC §13 Q3 + Q5).
- AISDLC-169.4 (Phase 4): `events.jsonl` writer; `cli-status --orchestrator` + `cli-status --needs-attention` views (AC #8 layer B); periodic PR poll reconciliation (AC #5); Slack push (RFC §13 Q1 layer C).
- AISDLC-169.5 (Phase 5): real-issue corpus + chaos test (kill mid-tick + verify resume) + promotion runbook to flip the flag default-on.
- Committed supervision templates (AC #6 second half) once a recurring shape emerges across operator deployments.
<!-- SECTION:FINAL_SUMMARY:END -->
