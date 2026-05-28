# CI Conflict Resolver Runbook (AISDLC-460)

Phase 1 polling watcher + `ci-conflict-resolver` subagent. Together they
auto-rebase auto-merge-armed PRs whose CI failed because `main` moved
ahead, then re-arm auto-merge. The operator no longer has to babysit
the BLOCKED-because-stale failure mode.

## What the system does

1. **`pipeline-cli/src/runtime/ci-failure-watcher.ts`** polls
   `gh pr list --state open --json number,...,statusCheckRollup` every
   60 seconds (configurable). For each open PR the watcher:
   - Classifies the failure shape (`conflict-detected`, `behind-only`,
     `pnpm-lock-regen`, `package-json-bin-concat`, `prettier-drift`,
     `CHANGELOG-merge`, `unclassified`, or `skip` for SUCCESS / DRAFT /
     no-checks-yet).
   - If the shape is rebase-fixable AND no 24h cool-down is active,
     spawns the `ci-conflict-resolver` agent (capped at N=2 concurrent
     per tick).
   - If the agent returns `escalated` / `failed`, writes a cool-down
     record at `.ai-sdlc/ci-conflict-resolver/cooldown/<pr>.json` and
     posts a one-line PR comment (deduplicated on the
     `ai-sdlc/ci-conflict-resolver:` prefix).

2. **`ai-sdlc-plugin/agents/ci-conflict-resolver.md`** is the subagent
   that runs the actual rebase + push. It reuses the rebase-resolver
   mechanical-conflict catalogue (CHANGELOG drop on feature branch,
   test additions to the same describe, prettier drift, pnpm-lock
   regen, package.json `bin:` concat) and escalates the 20% that needs
   human judgment.

## Trigger surfaces (pick one)

### 1. Manual: `/ai-sdlc resolve-conflicts <pr-number>`

Drives the agent against one PR immediately, in the foreground. Cool-down
state respects existing entries on a per-invocation basis but the manual
command always runs regardless of cool-down.

Use when:
- A specific auto-merge-armed PR is stuck and you want it cleared NOW.
- You've fixed whatever was blocking a cool-down'd PR and want to retry
  before the 24h window expires.
- You're testing the agent's flow end-to-end before relying on the
  watcher daemon.

### 2. Cron / standalone daemon: `cli-orchestrator ci-failure-watch`

Single-shot tick or polling loop. Suitable for:
- A `cron` job every 1-5 minutes (`--max-ticks 1`).
- A systemd / launchd / Docker daemon that holds the loop open
  (`--max-ticks` omitted; loop runs forever).

```bash
# Dry-run single tick (no agent spawn — Phase 1 default).
node pipeline-cli/bin/cli-orchestrator.mjs ci-failure-watch

# Daemon loop, polling every 60s.
node pipeline-cli/bin/cli-orchestrator.mjs ci-failure-watch \
  --max-ticks 0 --poll-interval-sec 60

# List the currently active cool-down records.
node pipeline-cli/bin/cli-orchestrator.mjs ci-failure-watch --list-cooldowns
```

> **Note on `--enable-dispatch`** — the standalone CLI does NOT have
> the Claude Code `Agent` tool. `--enable-dispatch` is reserved for
> the future hosting surface that wires the watcher into a session
> that DOES (e.g. an autonomous orchestrator-tick reconciliation
> step). Until then the standalone CLI runs classify-only dry-runs;
> use the slash command for foreground dispatch.

### 3. Recommended (Phase 1 simplest): inside `/ai-sdlc orchestrator-tick`

The autonomous orchestrator tick already runs every 20-30 minutes when
the operator is overnight-draining the backlog. Extending Step 4
(`failed/` verdict poll) to also poll GitHub via `runWatcherTick` is
the lowest-friction wiring — no extra cron, no extra daemon.

This is the **recommended Phase 1 wiring**. The alternative cron-based
approach is documented above for operators who want the watcher to
run independent of an open operator CC session.

## Cost cap

`MAX_CONCURRENT_AGENTS_PER_TICK = 2`. The watcher dispatches at most
2 `ci-conflict-resolver` agents per tick. This protects the operator's
subscription quota — a single bad tick (e.g. 30 BLOCKED PRs after a
big main-branch merge wave) cannot consume the day's allowance.

Tune via the `--max-concurrent-agents` flag. Phase 2 will introduce a
per-window quota check via the SubscriptionLedger (RFC-0010 §11) so
the cap can drift higher under low load.

## Cool-down behavior

When the agent returns `escalated` or `failed`, the watcher writes a
JSON record to:

```
.ai-sdlc/ci-conflict-resolver/cooldown/<pr-number>.json
```

Shape:

```json
{
  "prNumber": 123,
  "classification": "semantic-conflict",
  "escalatedAt": 1748382000000,
  "reason": "semantic-conflict src/foo.ts: both branches modified lines 12-18"
}
```

The watcher checks `Date.now() - escalatedAt < 86_400_000` (24h) on
every tick. PRs with an active cool-down are skipped. After 24h the
record is treated as expired and the agent retries on the next tick.

**The manual slash command (`/ai-sdlc resolve-conflicts`) does NOT
respect cool-downs** — it runs immediately regardless. Use it to retry
a cool-down'd PR after the operator has resolved the blocking issue.

## Comment deduplication

