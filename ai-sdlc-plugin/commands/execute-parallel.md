---
name: execute-parallel
description: >-
  Spawn N concurrent /ai-sdlc execute sessions in tmux panes (max 5). Reads the
  dispatch-ready frontier, presents top N candidates, asks operator to confirm,
  then fires one tmux window per task. Coordination via
  .ai-sdlc/dispatch/sessions/. Resource-gated: refuses if available memory <
  4GB or 1-min load avg >= ncpu. AISDLC-462.
argument-hint: "[--count N] [--tasks AISDLC-N,AISDLC-M,...]"
allowed-tools:
  - Read
  - Bash
model: inherit
---

Spawn N concurrent `/ai-sdlc execute` sessions in tmux panes (AISDLC-462).

## Hard rules

1. **Hard cap**: maximum 5 concurrent sessions. Refuses when already at cap.
2. **Resource gate**: refuses if available memory < 4GB OR 1-min load avg >= ncpu.
3. **Mutual-awareness**: refuses to spawn a task already in `sessions/` with status != done|failed.
4. **Operator confirmation**: always AskUserQuestion before spawning.
5. **Never merge PRs.** Never force-push to main/master.

## Path resolution

```bash
PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_DIR:-${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}}/scripts"
if [ -z "${PIPELINE_CLI_BIN:-}" ]; then
  PIPELINE_CLI_BIN=$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh") || exit 1
fi
```

## Step 1 — Parse arguments

```bash
ARG="${ARGUMENTS:-}"
REQUESTED_COUNT=4
EXPLICIT_TASKS=""

# ─── Task ID validation gate (SECURITY) ──────────────────────────────────────
# ALL task IDs from ALL input pathways (--tasks arg, frontier JSON, operator
# confirmation) MUST pass through this function before being interpolated into
# tmux commands, file paths, or branch names. Reject with a clear error if any
# ID fails — this is the primary defense against command injection.
validate_task_id() {
  local id="$1"
  if ! printf '%s' "$id" | grep -qE '^[A-Z][A-Z0-9]+-[0-9]+(\.[0-9]+)*$'; then
    echo "ERROR: invalid task ID '$id' — must match ^[A-Z][A-Z0-9]+-[0-9]+(\.[0-9]+)*$" >&2
    return 1
  fi
  return 0
}

# Parse --count N
if printf '%s' "$ARG" | grep -q '\-\-count'; then
  REQUESTED_COUNT=$(printf '%s' "$ARG" | sed -E 's/.*--count[= ]([0-9]+).*/\1/')
fi
# Clamp to max 5
if [ "$REQUESTED_COUNT" -gt 5 ]; then
  echo "WARNING: --count $REQUESTED_COUNT exceeds hard cap of 5. Clamping to 5." >&2
  REQUESTED_COUNT=5
fi

# Parse --tasks AISDLC-N,...
if printf '%s' "$ARG" | grep -q '\-\-tasks'; then
  EXPLICIT_TASKS=$(printf '%s' "$ARG" | sed -E 's/.*--tasks[= ]([A-Z0-9,-]+).*/\1/')
fi
```

## Step 2 — Resource gate

```bash
RESOURCE_GATE_SCRIPT="$PLUGIN_SCRIPTS_DIR/check-resource-gate.sh"
if [ -f "$RESOURCE_GATE_SCRIPT" ]; then
  bash "$RESOURCE_GATE_SCRIPT" || {
    echo "ERROR: resource gate refused — see stderr above." >&2
    echo "Set AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1 to override." >&2
    exit 1
  }
else
  echo "WARNING: check-resource-gate.sh not found at $RESOURCE_GATE_SCRIPT; skipping resource check." >&2
fi
```

## Step 3 — Count existing active sessions; enforce hard cap

