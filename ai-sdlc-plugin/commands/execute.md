---
name: execute
description: Execute a backlog task end-to-end via subagents — worktree → developer → reviews → PR. Replaces the orchestrator-driven dogfood pipeline for backlog tasks.
argument-hint: <task-id>
allowed-tools: Read, Grep, Glob, Bash, Task, AskUserQuestion, mcp__backlog__task_view, mcp__ai-sdlc-plugin__task_edit, mcp__ai-sdlc-plugin__task_complete
model: inherit
---

Execute backlog task `$ARGUMENTS` end-to-end. The flow runs entirely as Claude Code subagents — no orchestrator subprocess, no shadow auth/state. One task per invocation; compose with `/loop /ai-sdlc execute <task-id>` for batches.

## Step 0 — Sweep merged worktrees (auto-cleanup)

Before doing anything else, scan `.worktrees/` and remove any whose branch's PR has merged into `main`. This is the eventual-cleanup mechanism — running `/ai-sdlc execute` regularly keeps the worktree directory tidy without any manual intervention.

```bash
if [ -d .worktrees ]; then
  for wt in .worktrees/*/; do
    [ -d "$wt" ] || continue
    WT_BRANCH=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)
    [ -z "$WT_BRANCH" ] && continue
    [ "$WT_BRANCH" = "HEAD" ] && continue   # detached, skip
    # Check if a PR for this branch exists and is merged
    MERGED_AT=$(gh pr list --head "$WT_BRANCH" --state merged --json mergedAt --jq '.[0].mergedAt' 2>/dev/null)
    if [ -n "$MERGED_AT" ] && [ "$MERGED_AT" != "null" ]; then
      echo "Sweeping merged worktree: $wt (branch $WT_BRANCH merged at $MERGED_AT)"
      git worktree remove --force "$wt" 2>/dev/null || true
    fi
  done
fi
```

This runs SILENTLY when nothing matches. If anything was swept, print one line per removal so the operator can see what happened.

For ad-hoc / manual cleanup of a specific task without waiting for the next `/ai-sdlc execute`, use the `/ai-sdlc cleanup [<task-id>]` companion command.

## Step 1 — Validate the task

Find the task file and read its frontmatter:

```bash
TASK_ID="$ARGUMENTS"   # e.g. AISDLC-68
TASK_ID_LOWER="$(echo "$TASK_ID" | tr '[:upper:]' '[:lower:]')"
TASK_FILE=$(ls "backlog/tasks/${TASK_ID_LOWER} -"* 2>/dev/null | head -1)
[ -z "$TASK_FILE" ] && { echo "ERROR: no task file for $TASK_ID"; exit 1; }
```

Read the task with `mcp__backlog__task_view` to render its full structure. Then verify:

- **Status** is `To Do` or `In Progress` (not `Draft`, not `Done`). If `Done`, refuse — already shipped. If `Draft`, refuse — not ready.
- **At least one acceptance criterion** exists. If none, refuse — task isn't actionable.
- **Not all ACs already checked** while status is `In Progress` — that's a stale-Done shape; refuse and ask the user to triage.

If validation fails, print the reason clearly and stop. Don't create a worktree.

## Step 2 — Compute branch name

The branch pattern lives in `.ai-sdlc/pipeline-backlog.yaml` under `branching.pattern`. Today it's `ai-sdlc/{issueIdLower}-{slug}` where `{slug}` is a kebab-cased version of the task title.

```bash
BRANCH_PATTERN=$(grep -A2 'branching:' .ai-sdlc/pipeline-backlog.yaml | grep 'pattern:' | sed -E "s/.*pattern: *'([^']+)'.*/\1/")
TITLE=$(grep -E '^title:' "$TASK_FILE" | sed -E 's/title: *"?([^"]+)"?/\1/')
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-50)
BRANCH=$(echo "$BRANCH_PATTERN" | sed "s|{issueIdLower}|$TASK_ID_LOWER|g; s|{slug}|$SLUG|g")
WORKTREE_PATH=".worktrees/$TASK_ID_LOWER"
```

## Step 3 — Set up the worktree

```bash
git fetch origin main
mkdir -p .worktrees
git worktree add "$WORKTREE_PATH" -b "$BRANCH" origin/main
```

