# Incident records and recurring-mistakes ledger

Operational incidents are recorded here so the repository, not a session's memory, says what happened, what was ruled, and whether it has happened before. One file per incident, named `YYYY-MM-DD-<slug>.md`, written with `Write`. Add a row to the index below and update the ledger.

## Template

Copy this shape. Keep it to one screen. The six headings are fixed.

```markdown
# <Incident title>

## What happened

## Impact

## Timeline (UTC)

## Ruling and who made it

(Decision id when one exists.)

## Root cause

## Follow-up

(Task ids when filed.)
```

## Index

| Date | Record | Decisions |
|------|--------|-----------|
| 2026-10-15 | [Installation API quota exhaustion](2026-10-15-installation-api-quota-exhaustion.md) | DEC-0249, DEC-0250 |
| 2026-10-15 | [Webhook forwarder death](2026-10-15-webhook-forwarder-death.md) | DEC-0235 |
| 2026-10-15 | [Decision id allocation collisions](2026-10-15-decision-id-allocation-collisions.md) | DEC-0242 to DEC-0246 |
| 2026-10-16 | [PR head frozen on GitHub](2026-10-16-pr-head-frozen-on-github.md) | none on main |
| 2026-10-30 | [Parent checkout and all worktrees deleted by the pre-push coverage gate](2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md) | operator ruling in chat; fix PR |

## Recurring-mistakes ledger

Append a row, or bump the count and last-seen date, when a mistake recurs. File a rule or automation task when the count justifies it. "none yet" means no rule, doctor check or task addresses it.

| Mistake | Count | Last seen | Addressed by |
|---------|-------|-----------|--------------|
| Every PR push fans out to many workflows and exhausts the shared GitHub token bucket; gate jobs then fail with `API rate limit exceeded for installation` | 2 | 2026-10-16 | DEC-0250 (fan-out cut); [`tooling-limitations.md`](../tooling-limitations.md); `cli-file --pr` pacing (AISDLC-986) |
| Rerunning failed jobs while the bucket is empty spends more of it | 2 | 2026-10-16 | [`tooling-limitations.md`](../tooling-limitations.md) rerun-once-per-head rule |
| A background helper (forwarder, receiver) dies silently and nothing notices | 1 | 2026-10-15 | DEC-0235 (forwarder owned by `cli-hierarchy up/down`, poller backstop); no doctor check yet |
| Decision ids allocated twice for different records (concurrent sessions) | 2 | 2026-10-15 | none yet |
| The same decision record opened twice by one session | 1 | 2026-10-15 | none yet (DEC-0249 mirrors DEC-0250) |
| A PR head on GitHub does not move after a push, so checks and reviews target a stale SHA | 1 | 2026-10-16 | [`pr-unstick.md`](../pr-unstick.md); none yet for detection |
| A git hook's children inherit `GIT_DIR` from a linked worktree and act on the real repository (`core.bare` flips, HEAD moves, fixture teardown deletes the checkout) | 2 (AISDLC-137 nuisance flips; 2026-10-30 full deletion) | 2026-10-30 | [`2026-10-30 incident`](2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md): hook `unset`, `gitSafeEnv()`, `vitest.git-env.setup.mjs`; addressed by the `hook-env-hygiene` doctor check and the `check-orchestrator-state.sh` `parent-checkout` escalation (AISDLC-1129); mandatory `makeGitEnv()` check still to file |
