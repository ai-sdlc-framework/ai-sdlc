# Billing and cost optimization — calling the AI-SDLC orchestrator

> **Audience**: AI-SDLC adopters who run the framework against their own
> projects (forge teams, internal dogfood operators, third-party adopters
> shipping with the marketplace plugin).
>
> **Purpose**: explain every supported way to invoke the orchestrator, which
> Claude account / billing pool each one consumes, and the recommended pattern
> for keeping cost low.

If you're new to AI-SDLC, start with [`docs/operations/operator-runbook.md`](./operator-runbook.md). Come here when you need to understand the cost implications of each dispatch path or you're wiring CI / GitHub Actions and want to avoid surprise bills.

---

## TL;DR — pick the right path

| You want to… | Run | Bills against |
|---|---|---|
| Type a one-off task interactively | `/ai-sdlc execute <task-id>` in Claude Code | Your **interactive Max-20x quota** |
| **Continuous autonomous loop — zero incremental cost (post-2026-06-15)** | `/ai-sdlc orchestrator-tick` in an active Claude Code session | Your **interactive Max-20x quota** (Agent SDK credit NOT drawn) |
| Dispatch a single backlog task headless from a terminal | `node pipeline-cli/bin/ai-sdlc-pipeline.mjs execute <task-id> --run --spawner api-key` | **$200/mo Agent SDK credit** (Max-20x), then API-key overflow |
| Run an autonomous loop on the dispatch frontier (cron/daemon) | `cli-orchestrator tick --spawner claude` | **$200/mo Agent SDK credit** (Max-20x), then API-key overflow (post-2026-06-15; uses `claude -p` which the credit covers) |
| Run reviewers + attestation IN CI on every push | `ai-sdlc-review.yml` GitHub Actions | **$200/mo Agent SDK credit** (Max-20x), then API-key overflow |
| Skip CI-side reviewers when local attestation already signed | Sign locally first; CI's `verify-attestation.yml` short-circuits | Local sign uses no LLM (pure crypto). **FREE.** |

The single most impactful cost-saving habit: **always sign attestation locally before pushing.** Local sign uses your machine's signing key + a content-hash computation — no Claude API call. CI verifies the signature (also free) and skips its own reviewers. The CI-side review only fires when local attestation is missing — that's the fallback cost.

---

## What changed June 15, 2026

Anthropic introduced a separate monthly **Agent SDK credit** that is allocated alongside (and separate from) your interactive Claude subscription quota:

| Plan | Monthly Agent SDK credit |
|---|---|
| Pro | $20 |
| Max 5x | $100 |
| **Max 20x** | **$200** |
| Team Standard | $20 |
| Team Premium | $100 |
| Enterprise | varies |

The Agent SDK credit applies to:

- The Claude Agent SDK (Python or TypeScript) called from your own apps
- The `claude -p` (also `claude --print`) non-interactive CLI mode
- Claude Code GitHub Actions integrations
- Any third-party app that authenticates via the Agent SDK using your subscription

It does **not** apply to interactive Claude Code (typing in the chat / spawning subagents inside an interactive session) — that still draws from your interactive Max-20x quota.

Unused credit doesn't roll over. Once exhausted, traffic falls through to API-key pay-as-you-go IF you've explicitly enabled overflow charges; otherwise requests stop until the credit refreshes monthly.

**Adopter action required**: claim the credit via the email Anthropic sends to eligible accounts ahead of the cutover. One-time opt-in.

---

## Every supported invocation path

### 1. `/ai-sdlc execute <task-id>` (operator-typed slash command)

**Where it runs**: inside an interactive Claude Code session, started by typing the slash command in the chat.

**Bills against**: your **interactive Max-20x quota**. Same pool as your normal Claude Code chatting + subagent fan-out.

**When to use it**: ad-hoc dispatch of a single backlog task while you're already at the keyboard.

**Cost shape**: each dispatch fans out 1 dev subagent + (up to) 3 reviewer subagents + signing. On a typical task that's roughly 100K–500K tokens of interactive quota.

**Resume on failure**: limited. If the slash command body fails mid-pipeline, the recovery path is `cli-orchestrator tick` (autonomous orchestrator). See [`recovery-flows.md`](./recovery-flows.md) (filed as AISDLC-273 — pending).

---

### 1b. `/ai-sdlc orchestrator-tick` (subscription-only autonomous loop) — recommended post-2026-06-15

