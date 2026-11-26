# Installation API quota exhaustion

## What happened

Gate jobs (Detect Changes, Require Linked Issue, Governance gate OQ scan) failed within seconds with `API rate limit exceeded for installation`, turning `ai-sdlc/pr-ready` red on otherwise healthy PRs.

## Impact

PRs could not land while the bucket was empty. Reruns spent more of the bucket, extending the outage. Dispatch paused reruns until the next hourly window.

## Timeline (UTC)

- 2026-10-15: roughly 32 pushes in 90 minutes, each firing 7-8 workflows, drained the 1,000 requests per hour Actions token bucket.
- 2026-10-15 22:45: planner opened DEC-0249, then a duplicate DEC-0250, proposing to cut per-PR fan-out.
- 2026-10-15 22:46: operator chose `full` on DEC-0250.
- 2026-10-16: follow-on exhaustion of the shared installation bucket handled by `cli-file --pr` pacing (AISDLC-986), since removed (DEC-0432 b).

## Ruling and who made it

DEC-0250, operator: CodeQL off `pull_request` (main and weekly only), fold `require-issue-link` and `rfc-lifecycle-check` into `ai-sdlc-gate`, workflow-level trust `if`. DEC-0249 mirrors it and carries no separate authority.

## Root cause

Per-PR workflow fan-out multiplied by push rate exceeded the per-repository token bucket, and failed-job reruns consumed the same bucket.

## Follow-up

Ceiling documented in [`../tooling-limitations.md`](../tooling-limitations.md). The `cli-file --pr` filing spacing added by AISDLC-986 was removed by DEC-0432 b, the operator ruling of 2026-11-26 that overrules DEC-0426 c (AISDLC-1437): the root cause was workflow fan-out, addressed by DEC-0250 and the AISDLC-867 records-only fast lane.
