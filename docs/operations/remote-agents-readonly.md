# Remote-sandbox read-only constraint (AISDLC-442)

CCR (Claude Code Remote) sandboxes are **read-only by design** with respect to the AI-SDLC execution pipeline. This document covers what CCR can and cannot do, why the constraint exists, and the supported handoff workflow that bridges CCR tasks to local execution.

## Why CCR is read-only

`/ai-sdlc execute` requires four prerequisites that are absent in every CCR sandbox:

| Prerequisite | Local session | CCR sandbox | Notes |
|---|---|---|---|
| `~/.ai-sdlc/signing-key.pem` | Present | Absent | Operator-machine-local; never transported to sandbox |
| Plugin install | Present | Absent | `mcp__plugin_ai-sdlc_ai-sdlc__*` tools unavailable |
| Worktree filesystem | Present | Absent | `git worktree add .worktrees/<id>` fails in sandbox layout |
| Operator filesystem | Present | Absent | `.ai-sdlc/trusted-reviewers.yaml` pubkeys inaccessible |

Without all four, running `/ai-sdlc execute` in CCR produces cryptic downstream errors (missing signing key at Step 10, worktree creation failures at Step 3, plugin tool calls failing silently). AISDLC-442 adds an early-exit guard that detects the CCR environment and refuses with this message instead:

```
ERROR: /ai-sdlc execute cannot run in a CCR remote sandbox. (CLAUDE_CODE_ENV=ccr detected)

Remote sandboxes are read-only by design — they lack:
  - ~/.ai-sdlc/signing-key.pem (operator-machine-local, never in CCR)
  - Plugin install (no mcp__plugin_ai-sdlc_ai-sdlc__* tools)
  - Worktree filesystem (sandbox layout differs)
  - Operator filesystem (.ai-sdlc/trusted-reviewers.yaml pubkeys)

Supported alternatives from a CCR sandbox:
  1. File a backlog task for local pickup:
       Use mcp__backlog__task_create (works fine in CCR)
  2. File a GitHub issue for local pickup:
       Use mcp__github__create_issue (works fine in CCR)
  Then run /ai-sdlc execute <task-id> from a LOCAL Claude Code session.

See: docs/operations/remote-agents-readonly.md
```

## What CCR can do

| Operation | Works? | How |
|---|---|---|
| Survey open PRs | Yes | `gh pr list` |
| Check CI run health | Yes | `gh run list` |
| Post Slack digest | Yes | Webhook / `mcp__slack__*` |
| File a backlog task | Yes | `mcp__backlog__task_create` |
| File a GitHub issue | Yes | `mcp__github__create_issue` |
| Read backlog task status | Yes | `mcp__backlog__task_view` |
| Read repository files | Yes | `Read` tool |
| Search / grep repository | Yes | `Grep`, `Glob` tools |
| Survey flaky CI tests | Yes | `gh run list` + `gh run view` |
| Post PR comments (survey results) | Yes | `gh pr comment` |

## What CCR cannot do

| Operation | Why not |
|---|---|
| `/ai-sdlc execute` | Requires signing key + worktree + plugin install |
| Sign attestation envelopes | Requires `~/.ai-sdlc/signing-key.pem` |
| `git worktree add` | Sandbox filesystem layout differs |
| Run developer subagent | Plugin subagents (`developer`, `code-reviewer`, etc.) unavailable |
| Write to `.ai-sdlc/` config | Read-only governance config |
| Cross-repo writes | `permittedExternalPaths` resolved via `.active-task` sentinel absent |
| Call `mcp__plugin_ai-sdlc_ai-sdlc__*` | Plugin not installed in sandbox |

## Supported handoff workflow

When a `/schedule` CCR task detects work that needs local execution:

### Step 1 — File a backlog task (preferred for well-scoped work)

```
Use mcp__backlog__task_create with:
  title: clear, imperative description of the work
  description: full context — what triggered it, expected outcome, relevant files
  labels: [documentation | fix | feat | ...] as appropriate
  acceptanceCriteria: numbered list of ACs the local developer should satisfy
```

Include any relevant context the local session will need:
- File paths that need changing
- Error messages that triggered the work
- Links to CI runs, PRs, or issues
- Any research already done

### Step 2 — Alternatively, file a GitHub issue (for broader or exploratory work)

```
Use mcp__github__create_issue with:
  title: short imperative description
  body: markdown body with full context, links, reproduction steps
  labels: as appropriate
```

The local operator session can then route via `/ai-sdlc execute <issue-number>` (AISDLC-393 GH-issue path).

### Step 3 — Local operator session picks it up

On the next `/ai-sdlc orchestrator-tick`, the autonomous orchestrator reads the new task from the frontier and dispatches a developer subagent. Or the operator manually runs:

```bash
/ai-sdlc execute AISDLC-NNN
```

## Detection heuristics used by `/ai-sdlc execute`

The guard runs before any other step (before even path resolution). It checks three signals in order:

1. **`CLAUDE_CODE_ENV=ccr`** — canonical env var injected by Claude Code in CCR sessions. Exact, case-sensitive match.
2. **`CLAUDE_REMOTE_EXECUTION=1`** — alternative injection used in some operator configurations.
3. **`CLAUDE_CODE_ENV` set (any value) + `~/.ai-sdlc/signing-key.pem` absent** — conservative fallback. Fires only when BOTH hold, to avoid false-positives on local sessions that haven't run `/ai-sdlc init-signing-key` yet.

### Override for test environments

Integration tests or local CI environments that inject CCR-like env vars without actually being CCR sandboxes can bypass the guard:

```bash
AI_SDLC_SKIP_CCR_GUARD=1 /ai-sdlc execute AISDLC-NNN
```

Use sparingly. The guard protects against confusing downstream failures; bypassing it in non-CCR environments is safe but not recommended as a default.

## Architectural context

The read-only constraint is not an arbitrary policy — it reflects a deliberate security boundary:

- **Signing keys must stay operator-local.** Transporting `~/.ai-sdlc/signing-key.pem` into a managed sandbox would allow the sandbox operator (Anthropic, or whichever cloud provider runs CCR) to forge review attestations. The Merkle-transcript attestation model (RFC-0042) is specifically designed so the operator's key never leaves the local machine.
- **Worktree isolation is Pattern C.** The `.worktrees/<task-id>/` layout assumes a local filesystem with full git-worktree support. Sandbox environments may not expose the underlying `.git` directory in a way that supports `git worktree add`.
- **Plugin MCP server is not installed in sandboxes.** The `mcp__plugin_ai-sdlc_ai-sdlc__*` tools (task lifecycle management, permittedExternalPaths enforcement) require the plugin's MCP server to be running, which requires the plugin to be installed.

For the architectural paths that WOULD enable `/ai-sdlc execute` from CCR (signing-key transport alternatives, attestation trust model changes, worktree filesystem bridging), see the operator-maintained research at `/tmp/issue-701-research.md`. That is RFC-class work; this document covers the current-state constraint only.

## Related

- `CLAUDE.md` — "Remote agents (`/schedule`) — read-only by design" section
- `ai-sdlc-plugin/commands/execute.md` — "Remote-sandbox guard (AISDLC-442)" section
- `docs/operations/init.md` — how to run `/ai-sdlc init-signing-key` on a local session
- RFC-0042 — v6 attestation schema (Merkle-transcript model, operator-local signing)