> **This is the preferred high-throughput path post-2026-06-15.** It runs an
> unlimited autonomous dispatch loop at zero incremental cost as long as one
> Claude Code session stays alive.

**Where it runs**: inside an active Claude Code session, started by typing the slash command once. `ScheduleWakeup` fires the next tick every 30 seconds automatically.

**Bills against**: your **interactive Max-20x quota** — the same pool as your normal Claude Code chatting. The Agent SDK credit pool ($200/mo) is NOT drawn, because the dispatch happens inside a human-driven interactive session turn, not a non-interactive Agent SDK invocation.

**When to use it**: continuous autonomous backlog churning on Max-20x subscription where you want zero cost above your existing subscription fee.

**How it works**:

The `/ai-sdlc orchestrator-tick` slash command is the "consumer bridge" for the `--spawner claude-cli` inline path (AISDLC-225 / RFC-0015):

1. The command calls `cli-orchestrator tick --max-concurrent 1`. The orchestrator's `ClaudeCliInlineSpawner` writes a `dispatch-manifest.json` to `$ARTIFACTS_DIR/_orchestrator/` and returns `{status: 'manifest-emitted'}` without invoking any LLM.
2. The slash command body (which runs in the main Claude Code session) reads the manifest and calls the `Agent` tool with the manifest's parameters.
3. Because the `Agent` call is made from inside an interactive session turn, it draws from the operator's interactive quota — NOT the Agent SDK credit pool.
4. After the subagent completes, the slash command writes `dispatch-result.json` and runs the continuation tick (Steps 6+ of the pipeline: reviewer fan-out, attestation, PR open).
5. `ScheduleWakeup(30s)` fires — the next tick starts automatically 30 seconds later.

**Trade-off**: requires ONE active Claude Code session to remain open. The session can hibernate (no keyboard activity) between ticks; `ScheduleWakeup` wakes it automatically. If the session terminates, the loop stops until you restart it.

**Side-by-side comparison**:

| | `/ai-sdlc orchestrator-tick` (subscription loop) | `cli-orchestrator tick --spawner claude` (cron/daemon) |
|---|---|---|
| **Billing pool** | Interactive Max-20x quota | Agent SDK credit pool ($200/mo), then API overflow |
| **Post-2026-06-15 incremental cost** | **$0** (part of subscription) | First $200/mo free, then pay-as-you-go per token |
| **Requires active session?** | Yes — one terminal with Claude Code open | No — runs headless from cron/daemon/sidecar |
| **Recovery on session crash** | Operator restarts session + fires command again | Loop auto-restarts via cron/daemon |
| **Max throughput** | Bounded by interactive quota | Bounded by SDK credit pool ($200/mo) |
| **Setup complexity** | One command | Requires cron/systemd/daemon setup |

**Operator quickstart**:

```bash
# 1. Enable the experimental orchestrator flag (add to your shell profile):
export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental

# 2. Open a dedicated terminal and start Claude Code in your project root:
cd /path/to/your/project
claude

# 3. Fire the tick once — ScheduleWakeup handles the rest:
/ai-sdlc orchestrator-tick

# The loop now runs indefinitely every 30 seconds.
# To run a single tick without looping:
/ai-sdlc orchestrator-tick --once
```

**Cost projection — 20 tasks/day throughput**:

| Path | Monthly tasks | Incremental cost (post-2026-06-15) |
|---|---|---|
| Subscription loop (`/ai-sdlc orchestrator-tick`) | ~600/mo | **$0** — subscription covers it |
| SDK credit pool (`cli-orchestrator tick --spawner claude`) | ~600/mo | First $200/mo free; typical ~$0.50–$2 per task → $300–$1,200/mo overflow after credit exhausted |
| Pure API-key (`--spawner api-key`) | ~600/mo | ~$0.50–$2 per task direct = $300–$1,200/mo |

> **Note**: the "incremental cost $0" assumes your Max-20x subscription's interactive quota is not already saturated by other use. If you run heavy interactive workloads in parallel, the autonomous loop competes for the same pool. In practice, between-tick hibernation means the loop's share of the interactive quota is small relative to the dispatch subagent's wall-clock time.

**What happens if the Claude Code session crashes or closes mid-loop?**

