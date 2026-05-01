---
name: rebase
description: /ai-sdlc rebase <pr-number> — auto-rebase a PR onto latest main, resolve mechanical conflicts, force-push with --force-with-lease, re-sign attestation if contentHash changed.
argument-hint: <pr-number>
allowed-tools:
  - Read
  - Bash
  - Agent(rebase-resolver)
model: inherit
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

1. **Never merge a PR.** Do not run `gh pr merge`.
2. **Never force-push with plain `--force` / `-f`.** Always use
   `--force-with-lease` (mirrors agent-role.yaml block list).
3. **Never push to `main` or `master`.** Refuse early.
4. **Never close PRs or issues.** No `gh pr close`, `gh issue close`.
5. **Never delete branches.** No `git branch -D` / `-d`.
6. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.**
7. **Never write GitHub Actions CI-skip magic tokens** (AISDLC-88) — the
   five literal substrings (`[skip ci]`, `[ci skip]`, `[no ci]`,
   `[skip actions]`, `[actions skip]`) silently disable workflows. The
   re-attestation chore commit body composed by Step 5 below is
   sanitised the same way `/ai-sdlc execute` Step 10 sanitises it.

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
TASK_ID_LOWER=$(echo "$BRANCH" | sed -E 's|^ai-sdlc/([a-z]+-[0-9.]+).*|\1|')
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
  git worktree add "$WORKTREE_PATH" "origin/$BRANCH"
fi
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
1. CHANGELOG Unreleased > Added overlaps → KEEP BOTH bullets (earliest first)
2. Test file additions to same describe → KEEP BOTH it() blocks
3. Code additions, non-overlapping → KEEP BOTH; escalate if shared identifier
4. Run `pnpm exec prettier --write <file>` on every resolved file before
   `git rebase --continue`
5. Do NOT push from the subagent. The slash command body (Step 6) owns
   the single force-with-lease push so re-attestation can be committed
   atomically with the rebased commits.

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

## Hash oracle for the orchestrator
Before AND after rebase, run:
  node "${CLAUDE_PLUGIN_ROOT}/scripts/sign-attestation.mjs" --print-content-hash
This is the AISDLC-94 / AISDLC-101 contentHash. Same hash before/after
means re-attestation is NOT needed; different hash means it is. Report
both as `preContentHash` / `postContentHash` in your return JSON.

