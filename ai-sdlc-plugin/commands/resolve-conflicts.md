---
name: resolve-conflicts
description: /ai-sdlc resolve-conflicts <pr-number> — manually invoke the ci-conflict-resolver agent against a single PR. Phase 1 surface (AISDLC-460) for the same agent the ci-failure-watcher dispatches automatically. Use when CI failed on a stale base and you'd like the rebase + re-arm to happen now rather than waiting for the next watcher tick.
argument-hint: <pr-number>
allowed-tools:
  - Read
  - Bash
  - Agent(ci-conflict-resolver)
model: inherit
---

Manually invoke the `ci-conflict-resolver` subagent for PR
#$ARGUMENTS. This is the AISDLC-460 manual escape hatch — the watcher
will pick it up on the next tick anyway, but the operator sometimes
wants to drive the rebase + re-arm immediately (e.g. an auto-merge-armed
PR is stuck and you want it cleared before walking away).

## Why this lives in a slash command (not the agent directly)

Plugin subagents cannot use the `Agent` tool (the harness filters it
out one level deep — empirical proof in AISDLC-69.2 / AISDLC-98). The
slash command body runs in the main Claude Code session which DOES have
`Agent`, so it can spawn `ci-conflict-resolver` directly. This is the
same architecture pattern as `/ai-sdlc rebase` and `/ai-sdlc execute`.

## Hard rules (NEVER violate)

1. **Never merge a PR.** Do not run `gh pr merge` for merge —
   `gh pr merge --auto` is the re-arm path the agent owns and is
   explicitly permitted (it does NOT merge; it only re-attaches the
   auto-merge request that the force-push cleared per AISDLC-356).
2. **Never force-push with plain `--force` / `-f`.** Always use
   `--force-with-lease`. The agent enforces this; this command does
   not push directly.
3. **Never push to `main` or `master`.** The agent refuses; this
   command also refuses at Step 1.
4. **Never close PRs or issues.**
5. **Never delete branches.**
6. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.**
7. **Never write GitHub Actions CI-skip magic tokens.** (AISDLC-88.)

## Step 0 — Validate input

```bash
PR=$ARGUMENTS
if [ -z "$PR" ] || ! echo "$PR" | grep -qE '^[0-9]+$'; then
  echo "ERROR: pass a PR number, e.g. /ai-sdlc resolve-conflicts 1234"
  exit 1
fi
```

## Step 1 — Locate PR + worktree

```bash
gh pr view "$PR" --json number,title,headRefName,headRefOid,body,state,mergeStateStatus,statusCheckRollup \
  > /tmp/resolve-conflicts-pr-${PR}.json

BRANCH=$(jq -r '.headRefName' /tmp/resolve-conflicts-pr-${PR}.json)
HEAD_SHA=$(jq -r '.headRefOid' /tmp/resolve-conflicts-pr-${PR}.json)
TITLE=$(jq -r '.title' /tmp/resolve-conflicts-pr-${PR}.json)

# Refuse on main/master (Hard Rule 3).
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: refusing to operate on protected branch $BRANCH"
  exit 1
fi

TASK_ID_LOWER=$(echo "$BRANCH" | sed -E 's|^ai-sdlc/([a-z]+-[0-9.]+).*|\1|')
WORKTREE_PATH=".worktrees/$TASK_ID_LOWER"

if [ ! -d "$WORKTREE_PATH" ]; then
  git fetch origin "$BRANCH"
  mkdir -p .worktrees
  git worktree add "$WORKTREE_PATH" "origin/$BRANCH"
fi
```

## Step 2 — Pre-classify the failure shape

Use the same classifier the watcher uses, so the agent gets the same
seed hint:

```bash
node -e "
import('./pipeline-cli/dist/runtime/ci-failure-watcher.js').then((m) => {
  const raw = JSON.parse(require('fs').readFileSync('/tmp/resolve-conflicts-pr-${PR}.json', 'utf8'));
  const snap = m.normalizePrSnapshot(raw);
  process.stdout.write(m.classifyPrFailureShape(snap));
});
" > /tmp/resolve-conflicts-shape-${PR}.txt

CLASSIFIED_SHAPE=$(cat /tmp/resolve-conflicts-shape-${PR}.txt)
echo "[ai-sdlc-progress] classify: $CLASSIFIED_SHAPE"

if [ "$CLASSIFIED_SHAPE" = "skip" ]; then
  echo "PR #$PR does not need conflict resolution (SUCCESS / DRAFT / no-checks-yet)."
  exit 0
fi
```

