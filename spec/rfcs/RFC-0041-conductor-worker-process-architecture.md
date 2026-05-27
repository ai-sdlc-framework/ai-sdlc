---
id: RFC-0041
title: Conductor / Worker Process Architecture for Autonomous Dispatch
status: Implemented
lifecycle: Implemented
author: Dominique Legault
created: 2026-05-20
updated: 2026-05-26
targetSpecVersion: v1alpha1
requires:
  - RFC-0010
  - RFC-0012
  - RFC-0015
implementedBy:
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/dispatch/types.ts
  - pipeline-cli/src/dispatch/supervisor.ts
  - pipeline-cli/src/dispatch/recommend-worker.ts
  - pipeline-cli/src/dispatch/cost-estimate.ts
  - pipeline-cli/bin/cli-dispatch-supervisor.mjs
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/orchestrator/dispatch-bg-agent.ts
requiresDocs: []
---

# RFC-0041: Conductor / Worker Process Architecture for Autonomous Dispatch

**Status:** Implemented
**Lifecycle:** Implemented — OQ walkthrough complete 2026-05-20; all 7 §10 OQs resolved; Engineering + Operator signed off. All 6 phase sub-tasks (AISDLC-377.1–377.6) reached Done 2026-05-25/26; Dispatch Board protocol, `in-session-agent` Worker, `claude-p-shell` supervisor, and `--spawner claude-cli` removal shipped.
**Author:** Dominique Legault
**Created:** 2026-05-20
**Updated:** 2026-05-20
**Target Spec Version:** v1alpha1
**Depends on:** RFC-0010 (Parallel Execution), RFC-0012 (Two-Tier Pipeline), RFC-0015 (Autonomous Pipeline Orchestrator)
**Anchor:** Extension of RFC-0015; defines the cross-process execution model that RFC-0015 left to implementation.

---

## Sign-Off

- [x] Engineering owner — Dominique Legault (2026-05-20)
- [x] Operator owner — Dominique Legault (2026-05-20)

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-05-20 | dominique | Initial draft. Surfaces the Conductor/Worker process split that RFC-0015 implies but never named. Closes the "in-CC-session dispatch" gap exposed by 2026-05-20 4-wide drain attempt (6/7 dev subagents killed by Anthropic platform's 600s background-agent watchdog). |
| v2 | 2026-05-20 | dominique | Per-operator-2026-05-20 feedback: surface the 2026-06-15 Agent SDK credit cost wall. v1's single Worker model (`claude -p` shell-out) would become API-token-billed post-2026-06-15. v2 makes Worker invocation **pluggable** with two kinds: `in-session-agent` (foreground `Agent` in operator-opened CC session, preserves subscription quota indefinitely per AISDLC-353) and `claude-p-shell` (supervisor-spawned, Agent SDK credit pool, for headless/CI contexts). Adds `workerKind` to manifest schema, `.ai-sdlc/dispatch-config.yaml` for operator default, reorders implementation phases (in-session-agent now Phase 1; supervisor demoted to Phase 2). |
| v3 | 2026-05-20 | dominique | OQ walkthrough complete — all 7 Open Questions resolved per §10 Resolution markers. Key decisions: supervisor lives in `pipeline-cli/bin/` (not standalone package); auth inherits operator env (no new mode); heartbeat threshold = 30 min (single source of truth with `ShellClaudePSpawner.DEFAULT_TIMEOUT_MS`); iteration is Conductor-triggered but Worker-driven with context-preserving session resumption (via `claude -p --resume <session-id>` for shell kind, `Agent continue: true` for in-session kind); filesystem-local only (multi-host deferred); cost-first via biased poll cadence (in-session-agent 5s vs supervisor 15s); reactive quota cool-down with `Retry-After` honoring + exponential backoff. Lifecycle stays Draft pending operator + Product sign-off. |

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

### 4.1 The cost-model constraint (post-2026-06-15)

Before describing the process model, the economic constraint that shapes it: after **2026-06-15**, every `claude -p` invocation (whether via `--spawner claude` shell-out or via the Claude Code SDK) draws from the per-plan **Agent SDK credit pool** (~$200/mo on Max-20x), with overflow billed at API-token rates. The pre-2026-06-15 model where shell-spawned `claude -p` ran on subscription interactive quota does not survive.

The only invocation path that remains on subscription quota indefinitely is the one documented in AISDLC-353: **the `Agent` tool called from a slash-command body inside an operator's live Claude Code session.** That call is interpreted by Anthropic as part of an interactive turn (which the operator's subscription covers), not as an Agent SDK invocation (which the credit pool covers).