```bash
BOARD_DIR=".ai-sdlc/dispatch"
SESSIONS_DIR="$BOARD_DIR/sessions"
mkdir -p "$SESSIONS_DIR"

ACTIVE_COUNT=0
if [ -d "$SESSIONS_DIR" ]; then
  # Count session files whose status is starting or in-progress
  for f in "$SESSIONS_DIR"/*.session.json; do
    [ -f "$f" ] || continue
    STATUS=$(node -e "
      try {
        const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
        process.stdout.write(s.status || 'unknown');
      } catch { process.stdout.write('unknown'); }
    " "$f" 2>/dev/null || echo "unknown")
    if [ "$STATUS" = "starting" ] || [ "$STATUS" = "in-progress" ]; then
      ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
    fi
  done
fi

# Corroborate with live tmux windows — a stale session file doesn't bypass the cap.
# Use the max of (session-file count, live tmux window count) as the effective count.
TMUX_SESSION="ai-sdlc-parallel"
TMUX_WINDOW_COUNT=$(tmux list-windows -t "$TMUX_SESSION" 2>/dev/null | wc -l | tr -d ' ')
TMUX_WINDOW_COUNT=${TMUX_WINDOW_COUNT:-0}
if [ "$TMUX_WINDOW_COUNT" -gt "$ACTIVE_COUNT" ]; then
  echo "[execute-parallel] NOTE: tmux shows $TMUX_WINDOW_COUNT windows but session files show $ACTIVE_COUNT active — using tmux count as effective cap." >&2
  ACTIVE_COUNT=$TMUX_WINDOW_COUNT
fi

HARD_CAP=5
REMAINING_SLOTS=$((HARD_CAP - ACTIVE_COUNT))

if [ "$REMAINING_SLOTS" -le 0 ]; then
  echo "ERROR: hard cap of $HARD_CAP concurrent sessions already reached ($ACTIVE_COUNT active)." >&2
  echo "Run /ai-sdlc execute-parallel-status to see which sessions are running." >&2
  echo "Run /ai-sdlc execute-parallel-cleanup to kill stale sessions." >&2
  exit 1
fi

# Clamp requested count to remaining slots
if [ "$REQUESTED_COUNT" -gt "$REMAINING_SLOTS" ]; then
  echo "NOTE: requested $REQUESTED_COUNT but only $REMAINING_SLOTS slot(s) remain (cap=$HARD_CAP, active=$ACTIVE_COUNT). Clamping." >&2
  REQUESTED_COUNT=$REMAINING_SLOTS
fi
```

## Step 4 — Discover candidates

```bash
if [ -n "$EXPLICIT_TASKS" ]; then
  # Operator specified explicit task IDs — validate and use them
  # Each ID is validated against the strict regex before any further use.
  RAW_CANDIDATES=$(printf '%s' "$EXPLICIT_TASKS" | tr ',' '\n' | head -$REQUESTED_COUNT)
  CANDIDATES=""
  while IFS= read -r tid; do
    [ -z "$tid" ] && continue
    if ! validate_task_id "$tid"; then
      echo "ERROR: aborting — invalid task ID in --tasks argument." >&2
      exit 1
    fi
    CANDIDATES="${CANDIDATES}${CANDIDATES:+$'\n'}${tid}"
  done <<< "$RAW_CANDIDATES"
  echo "[execute-parallel] Using operator-specified tasks: $CANDIDATES"
else
  # Read dispatch-ready frontier
  echo "[execute-parallel] Reading dispatch-ready frontier..."
  FRONTIER_JSON=$(node "$PIPELINE_CLI_BIN/cli-deps.mjs" frontier \
    --format json \
    --check-dispatch-readiness \
    --work-dir "$(pwd)" 2>/dev/null || echo '[]')

  # Filter to truly dispatchable candidates (no open PR on branch, no existing active session)
  CANDIDATES=$(node -e "
    const fs = require('fs');
    const path = require('path');
    const sessionsDir = '.ai-sdlc/dispatch/sessions';
    const requestedCount = parseInt(process.argv[1], 10);

    let frontier;
    try {
      frontier = JSON.parse(process.argv[2]);
    } catch {
      frontier = [];
    }

    // Read active session task IDs
    const activeTasks = new Set();
    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.session.json'));
      for (const f of files) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
          if (s.status === 'starting' || s.status === 'in-progress') {
            activeTasks.add(s.taskId.toUpperCase());
          }
        } catch {}
      }
    } catch {}

    // Validate task IDs from frontier JSON — defense against malicious backlog task files.
    const TASK_ID_RE = /^[A-Z][A-Z0-9]+-[0-9]+(\.[0-9]+)*$/;
    const candidates = (Array.isArray(frontier) ? frontier : [])
      .filter(t => {
        const id = t.taskId || t.id || '';
        // Must match strict regex — rejects path-traversal and injection payloads
        if (!TASK_ID_RE.test(id)) return false;
        // Must be dispatch-ready
        if (t.dispatchReadiness && t.dispatchReadiness !== 'ready') return false;
        // Must not be already active
        if (activeTasks.has(id.toUpperCase())) return false;
        return true;
      })
      .slice(0, requestedCount)
      .map(t => t.taskId || t.id);

    process.stdout.write(candidates.join('\n'));
  " "$REQUESTED_COUNT" "$FRONTIER_JSON" 2>/dev/null)

  if [ -z "$CANDIDATES" ]; then
    echo "No dispatch-ready candidates found on the frontier."
    echo "Run: node \"$PIPELINE_CLI_BIN/cli-deps.mjs\" frontier --format table"
    echo "to see the full frontier and identify blockers."
    exit 0
  fi
fi

CANDIDATE_COUNT=$(printf '%s\n' "$CANDIDATES" | grep -c '[A-Z]' 2>/dev/null || echo 0)
echo "[execute-parallel] Found $CANDIDATE_COUNT candidate(s) for parallel dispatch:"
printf '%s\n' "$CANDIDATES" | while read -r tid; do
  echo "  - $tid"
done
```

