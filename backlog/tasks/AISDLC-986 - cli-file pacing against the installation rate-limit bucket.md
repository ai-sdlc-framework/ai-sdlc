---
id: AISDLC-986
title: 'cli-file pacing against the installation rate-limit bucket'
status: In Progress
assignee: []
created_date: '2026-10-20'
labels:
  - tooling
  - ci
dependencies:
  - AISDLC-964
references:
  - pipeline-cli/src/cli/file.ts
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/pre-push-and-ci-reference.md
priority: medium
dispatchable: true
---

## Description

Every CI job authenticates with the installation `GITHUB_TOKEN`, whose REST bucket is 5000 calls per hour shared by every job of the installation. On 2026-10-17 eight filing PRs opened by `cli-file ... --pr` (`pipeline-cli/src/cli/file.ts:11-13`: `cli-file task <path> [--pr]`, `cli-file decision ... [--pr]`, `cli-file rebase <id> [--pr]`) plus the executor PRs in the same window exhausted that bucket. The reds looked unrelated (`ai-sdlc/issue-link`, the Governance gate OQ scan, Dependency review "not supported") but were the same 403 `API rate limit exceeded for installation`, and each red cost a rerun that spent more of the bucket.

Fix: `cli-file --pr` paces filings against the bucket. Before opening a PR it reads `gh api rate_limit` and prints the remaining installation calls and the reset time; when a configurable spacing (default 15 minutes between filings, overridable by flag and config) has not elapsed since the last filing recorded on the board, it either waits or queues the filing as a brief for the next window (`--queue`), never fails silently. The tooling-limitations register that the dependency task creates gets the row for this ceiling with its headroom metric (remaining calls at the start of each filing), and `docs/operations/pre-push-and-ci-reference.md` points at it from the CI section.

**Five-step review (requirements first).**
1. Requirement questioned: is pacing the right lever, or fewer calls per PR? Both; the pacing is the cheap guard while per-job call reduction is tracked in the register.
2. Delete: nothing to delete.
3. Simplify: one spacing value, read from config, one place that records the last filing time.
4. Accelerate: no rerun storms from a bucket exhausted by filings.
5. Automate: the pre-filing bucket read and the queue path remove the operator from the loop.

## Acceptance Criteria

- [ ] `cli-file --pr` prints the remaining installation calls and reset time from `gh api rate_limit` before opening a PR.
- [ ] A configurable spacing (default 15 minutes) between filings is enforced, with `--queue` writing a brief for the next window instead of waiting; tests cover wait, queue and the elapsed case.
- [ ] The tooling-limitations register has a row for the installation bucket with the headroom metric.
- [ ] `docs/operations/pre-push-and-ci-reference.md` links the register row from its CI section.
