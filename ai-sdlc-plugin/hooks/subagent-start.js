/**
 * AI-SDLC SubagentStart Hook
 *
 * Reads .ai-sdlc/agent-role.yaml from the project directory and emits
 * governance context as additionalContext, which Claude Code injects into
 * the spawned subagent's session.
 *
 * Why this exists separately from session-start.js: SessionStart hooks do NOT
 * fire for subagents (verified in claude-code source: runAgent.ts:532-543
 * dispatches executeSubagentStartHooks instead of processSessionStartHooks).
 * Without this hook the developer subagent and reviewers would run with no
 * governance context at all.
 *
 * AISDLC-568: this hook ALSO writes a marker file to
 * `.ai-sdlc/subagent-sessions/<agent-id>.json` on every firing. This is the
 * structural signal `attestation/verdict-class.ts` uses to distinguish a
 * transcript leaf produced by a REAL, harness-spawned reviewer subagent
 * (this hook fires) from one a coordinator authored itself by running the
 * same Bash sequence without ever going through the `Agent`/`Task` tool
 * (this hook does NOT fire). See that module's JSDoc for the full mechanism
 * and its honest, single-machine limits.
 *
 * Fail-safe: exits silently on any error.
 *
 * AISDLC-571 CI follow-up: stdin is read via `readStdinSync()` (a bounded
 * `fs.readSync(0, ...)` retry loop), NOT a single `readFileSync('/dev/stdin')`
 * call. Node's synchronous read of a piped (non-TTY) fd 0 can throw `EAGAIN`
 * on Linux when the pipe hasn't fully buffered the writer's output yet at
 * the moment of the read — a well-known Node/libuv behavior difference from
 * macOS. This reproduced DETERMINISTICALLY in GitHub Actions (Linux
 * runners) for the AISDLC-571 integration test while never reproducing on a
 * macOS dev machine. A single `readFileSync` call treats that transient
 * `EAGAIN` as a hard failure, and the surrounding fail-safe `catch` exited
 * the whole hook (including the marker write) at that point — silently
 * skipping BOTH the marker write and governance injection on EVERY
 * Linux-hosted real `SubagentStart` firing that raced the same way, not
 * just under test. Retrying on `EAGAIN` (bounded, so a genuinely closed or
 * absent stdin still fails safe) fixes the hook itself.
 */

const { readFileSync, readSync, existsSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');

// ── Read stdin ───────────────────────────────────────────────────────

let stdinRaw;
try {
  stdinRaw = readStdinSync();
} catch {
  process.exit(0);
}

// ── Find project root ────────────────────────────────────────────────

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  (() => {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    } catch {
      return process.cwd();
    }
  })();

// ── Write subagent-session marker (AISDLC-568) ─────────────────────────
//
// Independent of agent-role.yaml presence: this marker is the structural
// signal for verdictClass detection and must be written on EVERY real
// SubagentStart firing, regardless of whether governance context config
// exists for this project.

writeSubagentSessionMarker(projectDir, stdinRaw);

// ── Load agent-role.yaml ─────────────────────────────────────────────

const agentRolePath = join(projectDir, '.ai-sdlc', 'agent-role.yaml');
if (!existsSync(agentRolePath)) {
  process.exit(0);
}

let yaml;
try {
  yaml = readFileSync(agentRolePath, 'utf-8');
} catch {
  process.exit(0);
}

const blockedActions = parseListField(yaml, 'blockedActions');
const blockedPaths = parseListField(yaml, 'blockedPaths');

// ── Build subagent governance context ────────────────────────────────
//
// Subagents get a TIGHTER prompt than the main session — they don't drive
// the lifecycle (no pre-commit checklist, no PR creation), they just do their
// stage. The hard rules are the same.

let context = `## AI-SDLC Governance (subagent context)

You are running as a Claude Code subagent. The orchestrating command will
gate your output (reviews, PR creation). Stay focused on your assigned task.

### Hard rules — NEVER violate
- **Never merge PRs** (\`gh pr merge\`)
- **Never force-push** (\`git push --force\`/\`-f\`)
- **Never close PRs or issues** (\`gh pr close\`, \`gh issue close\`)
- **Never delete branches** (\`git branch -D\`/\`-d\`)
- **Never run destructive git** (\`git reset --hard\`, \`git checkout -- .\`, \`git restore .\`)`;