If `git worktree add` fails because the branch already exists, the operator's prior run left state. Tell them: "Worktree branch `$BRANCH` already exists. Run `/ai-sdlc cleanup $TASK_ID` first, or pick a different task." Then stop.

## Step 4 — Flip task to In Progress + write active-task sentinel

Use `mcp__ai-sdlc-plugin__task_edit` to set `status: 'In Progress'`. This makes the dashboard reflect that work has started.

> **Why the plugin's task_edit (not upstream `mcp__backlog__task_edit`)?** Upstream re-serialises frontmatter from its known schema and silently strips unrecognised keys — including `permittedExternalPaths`, which this command relies on for cross-repo writes. The plugin's drop-in (AISDLC-73) preserves unknown keys verbatim. Same goes for `mcp__ai-sdlc-plugin__task_complete` in Step 10.

Then write the **per-worktree** active-task sentinel so the PreToolUse hook can resolve `permittedExternalPaths` for cross-repo writes:

```bash
echo "$TASK_ID" > "$WORKTREE_PATH/.active-task"
```

The sentinel lives **inside the worktree** (at `.worktrees/<task-id-lower>/.active-task`), not at the project-level `.worktrees/.active-task` path used by older versions. This is the canonical source of truth for "which task is active for this worktree." The hook walks up from the developer subagent's cwd to find this file, so each parallel `/ai-sdlc execute` run has its own sentinel without racing the others. Without it, cross-repo writes are denied.

CRITICAL: this file MUST be deleted at end of run (Step 13) regardless of success/failure, otherwise a future invocation reading the worktree (e.g. `/ai-sdlc cleanup` or another execute that re-uses the path) inherits the stale active task. Treat it as a try/finally — if anything fails between here and Step 13, still delete.

> **Parallel runs are safe.** Multiple `/ai-sdlc execute` invocations can run concurrently against the same project root, including with cross-repo writes — each invocation reads/writes its own per-worktree sentinel. The legacy project-level sentinel `.worktrees/.active-task` is no longer written by this command, but the hook still falls back to it for one release for compatibility (deprecated, will be removed in v0.9.0+).

## Step 5 — Invoke the developer subagent

Spawn the `developer` agent against the worktree. Build the prompt from the task content:

```
You are implementing backlog task $TASK_ID in worktree $WORKTREE_PATH.

## Task title
<title from frontmatter>

## Description
<body of the task file, between the AC list and the next ## section>

## Acceptance criteria
<numbered list from the task>

## References
<refs from frontmatter — read as needed via Read tool>

## Permitted external paths (cross-repo writes)
<permittedExternalPaths from frontmatter, or "none">

## Verification commands (run before commit)
- pnpm build
- pnpm test
- pnpm lint
- pnpm format:check

## Commit message template
<conventional-commit type>: <subject> ($TASK_ID)

<body>

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

## Branch
You are on branch `$BRANCH` checked out at `$WORKTREE_PATH`.

Return the JSON shape documented in your agent definition.
```

When invoking the Task tool for the developer agent:

- `subagent_type: developer`
- The agent's cwd will be the worktree path
- The PreToolUse hook walks up from the agent's cwd to find `<worktree>/.active-task` (written in Step 4) and resolves `permittedExternalPaths` from that task's frontmatter for cross-repo writes

Watch for `[ai-sdlc-progress]` lines in the agent's tool output and surface them to the user as they appear.

## Step 6 — Parse developer return value

The developer returns a JSON object. Parse it and check:

- If `commitSha` is `null`, the developer couldn't complete the task. Print the `notes` field, revert the task to `To Do` via `mcp__ai-sdlc-plugin__task_edit`, leave the worktree on disk for inspection, and stop. Print: "Worktree preserved at `$WORKTREE_PATH`. To clean up: `/ai-sdlc cleanup $TASK_ID`."
- If any of `verifications.{build,test,lint}` is `failed`, treat as developer failure (same rollback as above).
- Otherwise proceed to review.

## Step 7 — Run three reviews in parallel

Build the review context once, share across all reviewers:

```bash
cd "$WORKTREE_PATH"
git diff origin/main...HEAD > "/tmp/pr-diff-${TASK_ID}.txt"
git diff --name-only origin/main...HEAD > "/tmp/pr-files-${TASK_ID}.txt"
cd -
```

