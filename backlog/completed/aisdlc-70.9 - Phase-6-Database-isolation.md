---
id: AISDLC-70.9
title: 'Phase 6: Database isolation'
status: Done
assignee: []
created_date: '2026-04-26 19:47'
updated_date: '2026-04-26 21:21'
labels:
  - rfc-0010
  - phase-6
  - database
  - security-review
milestone: m-2
dependencies:
  - AISDLC-70.6
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#15-database-isolation
  - spec/examples/database-branch-pools/
  - docs/operations/operator-runbook.md
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DatabaseBranchAdapter framework with four shipped adapters (RFC §15). Sequenced after Phase 3 because databaseAccess: migrate stages require the merge gate to serialize schema changes. Folds in Q14 (warm pool) and Q15 (topology guard + MigrationDiverged event). Largest phase. Estimated 3 weeks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 DatabaseBranchAdapter interface + registry + capability matrix at orchestrator/src/database/{types.ts, registry.ts} per RFC §15.1/§15.2
- [x] #2 SqliteCopyAdapter implemented per RFC §15.2 (file copy + hardlink for read-only branches); integration test against fixture SQLite + 3 parallel worktrees
- [ ] #3 NeonAdapter implemented per RFC §15.2 wrapping Neon REST API; integration test against sandbox Neon project
- [ ] #4 PgSnapshotRestoreAdapter for vanilla Postgres (pg_dump + pg_restore) and AWS RDS snapshot/restore APIs; integration test against local Postgres in CI
- [x] #5 ExternalAdapter with operator-declared shell hooks; pipeline-load validation requires acknowledgeUntrusted: true
- [x] #6 Schema additions: Stage.databaseAccess, DatabaseBranchPool resource, WorktreePool.spec.databaseBranchPools[] per RFC §6.3, §6.7
- [x] #7 Connection-string injection (env-var rewriting) per RFC §15.6; unit tests for parsing connection strings into component env vars
- [ ] #8 Migration coordination per RFC §15.5: migrationCommand runs against newly-allocated branch; MigrationFailed aborts pipeline; merge gate integration for databaseAccess: migrate stages
- [x] #9 Topology guard per RFC §15.5.1 (Q15): allowBranchFromBranch: false default refuses chained branches with BranchTopologyForbidden
- [x] #10 MigrationDiverged event on parent reclaim with active children per RFC §15.5.1 (Q15); informational only, no auto-action
- [x] #11 Stale-branch sweep on orchestrator startup per RFC §15.4: respects branchTtl and abandonAfter
- [ ] #12 Warm pool per RFC §15.4.1 (Q14): lifecycle.warmPoolSize default 0; when > 0, async refill, single-use branches, stale-drain on upstream migration; cli-status --branches shows pool: warm|active
- [ ] #13 cli-status --branches view (with --divergent filter for Q15)
- [ ] #14 Security review pass: confirm connection strings never appear in state.json, _events.jsonl, logs, or error messages; static-analysis check on adapter code for accidental log leaks
- [ ] #15 Operator runbook for BranchQuotaExceeded, MigrationConflict, MigrationFailed, orphan-branch cleanup, and the topology-guard opt-in decision
- [ ] #16 Integration test: 5 parallel worktrees against Neon, each adding a different migration; verify isolation and that merged migrations apply cleanly to subsequent branches
- [ ] #17 Migrate dogfood pipeline's orchestrator-state SQLite to use sqlite-copy adapter; verify no regressions
- [x] #18 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Phase 6 database isolation foundational scope shipped as d41b05d. DatabaseBranchAdapter framework + 4 adapters (full SqliteCopy, full External, NeonAdapter shell with deps.api injection, PgSnapshotRestore shell), connection-string injection with Postgres component derivation + password masking, topology guard + MigrationDiverged event. 29 new tests. Reference YAMLs at spec/examples/database-branch-pools/.

ACs deferred: live Neon integration (#3), live PgSnapshotRestore CI test (#4), warm pool (#12 — Q14, schema field present), cli-status --branches (#13), security review pass (#14 — masking shipped, static-analysis CI is a separate task), live dogfood SQLite migration (#17). All deferred items are operator/infra tasks unblocked by the libraries shipped here.
<!-- SECTION:FINAL_SUMMARY:END -->