if (blockedPaths.length > 0) {
  context += `\n\n### Blocked paths (PreToolUse hook enforces — no edits)
${blockedPaths.map((p) => `- \`${p}\``).join('\n')}`;
}

if (blockedActions.length > 0) {
  context += `\n\n### Blocked Bash actions (PreToolUse hook enforces — no execution)
${blockedActions.map((a) => `- \`${a}\``).join('\n')}`;
}

context += `\n\n### Cross-repo writes
If you have \`AI_SDLC_ACTIVE_TASK_ID\` set, the active task's \`permittedExternalPaths\`
in its frontmatter allowlists writes to sibling repos. The PreToolUse hook honors
this — writes outside your cwd that aren't in the allowlist will be denied.`;

// ── Output ───────────────────────────────────────────────────────────

const result = {
  hookSpecificOutput: {
    hookEventName: 'SubagentStart',
    additionalContext: context,
  },
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Reads all of fd 0 (stdin) synchronously, retrying on `EAGAIN` instead of
 * treating it as a terminal failure. See the module-level AISDLC-571 CI
 * follow-up comment above for why this is necessary on Linux.
 *
 * Bounded to ~2s total (200 retries x 10ms) so a genuinely absent/closed
 * stdin still surfaces an error to the caller's fail-safe `catch` rather
 * than hanging the hook indefinitely.
 */
function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  const MAX_EAGAIN_RETRIES = 200;
  let eagainRetries = 0;

  for (;;) {
    let bytesRead;
    try {
      bytesRead = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        eagainRetries += 1;
        if (eagainRetries > MAX_EAGAIN_RETRIES) {
          throw err;
        }
        sleepSync(10);
        continue;
      }
      // EOF is thrown as an error on some platforms when the fd is
      // already exhausted; treat it the same as a 0-byte read.
      if (err && err.code === 'EOF') {
        break;
      }
      throw err;
    }
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }

  return Buffer.concat(chunks).toString('utf-8');
}

/** Blocks the event loop for `ms` milliseconds via a shared-memory wait. */
function sleepSync(ms) {
  const sharedBuffer = new SharedArrayBuffer(4);
  const view = new Int32Array(sharedBuffer);
  Atomics.wait(view, 0, 0, ms);
}

function parseListField(yaml, field) {
  const lines = yaml.split('\n');
  const items = [];
  let inSection = false;

  for (const line of lines) {
    if (new RegExp(`^\\s*${field}:\\s*$`).test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^[a-zA-Z]/.test(line)) break;
      if (/^\s*$/.test(line)) continue;
      const match = line.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/);
      if (match) items.push(match[1]);
    }
  }

  return items;
}

/**
 * AISDLC-568: write a marker file recording that a real SubagentStart hook
 * firing occurred. `pipeline-cli/src/attestation/verdict-class.ts` reads
 * these markers to classify a reviewer's transcript leaf as 'independent'
 * (a genuine subagent was spawned around the time the transcript was
 * written) vs. 'self-authored' (no such marker — the coordinator likely ran
 * the transcript-capture Bash steps itself).
 *
 * Best-effort / fail-safe: any error here is swallowed. A missing marker
 * only ever makes the resulting leaf look MORE self-authored, never less —
 * consistent with the "never over-claim independent" contract.
 *
 * `agentId` is read from the hook's stdin JSON payload (`agent_id`) when
 * present; otherwise a random UUID is used as the marker file name only
 * (the identifier itself is not load-bearing — the FILE'S EXISTENCE + its
 * write TIMING, which only the harness can produce, is the signal).
 */
function writeSubagentSessionMarker(projectDir, stdinRaw) {
  try {
    let agentId;
    try {
      const payload = JSON.parse(stdinRaw);
      if (payload && typeof payload.agent_id === 'string' && payload.agent_id) {
        agentId = payload.agent_id;
      }
    } catch {
      // stdin wasn't JSON, or had no agent_id — fall through to random id.
    }
    if (!agentId) {
      agentId = randomUUID();
    }

    const dir = join(projectDir, '.ai-sdlc', 'subagent-sessions');
    mkdirSync(dir, { recursive: true });

    const safeName = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const markerPath = join(dir, `${safeName}.json`);
    writeFileSync(
      markerPath,
      JSON.stringify({ agentId, firedAt: new Date().toISOString() }) + '\n',
      { encoding: 'utf-8' },
    );
  } catch {
    // Fail-safe: never let marker-writing errors break the SubagentStart hook.
  }
}