## Step 3 — Spawn the ci-conflict-resolver subagent

Build the prompt:

```
You are resolving CI conflicts for PR #$PR (branch $BRANCH) in worktree $WORKTREE_PATH.

## PR title
$TITLE

## Head SHA at snapshot time
$HEAD_SHA

## Classified failure shape (from the watcher's heuristic)
$CLASSIFIED_SHAPE

## Your job
Rebase onto origin/main, resolve mechanical conflicts (CHANGELOG drop,
test additions, prettier drift, pnpm-lock regen, package.json bin: concat),
run verification, force-push with --force-with-lease, re-arm auto-merge.
Escalate semantic conflicts, modify-vs-delete, verification failures,
or iteration-cap-exceeded per your agent definition.

## Return shape
{
  "prNumber": $PR,
  "action": "rebased" | "escalated" | "noop-already-up-to-date" | "failed",
  "commitSha": "...",
  "pushedBranch": "...",
  "reclassifiedShape": "...",
  "escalationReason": "...",
  "verifications": { "build": "passed|failed|skipped", ... },
  "rebaseAttempts": <number>,
  "notes": "..."
}
```

Invoke `Agent(ci-conflict-resolver)` with the prompt. Surface
`[ai-sdlc-progress]` lines from the agent as they appear.

## Step 4 — Parse return + cool-down on escalation

Read the JSON returned by the subagent. Branch on `action`:

- **`rebased`** — print summary (commitSha, pushedBranch, verifications).
  Stop.
- **`noop-already-up-to-date`** — print "no rebase needed". Stop.
- **`escalated`** — write the cool-down record + post the deduped
  comment, mirroring what the watcher does. The operator can then
  inspect the worktree (left clean) and decide next steps.
- **`failed`** — same cool-down + comment behavior as `escalated`,
  but the worktree may or may not be clean depending on where the
  failure surfaced.

For escalation/failed, route the cool-down + comment write through
`cli-orchestrator ci-failure-watch` reasoning:

```bash
NODE_PATH=./pipeline-cli/node_modules node -e "
import('./pipeline-cli/dist/runtime/ci-failure-watcher.js').then(async (m) => {
  const out = JSON.parse(require('fs').readFileSync('/tmp/agent-return-${PR}.json', 'utf8'));
  m.writeCooldown(process.cwd(), {
    prNumber: ${PR},
    classification: out.reclassifiedShape ?? '$CLASSIFIED_SHAPE',
    escalatedAt: Date.now(),
    reason: out.escalationReason ?? out.action,
  });
  const body = m.composeEscalationComment(out, '$CLASSIFIED_SHAPE');
  await m.postDeduplicatedComment(m.defaultRunner ?? (async (c, a) => {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve) => execFile(c, a, (err, stdout, stderr) => resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code ?? 1) : 0 })));
  }), undefined, ${PR}, body);
});
"
```

## Step 5 — Report

Print a tight summary:

- PR: `#$PR` — `$TITLE`
- Branch: `$BRANCH` (worktree at `$WORKTREE_PATH`)
- Classified shape: `$CLASSIFIED_SHAPE`
- Action: `<rebased | escalated | noop-already-up-to-date | failed>`
- Verifications: `<all clean | failed at <stage>>`
- Pushed: `<branch | no — escalation reason: <...>>`

## When the operator should invoke this manually

- **A specific auto-merge-armed PR is stuck and you want it cleared
  NOW** rather than waiting up to 60s for the watcher's next tick.
- **The watcher has the PR in cool-down** but you've fixed whatever was
  blocking it (e.g. resolved a semantic conflict manually) and want to
  retry without waiting 24h. The cool-down doesn't block this command
  — manual invocation always runs.
- **You're testing the agent's flow** end-to-end in a controlled
  setting before relying on the watcher daemon.

## What this command DOES NOT do (intentional)

- **Never runs `gh pr merge`** (the merge variant; `--auto` re-arm is
  delegated to the agent, which only re-attaches the auto-merge
  request).
- **Never deletes the worktree on escalation.** The worktree is left
  in a clean state so the operator can inspect.
- **Never force-pushes from the slash body itself.** The agent owns
  the force-push (with `--force-with-lease`).
