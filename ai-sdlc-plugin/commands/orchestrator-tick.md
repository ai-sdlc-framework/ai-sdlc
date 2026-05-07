---
name: orchestrator-tick
description: >-
  Run one orchestrator tick inline — reads the dispatch frontier, invokes the
  Agent tool for any admitted task (via the ClaudeCliInlineSpawner manifest
  protocol), writes the result back for the orchestrator tick loop, then
  optionally wakes again via ScheduleWakeup. This is the consumer-bridge
  half of AISDLC-198 Option 3.
argument-hint: "[--once]"
allowed-tools:
  - Read
  - Bash
  - Agent(developer, code-reviewer, test-reviewer, security-reviewer)
model: inherit
---

Run one autonomous orchestrator tick in the current Claude Code session.

This slash command is the **consumer bridge** for the `--spawner claude-cli`
inline path (AISDLC-225 / RFC-0015). The `ClaudeCliInlineSpawner` (AISDLC-198)
produces a dispatch manifest; this command reads that manifest, invokes the
`Agent` tool, writes the result back to disk, and returns control to the
orchestrator's tick loop.

> **Why this lives in the slash command body (not a subagent).** Plugin
> subagents cannot use the `Agent` tool — Claude Code filters it out one level
> deep, regardless of frontmatter declarations. The slash command body runs in
> the main Claude Code session which DOES have the `Agent` tool. See CLAUDE.md
> "Why this lives in the slash command body".

## Hard rules (identical to `/ai-sdlc execute`)

1. **Never merge any PR.** Do not run `gh pr merge`.
2. **Never force-push.** No `git push --force` / `-f`.
3. **Never close PRs or issues.** No `gh pr close`, `gh issue close`.
4. **Never delete branches.** No `git branch -D` / `-d`.
5. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.**
6. **Never run destructive git operations.** No `git reset --hard`.
7. **Never write CI-skip tokens** (`[skip ci]`, `[ci skip]`, etc.) in commits.

## Protocol overview

```
/ai-sdlc orchestrator-tick
  │
  ├── 1. Check AI_SDLC_AUTONOMOUS_ORCHESTRATOR is set
  ├── 2. node pipeline-cli/bin/cli-orchestrator.mjs tick --max-concurrent 1
  │         └── if spawner=claude-cli: writes dispatch-manifest.json,
  │               returns {status: 'manifest-emitted'}
  ├── 3. Detect manifest-emitted in tick output
  ├── 4. Read $ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json
  ├── 5. Invoke Agent tool with manifest parameters
  ├── 6. Write result to $ARTIFACTS_DIR/_orchestrator/dispatch-result.json
  ├── 7. node pipeline-cli/bin/cli-orchestrator.mjs tick (continues pipeline)
  └── 8. ScheduleWakeup(30s) — OR exit if --once passed
```

## Step 1 — Feature-flag guard

```bash
if [ -z "$AI_SDLC_AUTONOMOUS_ORCHESTRATOR" ]; then
  echo "ERROR: AI_SDLC_AUTONOMOUS_ORCHESTRATOR is not set. Set it to 'experimental' to enable."
  exit 1
fi
```

## Step 2 — Run one orchestrator tick

Run the tick via the direct-node invocation pattern (CLAUDE.md "CI behavior" /
AISDLC-156 — never `pnpm --filter ... exec cli-orchestrator`):

```bash
TICK_OUTPUT=$(AI_SDLC_AUTONOMOUS_ORCHESTRATOR="$AI_SDLC_AUTONOMOUS_ORCHESTRATOR" \
  node pipeline-cli/bin/cli-orchestrator.mjs tick --max-concurrent 1 2>&1)
TICK_EXIT=$?
echo "[orchestrator-tick] tick exited $TICK_EXIT"
echo "$TICK_OUTPUT"
```

Parse the JSON output to check for `manifest-emitted`:

```bash
# Extract manifest-emitted status from tick outcomes
MANIFEST_EMITTED=$(echo "$TICK_OUTPUT" | node -e "
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => {
    const raw = chunks.join('');
    // Find last JSON object in output (tick emits JSON to stdout)
    const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.ok && obj.tick) {
          const outcomes = obj.tick.outcomes || [];
          const emitted = outcomes.find(o => o.manifestEmitted);
          if (emitted) {
            process.stdout.write(JSON.stringify(emitted));
          }
        }
        break;
      } catch {}
    }
  });
" 2>/dev/null)
```

## Step 3 — Detect and handle manifest-emitted dispatches

When the spawner detected a task to dispatch and emitted a manifest:

