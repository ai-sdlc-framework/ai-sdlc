---
id: AISDLC-927
title: 'fix: cut per-push workflow fan-out so the GitHub App installation quota stops exhausting every hour'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [bug, ci, velocity, token-cost, github-actions]
dependencies: []
references: [.github/workflows/codeql.yml, .github/workflows/attestation-post.yml, .github/workflows/ai-sdlc-gate.yml, .github/workflows/main-health-monitor.yml, .github/workflows/require-issue-link.yml, docs/operations/quality-gate.md]
priority: high
dispatchable: true
---

## Description

The repository's GitHub App shares one installation budget of 5000 API calls per hour across every workflow run. On 2026-10-15 it was exhausted from 17:50Z to past 19:01Z and every check that calls the API (`Detect Changes`, `ai-sdlc/issue-link`, `ai-sdlc/pr-ready`, attestation-post) failed on every open PR with `API rate limit exceeded for installation`. Nothing could land for over an hour, including the critical-path PRs, and each blanket rerun re-exhausted the fresh budget within minutes.

Between 18:00Z and 19:05Z the repository started about 200 workflow runs: CodeQL 32, CodeQL Code Quality 29, attestation-post 36 (22 failed), AI-SDLC PR Ready Gate 27 (8 cancelled), Require Linked Issue 30 (11 failed), Untrusted-Contributor gate 30, Main Health Monitor 5 (3 cancelled). Every push to any PR fans out into seven to nine runs; docs-only and record-only PRs pay the same.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must every push run every workflow? No. CodeQL has nothing to scan on a backlog or decision-record diff; attestation-post has nothing to post when the attestation gate did not run; the untrusted gate exits at once for a trusted PR but still costs a run and its API calls. 2. Deleted: runs that cannot change the outcome. 3. Simplified: one `paths`/`paths-ignore` rule per workflow, derived from the same docs-only predicate the gate already uses. 4. Accelerated: fewer runs means the budget lasts the hour and PRs land on the first attempt. 5. Automated: a workflow-level test asserts the trigger filters, and the tick line reports the installation quota.

Scope, in order of saving:
- CodeQL and CodeQL Code Quality: run on `pull_request` only for code paths (`pipeline-cli/**`, `orchestrator/**`, `ai-sdlc-plugin/**`, `reference/**`, `scripts/**`, `.github/workflows/**`), never for `backlog/**`, `.ai-sdlc/_decisions/**`, `docs/**`, `spec/**`; keep the weekly full scan and the `push` to main.
- attestation-post: skip at the workflow level (job `if`) when the triggering gate run did not execute the attestation job, before any `gh` call. Decide whether docs-only PRs need the status at all.
- Untrusted-Contributor gate: move the trust test into the trigger where GitHub allows it, or make the first step a zero-API-call exit.
- Main Health Monitor: it already cancels superseded runs; confirm the cancelled runs make no API calls before cancellation.
- Expose the installation quota: the gate (or the reconciler, AISDLC-926) reads `x-ratelimit-remaining` and `x-ratelimit-reset` from one authenticated call and writes them to the tick line, so dispatch knows when a rerun can succeed instead of guessing.

A change that removes a scan from a code path, or stops posting a status that branch protection or the attestation trust chain reads, is a governance weakening and needs a decision record first; path filtering that keeps every scan for code is not.

## Acceptance Criteria

- [ ] A push to a PR whose diff touches only `backlog/**`, `.ai-sdlc/_decisions/**`, `docs/**` or `spec/**` starts no CodeQL run and no attestation-post run; a push touching a code path starts them as today.
- [ ] attestation-post makes no API call when the attestation job of the triggering gate run was skipped.
- [ ] The trusted-PR path of the untrusted-contributor gate makes no API call (or the workflow does not start for a collaborator's branch).
- [ ] The tick summary line (or the gate summary) shows the installation quota remaining and its reset time.
- [ ] `.github/workflows/__tests__/` has a test asserting the trigger path filters of the changed workflows, so a later edit cannot silently widen them.
- [ ] Workflow run count per PR push drops from seven or more to at most four for docs-only pushes; record the before/after counts in the PR body.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Observed 2026-10-15; counts from `gh run list --created ">=2026-10-15T18:00:00Z"`. Related: AISDLC-926 (reconciler treats rate-limit reds as wait-and-rerun), AISDLC-727 (one CI run per PR), AISDLC-867 (records-only fast lane in the gate).
