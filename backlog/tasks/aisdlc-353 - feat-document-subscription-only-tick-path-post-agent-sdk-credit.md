---
id: AISDLC-353
title: 'docs(operations): document the subscription-only autonomous-tick path post 2026-06-15 Agent SDK credit change (/ai-sdlc orchestrator-tick + ScheduleWakeup)'
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - documentation
  - billing-critical
  - autonomous-tick
  - operator-runbook
dependencies:
  - AISDLC-198
  - AISDLC-225
  - AISDLC-349
priority: critical
references:
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - pipeline-cli/docs/spawner.md
  - docs/operations/billing-and-cost-optimization.md
---

## Why this is critical

Per Anthropic's 2026-06-15 Agent SDK credit announcement, BOTH `claude -p` (`ShellClaudePSpawner`, AISDLC-349 / `--spawner claude`) AND `claude-code-sdk` + API key (`ClaudeCodeSDKSpawner` / `--spawner api-key`) draw from the per-plan monthly Agent SDK credit pool ($200/mo on Max-20x), with overflow billed at API-token rates.

For continuous autonomous backlog churning (multi-tick/day for weeks at a time), $200/mo will not cover the load. The AI-SDLC framework's core value prop — "autonomous SDLC orchestrator" — requires a billing model where ongoing autonomous operation is operationally sustainable without per-token charges accumulating.

**There IS a subscription-only path that survives the 2026-06-15 change**: the `/ai-sdlc orchestrator-tick` slash command (AISDLC-198 / AISDLC-225 consumer-bridge half) which:

1. Calls `cli-orchestrator tick --spawner claude-cli` (writes a dispatch manifest, returns `status: manifest-emitted` without invoking any LLM)
2. Reads the manifest from the slash command body (which runs in the operator's main Claude Code session)
3. Invokes the `Agent` tool with the manifest's parameters — `Agent` calls run against the operator's INTERACTIVE Claude Code session quota, NOT the Agent SDK credit pool (because the slash command body is a human-driven session turn, not a non-interactive Agent SDK invocation)
4. Writes the result back via `cli-orchestrator tick --continue-from-result`
5. Calls `ScheduleWakeup(30s)` (or longer) — the operator's session hibernates between ticks, no operator interaction needed; the harness re-invokes the slash command body when the timer fires

Net: as long as the operator keeps ONE Claude Code session alive (`claude` in a terminal somewhere), `/ai-sdlc orchestrator-tick` fires autonomously every 30s and the dispatch chain stays on subscription session quota indefinitely. No Agent SDK credit pool draw. No API-token overflow.

## Acceptance criteria

- [ ] **New section in `docs/operations/billing-and-cost-optimization.md`**: "The subscription-only autonomous loop" — explains the architecture, the trade-off (need active Claude Code session), and the recommended setup:
   - Open a dedicated terminal running `claude` (or use an existing one)
   - In that session, fire `/ai-sdlc orchestrator-tick` once
   - The skill auto-loops via ScheduleWakeup; the session can hibernate between ticks
   - Compare side-by-side vs `cli-orchestrator tick --spawner claude` (cron/daemon path that DOES draw the Agent SDK credit pool post-2026-06-15)
- [ ] **Cost-projection table**: for a typical backlog throughput (say 20 tasks/day), compare projected monthly cost across:
   - Subscription-only path (`/ai-sdlc orchestrator-tick` in active session) — $0 incremental
   - Agent SDK credit pool path (`cli-orchestrator tick --spawner claude` from cron) — first $200 free, then per-token overflow estimate
   - Pure API-key path (`--spawner api-key`) — per-token rates direct
- [ ] **Operator-quickstart checklist**: copy-paste setup for the subscription-only path (3-5 commands)
- [ ] **`/ai-sdlc orchestrator-tick` skill docstring**: update the description to call out that this is the subscription-only path post-2026-06-15
- [ ] **CLAUDE.md "Canonical execution paths" table**: add a row for the subscription-only autonomous loop
- [ ] **`pipeline-cli/docs/spawner.md` `--spawner claude` row**: cross-reference the subscription-only path as the preferred high-throughput alternative
- [ ] **Failure-mode docs**: what happens if the Claude Code session crashes / closes mid-loop?
   - Worktrees survive on disk (preserved)
   - `cli-orchestrator tick` next run detects via AISDLC-242 recoverable-abort path (or AISDLC-273 resume-from-draft)
   - Operator restarts the session + fires `/ai-sdlc orchestrator-tick` again — loop resumes

## Out of scope

- Building a session-keepalive wrapper (e.g. `tmux` + persistent `claude` session) — operator-environment concern
- Changing `Agent` tool billing semantics (Anthropic-side, out of our hands)
- Migrating the `--spawner api-key` path to also use Agent SDK credit (already does, per Anthropic announcement)

## Source

Operator 2026-05-17, post-AISDLC-349 land + post-2026-06-15 Agent SDK credit announcement review: "I did a review with an agent and it said there was a path for us to remain on the subscription even post the 2026-06-15+ date. I think it's crucial to the operations of the ai-sdlc."

The path is the `/ai-sdlc orchestrator-tick` slash command body + ScheduleWakeup loop. Already implemented (AISDLC-198 + AISDLC-225). Just needs documentation + operator-quickstart to make it discoverable as the preferred high-throughput path.
