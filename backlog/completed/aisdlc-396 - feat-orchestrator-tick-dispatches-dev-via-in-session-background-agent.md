---
id: AISDLC-396
title: 'feat: orchestrator-tick dispatches dev via in-session background Agent (single-session autonomy)'
status: Done
labels:
  - orchestrator
  - autonomous-loop
  - slash-commands
references:
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/commands/dispatch-worker.md
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/dispatch-bg-agent.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/orchestrator-promotion.md
  - CLAUDE.md
priority: high
---

## Description

Today `/ai-sdlc orchestrator-tick` is a Conductor that polls `done/`, fans out reviewers, signs + pushes + opens PRs, and emits new manifests to `queue/` — but **does not spawn its own dev Workers**. The three documented Worker patterns all require either operator manual action OR paid billing:

| Pattern | Worker mechanism | Cost | Operator effort |
|---|---|---|---|
| Z (current docs) | Operator opens N separate CC sessions running `/ai-sdlc dispatch-worker` | Subscription quota | Open N+1 sessions per drain |
| Y (`cli-orchestrator tick --spawner claude`) | Subprocess `claude -p` | Agent SDK credit pool ($200/mo on Max-20x; paid post-2026-06-15) | One-time daemon setup; session-independent |
| X (THIS TASK) | In-session background `Agent` call from the Conductor itself | Subscription quota only (Sonnet for dev) | Operator opens ONE CC session; fires `/ai-sdlc orchestrator-tick`; ScheduleWakeup loops |

Pattern X is what every recent dogfood session has emulated by hand: I (Claude) dispatch a developer subagent via background `Agent` call, get a completion notification, fan out 3 reviewers, sign, push, open PR. That whole loop is **manual orchestration that the framework should be doing automatically**.

The operator's stated goal (2026-05-22 session): *"I need you to be focused on higher-level tasks, manually driving orchestrator tasks is above your pay grade — figure out how to automate it so you can focus on higher level tasks."*

## What changes

### `ai-sdlc-plugin/commands/orchestrator-tick.md` — Step 5 enhancement

Currently Step 5 just emits manifests to `queue/`. The enhancement: after emitting a manifest, the Conductor ALSO dispatches a background `Agent` call (developer subagent) directly in this session, AND writes a Worker-claim record into `inflight/` so the next tick's Step 3 picks up the verdict when the background Agent completes.

Pseudo-shell:

```bash
# After emitting manifest to queue/<task-id>.json
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" claim-inflight \
  --board-dir "$BOARD_DIR" \
  --task-id "$TASK_ID" \
  --worker-id "in-session-$$" \
  --worker-kind "in-session-agent"

# Dispatch background Agent (developer subagent) via the framework — NOT
# via me hand-rolling Agent calls. Inputs come from the manifest; output
# (developer JSON envelope) lands in done/<task-id>.json on completion.
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" dispatch-bg-agent \
  --board-dir "$BOARD_DIR" \
  --task-id "$TASK_ID" \
  --manifest-path "$BOARD_DIR/inflight/$TASK_ID.json"
```