## Step 5 — Operator confirmation (AskUserQuestion)

Present the candidate list and ask for confirmation before spawning. This is a required human-in-the-loop gate — do NOT skip it.

Ask the operator:

> I found $CANDIDATE_COUNT task(s) ready for parallel dispatch:
>
> [list each candidate with its title if available]
>
> I will spawn $CANDIDATE_COUNT tmux window(s) in the 'ai-sdlc-parallel' tmux session, each running `/ai-sdlc execute <task-id>`.
>
> **Before I proceed:**
> - Confirm you want to spawn these sessions (yes/no)
> - Or provide alternative task IDs (comma-separated, max 5)
> - Or type "cancel" to abort

If the operator says "no" or "cancel" → exit 0.
If the operator provides alternative task IDs → validate each against the strict regex
(`^[A-Z][A-Z0-9]+-[0-9]+(\.[0-9]+)*$`) before use; refuse with a clear error if any
alternative fails validation.
Otherwise proceed with the confirmed list.

```bash
# (AskUserQuestion is handled by the slash command harness above this code block)
# After confirmation, CONFIRMED_TASKS holds the final list (one per line).
# If the operator supplied alternative IDs, validate them before use:
# OPERATOR_ALTERNATIVES="<comma-separated IDs from operator reply>"
# if [ -n "$OPERATOR_ALTERNATIVES" ]; then
#   CONFIRMED_TASKS=""
#   while IFS= read -r tid; do
#     [ -z "$tid" ] && continue
#     if ! validate_task_id "$tid"; then
#       echo "ERROR: aborting — invalid alternative task ID '$tid'" >&2
#       exit 1
#     fi
#     CONFIRMED_TASKS="${CONFIRMED_TASKS}${CONFIRMED_TASKS:+$'\n'}${tid}"
#   done <<< "$(printf '%s' "$OPERATOR_ALTERNATIVES" | tr ',' '\n')"
# fi
CONFIRMED_TASKS="$CANDIDATES"
```

## Step 6 — Ensure tmux session exists (idempotent)

```bash
TMUX_SESSION="ai-sdlc-parallel"

# Create session if it doesn't exist (detached, no window)
tmux new-session -d -s "$TMUX_SESSION" 2>/dev/null || true
echo "[execute-parallel] tmux session '$TMUX_SESSION' ready"
```

## Step 7 — Spawn one tmux window per task