1. **Worktrees survive on disk.** Any in-flight task's worktree at `.worktrees/<task-id>/` is preserved. No code is lost.
2. **Recovery detection.** The next `cli-orchestrator tick` run detects in-flight tasks via the AISDLC-242 recoverable-abort path (or the AISDLC-273 resume-from-draft mechanism when the task already has a PR).
3. **Restart.** Open a new Claude Code session in the same project directory, set `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`, and fire `/ai-sdlc orchestrator-tick` again. The orchestrator's tick loop picks up where it left off — unfinished tasks re-enter the dispatch frontier.

```bash
# Recovery after session crash:
export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental
claude  # open new session in project root
/ai-sdlc orchestrator-tick  # loop resumes
```

---

### 2. `ai-sdlc-pipeline execute <task-id> --run --spawner api-key` (headless one-shot)

**Where it runs**: any Node-capable terminal. Does not require Claude Code.

**Bills against**:
- **Pre-2026-06-15**: API-key pay-as-you-go (`ANTHROPIC_API_KEY`)
- **Post-2026-06-15**: $200/mo Agent SDK credit first, then API-key overflow if enabled

**When to use it**:
- Autonomous Bash dispatch from CI / a daemon / a script
- Operators who want headless dispatch without typing into Claude Code
- Any context where you can't / don't want to use the operator's interactive subscription

**Cost shape**: single Node process runs the full Step 0–13 pipeline inline (`executePipeline()`). Step 9 iteration handles up to 2 review→fix rounds within the same session.

**Setup**:

```bash
# Your account must have an API key with subscription access enabled.
export ANTHROPIC_API_KEY="sk-ant-..."

# Install the SDK lazy peer if not already:
pnpm add @anthropic-ai/claude-code

# Run:
node pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-NNN --run --spawner api-key
```

The `--run` flag is required to actually execute (default is `--dry-run` for safety).

---

### 3. `cli-orchestrator start` (autonomous polling loop)

**Where it runs**: long-lived process (terminal, systemd, Docker, GitHub Actions self-hosted runner).

**Bills against**:
- **Default spawner is `ShellClaudePSpawner` → `claude -p`**
- **Pre-2026-06-15**: same pool as your interactive Max-20x (or pay-as-you-go if `ANTHROPIC_API_KEY` is set in env)
- **Post-2026-06-15**: $200/mo Agent SDK credit (the Anthropic article explicitly lists `claude -p` as covered)

**When to use it**: continuous dogfood / production dispatch — orchestrator polls the backlog, picks up tasks as they become DoR-ready, dispatches in parallel up to the configured concurrency.

**Cost shape**: per-tick cost depends on dispatch rate. With `maxConcurrent=1` and one ready task per minute, ~1 dev + 3 reviewer subagent invocations per minute. Most tasks take 5–15 minutes wall-clock.

**Setup**:

```bash
# Required: opt into the experimental flag.
export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental

# Start the loop:
node pipeline-cli/bin/cli-orchestrator.mjs start
```

The loop respects `AISDLC-242` recoverable-abort detection — interrupted dispatches resume on the next tick. See [`pipeline-cli/docs/orchestrator.md`](../../pipeline-cli/docs/orchestrator.md) for the full operator runbook.

---

### 4. CI-side reviewers — `ai-sdlc-review.yml` + `verify-attestation.yml` GitHub Actions

**Where it runs**: GitHub Actions runners on every push / PR / merge_group event.

**Bills against**:
- The runner must have `ANTHROPIC_API_KEY` set in repo secrets to run reviewers
- **Pre-2026-06-15**: API-key pay-as-you-go
- **Post-2026-06-15**: $200/mo Agent SDK credit (the SDK is what the workflow uses internally)

**When it fires**:
- `verify-attestation.yml` runs on every PR; if the local DSSE envelope at `.ai-sdlc/attestations/<head-sha>.dsse.json` is valid → posts `ai-sdlc/attestation: success` and **skips CI-side reviewers**
- `ai-sdlc-review.yml`'s `Post Review Results` runs CI-side reviewers ONLY when local attestation is missing (cost-saver fallback)

**Cost shape**: 3 reviewer subagent runs per PR with no local attestation. Avoidable by signing locally.

**Setup**:

```yaml
# .github/workflows/ — both files come from `ai-sdlc init --with-workflows`
# Repo secret `ANTHROPIC_API_KEY` only needs to be set if you want the
# CI-side fallback reviewers to actually fire. If unset, the fallback
# silently skips ("Post Review Results: skipped (budget exhausted)") — at
# the cost of any PR without a local attestation NEVER getting reviewed.
```

