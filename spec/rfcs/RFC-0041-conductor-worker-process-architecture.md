---
id: RFC-0041
title: Conductor / Worker Process Architecture for Autonomous Dispatch
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-20
updated: 2026-05-20
targetSpecVersion: v1alpha1
requires:
  - RFC-0010
  - RFC-0012
  - RFC-0015
requiresDocs: []
---

# RFC-0041: Conductor / Worker Process Architecture for Autonomous Dispatch

**Status:** Draft
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io
**Created:** 2026-05-20
**Updated:** 2026-05-20
**Target Spec Version:** v1alpha1
**Depends on:** RFC-0010 (Parallel Execution), RFC-0012 (Two-Tier Pipeline), RFC-0015 (Autonomous Pipeline Orchestrator)
**Anchor:** Extension of RFC-0015; defines the cross-process execution model that RFC-0015 left to implementation.

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io
- [ ] Product owner — Alexander Kline
- [ ] Operator owner — dominique@reliablegenius.io

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-05-20 | dominique | Initial draft. Surfaces the Conductor/Worker process split that RFC-0015 implies but never named. Closes the "in-CC-session dispatch" gap exposed by 2026-05-20 4-wide drain attempt (6/7 dev subagents killed by Anthropic platform's 600s background-agent watchdog). |

---

## 1. Summary

RFC-0015 specifies an autonomous orchestrator as a "long-running Node process" with a worker pool. It is silent on **what kind of process** the workers are: in-process tasks within the orchestrator, child processes spawned via `child_process`, or background agents launched via the Claude Code `Agent` tool. The implementation chose mainly the third path, dispatching via `Agent(... run_in_background: true)` from a slash command body.

This RFC names the process split that RFC-0015 implies and specifies it as normative: the **Conductor** (interactive long-lived process, operator-facing, no LLM-side code editing) and **Workers** (short-lived task-scoped processes, fully isolated from the Conductor's session, code-editing). The two communicate exclusively through a filesystem-backed **Dispatch Board** — never through shared TTY, MCP stdio, or the Anthropic Agent-tool background queue.

The motivating failure: the Anthropic platform's hardcoded 600s silent-stdout watchdog on background `Agent` calls makes dev subagent dispatch inside a Claude Code session structurally unworkable for tasks that exceed 10 minutes of subprocess churn (which is most real backlog work). On 2026-05-20, 6 of 7 dispatched dev subagents were killed mid-`pnpm test`. The process-boundary fix moves Workers outside the Conductor's session, where we control the watchdog and there is no nested-session conflict.

## 2. Motivation

### 2.1 The failure mode this RFC closes

The 2026-05-20 "4-wide autonomous drain" session attempted to use the `Agent` tool with `run_in_background: true` as the dispatch mechanism for RFC-0015's worker pool. Outcome:

| Task | Watchdog killed? | Recoverable work? |
|---|---|---|
| AISDLC-305 | Yes (~10 min into `pnpm test`) | Partial — uncommitted (~1100 lines), discarded |
| AISDLC-307 | No (lucky timing) | Yes — PR #569 shipped |
| AISDLC-308 | Yes | Partial (~400 lines), discarded |
| AISDLC-311 | Yes | Partial (small), discarded |
| AISDLC-321 | Yes | Partial (~30 lines), discarded |
| AISDLC-350 | Yes (mid test-rewrite) | Partial (~5 files), discarded |
| AISDLC-364 | Yes | Partial (~7 files), discarded |

**Kill rate: 6 of 7 (~86%).** Each killed subagent burned ~25 min of subscription tokens producing work that was discarded because the Conductor had no protocol for "claim and resume a half-finished worker."

The kill mechanism is well-understood: the Anthropic platform monitors the subagent's own stdout/stderr stream and kills the subagent after 600 seconds of silence. While a subagent is blocked inside a long-running tool call (e.g. `Bash` running `pnpm test` for 15 minutes), the subagent emits nothing. The platform cannot distinguish "working hard" from "hung" and chooses to kill.

Confirmed via independent investigation of the `claude-code` repository (`/Users/dominique/Documents/dev/ai-sdlc/claude-code`): the 600s threshold is in the Anthropic platform runtime, not in the client CLI. No environment variable, settings key, or per-agent frontmatter option exposes it. The only existing overrides cover unrelated timeouts (`BASH_MAX_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`).

### 2.2 What's working: foreground & shell-spawned paths

The watchdog only fires on `run_in_background: true`. Foreground `Agent` calls and `/ai-sdlc execute` running in an operator-opened terminal session both work fine for 25+ minute tasks. The shell-spawner path (`cli-orchestrator tick --spawner claude` invoked from a plain shell, not inside a Claude Code session) also works — its watchdog is our own `DEFAULT_TIMEOUT_MS = 30 * 60 * 1000` in `pipeline-cli/src/runtime/shell-claude-p-spawner.ts`.

The structural failure is specifically: **Conductor in CC session + Workers as in-session background agents.** Move either the Conductor out of CC, or the Workers out of CC's Agent-tool queue, and the problem disappears.

### 2.3 Why "move the Conductor out" doesn't work

The Conductor needs:
- Long-running interactive context to talk to the operator (decisions, escalations)
- The `Agent` tool for spawning reviewer subagents (which DO fit in 600s — they read diffs, write JSON, exit)
- MCP tools (`mcp__plugin_ai-sdlc_*` for task editing, `mcp__backlog__*` for backlog state)
- Access to operator's terminal for `gh`, `git`, signing key

Moving the Conductor to a daemon process loses all of these. The Conductor is *correctly* a Claude Code session.

### 2.4 So: move the Workers out

Workers need:
- Long subprocess windows (`pnpm test`, `pnpm build`, `vitest run --coverage`)
- An isolated worktree
- A signing key (or to defer signing to the pre-push hook)
- A bounded task definition (one backlog task → one PR)
- A return channel (verdict JSON + commit SHA + PR URL)

Workers do not need:
- Operator interactivity
- The Agent tool (no nested subagents)
- MCP tools (filesystem and `gh` are enough)
- The Conductor's session state

Workers are textbook OS processes. Run them as separate `claude -p` invocations spawned from a small shell supervisor, completely outside the Conductor's CLAUDECODE-marked process tree.

## 3. Goals and Non-Goals

### Goals

- Define **Conductor** and **Worker** as normative roles with explicit responsibilities, lifetimes, and resource access.
- Define the **Dispatch Board** protocol — a filesystem-backed queue/inflight/done channel that decouples Conductor and Workers temporally and across process boundaries.
- Specify environment isolation rules that prevent nested-CC-session conflicts when Workers are launched from any context (shell daemon, Conductor, CI).
- Reuse the existing `cli-orchestrator tick --spawner claude` mechanism as the Worker entry point; add a `--spawner` mode dedicated to Conductor-initiated handoff.
- Keep RFC-0015's deterministic failure playbook intact — RFC-0041 changes **where** workers run, not **how** they recover from failure.
- Backward-compatible: existing `/ai-sdlc execute` (foreground, single-task, no Dispatch Board) continues to work unchanged.

### Non-Goals

- **Replace RFC-0015.** RFC-0015's worker-pool semantics, failure playbook, and tier-aware concurrency defaults remain authoritative. RFC-0041 is the missing process-boundary specification.
- **A new agent type.** Reuse `ai-sdlc:developer`, `code-reviewer`, `test-reviewer`, `security-reviewer`.
- **Multi-host orchestration.** Conductor + Workers stay on one machine (one filesystem) in v1. Multi-host is a future RFC.
- **Anthropic-side watchdog fix.** Out of scope. This RFC works around the constraint rather than fixing it.
- **Worker-side LLM calibration.** RFC-0011 (DoR), RFC-0014 (priority), RFC-0010 (subscription scheduling) own those layers.

## 4. Architecture

### 4.1 Process model

```
┌──────────────────────────────────────────────────────────────────┐
│ Operator Console (interactive terminal)                          │
│   ┌────────────────────────────────────────────────────────────┐ │
│   │ Conductor                                                  │ │
│   │ - Claude Code interactive session (CLAUDECODE=1)           │ │
│   │ - Picks frontier tasks via cli-deps                        │ │
│   │ - Writes dispatch manifest to Dispatch Board               │ │
│   │ - Spawns 3 reviewer subagents per completed Worker         │ │
│   │ - Signs attestations, pushes PRs, arms auto-merge          │ │
│   │ - Surfaces decisions to operator                           │ │
│   │ - NEVER edits code directly                                │ │
│   └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
             │                                       ▲
             │ writes <id>.dispatch.json             │ reads <id>.verdict.json
             ▼                                       │
  ┌──────────────────────────────────────────────────────────────┐
  │ Dispatch Board (project-local filesystem)                    │
  │   .ai-sdlc/dispatch/queue/<task-id>.dispatch.json            │
  │   .ai-sdlc/dispatch/inflight/<task-id>.{state,pid}.json      │
  │   .ai-sdlc/dispatch/done/<task-id>.verdict.json              │
  │   .ai-sdlc/dispatch/failed/<task-id>.diagnostic.json         │
  └──────────────────────────────────────────────────────────────┘
             ▲                                       │
             │ claim by atomic rename                │ pickup
             │                                       ▼
  ┌────────────────────────┐  ┌────────────────────────┐  ┌─────────────┐
  │ Worker Supervisor      │  │ Worker N               │  │ ...         │
  │ - Tiny daemon (~150    │  │ - claude -p invocation │  │             │
  │   LOC, supervised by   │  │ - env -u CLAUDECODE    │  │             │
  │   launchd/systemd or   │  │ - 30 min budget        │  │             │
  │   manual `pnpm dev`)   │  │ - one task, one PR     │  │             │
  │ - Polls queue/         │  │ - exits with verdict   │  │             │
  │ - Atomic claim → spawn │  │   written to done/ or  │  │             │
  │ - Bounded concurrency  │  │   failed/              │  │             │
  └────────────────────────┘  └────────────────────────┘  └─────────────┘
```

Key properties:

1. **Process boundary** — Conductor (CLAUDECODE=1) and Workers (CLAUDECODE unset) never share a process tree. Nested-session error is structurally impossible.
2. **Asynchronous hand-off** — Conductor writes a dispatch manifest and walks away. Workers pick up when ready. Conductor polls the Dispatch Board (cheap filesystem stat) at its own cadence; no streaming connection.
3. **No background-agent watchdog** — Workers don't run inside the Conductor's Anthropic Agent queue. They run as OS processes with our own 30-minute watchdog (already in `shell-claude-p-spawner.ts`).
4. **Stateless Workers** — each Worker handles exactly one task, writes a verdict, exits. The Conductor (or a supervisor) restarts on failure; no in-Worker recovery state.
5. **Bounded parallelism by supervisor** — the supervisor enforces `parallelism.maxConcurrent` from `WorktreePool` (RFC-0010 §6.7). Conductor can write more manifests than the supervisor will run concurrently; surplus manifests sit in `queue/` until a Worker frees up.

### 4.2 Roles

**Conductor**

| Responsibility | In scope | Out of scope |
|---|---|---|
| Frontier selection (read `cli-deps frontier`) | ✅ | |
| Manifest authoring (one per dispatched task) | ✅ | |
| Reviewer fan-out (3 parallel `code/test/security-reviewer` agents) | ✅ — these fit in 600s | |
| Verdict aggregation + attestation signing | ✅ | |
| `git rebase` / `gh pr merge --auto` | ✅ | |
| Operator question surfacing (`AskUserQuestion`) | ✅ | |
| Source-file editing | | ❌ |
| Long-running `pnpm test` | | ❌ |
| Worktree allocation | | ❌ — Worker owns its worktree |

**Worker**

| Responsibility | In scope | Out of scope |
|---|---|---|
| Worktree allocation + sentinel write | ✅ | |
| Backlog task implementation | ✅ | |
| `pnpm build && pnpm test && pnpm lint && pnpm format:check` | ✅ | |
| `git add`, `git commit`, `git push` to branch | ✅ | |
| Verdict JSON emission to `.ai-sdlc/dispatch/done/` | ✅ | |
| Reviewer invocation | | ❌ — Conductor owns review fan-out |
| Operator dialogue | | ❌ — Worker has no operator surface |
| Attestation signing | | ❌ — Conductor (or pre-push hook) signs after review |
| Resumption of prior failed run | | ❌ — Workers are idempotent-by-restart, not stateful |

### 4.3 Dispatch Board protocol

The Dispatch Board lives at `<project-root>/.ai-sdlc/dispatch/` with four subdirectories:

```
queue/      manifests written by Conductor, awaiting pickup
inflight/   manifests claimed by a Worker (atomic rename from queue/)
done/       verdicts written by Workers on success
failed/     diagnostics written by Workers (or supervisor) on failure
```

**Manifest shape** (`queue/<task-id>.dispatch.json`, JSON schema published as `spec/schemas/dispatch-manifest.v1.schema.json`):

```json
{
  "schemaVersion": "v1",
  "taskId": "AISDLC-305",
  "branch": "ai-sdlc/aisdlc-305-feat-rfc-0025-refit-phase-4",
  "worktree": ".worktrees/aisdlc-305",
  "baseSha": "a084c681",
  "dispatchedAt": "2026-05-20T10:14:33Z",
  "dispatchedBy": "conductor-session-<short-uuid>",
  "spec": {
    "taskFile": "backlog/tasks/aisdlc-305 - ...md",
    "model": "claude-sonnet-4-6",
    "budgetMs": 1800000,
    "verifyCommands": ["pnpm build", "pnpm test", "pnpm lint", "pnpm format:check"]
  }
}
```

**Verdict shape** (`done/<task-id>.verdict.json`, schema `dispatch-verdict.v1.schema.json`):

```json
{
  "schemaVersion": "v1",
  "taskId": "AISDLC-305",
  "outcome": "success",
  "commitSha": "abc12345",
  "pushedBranch": "ai-sdlc/aisdlc-305-...",
  "prUrl": null,
  "verifications": {"build":"passed","test":"passed","lint":"passed","format":"passed"},
  "acceptanceCriteriaMet": [1,2,3,4],
  "notes": "",
  "completedAt": "2026-05-20T10:39:12Z",
  "workerId": "worker-<pid>-<rand>"
}
```

**Atomic claim** — supervisor uses `rename(queue/<id>.dispatch.json, inflight/<id>.dispatch.json)`. Rename is atomic on the same filesystem (POSIX guarantee), so two supervisors (or two Worker pollers) racing for the same manifest is safe: one wins, the other gets `ENOENT` and tries the next file. No lock files required.

**Lifecycle**:

```
Conductor writes:  queue/AISDLC-305.dispatch.json
Supervisor moves:  queue/ → inflight/AISDLC-305.dispatch.json
Supervisor spawns: claude -p (env -u CLAUDECODE) with manifest path argv
Worker writes:     inflight/AISDLC-305.state.json (heartbeat)
Worker completes:  done/AISDLC-305.verdict.json
Supervisor moves:  inflight/AISDLC-305.dispatch.json → done/AISDLC-305.dispatch.json
Conductor polls:   sees done/AISDLC-305.verdict.json → triggers reviewer fan-out
```

**Heartbeat** — Workers update `inflight/<id>.state.json` every 60s with `{lastHeartbeat, currentStep, pid}`. Supervisor's stale-detector sweeps `inflight/` every 5 min; any worker with `lastHeartbeat > 35 min ago` is presumed dead, manifest is moved to `failed/` with diagnostic `{cause: "stale-heartbeat"}`, PID is `kill -TERM`ed for cleanup. This is the supervisor-side equivalent of the Anthropic 600s watchdog — but our threshold is 35 min, which comfortably accommodates the longest observed local `pnpm test` (~12 min).

### 4.4 Environment isolation

Workers MUST be spawned with `CLAUDECODE` unset:

```bash
env -u CLAUDECODE -u CLAUDE_API_KEY claude -p \
  --working-directory ".worktrees/$TASK_ID" \
  --max-turns 100 \
  "$(generate_prompt_from_manifest)"
```

Rationale: Claude Code's startup guard refuses to launch when `CLAUDECODE=1` is present. The supervisor must scrub that env var before each spawn. The same scrubbing applies when a Conductor wants to dispatch directly to a Worker without going through the supervisor (e.g. for one-off testing): `env -u CLAUDECODE pnpm --filter @ai-sdlc/pipeline-cli exec ai-sdlc-pipeline execute --manifest <path>`.

The supervisor itself runs with CLAUDECODE unset (it's a plain shell daemon, not a Claude Code session). The Conductor runs with CLAUDECODE=1 (it IS a Claude Code session).

### 4.5 Supervisor implementation

A small Node script (~150 LOC target) under `pipeline-cli/bin/cli-dispatch-supervisor.mjs`:

```typescript
// pseudocode
const POLL_MS = 5000;
const MAX_CONCURRENT = readWorktreePoolCap();      // RFC-0010 §6.7
const board = ".ai-sdlc/dispatch";
const inflight = new Set<string>();                // PIDs

setInterval(() => {
  sweepStaleHeartbeats(board);
  if (inflight.size >= MAX_CONCURRENT) return;
  const next = claimNextManifest(board);            // atomic rename
  if (!next) return;
  const child = spawn("claude", ["-p", ...], {
    env: { ...process.env, CLAUDECODE: undefined },
    cwd: next.worktree,
  });
  inflight.add(child.pid);
  child.on("exit", (code) => {
    inflight.delete(child.pid);
    finalizeManifest(next, code);
  });
}, POLL_MS);
```

The supervisor is run via the operator's choice of process manager: `launchd` (macOS), `systemd --user` (Linux), `pm2`, or just `pnpm supervisor:start` in a tmux pane. RFC-0041 ships a reference `launchd` plist + `systemd` unit at `docs/operations/dispatch-supervisor-install.md`. The supervisor is RFC-0041's only new long-running process; the Conductor is the operator's existing Claude Code session.

### 4.6 Conductor changes

The Conductor's existing dispatch logic (today: `Agent(... run_in_background: true)` from within the orchestrator tick) is replaced with **manifest emission**:

```typescript
// Conductor today (broken)
for (const task of candidates) {
  await Agent({ subagent_type: "developer", run_in_background: true, ... });
}

// Conductor with RFC-0041
for (const task of candidates) {
  writeManifest(`.ai-sdlc/dispatch/queue/${task.id}.dispatch.json`, {...});
}
// Then poll done/ on each ScheduleWakeup
```

The Conductor's poll loop on each ScheduleWakeup tick:

1. List `done/` — for each new verdict, spawn 3 reviewer subagents (foreground `Agent` calls within the 600s budget), aggregate verdicts, sign attestation, push, arm auto-merge.
2. List `failed/` — for each diagnostic, decide: retry (rewrite manifest into `queue/`) or escalate (surface to operator via `AskUserQuestion`).
3. List `queue/` and `inflight/` — measure backpressure; if `queue/` is empty AND `inflight/` count < MAX_CONCURRENT, pick more frontier tasks and emit manifests.

## 5. Design Details

### 5.1 Cardinality

- One Conductor per project per operator session. Operators with multiple concurrent sessions should use distinct project worktrees or accept the race (manifests are atomic; the worse case is two Conductors writing the same task ID, which the supervisor resolves by atomic rename — one wins, the other observes the manifest moved out of `queue/` and skips).
- One Supervisor per project. The supervisor stores its PID at `.ai-sdlc/dispatch/.supervisor.pid` and refuses to start if a live PID is already there. Re-up is `kill <pid> && pnpm supervisor:start`.
- N Workers (N = `parallelism.maxConcurrent`). Each is a short-lived `claude -p` subprocess.

### 5.2 Failure modes (Worker-side)

The Worker inherits all of RFC-0015 §5's failure handling logic (the playbook), executed inside the Worker process. The Worker emits structured failures into the verdict JSON; the Conductor's done/-pickup loop then dispatches reviewers or escalates based on the verdict's `outcome` field.

New failure modes introduced by the process split:

| Mode | Detection | Remediation | Owner |
|---|---|---|---|
| `WorkerSupervisorMissing` | `cli-dispatch-supervisor.pid` absent or PID dead, manifests accumulate in `queue/` >10 min | Conductor surfaces `AskUserQuestion` prompting operator to start supervisor | Conductor |
| `WorkerStaleHeartbeat` | `inflight/<id>.state.json.lastHeartbeat` >35 min old | Supervisor kills PID, moves manifest to `failed/`, Conductor retries (budget 1) or escalates | Supervisor + Conductor |
| `WorkerSpawnRefused` | `claude -p` exits immediately with non-zero (e.g. signing key missing, quota exhausted) | Supervisor moves manifest to `failed/` with `cause: spawn-rejected`; Conductor escalates | Supervisor |
| `DispatchBoardCorruption` | Manifest JSON parse fails, schema validation fails | Manifest moved to `failed/` with `cause: schema-violation`; Conductor surfaces | Supervisor + Conductor |

### 5.3 Backward compatibility

- `/ai-sdlc execute <task-id>` (interactive, foreground, single-task) — unchanged. No Dispatch Board involvement.
- `cli-orchestrator tick --spawner claude` from a plain shell — unchanged. RFC-0041 is additive.
- `cli-orchestrator tick --spawner claude-cli` from inside a Claude Code session — **deprecated** in favor of the Dispatch Board path. Cutover handled by Phase 3 of the implementation plan (§7).
- Existing in-flight worktrees and PRs are unaffected; the Conductor's existing finalization logic (rebase, sign, push) operates identically.

## 6. Integration with Existing RFCs

### 6.1 RFC-0015 (Autonomous Pipeline Orchestrator)

RFC-0041 is the **process model** for RFC-0015's worker pool. RFC-0015 §4.1 says "A single Node process running in the operator's sandbox"; RFC-0041 splits that into Conductor (interactive Claude Code session) + Supervisor (long-running Node daemon) + Workers (short-lived `claude -p` subprocesses). RFC-0015's deterministic failure playbook (§5) executes inside the Worker, with the Conductor's pickup loop interpreting the verdict.

### 6.2 RFC-0010 (Parallel Execution)

- `parallelism.maxConcurrent` from `WorktreePool` resource is the supervisor's concurrency cap.
- `WorktreePoolManager` (§7.1) is called by the Worker, not the Conductor or supervisor.
- Subscription scheduling (§14) is honored by the supervisor: a manifest tagged `schedule: off-peak` sits in `queue/` until the off-peak window opens.

### 6.3 RFC-0012 (Two-Tier Pipeline)

- Workers call `executePipeline()` from `@ai-sdlc/pipeline-cli` (Tier 2 library) — identical to today's path.
- The Conductor/Supervisor pair is Tier 3 "service" composing Tier 2 "library" composing Tier 1 "slash command body" (`/ai-sdlc execute` for the manual path remains Tier 1).

### 6.4 RFC-0011 (DoR Gate) and AISDLC-117 (cli-deps)

Unchanged. The Conductor still consults `cli-deps frontier` + `RefinementVerdict` before writing a manifest. DoR clarification comments still flow through the existing CI workflow (and the pre-push gate AISDLC-370).

## 7. Implementation Plan

Three phases, each shippable independently.

### Phase 1 — Dispatch Board protocol + supervisor MVP

- [ ] Publish `spec/schemas/dispatch-manifest.v1.schema.json` and `dispatch-verdict.v1.schema.json`
- [ ] `pipeline-cli/bin/cli-dispatch-supervisor.mjs` — ~150 LOC daemon with atomic claim, spawn, heartbeat sweep, exit handling
- [ ] `pnpm supervisor:start` / `supervisor:status` / `supervisor:stop` scripts
- [ ] `docs/operations/dispatch-supervisor-install.md` with `launchd` plist + `systemd --user` unit
- [ ] Hermetic test: simulate Conductor writing 4 manifests, supervisor spawning 4 mock Workers, all 4 verdicts collected
- [ ] Acceptance: a single Worker dispatched via supervisor completes `/ai-sdlc execute <task-id>` end-to-end (same outcome as the manual slash command, just driven from the board)

### Phase 2 — Conductor manifest emission + done-poll loop

- [ ] New CLI: `cli-orchestrator tick --spawner dispatch-board` that emits manifests instead of spawning workers in-process
- [ ] Conductor-side library: `dispatchBoard.writeManifest()`, `dispatchBoard.collectVerdicts()`, `dispatchBoard.peekQueue()` for backpressure
- [ ] Update `/ai-sdlc orchestrator-tick` slash command to consume the dispatch-board path when the supervisor PID file is present
- [ ] Hermetic test: 3-task fixture with one passing, one failing, one timing out — verify Conductor's pickup loop handles all three correctly
- [ ] Acceptance: a Conductor running in this Claude Code session, plus a supervisor running in a tmux pane, drains 3 frontier tasks concurrently without any 600s kill

### Phase 3 — Deprecate `claude-cli` in-session spawner

- [ ] Add deprecation warning to `--spawner claude-cli` mode pointing at `--spawner dispatch-board`
- [ ] Operator runbook update: documentation that in-CC dispatch goes through the board, not the Agent tool
- [ ] After one release with the deprecation warning, remove the `claude-cli` spawner kind entirely (separate PR)
- [ ] Acceptance: `/ai-sdlc orchestrator-tick` from a Claude Code session no longer attempts `Agent(... run_in_background: true)` for dev work

## 8. Backward Compatibility

- **No breaking changes** to existing user-facing CLIs.
- **`/ai-sdlc execute`** remains the single-task interactive entry point.
- **`cli-orchestrator tick --spawner claude`** (shell-driven) remains supported and unchanged.
- **`cli-orchestrator tick --spawner claude-cli`** (in-CC, Agent-tool-based) is deprecated in Phase 3 with a one-release warning window. Operators using `/ai-sdlc orchestrator-tick` get auto-cutover to `--spawner dispatch-board` when the supervisor is detected.
- **Existing PRs and worktrees** are untouched. RFC-0041 changes how *new* dispatches happen.

## 9. Alternatives Considered

### 9.1 Patch the Anthropic platform watchdog

**Rejected.** The 600s watchdog is in Anthropic infrastructure (tengu/runtime), not in the open `claude-code` client. No env var, settings key, or per-agent option exposes it. Confirmed by reading `/Users/dominique/Documents/dev/ai-sdlc/claude-code/src/utils/timeouts.ts` and surrounding runtime files. Even if Anthropic raised it to 60 minutes tomorrow, the structural problem (Conductor blocked while Workers run; no parallelism within one CC session) would persist.

### 9.2 Force every long subprocess to emit progress

**Rejected.** Wrapping `pnpm test` in a progress-emitter would require either modifying every workspace's test scripts (~6 packages × N scripts), or shipping a `cli-keepalive` wrapper that interleaves `[progress]` lines on stdout. Either path adds significant maintenance surface and is fragile against future commands not threaded through the wrapper. The process-boundary fix is one-time and complete.

### 9.3 Operator opens N terminals, each runs `/ai-sdlc execute <task-id>`

**Rejected as primary path; retained as operator escape hatch.** This works (foreground sessions have no watchdog) but requires operator time per task to open the terminal, paste the command, and monitor. It defeats RFC-0015's goal of an unattended autonomous loop. Operators may still use this for one-off tasks; RFC-0041 doesn't remove the option.

### 9.4 Background daemon as the Conductor too

**Rejected.** The Conductor needs `AskUserQuestion` to surface design decisions, `Agent` to spawn reviewers, MCP tools for backlog edits, and operator interactivity. A headless daemon loses all of these. The Conductor IS a Claude Code session; the fix is to move only the Workers out.

### 9.5 In-process worker pool (the literal reading of RFC-0015 §4.1)

**Rejected.** Worker LLM calls would still go through the Claude Code platform with the same watchdog. The fix has to be a process boundary, not a thread boundary.

## 10. Open Questions

1. Should the supervisor be a separate npm-installed CLI (`@ai-sdlc/dispatch-supervisor`) shipped to adopters, or live exclusively in this repo as a dogfood-only tool? Adopters will need the same isolation; recommend npm-installed, but defer the package split to Phase 2.
2. How does the supervisor authenticate to the Claude API for `claude -p`? Reuses operator's `~/.claude/credentials` by default (same path Claude Code uses); for CI/headless contexts, requires `ANTHROPIC_API_KEY` env. Both paths exist today; RFC-0041 doesn't add a new auth mode.
3. Heartbeat threshold (35 min default) — is that adequate for the slowest realistic task? Empirically, the longest observed `pnpm test` runs were ~12 min. 35 min leaves headroom but isn't so long that genuinely-hung Workers tie up resources for hours. Revisit after Phase 2 dogfood.
4. Should the Worker re-spawn for the iterate-dev case (verifier fails, RFC-0015 §5 budget=2)? Two options: (a) Worker handles iteration internally (one Worker per task, two iterations possible); (b) Worker exits after one iteration, Conductor writes a new manifest with `iteration: 2`. Option (b) is simpler and lets the supervisor enforce concurrency consistently. Recommend (b); flag as OQ for operator walkthrough.
5. Cross-soul / multi-host scaling — RFC-0015 §10 deferred this. RFC-0041 also defers. Note: the Dispatch Board protocol is filesystem-local; multi-host would require either a shared filesystem (NFS) or replacing the board with a real queue (Redis, NATS). Future RFC.

## 11. References

- RFC-0010 Parallel Execution and Worktree Pooling — `spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md`
- RFC-0012 Two-Tier Pipeline (slash-command + library composition) — `spec/rfcs/RFC-0012-...md`
- RFC-0015 Autonomous Pipeline Orchestrator — `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`
- 2026-05-20 session memory `feedback_watchdog_systemic_failure.md` — empirical 6-of-7 kill rate documenting the failure mode this RFC closes
- Claude Code client repo (investigated, no override found): `/Users/dominique/Documents/dev/ai-sdlc/claude-code`
- `pipeline-cli/src/runtime/shell-claude-p-spawner.ts` — existing 30-min watchdog the supervisor would reuse