This means RFC-0041 cannot specify a single Worker model. It must support two interchangeable kinds against the same Dispatch Board protocol:

| Worker kind | Watchdog | Cost post-2026-06-15 | Parallelism | Best for |
|---|---|---|---|---|
| `in-session-agent` (foreground `Agent` call from slash-command body) | None observed (interactive) | **Subscription quota** (no incremental cost) | One per CC session; N sessions = N parallel | High-volume autonomous drain on operator's subscription |
| `claude-p-shell` (supervisor spawns `env -u CLAUDECODE claude -p`) | Our own 30 min (`ShellClaudePSpawner`) | Agent SDK credit pool then API tokens | N from one supervisor | Headless CI, true daemon, ops contexts where no CC session is available |

The Dispatch Board protocol (§4.4) is shared. The Conductor writes the same manifest regardless. The two Worker kinds plug into different sides of the same board.

### 4.2 Process model

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
             ▲                                       ▲
             │                                       │
       ┌─────┴─────┐                           ┌─────┴─────┐
       │ kind A    │                           │ kind B    │
       │ in-session│                           │ claude-p- │
       │ -agent    │                           │ shell     │
       │ (Sub-$)   │                           │ (SDK-$)   │
       └─────┬─────┘                           └─────┬─────┘
             │ claim via foreground Agent          │ claim via supervisor atomic rename
             ▼                                       ▼
  ┌────────────────────────┐  ┌────────────────────────┐  ┌─────────────┐
  │ N parallel CC sessions │  │ Worker Supervisor      │  │ ...         │
  │ each running           │  │ - Tiny daemon (~150    │  │             │
  │ /ai-sdlc orchestrator- │  │   LOC, supervised by   │  │             │
  │ tick on a loop;        │  │   launchd/systemd or   │  │             │
  │ each tick claims one   │  │   manual `pnpm dev`)   │  │             │
  │ manifest, invokes      │  │ - Polls queue/         │  │             │
  │ Agent foreground       │  │ - Atomic claim → spawn │  │             │
  │ (no watchdog kill)     │  │   env -u CLAUDECODE    │  │             │
  └────────────────────────┘  └────────────────────────┘  └─────────────┘