The `dispatch-bg-agent` subcommand is new — it constructs the developer prompt from the manifest and writes a synthetic "background Agent dispatch request" file that the slash command body picks up at the next tick (so the actual `Agent` tool call happens from the main session, since plugin subagents can't use `Agent` per AISDLC-98). The Conductor and the dispatched dev coordinate via filesystem.

### `ai-sdlc-plugin/commands/orchestrator-tick.md` — Step 3 reviewer fanout

Already exists, but should also use background `Agent` calls for the 3 reviewers in parallel rather than blocking foreground. Reviewers are short (typically <2 min each), so this is an efficiency tweak more than a correctness change.

### Helper changes
- `pipeline-cli/src/cli/dispatch.ts` — add `dispatch-bg-agent` subcommand
- `pipeline-cli/src/orchestrator/dispatch-bg-agent.ts` (new) — write the synthetic request file the slash command picks up
- The slash command body's Step 2 (sweep) processes pending `bg-agent-request/<task-id>.json` files by firing actual `Agent` tool calls (in the main session where the tool is available)

### `CLAUDE.md` update

Add Pattern X to the canonical-execution-paths table:

```
| Autonomous loop — single session, parallel devs | `/ai-sdlc orchestrator-tick` (once, ScheduleWakeup loops; in-session background Agent for dev + reviewer fanout) | Subscription interactive quota only — Sonnet for dev/code/test, Opus only for security |
```

## Acceptance criteria

- [ ] AC-1: `orchestrator-tick.md` Step 5 dispatches a background `Agent` call for each emitted manifest (developer subagent), claims `inflight/`, and writes a `bg-agent-request/<task-id>.json` that the slash command body actions
- [ ] AC-2: When a background Agent completes, its developer JSON envelope is written to `done/<task-id>.json`. Next tick's Step 3 picks it up and fans out 3 reviewers (also background, parallel)
- [ ] AC-3: When all 3 reviewer verdicts are written, Conductor aggregates → composes verdict file → signs attestation → pushes branch → opens PR (existing Step 3 logic; should work unchanged)
- [ ] AC-4: ONE CC session is sufficient for end-to-end autonomous drain. Operator opens session, fires `/ai-sdlc orchestrator-tick --bootstrap`, walks away
- [ ] AC-5: Concurrency cap respected — at most `inSessionAgentMaxSessions` (default 4) background Agents in flight at any time. Conductor doesn't emit new manifests when cap is reached
- [ ] AC-6: When the operator exits the session, in-flight background Agents are NOT abandoned silently. Their `inflight/` records survive across sessions so the next `orchestrator-tick` (in a fresh session) can pick up + reap stale Workers per RFC-0041 §5.2
- [ ] AC-7: Hermetic test coverage — simulate a 3-task drain (mock developer/reviewer subagent verdicts) and assert all 3 PRs open within the tick budget
- [ ] AC-8: Operator runbook updated at `docs/operations/orchestrator-promotion.md` — Pattern X added; X→Y→Z escalation criteria documented (X for solo operator; Y when subscription quota saturates; Z when N>4 parallel needed)

## Why now

3 recent operator-flagged frictions converge on the same architectural gap:

1. **2026-05-22 explicit ask (this session):** *"manually driving orchestrator tasks is above your pay grade — figure out how to automate it"*
2. **`feedback_use_execute_not_hand_roll.md` memory (2026-05-22):** *"when operator says 'ship X', invoke `/ai-sdlc execute AISDLC-N` — do NOT manually do worktree+dev+reviewers+sign+push"* — same hand-rolling problem applied to single tasks; X applies it to the multi-task loop
3. **`feedback_autonomous_orchestration_pattern.md` memory:** the operator-away pattern already uses background Agent dispatch; X codifies that pattern into the framework so it's not session-instance ad-hoc

Without X, every operator-away session requires either operator manual dispatch OR me hand-rolling each task. Both fail the "focus on higher-level tasks" bar.

## Out of scope

- Cross-session Worker handoff (an in-flight Worker in session A surviving to a fresh session B) — RFC-0041 OQ for a later phase
- Replacing Y (subprocess Workers via Agent SDK credit pool) — Y is the right answer for headless/CI contexts; X is for interactive operator sessions
- Replacing Z (operator-opened Worker sessions) — Z stays the documented N>4 parallel pattern

## References

- RFC-0041 Phase 1 (Conductor/Worker decoupling) — AISDLC-377.1, MERGED
- RFC-0041 Phase 1.5 (iterate-needed resume signal) — AISDLC-377.2, MERGED
- RFC-0041 §4.4 (DispatchManifest schema)
- RFC-0041 §5.2 (heartbeat sweep + stale-claim recovery)
- AISDLC-349 (`--spawner claude` for subprocess Workers — Pattern Y)
- AISDLC-98 (plugin subagents cannot use Agent tool — why Step 5 dispatch must happen in slash command body, not plugin)
- `feedback_use_execute_not_hand_roll.md` (operator memory)
- `feedback_autonomous_orchestration_pattern.md` (operator memory)

## Estimated effort

4-6 hours. The pipeline-cli plumbing is straightforward; the tricky part is the orchestrator-tick body's filesystem coordination with the slash command's foreground Agent call (the `bg-agent-request/` queue).

## finalSummary

### Summary

Implemented Pattern X — in-session background `Agent(developer)` dispatch from the `/ai-sdlc orchestrator-tick` Conductor via a new filesystem coordination protocol (`bg-agent-request/<task-id>.json`). One operator-opened CC session now drives end-to-end autonomous drain with no sibling sessions required.

### Changes

- `pipeline-cli/src/orchestrator/dispatch-bg-agent.ts` (new): Library API for the bg-agent-request protocol — write/read/list/remove/prune, the union-deduplicated `countInFlightBgAgents()` backpressure probe, and `buildDevPromptFromManifest()` that mirrors the `dispatch-worker.md` Step 4-Fresh contract so dev subagents receive identical context regardless of Pattern X vs Z dispatch.
- `pipeline-cli/src/cli/dispatch.ts` (modified): Added five new subcommands — `dispatch-bg-agent`, `list-bg-agent-requests`, `remove-bg-agent-request`, `prune-orphaned-bg-agent-requests`, `count-in-flight-bg-agents`. The `dispatch-bg-agent` subcommand enforces the `inSessionAgentMaxSessions` cap (default 4) as defense-in-depth.
- `pipeline-cli/src/orchestrator/dispatch-bg-agent.test.ts` (new): 15 hermetic tests covering library API + the AC-7 3-task drain simulation + cross-session survivability (AC-6).
- `pipeline-cli/src/cli/dispatch.test.ts` (modified): Added 9 CLI integration tests for the new subcommands — write, dedup, cap enforcement, oldest-first listing, idempotent remove, prune-on-orphan, help-text.
- `pipeline-cli/src/orchestrator/index.ts` (modified): Re-exports the new library surface.
- `ai-sdlc-plugin/commands/orchestrator-tick.md` (modified): New Step 2.5 (sweep bg-agent-request, fire Agent in-session) and Step 5 enhancement (after each manifest emit, claim → heartbeat → dispatch-bg-agent). Added `Agent(developer)` to `allowed-tools`. Documented X→Y→Z escalation criteria.
- `CLAUDE.md` (modified): Added Pattern X and Pattern Z rows to the canonical-execution-paths table.
- `docs/operations/orchestrator-promotion.md` (modified): New "Dispatch patterns — X / Y / Z" section with escalation criteria, concurrency-cap tuning, and the operator kick-off runbook.

### Design decisions

- **Separate `bg-agent-request/` subdir, NOT mixed into `queue/`** — the four lifecycle subdirs (queue/inflight/done/failed) are governed by the manifest atomic-claim protocol. Mixing a coordination-channel file into queue/ would force every claim/peek/sweep site to learn about the new file type. Keeping it as a sibling directory means the Dispatch Board library stays untouched.
- **Concurrency cap via union dedup of inflight + request** — a Pattern X task can briefly exist in BOTH inflight/ (Conductor's claim) and bg-agent-request/ (Conductor's request) during the gap between Step 5 and Step 2.5. `countInFlightBgAgents()` dedups by taskId so the cap check is correct.
- **Subtract-self in `dispatch-bg-agent`** — the Conductor's Step 5 claims the manifest into inflight/ BEFORE calling dispatch-bg-agent. The cap comparison must therefore subtract 1 from the count (the task we're dispatching FOR is already in flight). Hermetic test pins this behaviour at 4 in-flight + cap=4 → refuse the 5th.
- **Library-level orphan GC** — when the stale-heartbeat sweeper reaps an inflight manifest into failed/, the corresponding bg-agent-request becomes orphaned. `pruneOrphanedBgAgentRequests()` runs at Step 2.5 every tick to delete those, preventing double-dispatch on a reaped task.
- **Sweep BEFORE claim, dispatch AFTER claim** — Step 2.5 (sweep + fire) runs early in the tick so any pending requests from previous ticks fire ASAP; Step 5 (emit + dispatch-bg-agent) runs at the end so cap-saturated tasks naturally wait for the next tick's sweep to drain before re-attempting.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 226 files, 4308 passed, 1 skipped. New tests: dispatch-bg-agent.test.ts (15), dispatch.test.ts +9 (40 total).
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Acceptance criteria status

