---
id: AISDLC-1439
title: "Record GitHub quota and rate-limit errors for both the local token and the CI token, with a weekly report"
status: To Do
priority: high
labels:
  - observability
  - github
dependencies: []
references:
  - pipeline-cli/src/hierarchy/gh-calls.ts
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/tooling-limitations.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator direction 2026-11-26. The operator is weighing larger moves (replacing or rewriting GitHub-dependent tech) and needs evidence. A planner audit found the evidence missing exactly where it matters: (a) `.ai-sdlc/dispatch/gh-calls.jsonl` records only `at`, `session`, `argv`, `exit` for the local operator token: no remaining quota, no resource bucket, no error text, so rate-limit hits are invisible; (b) nothing records the Actions `GITHUB_TOKEN` / installation token quota in CI, which is the bucket that was exhausted on 2026-10-15 (`docs/operations/incidents/2026-10-15-installation-api-quota-exhaustion.md`); (c) `tooling-limitations.md` headroom cells read "unmeasured".
2. Delete: nothing.
3. Simplify: no polling. Local: when a `gh` call fails, record its stderr first line and whether it is a rate-limit error; record `x-ratelimit-remaining`/`-resource` from responses where `gh` exposes them cheaply, otherwise one `rate_limit` read per hour at most. CI: one step at the end of the gate job writes the token's `rate_limit` snapshot (core, graphql) and the run id to the job summary and an artifact; a failed step whose log contains `API rate limit exceeded` is tagged.
4. Accelerate: none.
5. Automate: `cli-hierarchy gh-usage report [--since 7d]` prints per token: calls/h (mean, p95, max), lowest remaining seen, count and times of rate-limit errors, top 10 call shapes. The report is the evidence attached to any `dependency-limit:github` escalation (AISDLC-1438).

## Acceptance Criteria
- [ ] #1 Local ledger entries for failed calls carry the error's first line and a `rateLimited: true|false` flag; a test feeds a canned `API rate limit exceeded` stderr and asserts the flag.
- [ ] #2 The local ledger records remaining quota per resource at least hourly without adding more than one `gh api rate_limit` call per hour per session.
- [ ] #3 The CI gate job ends with a step (runs on success and failure) that records the token's core and graphql remaining/limit/reset with the run id, readable from the run summary and an artifact.
- [ ] #4 `cli-hierarchy gh-usage report --since 7d` prints the per-token figures above; tested on a fixture ledger.
- [ ] #5 `tooling-limitations.md` headroom cells for the user token and the installation token point at the report instead of "unmeasured".
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
