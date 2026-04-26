# @ai-sdlc/orchestrator

## Unreleased

### Features

* RFC-0010 Phase 1: deterministic port allocator + worktree slug/ownership verification + JSON schemas (`Pipeline.spec.parallelism`, `WorktreePool`, `SubscriptionPlan`, `DatabaseBranchPool`).
* RFC-0010 Phase 2: WorktreePoolManager (allocate/adopt/reclaim/cleanupOnMerge/list/reclaimStale) with strict cross-clone ownership guard. Wired into `execute.ts` behind `AI_SDLC_PARALLELISM=experimental`.
* RFC-0010 Phase 2.5: per-stage model routing + ModelRegistry with deprecation lifecycle + conditional review fan-out classifier with confident/confidence consistency rule + calibration log + cli-model-bump + cli-classifier-feedback. Cost-governance gains `model_alias` and `shadow_cost_usd` columns (Migration V13).
* RFC-0010 Phase 2.7: HarnessAdapter framework with shipped Claude Code + Codex adapters, version probe (open-ended upper bound default), independence enforcement (`requiresIndependentHarnessFrom`), cyclic-constraint validation. Adapter-authoring guide at `docs/operations/adapter-authoring.md`.
* RFC-0010 Phase 2.8: SubscriptionLedger with `(harness, accountId, tenant)` keying + schedule-aware dispatcher (4 modes) + rolling token-estimate calibration + EstimateBootstrapped + frozen estimates + burn-down report + tier analysis + cli-tier-recommendation. Reference plans at `spec/examples/subscription-plans/`.
* RFC-0010 Phase 3: WorkerPool (bounded concurrency, PPA-priority ordering) + file-based MergeGate (with timeout + force-release) + decideRequeue (failure-type taxonomy + RetriageStorm detection + triage-history JSONL). Per project policy: orchestrator never executes `gh pr merge`.
* RFC-0010 Phase 4: dual-format artifact directory (`.md` + schema-conformant `.json`), 5 JSON schemas at `spec/schemas/artifacts/`, StateWriter with 60s heartbeat + 5min stale detection, `_events.jsonl` event stream, atomic JSON writes, cli-status command.
* RFC-0010 Phase 5: extended operator runbook with five new failure-mode recovery playbooks (WorktreeOwnershipMismatch, RebaseConflict, stuck heartbeats, IndependenceViolated, MigrationDiverged, BranchQuotaExceeded), chaos test plan, feature-flag promotion ritual.

### Notes

The `AI_SDLC_PARALLELISM` flag remains `off` by default. Promotion to default-on requires the chaos-test plan in `docs/operations/operator-runbook.md` to pass and a 1-week dogfood soak window — both deferred to a follow-up release.

## [0.6.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.5.0...orchestrator-v0.6.0) (2026-03-31)


### Features

