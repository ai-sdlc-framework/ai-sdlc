---
id: AISDLC-377.5
title: 'feat(cli-deps): RFC-0041 Phase 3.2 — `cli-deps frontier` recommendedWorkerKind annotation'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0041
  - phase-3
  - cli-deps
  - operator-ux
parentTaskId: AISDLC-377
dependencies:
  - AISDLC-377.1
priority: low
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - pipeline-cli/src/cli/deps.ts
  - pipeline-cli/docs/deps.md
---

## Scope (RFC-0041 §7 Phase 3.2)

Adds a `recommendedWorkerKind` annotation to each frontier entry in `cli-deps frontier --format table` so operators can see, at a glance, which Worker kind the task is best dispatched to (based on estimated cost + task complexity).

### Heuristic

For each frontier task, recommend:
- `claude-p-shell` when: task `estimatedTokens > 100_000` (per RFC-0010 §14.6 estimate) AND operator's subscription quota utilization > 80% AND `claudePShellMaxConcurrent > 0` (supervisor configured) — i.e. the task is big AND the subscription is tight AND headless is available
- `in-session-agent` otherwise (the cost-preferred default)
- `any` when no clear preference (e.g. when subscription quota is plentiful AND task is small)

### Deliverables

1. **Heuristic implementation** in `pipeline-cli/src/cli/cli-deps.ts`:
   - Read `dispatch-config.yaml` for `claudePShellMaxConcurrent`
   - Read subscription quota utilization from `$ARTIFACTS_DIR/_ledger/`
   - Read `estimatedTokens` from task frontmatter (RFC-0010 §6.5)
   - Output `recommendedWorkerKind` column

2. **Table format update**:
```
ID            Title                      EffPri  CPL  Deps      RecKind         Notes
-----------   -----------------------    ------  ---  --------  --------------- -----
AISDLC-378.1  feat: small docs change    3       0    (none)    in-session-agent
AISDLC-379    feat: huge RFC-0010 phase  4       2    AISDLC-X  claude-p-shell  high tokens
```

3. **Format flags**: `--format json` emits the field; `--format table` adds the column; legacy callers unaffected

## Acceptance criteria

- [ ] #1 `recommendedWorkerKind` field added to `cli-deps frontier --format json` output (one of `in-session-agent | claude-p-shell | any`)
- [ ] #2 `--format table` includes new `RecKind` column
- [ ] #3 Heuristic implemented per §Scope; reads `dispatch-config.yaml` + quota utilization + task `estimatedTokens`
- [ ] #4 When `dispatch-config.yaml` absent or `claudePShellMaxConcurrent: 0`, every entry recommends `in-session-agent`
- [ ] #5 When task `estimatedTokens` absent, recommends `any` (no signal)
- [ ] #6 Hermetic test: 3-task fixture with varying token estimates + simulated quota states → correct recommendations emitted
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- Auto-tagging manifests with the recommended kind (Conductor still chooses; this is operator info only)
- Quota utilization measurement (reuses existing `_ledger/` data; no new ledger work)
- Multi-tenant quota accounting (single-operator scope)

## Source

RFC-0041 §7 Phase 3.2 deliverable.