---

## Billing-safety checklist (AISDLC-352)

Run through this before every autonomous tick session to avoid surprise API-key charges:

1. **Use `--spawner claude` (or rely on the new default).**
   Since AISDLC-352, `cli-orchestrator tick` defaults to `--spawner claude`. You no longer need to pass the flag explicitly for cron/daemon dispatch. If you have a legacy script that passes `--spawner claude-cli` from a plain shell (not inside a Claude Code session), update it to `--spawner claude` — the `claude-cli` spawner emits a manifest that nothing reads in a plain shell, causing silent `developer-json-contract-violated` failures.

2. **Unset `ANTHROPIC_API_KEY` unless you intend to use API-key billing.**
   When `ANTHROPIC_API_KEY` is set and you run `cli-orchestrator tick --spawner claude`, the CLI emits this warning to stderr:

   ```
   [orchestrator] warning: ANTHROPIC_API_KEY is set but --spawner claude is requested.
   If the dispatch falls back to --spawner api-key for any reason, you'll be billed
   for paid API tokens. To force subscription-only, unset ANTHROPIC_API_KEY before
   running the tick.
   ```

   The `claude` spawner itself does NOT consume the API key. But if `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is also set, a spawner error will silently retry with paid API tokens. Unset `ANTHROPIC_API_KEY` to prevent any accidental billing.

3. **Watch for the `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK` warning.**
   When `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is set AND the configured spawner is not `api-key`, the CLI emits:

   ```
   [orchestrator] warning: AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key is set.
   If the configured spawner is unavailable the orchestrator will silently retry
   with --spawner api-key, billing paid API tokens. Unset ANTHROPIC_API_KEY to
   prevent API-key overflow, or unset AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK to
   disable the silent fallback entirely.
   ```

   This warning fires at the start of every tick so you can catch the misconfiguration before a billing event occurs.

---

## Cost optimization patterns

### Pattern 1 — Always sign locally first ⭐ (most impactful)

Local sign costs **zero LLM tokens**. The pre-push hook (`scripts/check-attestation-sign.sh`) detects the per-worktree `.active-task` sentinel + verdict file and auto-signs the DSSE envelope. CI's `verify-attestation.yml` then accepts the signature and posts `success` — bypassing CI-side reviewers entirely.

Most adopters who watched their bill soar discovered they were signing in CI when they could have signed locally. Wire your dispatch to:

1. Run the dev + reviewers + sign step on the **operator's machine** (or CI runner with subscription auth)
2. Push the signed envelope as part of the PR
3. CI verifies (free) and skips its own reviewers

This is why `/ai-sdlc execute` and `cli-orchestrator start` route the entire Step 0–13 pipeline through the local spawner.

### Pattern 2 — Cap CI fallback to "no API key" (current best practice)

If you do NOT want CI to fall back on API-key reviewers, simply **don't set `ANTHROPIC_API_KEY`** as a repo secret. The CI-side reviewer step will then post `skipped (budget exhausted)` — no LLM call, no cost. PRs without local attestation will still post `ai-sdlc/attestation: failure` (the verifier sees no envelope), so the gate still fires; you just don't get an autonomous fix path.

This is what the dogfood repo currently does. Operators are forced to fix the missing-attestation locally + re-push, which keeps the cost at zero.

**Limitation**: this is a "by absence" guard. A future contributor adds the secret and the cost reappears with no warning. Track AISDLC-N (TBD) for an explicit allowlist mechanism: "only run CI-side reviewers when commit body includes `ai-sdlc-review-fallback: yes`" or similar.

### Pattern 3 — Route bulk dispatch to the SDK credit pool, not interactive

When you have a queue of N tasks to dispatch tonight (e.g. dogfood batch), prefer:

