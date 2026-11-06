---
name: rebase
description: /ai-sdlc rebase <pr-number> — auto-rebase a PR onto latest main, resolve mechanical conflicts, force-push with --force-with-lease.
argument-hint: <pr-number>
allowed-tools:
  - Read
  - Bash
  - Agent(rebase-resolver)
model: sonnet
rung: 4
---

Rebase PR #$ARGUMENTS onto latest `origin/main` by spawning the
`rebase-resolver` subagent. This command exists because manual rebase
loops were eating significant orchestrator time across PRs #113, #114,
and #115 (AISDLC-105). The mechanical 80% (CHANGELOG overlaps, test
additions, prettier drift) is delegated to the subagent; the
architectural 20% (modify-vs-delete, semantic conflicts, verification
failures) escalates back here for human attention.

## Why this command lives in the slash command body (not a subagent middleman)

Same reason as `/ai-sdlc execute`: plugin subagents cannot use the
`Agent` tool (the harness filters it out one level deep regardless of
frontmatter — empirical proof in AISDLC-69.2 / AISDLC-98). The slash
command body runs in the main Claude Code session which DOES have
`Agent`, so it can spawn `rebase-resolver` directly.

## Hard rules (NEVER violate)

1. **Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`, rendered into the session hard rules; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command.** Do not run `gh pr merge`.
2. **Never force-push with plain `--force` / `-f`.** Always use
   `--force-with-lease` (mirrors agent-role.yaml block list).
3. **Never push to `main` or `master`.** Refuse early.
4. **Never close PRs or issues.** No `gh pr close`, `gh issue close`.
5. **Never delete branches.** No `git branch -D` / `-d`.
6. **Edit governance config (`.ai-sdlc/**`) only when the task names the file and the change; never as a side effect.** Runtime artifacts (attestations, reviews, transcript leaves, the decision log, the dispatch board) are written through their CLIs as today. Runs marked untrusted (`AI_SDLC_UNTRUSTED_RUN`) are blocked from `.ai-sdlc/**` and `.github/workflows/**` by the hook; ask a maintainer in the PR instead of retrying. `.github/workflows/**` is only refused when the project's `.ai-sdlc/agent-role.yaml` lists it under `blockedPaths` — not blocked by default.
7. **Never write GitHub Actions CI-skip magic tokens** (AISDLC-88) — the
   five literal substrings (`[skip ci]`, `[ci skip]`, `[no ci]`,
   `[skip actions]`, `[actions skip]`) silently disable workflows.

## Step 0 — Validate input

```bash
PR=$ARGUMENTS
if [ -z "$PR" ] || ! echo "$PR" | grep -qE '^[0-9]+$'; then
  echo "ERROR: pass a PR number, e.g. /ai-sdlc rebase 115"
  exit 1
fi
```

## Step 1 — Locate PR + worktree

```bash
gh pr view "$PR" --json number,title,headRefName,headRefOid,body,state \
  > /tmp/rebase-pr-${PR}.json

BRANCH=$(jq -r '.headRefName' /tmp/rebase-pr-${PR}.json)
HEAD_SHA=$(jq -r '.headRefOid' /tmp/rebase-pr-${PR}.json)
TITLE=$(jq -r '.title' /tmp/rebase-pr-${PR}.json)

# Refuse on main/master (Hard Rule 3).
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: refusing to rebase $BRANCH — protected branch"
  exit 1
fi

# Derive task ID from branch (pattern: ai-sdlc/<prefix>-<numeric>[.<sub>]-<slug>).
# IMPORTANT: this regex MUST be portable across BSD sed (macOS) and GNU sed
# (linux). BSD sed has no `+?` non-greedy quantifier, and even on GNU sed
# `+?` would stop at the first dash, mangling task IDs like `aisdlc-105`
# down to `aisdlc`. Use an explicit `<letters>-<digits-and-dots>` shape
# instead — captures `aisdlc-105`, `aisdlc-100.2`, etc.
TASK_ID_LOWER=$(echo "$BRANCH" | sed -E 's|^ai-sdlc/([a-z]+(-[a-z]+)*-[0-9.]+).*|\1|')
WORKTREE_PATH=".worktrees/$TASK_ID_LOWER"
```

## Step 2 — Recreate worktree if missing

If `.worktrees/<task-id-lower>` doesn't exist (e.g. cleanup ran or this
is being invoked from a fresh checkout), recreate it from the PR's
remote head:

```bash
if [ ! -d "$WORKTREE_PATH" ]; then
  git fetch origin "$BRANCH"
  mkdir -p .worktrees
  # Create the worktree ON the branch (-B), not detached: the force-push in
  # Step 6 is only permitted from a dispatched worktree that is checked out
  # on its own task branch.
  git worktree add "$WORKTREE_PATH" -B "$BRANCH" "origin/$BRANCH"
fi

# Task sentinel: the PreToolUse hook binds the lease push to the task named
# here (it must match the worktree directory name and the branch prefix).
[ -s "$WORKTREE_PATH/.active-task" ] || printf '%s\n' "$TASK_ID_LOWER" > "$WORKTREE_PATH/.active-task"
```

If `git worktree add` fails because the branch is already checked out
elsewhere, abort with a clear message. Don't try to force.

## Step 3 — Invoke the rebase-resolver subagent

Spawn the `rebase-resolver` agent against the worktree. Build the
prompt:

```
You are rebasing PR #$PR (branch $BRANCH) in worktree $WORKTREE_PATH.

## PR title
$TITLE

## Head SHA before rebase
$HEAD_SHA

## Base
origin/main

## Conflict resolution rules (the 80%)
1. CHANGELOG.md conflict on a feature branch → ACCEPT MAIN SIDE, DROP feature-branch edits (AISDLC-401: CHANGELOG is release-please's domain; feature branches must not edit it)
2. Test file additions to same describe → KEEP BOTH it() blocks
3. Code additions, non-overlapping → KEEP BOTH; escalate if shared identifier
4. Run `pnpm exec prettier --write <file>` on every resolved file before
   `git rebase --continue`
5. Do NOT push from the subagent. The slash command body (Step 6) owns
   the single force-with-lease push of the rebased commits.

## Escalation cases (the 20%)
1. Modify-vs-delete → escalate with best-guess port location
2. Semantic conflict on overlapping lines → escalate with diff context
3. Verification failure (build/test/lint/format) → escalate, do NOT push
4. Iteration cap exceeded (>3 rebase attempts) → escalate

## Verification commands (before push)
- pnpm build
- pnpm test
- pnpm lint
- pnpm format:check

## Return shape
{
  "outcome": "success" | "escalated" | "failed",
  "resolvedFiles": [...],
  "escalationReason": "...",
  "verifications": { "build": "passed|failed|skipped", ... },
  "rebaseAttempts": <number>,
  "notes": "..."
}
```

When invoking the Agent tool: `subagent_type: rebase-resolver`. The
agent's cwd will be the worktree path.

Watch for `[ai-sdlc-progress]` lines and surface them to the user as
they appear.

## Step 4 — Parse subagent return value

Read the JSON returned by the subagent (its final assistant message is a
single JSON object — see the rebase-resolver agent's "Return value"
section). Branch on `outcome`:

- **`escalated`** — print `escalationReason`, `notes`, and tell the
  operator they need to handle this manually. Do NOT push. Print: "Worktree preserved at `$WORKTREE_PATH`
  for manual conflict resolution." Stop.
- **`failed`** — print the failure reason. The subagent already
  rolled back. Stop.
- **`success`** — persist the structured return JSON to disk so Step 5
  can read it with `jq` (the assistant message itself isn't directly
  accessible to the bash subshell), then proceed to Step 5.

```bash
# Persist the subagent's return JSON before Step 5 reads it. Without
# this write the jq calls in Step 5 would always see empty hashes and
# the skip-resign optimization would never fire.
cat > /tmp/rebase-resolver-${PR}.json <<'REBASE_RESOLVER_JSON'
<<paste the subagent's return JSON object here verbatim>>
REBASE_RESOLVER_JSON
```

## Step 5 — No re-signing (RFC-0061)

Nothing is signed any more. The review verdict gate carries an earlier
approval across a rebase by the clean-replay rule (`cli-attestation
verdict-check` reports `ok-carried:<sha>`), or asks for a fresh review.
There is no attestation to re-sign, so proceed straight to Step 6.

## Step 6 — Force-push with --force-with-lease (AISDLC-105 Hard Rule 2)

Always `--force-with-lease`, never plain `--force`. The subagent already
verified the branch is not main/master, but defense-in-depth here:

```bash
cd "$WORKTREE_PATH"
BRANCH=$(git branch --show-current)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: refusing to force-push $BRANCH"
  exit 1
fi
echo "$BRANCH"
```

Then run the push as its **own, standalone Bash command** from `$WORKTREE_PATH`
(the PreToolUse hook reads the tool call's cwd). Write the branch name printed
above LITERALLY into the command: no variables, no quotes, no `cd &&`, no
chaining, no `--set-upstream`/`-u` needed. This is the canonical spelling the
`leaseOnOwnBranch` policy accepts (the default policy; push without asking the operator):

```bash
git push --force-with-lease origin HEAD:refs/heads/<branch>
```

When you are done pushing, `cd` back to the original directory.

If the push is rejected (someone pushed to the same branch under us),
do NOT escalate to plain `--force`. Print the rejection and tell the
operator to investigate.

After a successful push, re-arm auto-merge — GitHub clears the PR's
auto-merge request on every force-push (AISDLC-356):

```bash
PR_NUMBER=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo '')
if [ -n "$PR_NUMBER" ]; then
  # AISDLC-872: re-arm only when the patch-id is unchanged versus the pre-rebase head
  node "${PIPELINE_CLI_BIN:-pipeline-cli/bin}/cli-merge-if-eligible.mjs" "$PR_NUMBER" --source-kind backlog --rearm-previous-head "$HEAD_SHA" 2>/dev/null || true
  # refused (content changed / policy never / untrusted PR) is fine: a content change needs a fresh review and arm
fi
```

Swallow non-zero exits — auto-merge may not be enabled in the repo or
the PR may not yet be ready. The re-arm is best-effort.

## Step 7 — Report

Print a tight summary:

- PR: `#$PR` — `$TITLE`
- Branch: `$BRANCH` (worktree at `$WORKTREE_PATH`)
- Outcome: `<success | escalated | failed>`
- Rebase attempts: `<N>`
- Resolved files: `<N>`
- Verification: `<all clean | failed at <stage>>`
- Pushed: `<yes | no — escalation reason: <...>>`

## What this command DOES NOT do (intentional)

- **Never runs the raw merge command.** Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`; when it permits merging, the only path is `cli-merge-if-eligible`.
- **Never runs `git push --force` / `-f`.** Only `--force-with-lease`.
- **Never pushes to `main`/`master`.** Hard refused at Step 1 + Step 6.
- **Never auto-resolves modify-vs-delete or semantic conflicts.** Those
  escalate back to the operator.
- **Never deletes the worktree on escalation.** The worktree is left in
  a clean state (rebase aborted) so the operator can inspect.

## When the operator should invoke this manually

- **A PR's CI status check failed because main moved** (the most common
  case — the review verdict check reports `replay-dirty` because a sibling
  merged into the PR's files). `/ai-sdlc rebase <pr>` rebases and
  force-pushes. CI re-runs cleanly.
- **A PR is "Update branch" yellow** in the GitHub UI but you don't want
  a merge commit (CLAUDE.md "Always rebase" rule). `/ai-sdlc rebase`
  produces a linear history without `gh api pulls/N/update-branch`.
- **A PR has been sitting idle for hours** while sibling PRs merged.
  Avoid the "rebase loop" pain proactively.
