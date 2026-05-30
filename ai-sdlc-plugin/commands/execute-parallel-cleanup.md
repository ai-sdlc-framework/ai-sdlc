---
name: execute-parallel-cleanup
description: >-
  Kill in-flight /ai-sdlc execute-parallel panes and archive their session
  files. Lists running tmux windows, asks operator to confirm before killing,
  then moves session files to sessions/archived/. AISDLC-462.
argument-hint: "[--all | AISDLC-N,AISDLC-M,...]"
allowed-tools:
  - Read
  - Bash
model: inherit
---

Kill in-flight `/ai-sdlc execute-parallel` panes and archive their session files (AISDLC-462).

## Hard rules

1. **AskUserQuestion before kill.** Always list what will be killed and ask for confirmation.
2. **Never merge PRs.** Never close PRs or issues.
3. If a session is already done/failed, archive it without killing (no tmux window to kill).

## Arguments

- No arguments: list and clean up ALL sessions (done, failed, and optionally in-progress).
- `--all`: same as no arguments.
- `AISDLC-N,AISDLC-M,...`: target specific task IDs only.

```bash
ARG="${ARGUMENTS:-}"
BOARD_DIR=".ai-sdlc/dispatch"
SESSIONS_DIR="$BOARD_DIR/sessions"
ARCHIVE_DIR="$SESSIONS_DIR/archived"
TMUX_SESSION="ai-sdlc-parallel"

# Parse target tasks
EXPLICIT_TASKS=""
if [ -n "$ARG" ] && [ "$ARG" != "--all" ]; then
  EXPLICIT_TASKS=$(printf '%s' "$ARG" | tr -d ' ')
fi

if [ ! -d "$SESSIONS_DIR" ]; then
  echo "No sessions directory at $SESSIONS_DIR. Nothing to clean up."
  exit 0
fi

mkdir -p "$ARCHIVE_DIR"
```

## Step 1 — List sessions to clean up

```bash
# Collect candidate session files
CANDIDATES_JSON=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const sessionsDir = process.argv[1];
  const explicitTasks = process.argv[2] ? process.argv[2].split(',').map(t => t.trim().toUpperCase()) : [];

  const sessions = [];
  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.session.json'));
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
        if (explicitTasks.length === 0 || explicitTasks.includes((s.taskId || '').toUpperCase())) {
          sessions.push(s);
        }
      } catch {}
    }
  } catch {}

  process.stdout.write(JSON.stringify(sessions));
" "$SESSIONS_DIR" "$EXPLICIT_TASKS" 2>/dev/null || echo '[]')
```

## Step 2 — Present the list and ask for confirmation (AskUserQuestion)

List all candidate sessions with their status and ask the operator to confirm before killing any in-progress sessions.

Ask the operator:

> Here are the sessions I found:
>
> [table: task | window | status | step | PR]
>
> - Already done/failed sessions will be archived silently.
> - In-progress sessions will have their tmux window killed before archiving.
>
> **Confirm:** Kill and archive all listed sessions? (yes/no)
>
> Or specify which tasks to keep running (e.g. "keep AISDLC-N").

If operator says "no" → exit 0.

## Step 3 — Kill tmux windows for in-progress sessions + archive all