- ✅ `cli-orchestrator start` (uses `claude -p` → SDK credit pool post-cutover)
- ✅ `ai-sdlc-pipeline execute --run --spawner api-key` (uses SDK directly → SDK credit pool post-cutover)
- ❌ Spawning `Agent({subagent_type: "developer"})` from inside an interactive Claude Code session (eats interactive quota — the SDK credit doesn't help)

Tonight's interactive quota is finite. The SDK credit is a separate $200/mo pool. Routing autonomous work to the SDK pool keeps your interactive ceiling free for ad-hoc work + chat.

### Pattern 4 — Track your burn

```bash
# Watch the orchestrator's burn-down report:
node pipeline-cli/bin/cli-orchestrator.mjs status

# Cost-governance ledger (RFC-0004):
ls -la .ai-sdlc/artifacts/_cost/
```

The ledger records every dispatch's token consumption + estimated dollar cost. Wire it into your operator dashboard or check it weekly.

---

## Decision tree

```
                       ┌──────────────────────────────────┐
                       │  Is this an interactive ad-hoc   │
                       │   "do this one task right now"?  │
                       └──────┬────────────────┬──────────┘
                              │ Yes            │ No
                              ▼                ▼
                    ┌───────────────┐  ┌──────────────────────┐
                    │ /ai-sdlc      │  │ Are you OK using API │
                    │ execute       │  │ key billing?         │
                    │ (interactive) │  └──┬───────────────┬───┘
                    └───────────────┘     │ Yes           │ No
                                          ▼               ▼
                              ┌─────────────────┐  ┌──────────────────┐
                              │ Single task?    │  │ /ai-sdlc execute │
                              └──┬───────────┬──┘  │ (interactive)    │
                                 │ Yes       │ No  │ OR cli-orch start│
                                 ▼           ▼     │ (uses claude -p) │
                    ┌─────────────────┐  ┌────────────────────────────┐
                    │ ai-sdlc-pipeline│  │ cli-orchestrator start     │
                    │ execute --run   │  │ (autonomous loop)          │
                    │ --spawner api-  │  │                            │
                    │ key             │  │                            │
                    └─────────────────┘  └────────────────────────────┘
```

For CI: always sign locally first. CI-side review is fallback, not primary.

---

## Common questions

**Q. I'm on Pro, can I run `cli-orchestrator start` autonomously?**

Yes — same architecture, just smaller credit pool ($20/mo). One dispatch consumes ~$0.50–$2 of credit; budget accordingly.

**Q. Does `ai-sdlc-pipeline execute --spawner claude-cli` use the SDK credit?**

Currently no — the `claude-cli` spawner uses the inline-manifest protocol that requires an operator-typed `/ai-sdlc orchestrator-tick` consumer. That consumer runs in interactive Claude Code → interactive quota. (Open issue: post-cutover the inline-manifest path could route through `claude -p` instead — file an ask if this matters for your setup.)

**Q. My CI is silently skipping reviewers — is that a problem?**

It means your repo's `ANTHROPIC_API_KEY` secret is unset (or your local attestation IS valid). Check `gh pr checks <pr>` — if you see `Post Review Results: skipped (budget exhausted)`, that's the fallback declining. If you ALSO see `ai-sdlc/attestation: failure`, the local attestation is missing too — the PR is blocked. Sign locally + re-push.

**Q. How do I know which spawner ran a given dispatch?**

The dispatch envelope at `.ai-sdlc/attestations/<head-sha>.dsse.json` includes a `harness` field per reviewer verdict. The orchestrator's `events.jsonl` records the spawner kind per `OrchestratorDispatched` event.

**Q. Can I mix-and-match (dev via subscription, reviewers via API key)?**

Not today — the spawner choice is per-dispatch, not per-step. If this matters, file an ask. RFC-0010 §13 (HarnessAdapter) is the place this would land.

---

## See also

- [`pipeline-cli/docs/spawner.md`](../../pipeline-cli/docs/spawner.md) — engineer-facing reference for the `SubagentSpawner` interface, custom spawner howto, and per-spawner contract details
- [`docs/operations/operator-runbook.md`](./operator-runbook.md) — high-level operator workflows
- [`docs/operations/orchestrator-runbook.md`](./orchestrator-runbook.md) — `cli-orchestrator` setup + monitoring
- [`docs/operations/claude-cli-spawner.md`](./claude-cli-spawner.md) — `claude-cli` inline-manifest protocol details
- [`spec/rfcs/RFC-0012-shared-pipeline-core.md`](../../spec/rfcs/RFC-0012-shared-pipeline-core.md) — Tier 1 vs Tier 2 architectural rationale
- [`spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md`](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) §14 — subscription scheduling + token-budget governance

---

*Last updated: 2026-05-17 (AISDLC-353: added subscription-only autonomous loop via `/ai-sdlc orchestrator-tick`; cost-projection table; failure-mode docs).*