* add action governance — blockedActions in agent-role.yaml ([#45](https://github.com/ai-sdlc-framework/ai-sdlc/issues/45)) ([eb53342](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eb5334229bfd3f66464c4986efb0c432d1756a3e))
* add automated dogfood pipeline — admission, routing, and PR review workflows ([4583ab6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4583ab65285163ab16e42f140cdd74e87dbfdb9a))
* add pipeline visibility and lint/format to agent context ([8f07b3e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8f07b3ef4bc72c1a3bc48a1ba77e6ab9643420ea))
* add pipeline-level cycle detection ([#41](https://github.com/ai-sdlc-framework/ai-sdlc/issues/41)) ([#42](https://github.com/ai-sdlc-framework/ai-sdlc/issues/42)) ([c730803](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c7308031e4b6f340c1cc195ae876565d0afe6d7d))
* add Slack integration — pipeline visibility and emoji-to-issue trigger ([ec53b7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec53b7c7cd9adf834e17c28fb7e45271d1bd6e9a))
* add trust-based source weighting to PPA admission scoring ([c04ca18](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c04ca1836ce35db8f15f363f1efb5262317eefb0))
* add typecheck command to agent prompt to prevent pre-commit failures ([3497c71](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3497c7191bb2c7a5b34e973a68de3fc2986644ae))
* human-readable agent log output instead of raw NDJSON ([685452f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/685452f8559232d187df0a6a0095f017ef4f0fb8))
* stream agent progress via Claude Code stream-json output ([4c5c5b4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4c5c5b4ead16d2238af4809ec1ea1e1ef954767b))
* workflow pattern detection Phase 1 — telemetry collection ([#50](https://github.com/ai-sdlc-framework/ai-sdlc/issues/50)) ([68f36be](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68f36be6e66dd354b483ed2d851993823d544b7b))
* workflow pattern detection Phases 2-4 — detection, proposals, artifacts ([e6ffd6a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6ffd6aa93cbd9ca27fdb9b2eead4e6f12ed54ac))


### Bug Fixes

* Add missing validation for empty issueBody in SecurityTriageRunner ([#33](https://github.com/ai-sdlc-framework/ai-sdlc/issues/33)) ([#34](https://github.com/ai-sdlc-framework/ai-sdlc/issues/34)) ([9f81e66](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9f81e66dde0950f13272064cb36695cd7c2d8387))
* add real-time observability to Claude Code runner ([bcb2f08](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bcb2f0825f52914fa7b07acd286bbdd97f50dd87))
* address review findings — add schema, audit logging, requireHumanApproval ([e11a79d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e11a79dcacd8ff0f19934e09e18c6e169879a52f))
* Agent should address review findings before human review ([#35](https://github.com/ai-sdlc-framework/ai-sdlc/issues/35)) ([#36](https://github.com/ai-sdlc-framework/ai-sdlc/issues/36)) ([34c7606](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34c7606db4dacdc21875f876f332f8d61bfc4c2a))
* allow review dismissals with documented reason ([c38fa35](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c38fa358d89c6d9d297f68bbb7f4f99fbd008569))
* detect agent commits by diffing against merge-base with main ([5a27dc6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5a27dc66d51c87587f02da1eaa60e46f5fa962b4))
* detect agent-committed changes instead of reporting 'no files modified' ([7b6309d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7b6309d30a0a1a172951ba83cbc542311dc86143))
* only use openshell prefix when provider is explicitly openshell ([e2ea832](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e2ea8324c8de7fb49c16e64bcc21e6d85a4df5e1))
* prevent duplicate .gitignore entries from ensureRuntimeGitignore ([a1ff0fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a1ff0fe49681ea1200059e5eefc40e555915361c))
* resolve issue [#29](https://github.com/ai-sdlc-framework/ai-sdlc/issues/29) ([8b74a6d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b74a6dbe9eee88c85fea40269e79c34ceded39c))
* resolve issue [#37](https://github.com/ai-sdlc-framework/ai-sdlc/issues/37) ([a8b0707](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a8b0707fa96b565a049fd8f123535a6eb885a3ca))
* resolve issue [#46](https://github.com/ai-sdlc-framework/ai-sdlc/issues/46) ([6bd9f39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6bd9f39c84423f688e39f87467c5aea4810e446c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.6.0

## [0.5.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.4.0...orchestrator-v0.5.0) (2026-03-24)


### Features

* add composite IssueTracker adapter for multi-backend routing ([0cf6a12](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0cf6a12cdb21a0592ff448156ea452c8c3ce3e55))
* add NVIDIA OpenShell sandbox integration ([cac7ab2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cac7ab2000f7a04722a16f21b7ac0bdcfd119a95))
* add security triage pipeline and backlog-drift hooks ([8859bf5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8859bf57a3096ffab98786a6f0d5ddbdf4b4ccfd))
* add test coverage reporting with Codecov ([f31137a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f31137a52f3c6ec317c68eef50403e05b2b1c19e))
* address PPA architectural concerns for RFC readiness ([db00094](https://github.com/ai-sdlc-framework/ai-sdlc/commit/db00094b74ed825dc88ddcee885961f01d9a7e17))
* complete OpenShell integration gaps ([905219a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/905219a77e15ab0c7c0398abb6a3adaf2fa75fe6))
* integrate Product Priority Algorithm (PPA) across all SDKs (AISDLC-7) ([bc4a32d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc4a32df4de65eb9c853b33e85aac56690092ecf))
* support multiple AdapterBinding resources per repo ([5a0b39e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5a0b39e56dfb4f24be3c1b726b36201cb6cdad42))
* support string issue IDs and config-driven tracker resolution ([56f3c95](https://github.com/ai-sdlc-framework/ai-sdlc/commit/56f3c95326da253a914f54613a3240147911b25c))
* wire OpenShell sandbox into runner and execution pipeline ([84df6fb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/84df6fb9e136147d33ddd3bb842225b4580c337d))


### Bug Fixes

* Add formatIssueRef and issueIdToNumber unit tests (#AISDLC-4) ([#24](https://github.com/ai-sdlc-framework/ai-sdlc/issues/24)) ([5f5f0cb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5f5f0cb3135ac2977780bb099a6ee106e9e316e9))
* backlog adapter, runner lint/format, and gitignore dedup ([#25](https://github.com/ai-sdlc-framework/ai-sdlc/issues/25)) ([ae44805](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ae4480566181b3f715a7365bccff13968fc883ea))
* prevent duplicate .gitignore entries from ai-sdlc init ([957e89f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/957e89feb5a83b99f26cafaa0009b49738849b44))
* resolve TypeScript build errors in test files ([c3cb763](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c3cb763c0c8635ccc243ceb04aadffc9c2ba57a0))
* use config dir path for triage config loading ([eaa3a7f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eaa3a7fdca49ad2959243b0ce52ddf1309a15944))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.5.0

## [0.4.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.3.0...orchestrator-v0.4.0) (2026-03-08)


### Features

* add Backlog.md IssueTracker adapter ([3b1e11c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3b1e11cb4022680fa8cd9e1e24719e57b607bffe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.4.0

## [0.3.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.2.0...orchestrator-v0.3.0) (2026-03-08)


### Features

* auto-detect coding agents, workspace support, and MCP setup during init ([7d224db](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7d224db1c07035763863298173133ff87354d847))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.3.0

## [0.2.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.1.2...orchestrator-v0.2.0) (2026-03-06)


### Features

* implement RFC-0004 cost governance (phases 1-3) ([34e0e03](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34e0e03a8d01b9a964f71b1096654183c8f6d75f))


### Bug Fixes

* address feedback issues [#3](https://github.com/ai-sdlc-framework/ai-sdlc/issues/3), [#4](https://github.com/ai-sdlc-framework/ai-sdlc/issues/4), [#8](https://github.com/ai-sdlc-framework/ai-sdlc/issues/8), [#9](https://github.com/ai-sdlc-framework/ai-sdlc/issues/9), [#10](https://github.com/ai-sdlc-framework/ai-sdlc/issues/10) ([0efc9dd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0efc9dd78eb1ab1ebfe93507b74650ca6b687926))
* **orchestrator:** use createRequire for better-sqlite3 in ESM context ([d67464a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d67464adf454f4c96c460f96979612ca3fa72609))
* resolve all lint and format errors across codebase ([27526fa](https://github.com/ai-sdlc-framework/ai-sdlc/commit/27526faef49fec6fabca3cfdbb11994721866e90))
* resolve workspace:* leak and invalid init templates ([68404b7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68404b7e92687b558e0e842a3642ddc52613698b))
* sync Go SDK schemas with canonical spec and add publishConfig to packages ([78283b3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/78283b35b2c6986f30e35f92a5ddf01c8e3b3462))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.2.0

## 0.1.2

### Patch Changes

- e37c98a: Fix validation error messages, add validate command, wire gate check runs, and load config into MCP advisor
- Updated dependencies [e37c98a]
  - @ai-sdlc/reference@0.1.2