Detect Codex availability once (the reviewer agents declare `harness: codex`):

```bash
if which codex >/dev/null 2>&1; then
  HARNESS_NOTE=""
else
  HARNESS_NOTE="⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)"
fi
```

Spawn **three subagents in parallel** (single message, three Task tool calls):

- `subagent_type: code-reviewer`
- `subagent_type: test-reviewer`
- `subagent_type: security-reviewer`

Each prompt should contain:

- The PR diff (from `/tmp/pr-diff-${TASK_ID}.txt`)
- The task title, description, AC list
- Contents of `.ai-sdlc/review-policy.md` if present (project-specific calibration)
- The branch name + base (`main`)

Each returns a verdict JSON: `{ approved, findings, summary }`.

## Step 8 — Aggregate verdicts

Combine the three verdicts:

- Count findings by severity across all reviewers (`critical`, `major`, `minor`, `suggestion`).
- If `HARNESS_NOTE` is non-empty, prepend it to the aggregated summary so the operator sees the independence warning every time it applies.
- Compute the gate decision:
  - **APPROVED**: all three reviewers approved AND no `critical`/`major` findings → proceed to PR (Step 10).
  - **CHANGES REQUESTED**: any `critical` or `major` findings → enter the iteration loop (Step 9).

Print the aggregation summary to the user before proceeding.

## Step 9 — Iteration loop (max 2 dev iterations on review failure)

Track iteration count starting at 1 (the first developer pass already ran).

While `iteration_count < 2` AND there are still critical/major findings:

1. Increment `iteration_count`.
2. Re-spawn the `developer` subagent with the SAME task context PLUS a `## Reviewer feedback (round N)` section listing the findings as bullet items (file:line — message). Tell the developer to address them and re-run verification.
3. Re-run the three parallel reviews against the updated diff.
4. Re-aggregate; if approved, break out of the loop and proceed to PR (Step 10).

After the loop, if there are STILL critical/major findings, do NOT abort. Open the PR anyway with the `[needs-human-attention]` flag in the body so the human can take it from there. The work is preserved, the human decides next steps.

```
PR title: feat: <task title> [needs-human-attention] (<task-id>)
PR body opens with: > **⚠ This PR exceeded the auto-iteration cap (2 rounds) with unresolved review findings. Human review/intervention requested.**
```

Then collapse all three review verdicts (round-by-round if multiple iterations ran) into `<details>` blocks in the PR body.

## Step 10 — Mark task Done + sign attestation + commit (BEFORE push)