## Return shape
{
  "outcome": "success" | "escalated" | "failed",
  "resolvedFiles": [...],
  "escalationReason": "...",
  "verifications": { "build": "passed|failed|skipped", ... },
  "rebaseAttempts": <number>,
  "preContentHash": "...",
  "postContentHash": "...",
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
  operator they need to handle this manually. Do NOT push, do NOT
  re-sign attestation. Print: "Worktree preserved at `$WORKTREE_PATH`
  for manual conflict resolution." Stop.
- **`failed`** — print the failure reason. The subagent already
  rolled back. Stop.
- **`success`** — persist the structured return JSON to disk so Step 5
  can read it with `jq` (the assistant message itself isn't directly
  accessible to the bash subshell), then proceed to Step 5
  (re-attestation).

```bash
# Persist the subagent's return JSON before Step 5 reads it. Without
# this write the jq calls in Step 5 would always see empty hashes and
# the skip-resign optimization would never fire.
cat > /tmp/rebase-resolver-${PR}.json <<'REBASE_RESOLVER_JSON'
<<paste the subagent's return JSON object here verbatim>>
REBASE_RESOLVER_JSON
```

## Step 5 — Re-sign attestation if contentHash changed (AISDLC-105 + AISDLC-102 + AISDLC-94)

The rebase changed HEAD, but the AISDLC-94 dual-hash predicate accepts
envelopes whose `contentHash` is unchanged (rebase didn't touch any blob
SHA at HEAD). AISDLC-101 further accepts unchanged per-file delta
hashes. So re-signing is only needed when `contentHash` actually moved.

Use the oracle the subagent already ran. **CRITICAL**: the conditional
below skips the *signing* logic but MUST fall through to Step 6
(force-push). Do NOT `exit 0` inside the skip branch — the rebase
commits still need to be pushed even when no re-attestation is needed.

```bash
PRE_HASH=$(jq -r '.preContentHash // empty' /tmp/rebase-resolver-${PR}.json)
POST_HASH=$(jq -r '.postContentHash // empty' /tmp/rebase-resolver-${PR}.json)

if [ -n "$PRE_HASH" ] && [ "$PRE_HASH" = "$POST_HASH" ]; then
  echo "[ai-sdlc-progress] re-attestation: skipped — contentHash unchanged ($PRE_HASH)"
  # No re-signing needed; the existing attestation envelope still verifies.
  # Falls through to Step 6 (push) — the rebased commits MUST still push.
else
  echo "[ai-sdlc-progress] re-attestation: contentHash changed ($PRE_HASH → $POST_HASH); re-signing"

  cd "$WORKTREE_PATH"

  if [ ! -f "$HOME/.ai-sdlc/signing-key.pem" ]; then
    echo "ERROR: No signing key at ~/.ai-sdlc/signing-key.pem."
    echo "       Re-attestation needed but cannot sign locally."
    echo "       Run /ai-sdlc init-signing-key once, open the printed onboarding PR,"
    echo "       then re-run /ai-sdlc rebase $PR."
    exit 1
  fi

  # Reuse any review-verdicts from a previous run if present, otherwise
  # pass an empty verdicts file so the predicate carries the iteration
  # count + harness note from a normal /ai-sdlc execute Step 10 invocation.
  VERDICTS=/tmp/review-verdicts-${TASK_ID_LOWER}.json
  [ -f "$VERDICTS" ] || echo '[]' > "$VERDICTS"

  # Carry the pre-rebase attestation's iterationCount + harnessNote
  # forward to preserve fidelity. The originals live in the DSSE payload
  # at `.ai-sdlc/attestations/<pre-rebase-head-sha>.dsse.json`. If we
  # can't read them (envelope missing or malformed), fall back to the
  # safe defaults and document the loss in the chore commit body.
  PRE_HEAD_SHA="$HEAD_SHA"
  PRE_ATTESTATION=".ai-sdlc/attestations/${PRE_HEAD_SHA}.dsse.json"
  if [ -f "$PRE_ATTESTATION" ]; then
    PRE_ITER=$(jq -r '.payload' "$PRE_ATTESTATION" \
      | base64 -d 2>/dev/null \
      | jq -r '.iterationCount // 1')
    PRE_HARNESS_NOTE=$(jq -r '.payload' "$PRE_ATTESTATION" \
      | base64 -d 2>/dev/null \
      | jq -r '.harnessNote // ""')
    FIDELITY_NOTE=""
  else
    PRE_ITER=1
    PRE_HARNESS_NOTE=""
    FIDELITY_NOTE="(pre-rebase attestation $PRE_ATTESTATION not on disk; iterationCount + harnessNote reset to defaults)"
  fi

  node "${CLAUDE_PLUGIN_ROOT}/scripts/sign-attestation.mjs" \
    --review-verdicts "$VERDICTS" \
    --iteration-count "$PRE_ITER" \
    --harness-note "$PRE_HARNESS_NOTE"

  # Sanitise CHORE_BODY for AISDLC-88 magic tokens, same as
  # /ai-sdlc execute Step 10. The chore commit MUST fire
  # verify-attestation.yml on push.
  CHORE_BODY="chore: re-sign review attestation after rebase

Auto-generated by /ai-sdlc rebase. Rebase changed HEAD but reviewers'
approval still binds (re-signed because contentHash changed); the new
envelope verifies against the rebased HEAD. ${FIDELITY_NOTE}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
  CHORE_BODY=$(printf '%s' "$CHORE_BODY" | sed -E \
    -e 's/\[[Ss][Kk][Ii][Pp] [Cc][Ii]\]/(skip ci marker)/g' \
    -e 's/\[[Cc][Ii] [Ss][Kk][Ii][Pp]\]/(ci skip marker)/g' \
    -e 's/\[[Nn][Oo] [Cc][Ii]\]/(no ci marker)/g' \
    -e 's/\[[Ss][Kk][Ii][Pp] [Aa][Cc][Tt][Ii][Oo][Nn][Ss]\]/(skip actions marker)/g' \
    -e 's/\[[Aa][Cc][Tt][Ii][Oo][Nn][Ss] [Ss][Kk][Ii][Pp]\]/(actions skip marker)/g')

  git add .ai-sdlc/attestations
  git commit -m "$CHORE_BODY"
  cd -
fi
```

## Step 6 — Force-push with --force-with-lease (AISDLC-105 Hard Rule 2)

Always `--force-with-lease`, never plain `--force`. The subagent already
verified the branch is not main/master, but defense-in-depth here:

```bash
cd "$WORKTREE_PATH"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: refusing to force-push $BRANCH"
  exit 1
fi

git push --force-with-lease origin "$BRANCH"
cd -
```

If the push is rejected (someone pushed to the same branch under us),
do NOT escalate to plain `--force`. Print the rejection and tell the
operator to investigate.

## Step 7 — Report

Print a tight summary:

- PR: `#$PR` — `$TITLE`
- Branch: `$BRANCH` (worktree at `$WORKTREE_PATH`)
- Outcome: `<success | escalated | failed>`
- Rebase attempts: `<N>`
- Resolved files: `<N>`
- Verification: `<all clean | failed at <stage>>`
- Re-attestation: `<skipped (hash unchanged) | re-signed (hash changed) | not applicable (escalated)>`
- Pushed: `<yes | no — escalation reason: <...>>`

## What this command DOES NOT do (intentional)

- **Never runs `gh pr merge`.** Only humans merge.
- **Never runs `git push --force` / `-f`.** Only `--force-with-lease`.
- **Never pushes to `main`/`master`.** Hard refused at Step 1 + Step 6.
- **Never auto-resolves modify-vs-delete or semantic conflicts.** Those
  escalate back to the operator.
- **Never re-signs attestation when contentHash is unchanged** — the
  AISDLC-94/101 verifier accepts the existing envelope, so re-signing
  would only churn commits.
- **Never deletes the worktree on escalation.** The worktree is left in
  a clean state (rebase aborted) so the operator can inspect.

## When the operator should invoke this manually

- **A PR's CI status check failed because main moved** (the most common
  case — `verify-attestation.yml` reports `invalid (diff drift)` because
  a sibling merged into the PR's files). `/ai-sdlc rebase <pr>` rebases,
  re-signs if needed, and force-pushes. CI re-runs cleanly.
- **A PR is "Update branch" yellow** in the GitHub UI but you don't want
  a merge commit (CLAUDE.md "Always rebase" rule). `/ai-sdlc rebase`
  produces a linear history without `gh api pulls/N/update-branch`.
- **A PR has been sitting idle for hours** while sibling PRs merged.
  Avoid the "rebase loop" pain proactively.