The escalation comment is prefixed with `ai-sdlc/ci-conflict-resolver:`.
Before posting, the watcher fetches the PR's most recent comment; if
it already starts with that prefix, the new comment is suppressed.
This avoids noisy repeat-spam on PRs that hit the watcher across many
ticks before cool-down kicks in.

The comment shape is:

```
ai-sdlc/ci-conflict-resolver: failure shape '<shape>' not auto-resolvable, operator review required (<reason>)
```

## Failure shapes — what the agent handles vs escalates

| Shape | Auto-fixable | Notes |
|---|---|---|
| `behind-only` | Yes | Most common — PR is BEHIND main but no surface failure yet |
| `conflict-detected` | Yes | pr-ready FAILURE/ERROR; agent re-classifies during the rebase |
| `pnpm-lock-regen` | Yes | Accept incoming, run `pnpm install`, re-stage |
| `package-json-bin-concat` | Yes | Concat both sides of `bin:` list additions |
| `prettier-drift` | Yes | Format-on-resolve before `git rebase --continue` |
| `test-additions-overlap` | Yes | Keep both `it(...)` blocks in same describe |
| `CHANGELOG-merge` | No (escalate) | AISDLC-401: agent drops single-side feature edits but escalates "merge both sides" surfaces |
| `modify-vs-delete` | No (escalate) | File deleted on main, modified on branch; needs hand-port |
| `semantic-conflict` | No (escalate) | Both branches modified same lines with different intent |
| `unclassified` | No (skip) | No clear failure surface; do nothing |
| `skip` | No (skip) | SUCCESS / DRAFT / no checks |

## Hard rules (NEVER violate)

The agent enforces these defensively at every step:

1. Never merge a PR (`gh pr merge --merge/--squash/--rebase`).
   `gh pr merge --auto` IS permitted — it only re-attaches the
   auto-merge request, not the merge itself.
2. Force-push only with `--force-with-lease`. Plain `git push --force`
   / `-f` is forbidden.
3. Never push to `main` / `master`. Refused at agent Stage 1 + Stage 7.
4. Never close PRs / issues.
5. Never delete branches.
6. Never edit `.ai-sdlc/**` or `.github/workflows/**`. PreToolUse hook
   blocks anyway.
7. Never write GitHub Actions CI-skip magic tokens (`[skip ci]`,
   `[ci skip]`, etc.).

## Phase 2 — explicitly deferred

The following are out of scope for Phase 1. They will be addressed in
follow-up tasks once Phase 1 polling proves the agent works in
production:

- **Webhook-based push notification** (replaces polling). Requires a
  public endpoint, security review, and a new infra surface.
- **Slack notification fan-out** — the watcher just needs to act, not
  announce.
- **Automatic re-arming after merge-queue rejection** — current
  behavior re-arms auto-merge once post-rebase; merge-queue races are
  Phase 2.
- **Cross-PR dependency resolution** (e.g. PR #A depends on PR #B's
  branch; rebase #A only after #B lands).

## Observability

The watcher writes a structured result per tick:

```json
{
  "scannedPrs": 12,
  "candidatePrs": [123, 456, 789],
  "dispatchedPrs": [123, 456],
  "skippedByCooldown": [789],
  "rebased": [123],
  "escalated": [456],
  "commentedPrs": [456],
  "commentSuppressed": [],
  "classifications": [
    { "prNumber": 123, "shape": "behind-only" },
    { "prNumber": 456, "shape": "conflict-detected" },
    { "prNumber": 789, "shape": "conflict-detected" }
  ]
}
```

When wired into `orchestrator-tick`, the tick's `events.jsonl` writer
will emit one event per dispatched/escalated PR for the dashboard
TUI's CI-watcher pane (RFC-0023 future work).

## Troubleshooting

### "The watcher keeps escalating the same PR"

24h cool-down should kick in after the first escalation. If you see
repeat escalations, check:

1. `.ai-sdlc/ci-conflict-resolver/cooldown/<pr>.json` exists and has
   `escalatedAt` within the last 24h.
2. The watcher process can read/write `<workDir>/.ai-sdlc/`.
3. Two separate watcher processes aren't running with different
   `--work-dir` settings.

### "The agent says push-rejected even though `--force-with-lease` should work"

The remote moved under the watcher between snapshot + push. This is
expected and the cool-down handles it. Next tick (after 24h cool-down
expires) will re-classify against the fresh state.

To retry immediately, run `/ai-sdlc resolve-conflicts <pr>` manually
— the slash command bypasses the cool-down.

### "Operator wants to clear all cool-downs"

```bash
rm -rf .ai-sdlc/ci-conflict-resolver/cooldown/
```

Safe — the next watcher tick will rebuild any still-relevant records.

## References

- Task spec: `backlog/completed/aisdlc-460 - feat-ci-triggered-pr-conflict-resolver-agent.md`
- Agent definition: `ai-sdlc-plugin/agents/ci-conflict-resolver.md`
- Watcher module: `pipeline-cli/src/runtime/ci-failure-watcher.ts`
- Slash command: `ai-sdlc-plugin/commands/resolve-conflicts.md`
- CLI subcommand: `cli-orchestrator ci-failure-watch` (registered in
  `pipeline-cli/src/cli/orchestrator.ts`)
- Sibling: `ai-sdlc-plugin/agents/rebase-resolver.md` (reusable core)
- Sibling runbook: `docs/operations/auto-rebase-stale-prs.md`
- RFC-0010 §11 — SubscriptionLedger (Phase 2 cost-cap target)
- AISDLC-401 — CHANGELOG.md release-please ownership