```

Key properties (shared across both Worker kinds):

1. **Process boundary** — Conductor (CLAUDECODE=1) and Worker execution context never share a process tree directly. For `claude-p-shell`, the supervisor scrubs `CLAUDECODE` before spawn. For `in-session-agent`, the Worker IS a separate CC session (different shell, different operator-opened terminal) running its own `/ai-sdlc orchestrator-tick` loop.
2. **Asynchronous hand-off** — Conductor writes a dispatch manifest and walks away. Workers pick up when ready. Conductor polls the Dispatch Board (cheap filesystem stat) at its own cadence; no streaming connection.
3. **Watchdog ownership** — `claude-p-shell` Workers use our 30-min watchdog in `shell-claude-p-spawner.ts`. `in-session-agent` Workers run inside foreground `Agent` calls in their own CC session, which have no background-agent 600s watchdog (foreground calls show a live spinner; the platform trusts them).
4. **Stateless Workers** — each Worker handles exactly one task, writes a verdict, exits. The Conductor restarts dispatch on failure; no in-Worker recovery state.
5. **Pluggable backend per manifest** — a manifest can declare `workerKind: in-session-agent` or `workerKind: claude-p-shell` (default: operator's project-level config). The Dispatch Board doesn't care; only the Worker-side claim logic differs.
6. **Bounded parallelism** — for `claude-p-shell`, the supervisor enforces `parallelism.maxConcurrent` from `WorktreePool` (RFC-0010 §6.7). For `in-session-agent`, parallelism = number of operator-opened CC sessions, each running one task at a time. Both bound on the same project-level cap.

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

### 4.3 Worker kinds

Two pluggable backends against the Dispatch Board. A manifest's `workerKind` field declares which kind owns it; the Conductor sets the default from `.ai-sdlc/dispatch-config.yaml` and may override per-task. Adopters MAY ship only one kind; both is recommended for cost flexibility.

#### 4.3.1 `in-session-agent` — subscription-quota, operator-parallel

Each Worker is its own Claude Code interactive session opened in a separate terminal. The session runs `/ai-sdlc orchestrator-tick` on a `ScheduleWakeup` loop. Each tick:

1. Looks for an unclaimed manifest in `queue/` matching `workerKind ∈ {any, in-session-agent}`.
2. Claims it via atomic `rename` to `inflight/`.
3. Invokes the `ai-sdlc:developer` agent via a **foreground** `Agent` call from the slash-command body. Foreground calls inside an interactive CC session are not subject to the background-agent 600s watchdog.
4. On agent return, writes the verdict to `done/` (success) or `failed/` (with diagnostic), then `ScheduleWakeup` for the next tick.
5. If `queue/` is empty for `workerKind ∈ {any, in-session-agent}`, the session hibernates 30-60s and tries again.

**Cost model**: Foreground `Agent` calls in an interactive CC session draw from the operator's **subscription interactive quota**, not the Agent SDK credit pool. This is the AISDLC-353 path. As long as the operator keeps N sessions open, N tasks run in parallel at zero incremental cost.

**Parallelism**: 1 task per session at any time. Operator-controlled parallelism by opening more terminals. Practical ceiling: ~6-8 sessions per operator before subscription quota starts queuing requests (operator-observed).

**Trade-off**: requires N terminals to be open (`tmux`, iTerm tabs, etc.). Each session needs the operator's Anthropic credentials. Sessions don't survive a laptop reboot without explicit operator action — recommend `tmux` + `claude` + a startup script.

**Failure modes specific to this kind**:
- *Session crashes mid-tick* — heartbeat goes stale → supervisor (or Conductor sweep) moves manifest back to `queue/` after 35 min idle.
- *Subscription quota exhausted* — `Agent` tool returns rate-limit error → Worker writes `failed/<id>.diagnostic.json` with `cause: quota-exhausted`, Conductor backs off all dispatch for the operator-configured cool-down period.

#### 4.3.2 `claude-p-shell` — Agent-SDK-credit, supervisor-parallel

Each Worker is a `claude -p` subprocess spawned by a supervisor daemon. The supervisor scrubs `CLAUDECODE` from the env and enforces the project-level concurrency cap.

**Cost model** (post-2026-06-15): Each `claude -p` invocation draws from the per-plan **Agent SDK credit pool** (~$200/mo on Max-20x). Overflow billed at API-token rates. Suitable for headless CI, ops-driven cron, or environments without an operator-opened CC session.

**Parallelism**: N from a single supervisor (bounded by `WorktreePool.spec.parallelism.maxConcurrent` from RFC-0010 §6.7). No operator terminal required.

**Trade-off**: costs money post-2026-06-15. Best for bursts the operator wants to run without interactive supervision (overnight catch-up, CI-triggered batch).

**Failure modes specific to this kind**:
- *Spawn refused* (no signing key, no Anthropic credentials) — supervisor writes `failed/<id>.diagnostic.json` with `cause: spawn-rejected`, no retry.
- *30 min watchdog fires* — supervisor's `setTimeout` in `shell-claude-p-spawner.ts` sends SIGTERM, writes `failed/<id>.diagnostic.json` with `cause: shell-watchdog-fired`.
- *Anthropic credit pool exhausted* — `claude -p` exits non-zero with quota error; supervisor writes diagnostic + backs off subsequent spawns.

#### 4.3.3 Choosing a default

The Conductor reads `.ai-sdlc/dispatch-config.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DispatchConfig
metadata:
  name: ai-sdlc-dispatch