```bash
SPAWNED_TASKS=""
SPAWN_ERRORS=""

# Detect case-insensitive duplicates BEFORE spawning — two IDs that lower-case
# to the same string would silently overwrite each other's session file.
SEEN_LOWER=""
while IFS= read -r tid; do
  [ -z "$tid" ] && continue
  tl=$(printf '%s' "$tid" | tr '[:upper:]' '[:lower:]')
  for seen in $SEEN_LOWER; do
    if [ "$tl" = "$seen" ]; then
      echo "ERROR: task IDs '$tid' and a prior entry both map to lowercase '$tl' — case-insensitive collision. Deduplicate before spawning." >&2
      exit 1
    fi
  done
  SEEN_LOWER="$SEEN_LOWER $tl"
done <<< "$CONFIRMED_TASKS"

while IFS= read -r TASK_ID; do
  [ -z "$TASK_ID" ] && continue

  # SECURITY: validate task ID against strict regex before any tmux/file use.
  if ! validate_task_id "$TASK_ID"; then
    echo "[execute-parallel] ERROR: invalid task ID '$TASK_ID' — skipping" >&2
    SPAWN_ERRORS="$SPAWN_ERRORS $TASK_ID"
    continue
  fi

  TASK_ID_LOWER=$(printf '%s' "$TASK_ID" | tr '[:upper:]' '[:lower:]')
  SESSION_FILE="$SESSIONS_DIR/${TASK_ID_LOWER}.session.json"
  TMUX_WINDOW="exec-${TASK_ID_LOWER}"

  # Per-task pre-flight: check mutual-awareness
  if [ -f "$SESSION_FILE" ]; then
    STATUS=$(node -e "
      try {
        const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
        process.stdout.write(s.status || 'unknown');
      } catch { process.stdout.write('unknown'); }
    " "$SESSION_FILE" 2>/dev/null || echo "unknown")
    if [ "$STATUS" = "starting" ] || [ "$STATUS" = "in-progress" ]; then
      echo "[execute-parallel] SKIP $TASK_ID — already active (status=$STATUS)"
      continue
    fi
  fi

  # Per-task pre-flight: check no worktree already exists for a different branch
  if [ -d ".worktrees/${TASK_ID_LOWER}" ]; then
    echo "[execute-parallel] NOTE: worktree .worktrees/${TASK_ID_LOWER} already exists for $TASK_ID — execute will reuse or re-create it."
  fi

  # Reserve: write session file (status=starting)
  SPAWN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  node -e "
    const fs = require('fs');
    const sessionsDir = process.argv[1];
    fs.mkdirSync(sessionsDir + '/archived', { recursive: true });
    const session = {
      schemaVersion: 'v1',
      taskId: process.argv[2],
      tmuxSession: process.argv[3],
      tmuxWindow: process.argv[4],
      paneId: '',
      spawnedAt: process.argv[5],
      status: 'starting',
    };
    const filePath = sessionsDir + '/' + process.argv[2].toLowerCase() + '.session.json';
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2));
    fs.renameSync(tmpPath, filePath);
  " "$SESSIONS_DIR" "$TASK_ID" "$TMUX_SESSION" "$TMUX_WINDOW" "$SPAWN_AT" 2>/dev/null || {
    echo "[execute-parallel] ERROR: failed to write session file for $TASK_ID — skipping" >&2
    SPAWN_ERRORS="$SPAWN_ERRORS $TASK_ID"
    continue
  }

  # Spawn: new tmux window running /ai-sdlc execute <task-id>
  # SECURITY: TASK_ID is validated above — safe to interpolate.
  # The window runs in the current working directory so /ai-sdlc execute can
  # find the repo root.
  tmux new-window \
    -t "$TMUX_SESSION" \
    -n "$TMUX_WINDOW" \
    "claude /ai-sdlc execute $TASK_ID; read -rp 'Session for $TASK_ID complete. Press Enter to close.' _" \
    2>/dev/null || {
    echo "[execute-parallel] ERROR: tmux new-window failed for $TASK_ID" >&2
    # Update session to failed
    node -e "
      const fs = require('fs');
      const f = process.argv[1];
      try {
        const s = JSON.parse(fs.readFileSync(f, 'utf8'));
        s.status = 'failed';
        s.lastHeartbeat = new Date().toISOString();
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, f);
      } catch {}
    " "$SESSION_FILE" 2>/dev/null || true
    SPAWN_ERRORS="$SPAWN_ERRORS $TASK_ID"
    continue
  }

  # Capture pane ID
  PANE_ID=$(tmux display-message -p -t "${TMUX_SESSION}:${TMUX_WINDOW}" '#{pane_id}' 2>/dev/null || echo '')

  # Update session with pane ID (atomic write)
  if [ -n "$PANE_ID" ]; then
    node -e "
      const fs = require('fs');
      const f = process.argv[1];
      try {
        const s = JSON.parse(fs.readFileSync(f, 'utf8'));
        s.paneId = process.argv[2];
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, f);
      } catch {}
    " "$SESSION_FILE" "$PANE_ID" 2>/dev/null || true
  fi

  echo "[execute-parallel] SPAWNED: $TASK_ID → tmux window '$TMUX_WINDOW' (pane $PANE_ID)"
  SPAWNED_TASKS="$SPAWNED_TASKS $TASK_ID"
done <<< "$CONFIRMED_TASKS"

echo "[execute-parallel] Summary: spawned=$(echo $SPAWNED_TASKS | wc -w | tr -d ' ') errors=$(echo $SPAWN_ERRORS | wc -w | tr -d ' ')"
if [ -n "$SPAWN_ERRORS" ]; then
  echo "[execute-parallel] Failed tasks:$SPAWN_ERRORS" >&2
fi
```

## Step 8 — Print status table

```bash
echo ""
echo "[execute-parallel] Status table ($(date -u +"%H:%M:%SZ")):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "%-20s %-22s %-14s %-12s %s\n" "Task" "Window" "Status" "Step" "PR"
echo "────────────────────────────────────────────────────────────────────"

for f in "$SESSIONS_DIR"/*.session.json; do
  [ -f "$f" ] || continue
  node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const task = (s.taskId || '').padEnd(20).slice(0, 20);
      const win = (s.tmuxWindow || '').padEnd(22).slice(0, 22);
      const status = (s.status || '').padEnd(14).slice(0, 14);
      const step = (s.currentStep || '—').padEnd(12).slice(0, 12);
      const pr = s.prNumber ? '#' + s.prNumber : '—';
      process.stdout.write(task + ' ' + win + ' ' + status + ' ' + step + ' ' + pr + '\n');
    } catch {}
  " "$f" 2>/dev/null || true
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Attach to any pane:"
echo "  tmux attach -t $TMUX_SESSION"
echo "  tmux select-window -t $TMUX_SESSION:<window-name>"
echo ""
echo "Monitor status:"
echo "  /ai-sdlc execute-parallel-status"
echo ""
echo "Kill sessions when done:"
echo "  /ai-sdlc execute-parallel-cleanup"
```
