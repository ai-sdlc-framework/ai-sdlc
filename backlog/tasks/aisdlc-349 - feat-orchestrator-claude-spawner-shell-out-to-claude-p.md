---
id: AISDLC-349
title: 'feat(orchestrator): add --spawner claude that actually shells out to `claude -p` for autonomous tick'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - framework-gap
  - orchestrator
  - spawner
  - autonomous-tick
dependencies: []
priority: high
references:
  - pipeline-cli/src/runtime/spawners/claude-cli-inline.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
---

## Bug

`cli-orchestrator tick --spawner claude-cli` invoked from a shell (NOT inside a Claude Code session) silently fails because `ClaudeCliInlineSpawner.spawn()` only writes a `dispatch-manifest.json` — it does NOT shell out to `claude -p`. The orchestrator gets back `output: ''` and the developer subagent is reported as `developer-json-contract-violated`.

Encountered 2026-05-16: ran `cli-orchestrator tick --max-concurrent 2 --spawner claude-cli` from terminal expecting autonomous dispatch. Both admitted tasks (AISDLC-281, AISDLC-285) returned `developer-json-contract-violated` with raw output `""`. Diagnosed at `pipeline-cli/src/runtime/spawners/claude-cli-inline.ts:219-244`:

```ts
spawn(opts: SpawnOpts): Promise<SubagentResult> {
  // ...writes manifest to dispatch-manifest.json...
  return Promise.resolve({
    type: opts.type,
    output: '',
    status: 'manifest-emitted',  // ← no actual claude -p invocation
    manifest,
    ...
  });
}
```

The architecture assumes a slash command body (running in main Claude Code session) reads the manifest and dispatches the `Agent` tool. That's the `/ai-sdlc execute` flow. But for **shell-driven** `cli-orchestrator tick` (cron/daemon/sidecar pattern per RFC-0015), there's no slash command body to read the manifest.

## Operator question (2026-05-16)

> "Do we need to add a --spawner claude option?"

Answer: yes. The current `claude-cli` spawner name is misleading (it's a manifest emitter, not a CLI invoker).

## Design options

**Option A — rename current + add new (recommended)**:
- Rename `claude-cli` → `claude-cli-manifest` (keep for `/ai-sdlc execute` slash command body flow)
- Add new `claude` (or `claude-cli-direct`) spawner that actually `child_process.spawn`s `claude -p` and parses the JSON output
- `cli-orchestrator tick --spawner claude` becomes the autonomous shell-driven path

**Option B — fix `claude-cli` to do both**:
- Detect whether running inside a Claude Code session (e.g., check `CLAUDE_CODE_SESSION_ID` env var)
- If yes: emit manifest (current behavior)
- If no: shell out to `claude -p` directly
- Single spawner, dual behavior

**Option A** is cleaner — explicit operator choice, no env-var magic, easier to test.

## Acceptance criteria

- [ ] **New spawner**: `pipeline-cli/src/runtime/spawners/claude-direct.ts` (or similar) that:
   - Resolves `claude` binary from PATH (or `CLAUDE_BIN` env override)
   - Spawns `claude -p --model <model>` with the dev/reviewer prompt on stdin
   - Captures stdout, parses as JSON, returns `SubagentResult`
   - Honors the per-role model split (sonnet for dev/code/test, opus for security) per `DEFAULT_MODELS` in `claude-cli-inline.ts`
   - Handles `claude -p` failure modes (binary missing, quota exhausted, non-JSON output) with actionable error messages
   - Stream `[ai-sdlc-progress]` lines from claude's stdout in real time
- [ ] **Register in spawner factory**: `pipeline-cli/src/orchestrator/loop.ts` accepts new spawner name in `--spawner` flag + `AI_SDLC_ORCHESTRATOR_SPAWNER` env
- [ ] **Test coverage**: spawn invocation, stdout parsing, error paths, model selection per role, prompt streaming
- [ ] **Docs update**: `pipeline-cli/docs/spawner.md` documents the new spawner + when to use it (autonomous tick vs slash command body)
- [ ] **CLAUDE.md update**: Canonical execution paths table gains a row for autonomous orchestrator tick via shell
- [ ] **Cost note**: clarify that this spawner uses subscription billing (via `claude -p`), same as `/ai-sdlc execute` — distinct from `--spawner api-key` which uses Anthropic API tokens

## Out of scope

- Renaming current `claude-cli` (could break `/ai-sdlc execute` callers — backward-compat is its own task)
- Per-stage parallelism beyond the existing `--max-concurrent` (orthogonal — RFC-0010 §13 work)
- Changes to the manifest format used by `claude-cli-inline.ts`

## Source

Operator question 2026-05-16 during autonomous backlog dispatch session, after `cli-orchestrator tick` from shell silently produced `developer-json-contract-violated` on both admitted tasks. Filed alongside the manual-dispatch fallback that I used to keep throughput while this gap exists.