spec:
  defaultWorkerKind: in-session-agent   # 'in-session-agent' | 'claude-p-shell'
  parallelism:
    inSessionAgentMaxSessions: 4          # operator's expected open-terminal count
    claudePShellMaxConcurrent: 0          # 0 = supervisor disabled; bump to enable
  inSessionAgent:
    quotaBackoffSec: 600                  # cool-down on rate-limit
  claudePShell:
    watchdogMs: 1800000                   # 30 min default
    supervisorPidFile: .ai-sdlc/dispatch/.supervisor.pid
```

Adopters that never want API-token billing can set `claudePShellMaxConcurrent: 0` and only operate in-session-agent. Adopters running headless CI can flip the default to `claude-p-shell` and accept the credit-pool cost.

### 4.4 Dispatch Board protocol

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
  "workerKind": "in-session-agent",
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

`workerKind` is one of `in-session-agent` | `claude-p-shell` | `any`. `any` means either backend may claim it (use when the operator wants the first available Worker regardless of cost). The Conductor sets `workerKind` from `.ai-sdlc/dispatch-config.yaml` `spec.defaultWorkerKind` and may override per task.

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

- **Conductor** — exactly one per project. Usually the operator's primary CC session. If multiple, the latest manifest write wins (Conductors are stateless w.r.t. the board; they observe and respond).
- **Supervisor (`claude-p-shell` only)** — optional. Zero or one per project. PID stored at `.ai-sdlc/dispatch/.supervisor.pid`; refuses to start if a live PID is already there. Adopters running only `in-session-agent` don't need a supervisor at all.
- **Workers** — N total across both kinds:
  - `in-session-agent` Workers: 0 to ~8 (operator-opened terminal count). Each is its own CC session running `/ai-sdlc orchestrator-tick` on a `ScheduleWakeup` loop.
  - `claude-p-shell` Workers: 0 to `parallelism.maxConcurrent` (`WorktreePool` cap). Each is a `claude -p` subprocess spawned by the supervisor.

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

Three phases, each shippable independently. **Phase 1 prioritizes the `in-session-agent` Worker kind** because it preserves the subscription-quota cost model post-2026-06-15 (per AISDLC-353) and unblocks the immediate operator pain point without a daemon dependency. The supervisor (`claude-p-shell` Worker kind) is a Phase 2 add for headless contexts.

### Phase 1 — Dispatch Board protocol + `in-session-agent` Worker

- [ ] Publish `spec/schemas/dispatch-manifest.v1.schema.json` and `dispatch-verdict.v1.schema.json` (manifest includes `workerKind` field)
- [ ] Conductor-side library in `pipeline-cli/src/dispatch/`: `writeManifest()`, `collectVerdicts()`, `peekQueue()`, `claimNext(workerKind)`
- [ ] Update `/ai-sdlc orchestrator-tick` slash command to use the new dispatch-board library: emit manifests instead of `Agent(... run_in_background)`, foreground-poll `done/` on each `ScheduleWakeup` tick
- [ ] New slash command `/ai-sdlc dispatch-worker` (or extend `orchestrator-tick`): the operator opens N CC sessions and fires this in each; the slash-command body claims a manifest, foreground-invokes the `ai-sdlc:developer` agent on it, writes the verdict, ScheduleWakeup-loops
- [ ] `.ai-sdlc/dispatch-config.yaml` schema with `defaultWorkerKind: in-session-agent` default
- [ ] Hermetic test: simulate 3-manifest queue + 2 Worker sessions; verify atomic claim, no double-pickup, both Workers go idle when queue empties
- [ ] Hermetic test: Conductor pickup loop handles `success`, `iterate-needed`, `failed` verdict outcomes correctly
- [ ] Acceptance: this session as Conductor + 2 operator-opened sibling CC sessions as Workers drain 2 frontier tasks concurrently with zero 600s kills

### Phase 2 — Supervisor + `claude-p-shell` Worker (headless path)

- [ ] `pipeline-cli/bin/cli-dispatch-supervisor.mjs` — ~150 LOC daemon: atomic claim, `env -u CLAUDECODE claude -p` spawn, heartbeat sweep, exit handling
- [ ] `pnpm supervisor:start` / `supervisor:status` / `supervisor:stop` scripts
- [ ] `docs/operations/dispatch-supervisor-install.md` with `launchd` plist + `systemd --user` unit
- [ ] Conductor logic: detect `.ai-sdlc/dispatch/.supervisor.pid` presence + use it for manifests tagged `workerKind: claude-p-shell` or `any`
- [ ] Cost-warning UX: Conductor prints projected Agent SDK credit cost when first manifest with `claude-p-shell` is queued in a session
- [ ] Hermetic test: 3 mock manifests, supervisor spawns 3 mock workers (subprocess stubs), all 3 verdicts collected
- [ ] Acceptance: a headless cron job runs `cli-dispatch-supervisor` continuously; Conductor in a separate CC session emits manifests; drain succeeds with no operator-opened Worker sessions

### Phase 3 — Deprecate `--spawner claude-cli`, tune defaults

- [ ] Add deprecation warning to `--spawner claude-cli` (the legacy in-CC path that races the 600s watchdog)
- [ ] Operator runbook: documentation of the three patterns (in-session-agent, claude-p-shell, hybrid)
- [ ] `cli-deps frontier` annotates each frontier entry with `recommendedWorkerKind` based on estimated cost + task size
- [ ] After one release with the deprecation warning, remove `claude-cli` spawner kind entirely (separate PR)
- [ ] Acceptance: no `Agent(... run_in_background: true)` calls remain in the dispatch hot path; existing `/ai-sdlc execute` (single-task interactive) unchanged

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

1. ~~Should the supervisor be a separate npm-installed CLI (`@ai-sdlc/dispatch-subervisor`) shipped to adopters, or live exclusively in this repo as a dogfood-only tool?~~ **Resolution (operator walkthrough 2026-05-20):** Ship as a bin in `pipeline-cli` (`pipeline-cli/bin/cli-dispatch-supervisor.mjs`) alongside the other CLI bins. Matches the existing convention (every CLI lives in `pipeline-cli/bin/`), zero adopter friction — one `pnpm install` covers it. Independent versioning was considered (alternative B: `@ai-sdlc/dispatch-supervisor` standalone package) and rejected as premature: at ~150 LOC the supervisor doesn't justify a separate package + publishConfig + release-please surface, and a split is a 30-min refactor later if it becomes warranted (e.g. supervisor grows past ~500 LOC or develops independent external deps). Counter-argument considered: bug-fix release latency from coupling — rebutted because `pipeline-cli` releases via release-please within hours of merge, not weeks.
2. ~~How does the supervisor authenticate to the Claude API for `claude -p`?~~ **Resolution (operator walkthrough 2026-05-20):** Inherit operator env. Supervisor passes through whatever env it has: `~/.claude/credentials` for operator-laptop subscription (post-2026-06-15 → Agent SDK credit pool) OR `ANTHROPIC_API_KEY` for CI/headless (per-call API tokens). Same precedence as `claude -p` itself; matches `gh`/`aws`/`gcloud` conventions. No new auth mode, no DispatchConfig field. **Cost-surfacing UX is the Conductor's job, not the supervisor's** — when the Conductor emits a `claude-p-shell` manifest, it prints projected cost (per the Phase 2 plan). Counter-argument considered: operator-tmux silent-cost risk — rebutted because cost UX belongs in the dispatch layer (Conductor), not in the spawner (supervisor).
3. ~~Heartbeat threshold (35 min default) — is that adequate for the slowest realistic task?~~ **Resolution (operator walkthrough 2026-05-20):** **30 min**, matching `ShellClaudePSpawner.DEFAULT_TIMEOUT_MS = 30 * 60 * 1000`. Single source of truth — supervisor's stale-detector and Worker's own watchdog fire at the same threshold. Configurable via `AI_SDLC_DISPATCH_WORKER_TIMEOUT_MS` (single env var changes both atomically). Counter-argument considered: 5-min margin to dodge the simultaneous-fire race — rebutted because no race exists (Worker's SIGTERM writes `failed/<id>.diagnostic.json`; supervisor's sweep is conditional on `inflight/` membership and clears the inflight set on spawn-handler exit). If empirical false-kills appear in Phase 2 dogfood, bump from data; do not preemptively pad.
4. ~~Should the Worker re-spawn for the iterate-dev case (verifier fails, RFC-0015 §5 budget=2)?~~ **Resolution (operator walkthrough 2026-05-20):** **Conductor-initiated, Worker-driven, context-preserving.** The Conductor's role is to **trigger** the iteration — it writes a resume signal (e.g. `inflight/<id>.resume.json` with the new feedback) but does NOT pick a fresh Worker or re-bootstrap the task. The original Worker resumes with its **full prior conversation state** plus the Conductor's added feedback context. Implementation surface differs by Worker kind:

   - **`in-session-agent` Worker**: the Worker's slash-command-body loop is still alive after the first `Agent` call returns. Next loop iteration checks for a resume signal on the manifest it just completed; if present, invokes `Agent` again with `continue: true` semantics (re-spawning the same subagent type with the prior thread + feedback prepended).
   - **`claude-p-shell` Worker**: the supervisor captures the Worker's session ID before its exit (via `claude -p --session-id <uuid>` flag or `--output-format json` parse). On resume signal, supervisor re-spawns with `claude -p --resume <session-id> "<conductor-feedback>"` — `claude -p` natively supports session resumption, preserving the prior conversation transcript without re-bootstrap.

   Rejected alternative B (Conductor writes a fresh manifest with `iteration: 2`) because it forces the Worker to re-read the task body, re-explore the codebase, re-figure out the implementation plan — losing the "what I tried and why it failed" context that makes iteration valuable in the first place. The operator-preferred shape: **iteration is a continuation, not a restart**. Counter-argument considered: in-Worker resumption is harder to implement than B (requires session-ID capture + resume protocol) — accepted as a cost worth bearing for the context-preservation win. Each iteration still counts against the concurrency cap (the Worker holding its session counts as 1 inflight slot) and still respects the 30-min watchdog (resumption starts a fresh budget). Manifest fields added: `iterationsAttempted: 0` (incremented per resume), `iterationBudget: 2` (RFC-0015 §5 carryover), `lastSessionId: <uuid>` (set by Worker on first attempt).
5. ~~Cross-soul / multi-host scaling — RFC-0015 §10 deferred this. RFC-0041 also defers.~~ **Resolution (operator walkthrough 2026-05-20):** **Filesystem-local only**, defer multi-host to a separate future RFC. No `DispatchBoard` interface abstraction, no `kind: filesystem | redis | nats` enum on the schema. Matches RFC-0015's existing same deferral. Single-machine + single-Conductor + N-terminal-Workers covers every realistic adopter use case at v1. The manifest schema's `worktree` field is intrinsically filesystem-local — pretending otherwise via abstraction is dishonest. Counter-argument considered: future migration cost — rebutted because designing for hypothetical multi-host requirements is the premature-abstraction failure mode (we have *zero* signal about real multi-host adopter requirements; abstractions designed without that signal age badly). When multi-host actually surfaces, it gets its own RFC with concrete latency/consistency/auth requirements to design against.
6. ~~Default `workerKind` when both Worker kinds are configured.~~ **Resolution (operator walkthrough 2026-05-20):** **Cost-first via biased poll cadence.** `in-session-agent` Workers poll the queue every 5 seconds; `claude-p-shell` supervisor polls every 15 seconds. Both use atomic `rename` for claim. When a `workerKind: any` manifest is queued, the in-session-agent Worker wins the race ~95% of the time while subscription sessions are idle; the shell supervisor picks up within 15s when all sessions are saturated. Operators force the shell path with explicit `workerKind: claude-p-shell` tag per manifest; the inverse for shell-preferred. Poll cadences are configurable via `.ai-sdlc/dispatch-config.yaml` `spec.inSessionAgent.pollIntervalSec` and `spec.claudePShell.pollIntervalSec`. Counter-argument considered: race-condition fragility under load — accepted as acceptable v1 trade-off (the edge-race "wrong claim" is one task to shell, reversible by re-emit). If material cost surprises surface in Phase 2 dogfood, escalate to a proper scheduler. The bias preserves the AISDLC-353 economic priority (subscription quota is the framework's competitive moat post-2026-06-15).
7. ~~Subscription quota detection.~~ **Resolution (operator walkthrough 2026-05-20):** **Reactive + structured cool-down**, no pre-flight. On 429 (quota exhaustion), Worker writes `failed/<id>.diagnostic.json` with `{cause: "quota-exhausted", retryAfter: <seconds from Anthropic 429 Retry-After header, default 600s if absent>}`. Conductor sees the diagnostic and: (i) re-enqueues the failed task to `queue/` with `noClaimBefore: now + retryAfter`; (ii) pauses emitting new `workerKind: in-session-agent` (and `any`) manifests for `retryAfter` duration; (iii) surfaces an operator event ("Subscription quota exhausted, paused N tasks for 10 min"). Exponential backoff on successive failures (`quotaBackoffMultiplier: 2`, capped at `quotaBackoffMaxSec: 3600`). All configurable via `.ai-sdlc/dispatch-config.yaml` `spec.inSessionAgent.{quotaBackoffSec, quotaBackoffMaxSec, quotaBackoffMultiplier}`. Counter-argument considered: arbitrary cool-down duration — rebutted because we honor Anthropic's `Retry-After` header when present (correct most of the time); the default is the failure-case heuristic. **Selected over pre-flight (`/usage` parse)** because parsing the Claude Code client's local state is tight coupling to undocumented CC internals, brittle across CC version bumps.

## 11. References

- RFC-0010 Parallel Execution and Worktree Pooling — `spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md`
- RFC-0012 Two-Tier Pipeline (slash-command + library composition) — `spec/rfcs/RFC-0012-...md`
- RFC-0015 Autonomous Pipeline Orchestrator — `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`
- AISDLC-353 — subscription-only autonomous-tick path post-2026-06-15 — `backlog/completed/aisdlc-353 - feat-document-subscription-only-tick-path-post-agent-sdk-credit.md`. Documents the AISDLC-198/225 finding that foreground `Agent` calls in slash-command bodies stay on subscription quota; this RFC names that path as the `in-session-agent` Worker kind.
- 2026-05-20 session memory `feedback_watchdog_systemic_failure.md` — empirical 6-of-7 kill rate documenting the failure mode this RFC closes
- Claude Code client repo (investigated, no override found): `/Users/dominique/Documents/dev/ai-sdlc/claude-code`
- `pipeline-cli/src/runtime/shell-claude-p-spawner.ts` — existing 30-min watchdog the supervisor would reuse