- AC-1: Step 5 dispatches bg-agent-request per emitted manifest — DONE (dispatch.ts dispatch-bg-agent + orchestrator-tick.md Step 5 enhancement).
- AC-2: Verdict lands in done/ → reviewer fanout — DONE (existing Step 3 flow unchanged; 3-task drain test asserts verdicts stage correctly).
- AC-3: Sign + push + open PR works — DONE (existing Step 3 logic touched only via inclusion; no behaviour change to that path).
- AC-4: ONE CC session = autonomous drain — DONE (orchestrator-tick.md description rewritten; runbook documents it; X→Y→Z escalation criteria in promotion doc).
- AC-5: `inSessionAgentMaxSessions` cap respected — DONE (CLI-level + library-level checks, hermetic test).
- AC-6: Cross-session survivability — DONE (bg-agent-request files persist on disk; explicit hermetic test).
- AC-7: 3-task drain simulation — DONE (hermetic test in dispatch-bg-agent.test.ts).
- AC-8: Operator runbook updated — DONE (docs/operations/orchestrator-promotion.md "Dispatch patterns" + "Operator runbook").

### Follow-up

- The slash command body's actual `Agent(developer)` invocation with `run_in_background: true` is documented in Step 2.5 but cannot be exercised hermetically — it requires a live Claude Code session. Operators should soak this with `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` before the default-on flip.
- The events.jsonl writer (RFC-0015 Phase 4) does not yet emit a `PatternXBgAgentDispatched` event — the operator-promotion criteria currently count `OrchestratorDispatched` regardless of pattern. If Pattern X usage needs separate metrics, file a follow-up.