```bash
node -e "
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  const sessionsDir = process.argv[1];
  const archiveDir = process.argv[2];
  const tmuxSession = process.argv[3];
  const candidatesJson = process.argv[4];

  // Canonical task-ID shape (e.g. AISDLC-462, ACME-123, RFC-7.2): an alpha-led
  // alphanumeric prefix, a hyphen, then a dotted numeric run. Used to (a) guard
  // s.taskId before it is interpolated into a file path, and (b) derive the
  // tmux window matcher so adopters with a non-aisdlc prefix are not skipped.
  const TASK_ID_RE = /^[A-Za-z][A-Za-z0-9]*-[0-9]+(\.[0-9]+)*$/;

  // Validate tmuxWindow matches the expected pattern (defense-in-depth against
  // an attacker-controlled session file injecting shell metacharacters). The
  // window name is 'exec-' + taskId.toLowerCase(); derive the matcher from the
  // task-ID shape rather than hardcoding the 'aisdlc-' prefix (AISDLC-464).
  const TMUX_WINDOW_RE = /^exec-[a-z][a-z0-9]*-[0-9]+(\.[0-9]+)*$/;

  let sessions;
  try { sessions = JSON.parse(candidatesJson); } catch { sessions = []; }

  let killed = 0;
  let archived = 0;
  let errors = 0;

  for (const s of sessions) {
    const taskId = s.taskId || '?';
    // Defense-in-depth: reject a crafted session file whose taskId contains
    // path separators or '..' segments that would escape the sessions dir when
    // interpolated into the file path below (AISDLC-464).
    if (!TASK_ID_RE.test(taskId)) {
      console.error('[cleanup] SECURITY: taskId ' + JSON.stringify(taskId) + ' does not match the canonical task-ID pattern — skipping to prevent path traversal');
      errors++;
      continue;
    }
    const taskIdLower = taskId.toLowerCase();
    const sessionFile = path.join(sessionsDir, taskIdLower + '.session.json');
    const archiveFile = path.join(archiveDir, taskIdLower + '.session.json');
    const isActive = s.status === 'starting' || s.status === 'in-progress';

    // Kill tmux window for active sessions
    if (isActive && s.tmuxWindow) {
      // Validate tmuxWindow before use — rejects shell-metachar payloads.
      if (!TMUX_WINDOW_RE.test(s.tmuxWindow)) {
        console.error('[cleanup] SECURITY: tmuxWindow value ' + JSON.stringify(s.tmuxWindow) + ' for ' + taskId + ' does not match expected pattern — skipping kill to prevent injection');
        errors++;
      } else {
        try {
          // Use execFileSync with arg array — no shell evaluation, no injection risk.
          execFileSync('tmux', ['kill-window', '-t', tmuxSession + ':' + s.tmuxWindow], {
            stdio: 'pipe',
          });
          console.log('[cleanup] Killed tmux window: ' + s.tmuxWindow + ' (' + taskId + ')');
          killed++;
        } catch (e) {
          // Window may already be gone
          console.log('[cleanup] tmux kill-window for ' + s.tmuxWindow + ' failed (already gone?): ' + e.code);
        }
      }
      // Update status to failed before archiving (atomic write)
      try {
        const updated = { ...s, status: 'failed', lastHeartbeat: new Date().toISOString(), currentStep: 'killed-by-cleanup' };
        const tmpPath = sessionFile + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
        fs.renameSync(tmpPath, sessionFile);
      } catch {}
    }

    // Archive the session file (atomic: write to tmp, rename, then delete original)
    try {
      const content = fs.readFileSync(sessionFile, 'utf8');
      const tmpArchive = archiveFile + '.tmp';
      fs.writeFileSync(tmpArchive, content);
      fs.renameSync(tmpArchive, archiveFile);
      fs.rmSync(sessionFile);
      console.log('[cleanup] Archived session: ' + taskId + ' → ' + archiveFile);
      archived++;
    } catch (e) {
      console.error('[cleanup] ERROR archiving ' + taskId + ': ' + e.code);
      errors++;
    }
  }

  console.log('');
  console.log('Done: killed=' + killed + ' archived=' + archived + ' errors=' + errors);
" "$SESSIONS_DIR" "$ARCHIVE_DIR" "$TMUX_SESSION" "$CANDIDATES_JSON" 2>/dev/null
```

## Step 4 — Post-cleanup status

```bash
echo ""
REMAINING=$(ls "$SESSIONS_DIR"/*.session.json 2>/dev/null | wc -l | tr -d ' ')
echo "Remaining active sessions: $REMAINING"
if [ "$REMAINING" -gt 0 ]; then
  echo "Run /ai-sdlc execute-parallel-status to see remaining sessions."
fi
ARCHIVED_COUNT=$(ls "$ARCHIVE_DIR"/*.session.json 2>/dev/null | wc -l | tr -d ' ')
echo "Total archived sessions: $ARCHIVED_COUNT (in $ARCHIVE_DIR)"
```