```bash
if [ -n "$MANIFEST_EMITTED" ]; then
  # Resolve the manifest path
  ARTIFACTS_DIR="${ARTIFACTS_DIR:-$(pwd)/artifacts}"
  MANIFEST_PATH="$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json"
  RESULT_PATH="$ARTIFACTS_DIR/_orchestrator/dispatch-result.json"

  echo "[orchestrator-tick] manifest-emitted: reading $MANIFEST_PATH"

  # Read the manifest
  MANIFEST=$(cat "$MANIFEST_PATH" 2>/dev/null)
  if [ -z "$MANIFEST" ]; then
    echo "ERROR: dispatch-manifest.json not found at $MANIFEST_PATH"
    exit 1
  fi

  TASK_ID=$(echo "$MANIFEST" | node -e "const d=[]; process.stdin.on('data',c=>d.push(c)); process.stdin.on('end',()=>{ const m=JSON.parse(d.join('')); process.stdout.write(m.taskId||''); })")
  SUBAGENT_TYPE=$(echo "$MANIFEST" | node -e "const d=[]; process.stdin.on('data',c=>d.push(c)); process.stdin.on('end',()=>{ const m=JSON.parse(d.join('')); process.stdout.write(m.subagentType||'developer'); })")
  MODEL=$(echo "$MANIFEST" | node -e "const d=[]; process.stdin.on('data',c=>d.push(c)); process.stdin.on('end',()=>{ const m=JSON.parse(d.join('')); process.stdout.write(m.model||''); })")
  CWD=$(echo "$MANIFEST" | node -e "const d=[]; process.stdin.on('data',c=>d.push(c)); process.stdin.on('end',()=>{ const m=JSON.parse(d.join('')); process.stdout.write(m.cwd||process.cwd()); })")
  PROMPT=$(echo "$MANIFEST" | node -e "const d=[]; process.stdin.on('data',c=>d.push(c)); process.stdin.on('end',()=>{ const m=JSON.parse(d.join('')); process.stdout.write(m.prompt||''); })")

  echo "[orchestrator-tick] dispatching $SUBAGENT_TYPE subagent for $TASK_ID (model=$MODEL cwd=$CWD)"
```

## Step 4 — Invoke the Agent tool

This is where the actual LLM dispatch happens. The Agent tool is invoked with
the parameters from the manifest. The `subagentType` maps to the
`ai-sdlc-plugin/agents/<type>.md` system prompt.

Use the Agent tool to spawn a `$SUBAGENT_TYPE` subagent in `$CWD` with
`$PROMPT`. Pass `$MODEL` as the model override when set. The subagent runs
the full developer/reviewer flow and returns a structured JSON result.

After the Agent call completes, write its result to the result file so the
orchestrator tick loop can continue:

```bash
  # Write the Agent result to disk for the orchestrator to consume
  # (The result will contain the developer's JSON return or reviewer verdict)
  DISPATCH_START_MS=$(date +%s%3N)

  # ... (Agent tool invocation happens here — this is the live dispatch) ...

  # After Agent completes, write dispatch-result.json
  node pipeline-cli/bin/cli-orchestrator.mjs write-dispatch-result \
    --task-id "$TASK_ID" \
    --subagent-type "$SUBAGENT_TYPE" \
    --output "$AGENT_RESULT_JSON" \
    --result-path "$RESULT_PATH" \
    --start-ms "$DISPATCH_START_MS" \
    2>/dev/null || true
fi
```

## Step 5 — Continue the tick loop (reads dispatch-result.json)

After the Agent result is written, run the continuation tick that picks up
`dispatch-result.json` and advances the pipeline to Steps 6+:

```bash
CONTINUATION_OUTPUT=$(AI_SDLC_AUTONOMOUS_ORCHESTRATOR="$AI_SDLC_AUTONOMOUS_ORCHESTRATOR" \
  node pipeline-cli/bin/cli-orchestrator.mjs tick --max-concurrent 1 \
    --continue-from-result 2>&1)
echo "[orchestrator-tick] continuation tick: $CONTINUATION_OUTPUT"
```

## Step 6 — ScheduleWakeup (loop control)

Unless `--once` was passed in `$ARGUMENTS`, schedule the next tick:

```bash
ONCE_FLAG="${ARGUMENTS:-}"
if [ "$ONCE_FLAG" != "--once" ]; then
  echo "[orchestrator-tick] scheduling next tick in 30s"
  # ScheduleWakeup 30s /ai-sdlc orchestrator-tick
fi
```

> **Operator loop pattern.** Instead of ScheduleWakeup you can also use
> `/loop /ai-sdlc orchestrator-tick` which Claude Code natively loops.
> ScheduleWakeup is preferred when you want the operator to remain in
> interactive mode between ticks (the wakeup fires in the background while
> you can still type other commands).

---

## Implementation note — live Agent invocation

When the manifest indicates a `developer` subagent, the slash command body
invokes the Agent tool to run the `ai-sdlc-plugin/agents/developer.md` system
prompt with the task prompt from the manifest. This is the same dispatch the
`/ai-sdlc execute` command does in its Step 5.

The Agent result is a structured JSON object (the developer's return envelope).
Write it to `$ARTIFACTS_DIR/_orchestrator/dispatch-result.json`:

```json
{
  "version": 1,
  "taskId": "AISDLC-123",
  "subagentType": "developer",
  "status": "success",
  "output": "<raw Agent output>",
  "parsed": { ...developer JSON return... },
  "durationMs": 42000,
  "writtenAt": "2026-05-06T00:00:00.000Z"
}
```

The `parsed` field carries the developer's JSON return envelope — the same
shape `executePipeline()` expects from any `SubagentResult`. The orchestrator
tick loop reads this file, constructs a `SubagentResult` from it, and
continues to Steps 6+ (reviewer dispatch, attestation, PR open).

See `docs/operations/orchestrator-inline-loop.md` for the full protocol.
