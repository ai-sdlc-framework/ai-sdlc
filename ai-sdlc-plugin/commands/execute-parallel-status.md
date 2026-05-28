---
name: execute-parallel-status
description: >-
  Show live status table of all /ai-sdlc execute-parallel sessions. Reads
  .ai-sdlc/dispatch/sessions/ and renders task | pane | status | step | PR |
  heartbeat-age columns. AISDLC-462.
argument-hint: ""
allowed-tools:
  - Read
  - Bash
model: inherit
---

Show the live status of all `/ai-sdlc execute-parallel` sessions (AISDLC-462).

Reads `.ai-sdlc/dispatch/sessions/` and renders a status table. No side effects.

```bash
BOARD_DIR=".ai-sdlc/dispatch"
SESSIONS_DIR="$BOARD_DIR/sessions"

if [ ! -d "$SESSIONS_DIR" ]; then
  echo "No sessions directory found at $SESSIONS_DIR."
  echo "Run /ai-sdlc execute-parallel to start parallel sessions."
  exit 0
fi

# Count session files
SESSION_FILES=$(ls "$SESSIONS_DIR"/*.session.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$SESSION_FILES" -eq 0 ]; then
  echo "No session files in $SESSIONS_DIR."
  echo "Run /ai-sdlc execute-parallel to start parallel sessions."
  exit 0
fi

NOW_EPOCH=$(date +%s)

echo ""
echo "AI-SDLC Parallel Execute Status ($(date -u +"%Y-%m-%dT%H:%M:%SZ"))"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "%-18s %-22s %-12s %-20s %-10s %s\n" "Task" "Window" "Status" "Step" "PR" "Heartbeat"
echo "────────────────────────────────────────────────────────────────────────────────"

node -e "
  const fs = require('fs');
  const path = require('path');
  const sessionsDir = process.argv[1];
  const nowEpoch = parseInt(process.argv[2], 10);

  function heartbeatAge(ts) {
    if (!ts) return '—';
    try {
      const epochMs = new Date(ts).getTime();
      if (isNaN(epochMs)) return '?';
      const ageSec = Math.floor(nowEpoch - epochMs / 1000);
      if (ageSec < 0) return '0s';
      if (ageSec < 60) return ageSec + 's ago';
      if (ageSec < 3600) return Math.floor(ageSec / 60) + 'm ago';
      return Math.floor(ageSec / 3600) + 'h ago';
    } catch { return '?'; }
  }

  const files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.session.json'))
    .sort();

  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
      const task = (s.taskId || '?').padEnd(18).slice(0, 18);
      const win = (s.tmuxWindow || '—').padEnd(22).slice(0, 22);
      const status = (s.status || '?').padEnd(12).slice(0, 12);
      const step = (s.currentStep || '—').padEnd(20).slice(0, 20);
      const pr = s.prNumber ? ('#' + s.prNumber).padEnd(10).slice(0, 10) : '—'.padEnd(10).slice(0, 10);
      const hb = heartbeatAge(s.lastHeartbeat);
      process.stdout.write(task + ' ' + win + ' ' + status + ' ' + step + ' ' + pr + ' ' + hb + '\n');
    } catch (e) {
      process.stdout.write(f.padEnd(18).slice(0, 18) + ' (unreadable: ' + e.message + ')\n');
    }
  }
" "$SESSIONS_DIR" "$NOW_EPOCH" 2>/dev/null

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Count active sessions
ACTIVE=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const sessionsDir = process.argv[1];
  let count = 0;
  try {
    for (const f of fs.readdirSync(sessionsDir).filter(f => f.endsWith('.session.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
        if (s.status === 'starting' || s.status === 'in-progress') count++;
      } catch {}
    }
  } catch {}
  process.stdout.write(String(count));
" "$SESSIONS_DIR" 2>/dev/null || echo 0)

echo "Active: $ACTIVE / 5 sessions"
echo ""
echo "Attach to running sessions:"
echo "  tmux attach -t ai-sdlc-parallel"
echo ""
echo "Clean up completed/failed sessions:"
echo "  /ai-sdlc execute-parallel-cleanup"
echo ""

# Show archived count
ARCHIVE_DIR="$SESSIONS_DIR/archived"
if [ -d "$ARCHIVE_DIR" ]; then
  ARCHIVED=$(ls "$ARCHIVE_DIR"/*.session.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ARCHIVED" -gt 0 ]; then
    echo "Archived sessions (cleaned up): $ARCHIVED (in $ARCHIVE_DIR)"
  fi
fi
```

## Status definitions

| Status | Meaning |
|--------|---------|
| `starting` | tmux window spawned; `claude /ai-sdlc execute` not yet running |
| `in-progress` | First heartbeat received; pipeline is running |
| `done` | `/ai-sdlc execute` reported success; PR URL set |
| `failed` | `/ai-sdlc execute` exited non-zero or tmux window was killed |

## Heartbeat staleness

A heartbeat older than **5 minutes** during `in-progress` may indicate the session is stuck (e.g. waiting for user input in the pane, or a long build step). Attach to inspect:

```bash
tmux attach -t ai-sdlc-parallel
# Then select the window: Ctrl-b then '
```