This step lands the entire task lifecycle inside a single PR — Done state, file move, the signed review attestation, and the implementation work all merge atomically. Per CLAUDE.md (this command's authority): for tasks shipped via `/ai-sdlc execute`, **Done = "reviews-approved-and-PR-opened"**, not "merged."

Skip this step entirely if the iteration cap was exceeded (the PR is `[needs-human-attention]` — let the human flip Done after they're satisfied via `/ai-sdlc complete <task-id>` or by hand).

If reviews approved cleanly:

1. **Build `acceptanceCriteriaCheck`** — list all AC indices `[1..N]` by default. If reviewers explicitly contested any AC ("AC #3 not actually met" wording), drop those indices.
2. **Build `finalSummary`** — assemble per the CLAUDE.md template:
   ```markdown
   ## Summary
   <developer's `summary` field>

   ## Changes
   <bullet list of files from developer's `filesChanged` with one-liner each>

   ## Design decisions
   <from developer's `notes` field, or "(none)" if empty>

   ## Verification
   - `pnpm build` — <developer.verifications.build>
   - `pnpm test` — <developer.verifications.test>
   - `pnpm lint` — <developer.verifications.lint>
   - `pnpm format:check` — <developer.verifications.format>
   - 3 parallel reviews approved (<HARNESS_NOTE if any>)

   ## Follow-up
   (none) | <anything from developer.notes>
   ```
3. **Call `mcp__ai-sdlc-plugin__task_edit`** with `id: $TASK_ID`, `status: 'Done'`, `acceptanceCriteriaCheck: [...]`, `finalSummary: '...'`.
4. **Call `mcp__ai-sdlc-plugin__task_complete`** with `id: $TASK_ID` — this physically moves `backlog/tasks/<file>.md` → `backlog/completed/<file>.md`.
5. **Build + sign the review attestation** (AISDLC-74). Before staging the chore commit, write a DSSE envelope at `.ai-sdlc/attestations/<head-sha>.dsse.json` so CI can verify the local review and skip its own duplicate review run:

   ```bash
   cd "$WORKTREE_PATH"

   # Refuse early if the contributor hasn't onboarded their signing key yet —
   # /ai-sdlc init-signing-key is a one-time setup pointing at ~/.ai-sdlc/signing-key.pem.
   if [ ! -f "$HOME/.ai-sdlc/signing-key.pem" ]; then
     echo "ERROR: No signing key at ~/.ai-sdlc/signing-key.pem."
     echo "       Run /ai-sdlc init-signing-key once, open the printed onboarding PR"
     echo "       adding your pubkey to .ai-sdlc/trusted-reviewers.yaml, then re-run."
     exit 1
   fi

   # Compute predicate inputs the verifier will re-derive on CI:
   #   - HEAD_SHA       = git rev-parse HEAD (the commit being attested)
   #   - DIFF           = git diff origin/main...HEAD
   #   - POLICY         = .ai-sdlc/review-policy.md
   #   - AGENT_HASHES   = sha256 of each ai-sdlc-plugin/agents/{code,test,security}-reviewer.md
   #   - PLUGIN_VERSION = ai-sdlc-plugin/plugin.json `.version`
   # The orchestrator helper does this in one call (it imports buildPredicate +
   # signAttestation from `@ai-sdlc/orchestrator/runtime`), reading the developer
   # commit's HEAD, the three reviewer verdicts (counts only — full JSON stays in
   # the PR body), $iteration_count, and $HARNESS_NOTE.
   #
   # The helper writes `.ai-sdlc/attestations/<head-sha>.dsse.json` and prints the
   # path on stdout. If iteration cap was exceeded, the helper is NOT called
   # (the PR is `[needs-human-attention]` per the iteration loop).
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sign-attestation.mjs" \
     --review-verdicts /tmp/review-verdicts-${TASK_ID}.json \
     --iteration-count "$iteration_count" \
     --harness-note "$HARNESS_NOTE"
   cd -
   ```

   The verdict JSON written to `/tmp/review-verdicts-${TASK_ID}.json` is the aggregated structure from Step 8 — `[{ agentId, harness, approved, findings: { critical, major, minor, suggestion } }, ...]`. Reviewer's full line-level findings live in the PR body for human consumption.

6. **Stage and commit the move + attestation** in the worktree as a separate chore commit so the developer's commit stays clean:
   ```bash
   cd "$WORKTREE_PATH"
   git add backlog/tasks backlog/completed .ai-sdlc/attestations
   git commit -m "chore: mark $TASK_ID complete

   Auto-generated by /ai-sdlc execute. Reviews approved; task lifecycle landed in this PR.
   Signed review attestation included at .ai-sdlc/attestations/<head-sha>.dsse.json
   (AISDLC-74) so CI's verify-attestation workflow can skip the duplicate review run.

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
   cd -
   ```

When the PR merges, the file is already in `backlog/completed/` on `main` — no race with the post-merge workflow. The attestation file stays in the repo as audit trail (~1-2KB per PR; not a secret — the private key never left the contributor's machine).

## Step 11 — Push and open PR

```bash
cd "$WORKTREE_PATH"
git push -u origin "$BRANCH"
```

If push fails with non-fast-forward (someone else pushed to the same branch), abort with a clear message — the cleanup story is "delete the remote branch and rerun" but that's a destructive action so we ask the user first.

Compose the PR title from `.ai-sdlc/pipeline-backlog.yaml` `pullRequest.titleTemplate` (today: `feat: {issueTitle} ({issueId})`).

Compose the PR body from:
- The developer's `summary` field
- A list of changed files (`git diff --name-only origin/main...HEAD`)
- A `<details>` block with the code-reviewer verdict
- A footer: `References $TASK_ID` (NOT `Closes` — backlog tasks aren't auto-closed by GitHub PR merges; the `.github/workflows/backlog-task-complete.yml` workflow handles it)

```bash
gh pr create \
  --title "<composed title>" \
  --body "<composed body>" \
  --base main \
  --head "$BRANCH"
```

Print the PR URL. Capture it as `MAIN_PR_URL`.

## Step 12 — Cross-repo PRs (siblings under permittedExternalPaths)

If the developer reported `filesChangedExternal` (sibling-repo writes) AND the task's frontmatter has `permittedExternalPaths`, create one parallel PR per dirty sibling repo:

For each entry in `developer.filesChangedExternal`:

1. **Verify it's a git repo**:
   ```bash
   SIBLING="<dev-reported repo path>"
   git -C "$SIBLING" rev-parse --show-toplevel >/dev/null 2>&1 || continue
   ```
2. **Check the dirty state matches what the developer claimed** (`git -C $SIBLING status --porcelain`). If empty, skip — nothing to push.
3. **Confirm `gh` auth works for the sibling**:
   ```bash
   gh -R "$(gh -C $SIBLING repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" auth status >/dev/null 2>&1
   ```
   If it fails, skip with a clear warning: "⚠ Cannot create sibling PR for `$SIBLING` — gh auth not configured for that repo. Files left dirty for manual handling: <list>."
4. **Create a parallel branch** in the sibling using the same task slug:
   ```bash
   SIBLING_BRANCH="ai-sdlc/${TASK_ID_LOWER}-sibling"
   git -C "$SIBLING" checkout -b "$SIBLING_BRANCH"
   git -C "$SIBLING" add -- <files reported by developer>
   git -C "$SIBLING" commit -m "feat: <task title> — sibling for $TASK_ID

   Companion changes for $MAIN_PR_URL.

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
   git -C "$SIBLING" push -u origin "$SIBLING_BRANCH"
   ```
5. **Open the sibling PR** with a body that links back to the main PR:
   ```bash
   gh -R "<sibling repo>" pr create \
     --title "feat: <task title> — sibling for $TASK_ID" \
     --body "Companion PR for $MAIN_PR_URL ($TASK_ID).

   <developer's summary>

   Files changed: <list>" \
     --base main \
     --head "$SIBLING_BRANCH"
   ```
6. **Capture the sibling PR URL.**

If any sibling PR creation fails partway, do NOT roll back the main PR — print the failure clearly and tell the operator to handle the sibling manually. Each sibling is independent.

After all siblings:
- Update the main PR body via `gh pr edit $MAIN_PR_URL --body "..."` to add a `## Sibling PRs` section listing each sibling URL.

## Step 13 — Cleanup sentinel + Report

Always remove the per-worktree active-task sentinel — without this a future invocation reading the worktree could see a stale active task:

```bash
rm -f "$WORKTREE_PATH/.active-task"
```

Run this whether the run succeeded, failed, was rolled back, or escalated. It's the closing bracket of the implicit try/finally started at Step 4. Note: only the per-worktree sentinel is touched here — the legacy project-level `.worktrees/.active-task` is no longer written by Step 4 and is not deleted here either (the hook will simply ignore it when no per-worktree sentinel matches).

Then print a tight summary:

- ✅ Task: `$TASK_ID` — `<title>`
- ✅ Branch: `$BRANCH` (worktree at `$WORKTREE_PATH`)
- ✅ Developer: `<N>` files, commit `<sha>`
- ✅ Reviews: `<APPROVED | NEEDS HUMAN ATTENTION>` — `<N>` critical, `<N>` major, `<N>` minor across 3 reviewers (`<HARNESS_NOTE if any>`)
- ✅ Iterations: `<N>` (capped at 2)
- ✅ PR: `<url>`
- ✅ Sibling PRs (if any): `<url>` for each
- ℹ️  Worktree retained for inspection. Will be auto-removed on next `/ai-sdlc execute` once this PR merges.

## What this command DOES NOT do (intentional)

- **Never runs `gh pr merge`.** Per CLAUDE.md, only humans merge.
- **Never runs `git push --force`.** If push fails, asks the operator.
- **Never edits `.ai-sdlc/**` or `.github/workflows/**`.** PreToolUse hook blocks anyway, but the developer prompt makes this explicit.
- **Does not yet** sweep merged worktrees on start (Step 7 of the larger plan). That lands in the next commit.
