---
id: AISDLC-460
title: 'feat: CI-triggered PR conflict-resolver agent (auto-rebase on CI failure notification)'
status: To Do
assignee: []
created_date: '2026-05-27'
labels:
  - agent
  - ci
  - automation
  - rebase
  - friction-reduction
dependencies: []
assumes:
  - RFC-0010
references:
  - ai-sdlc-plugin/agents/rebase-resolver.md
  - .github/workflows/ai-sdlc-gate.yml
priority: high
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A specialized agent that **automatically rebases stale-base PRs when CI fails on them**. Reuses the `rebase-resolver` core (manual `/ai-sdlc rebase <pr>` slash command, AISDLC-105) but wires it to a CI-failure notification trigger so the operator doesn't have to babysit auto-merge-armed PRs that get stuck waiting on rebase.

## Problem

Auto-merge-armed PRs sit `BLOCKED` whenever main moves ahead and CI fails on the stale base. The operator has to:
1. Notice the CI failure (Slack notification, GitHub email, or manual `gh pr view` poll)
2. Decide: is this a rebase-fixable failure, or a real test break?
3. Invoke `/ai-sdlc rebase <pr>` manually
4. Wait for it to push
5. Re-arm auto-merge if it dropped

Steps 1-3 are mechanical for the "stale base" failure mode. Steps 4-5 should be automatic. Today they aren't — so the autonomous-overnight pattern has a hole: any auto-merge-armed PR that gets blocked on a rebase sits indefinitely until the operator wakes up.

## Scope (Phase 1)

### CI-failure notification listener

A polling watcher (`pipeline-cli/src/runtime/ci-failure-watcher.ts` or similar) that:
1. Polls `gh pr list --state open --json number,statusCheckRollup` every 60s.
2. For each open PR with `mergeStateStatus: BEHIND` OR a `FAILURE`/`ERROR` conclusion on `ai-sdlc/pr-ready`:
3. Classifies the failure shape via the same heuristics rebase-resolver uses (`conflict-detected`, `test-additions-overlap`, `prettier-drift`, `CHANGELOG-merge`).
4. **Rebase-fixable** → spawns the `ci-conflict-resolver` agent in a worktree, runs the rebase-resolver flow, force-pushes with `--force-with-lease`, re-arms auto-merge.
5. **Non-rebase-fixable** → posts a one-line comment on the PR (`ai-sdlc/ci-conflict-resolver: failure shape '<x>' not auto-resolvable, operator review required`), skips to next PR. Cools-down 24h before re-classifying the same PR (avoid noise).

### `ci-conflict-resolver` subagent

New file `ai-sdlc-plugin/agents/ci-conflict-resolver.md` modeled on `rebase-resolver.md`. Differences from rebase-resolver:
- **Trigger source**: spawned by the watcher (or by `/ai-sdlc orchestrator-tick`'s Step 4 when a `failed/` verdict shape matches), not by `/ai-sdlc rebase`.
- **Input contract**: receives PR number + classified failure shape from the watcher. Re-classifies the failure shape itself defensively (don't trust caller).
- **Output contract**: returns JSON envelope `{prNumber, action: 'rebased'|'escalated', commitSha?, pushedBranch?, escalationReason?}`.
- **Hard rules**: identical to rebase-resolver (never merge, never force-push to main, never close, never edit `.ai-sdlc/**` or `.github/workflows/**`, never write CI-skip tokens).
- **Cap**: never operate on more than N=2 PRs concurrently per watcher tick (subscription cost protection).

### Trigger surfaces

Phase 1 ships two trigger surfaces:
1. **Manual invocation**: `/ai-sdlc resolve-conflicts <pr-number>` slash command body that spawns the agent in foreground.
2. **Watcher daemon**: `cli-orchestrator ci-failure-watch` subcommand that runs the polling loop. Operator can wire it to cron OR to the existing autonomous orchestrator tick (Step 4 `failed/` poll extended to also poll GitHub).

### Out of scope (defer)

- Webhook-based push notification (vs polling) — requires a public endpoint, security review, and a new infra surface. Phase 2 once Phase 1 polling proves the agent works.
- Slack notification fan-out — Phase 2; the watcher just needs to act, not announce.
- Automatic re-arming after merge-queue rejection — Phase 2.
- Cross-PR dependency resolution (e.g. "PR #A depends on #B's branch; rebase #A only after #B lands") — Phase 2.

### Tests

- Hermetic mocks of `gh pr list` JSON payloads covering: BEHIND, FAILURE-on-pr-ready, SUCCESS (skip), DRAFT (skip), no-checks-yet (skip).
- Classification heuristics covered against representative fixtures from the rebase-resolver test suite.
- 24h cool-down respected on repeat classifications.
- N=2 concurrent cap respected.
- Failure mode: agent returns `escalated` → watcher posts the one-line comment exactly once (deduplicated on `ai-sdlc/ci-conflict-resolver:` prefix).

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ai-sdlc-plugin/agents/ci-conflict-resolver.md` ships with frontmatter + hard rules + trigger contract documented
- [ ] #2 `pipeline-cli/src/runtime/ci-failure-watcher.ts` (or similar) polls open PRs and classifies failure shapes
- [ ] #3 Rebase-fixable failures spawn the agent in a worktree; agent runs rebase-resolver flow; force-pushes; re-arms auto-merge
- [ ] #4 Non-rebase-fixable failures post a one-line comment and respect 24h cool-down
- [ ] #5 N=2 concurrent-PR cap enforced per watcher tick
- [ ] #6 `/ai-sdlc resolve-conflicts <pr-number>` manual slash command surface
- [ ] #7 `cli-orchestrator ci-failure-watch` subcommand surface (cron-wireable)
- [ ] #8 Hermetic tests cover all classification shapes + cool-down + concurrency cap + deduplicated comments
- [ ] #9 Operator runbook at `docs/operations/ci-conflict-resolver.md` documents trigger surfaces, cost-cap, and Phase 2 deferrals
- [ ] #10 Agent never merges PRs, never force-pushes to main, never edits `.ai-sdlc/**` or `.github/workflows/**`
<!-- AC:END -->

## Out of scope

- Webhook trigger (Phase 2)
- Slack fan-out (Phase 2)
- Cross-PR dependency resolution (Phase 2)
- Re-classification on failed rebase attempts (single attempt per cool-down window — operator escalation after)

## References

- ai-sdlc-plugin/agents/rebase-resolver.md (reusable core)
- spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md (SubscriptionLedger for cost-cap)
- AISDLC-105 (rebase-resolver original)
- AISDLC-401 (CHANGELOG conflict handling)
