---
name: execute
description: Execute a backlog task end-to-end — worktree → developer subagent → 3 parallel reviewer subagents → PR. Runs inline in the main Claude Code session so the Agent tool is available without a subagent middleman.
argument-hint: <task-id>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Agent(developer, code-reviewer, test-reviewer, security-reviewer)
  - mcp__backlog__task_view
  - mcp__plugin_ai-sdlc_ai-sdlc__task_edit
  - mcp__plugin_ai-sdlc_ai-sdlc__task_complete
model: inherit
---

Execute backlog task `$ARGUMENTS` end-to-end. The Step 0-15 pipeline below runs inline in the main Claude Code session — worktree creation, developer subagent fan-out, 3 parallel reviewer subagents, attestation signing, PR open.

> **AISDLC-218 — 1 CI run per PR.** Prior to this change, opening the PR before reviewers completed triggered CI run #1 (failing verify-attestation), then the attestation chore commit triggered CI run #2. The fix: the developer opens the PR as a **draft** (`gh pr create --draft`). Reviewers run + attestation signs while still draft. Step 13 calls `gh pr ready` to flip draft→ready_for_review, which triggers CI exactly once on the fully-signed, reviewer-approved state. ~50% CI-minute reduction per PR.

## Why this lives in the slash command body (not a subagent)

The Step 0-13 pipeline used to live here, then briefly moved to an `execute-orchestrator` subagent (AISDLC-82) for a cleaner parallel-runs design, then moved back here (AISDLC-98) once it became clear the harness blocks the orchestrator pattern. Rationale:

- **Plugin subagents cannot use the `Agent` tool.** Empirical proof: the parallel-execution test for AISDLC-69.2 returned `"No such tool available: Agent. Agent is not available inside subagents."` regardless of frontmatter declarations. Claude Code filters `Agent` out of every plugin subagent's tool grant one level deep — the allowlist form `Agent(developer, ...)` is silently dropped just the same.
- **The slash command body runs in the main Claude Code session**, which DOES have the `Agent` tool. So the body can spawn `developer` and the three reviewers (`code-reviewer`, `test-reviewer`, `security-reviewer`) directly without an orchestrator middleman.
- **Parallelism is per-Claude-Code-session**, not per-orchestrator-subagent. Run `/loop /ai-sdlc execute <task-id>` (or just invoke the slash command repeatedly) to fan out N pipelines — each invocation gets its own session-scoped pipeline run with its own worktree and per-worktree `.active-task` sentinel (AISDLC-81).

## Hard rules (NEVER violate)

1. **Never merge any PR.** Do not run `gh pr merge` under any circumstance. Per CLAUDE.md, only humans merge.
2. **Never force-push.** No `git push --force` / `-f`. If push fails (non-fast-forward), abort with a clear message and ask the operator.
3. **Never close PRs or issues.** No `gh pr close`, `gh issue close`.
4. **Never delete branches.** No `git branch -D` / `-d`.
5. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.** Configuration and CI are out of scope for task work — the PreToolUse hook also blocks this, but you must not even try.
6. **Never run destructive git operations.** No `git reset --hard`, `git checkout -- .`, `git restore .`.
7. **Never write GitHub Actions CI-skip magic tokens into commit messages (AISDLC-88).** GitHub Actions parses five literal substrings — `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` — case-insensitively, and SUPPRESSES every workflow on commits that carry any of them. That silently disables verify-attestation and ai-sdlc-review in one stroke. If you genuinely need to mention these tokens in a commit body, use the **paren-quoted form**: `(skip ci marker)` instead of `[skip ci]`. Backtick-wrapping (`` `[skip ci]` ``) does NOT defeat the parser — the literal bracketed substring is still present. The `.husky/pre-push` `check-skip-ci-marker.sh` gate (AISDLC-88) blocks pushes that violate this. The legacy AISDLC-87 CI-side attestor's `chore(ci): sign review attestation [skip ci]` commits (authored by `ai-sdlc-ci-attestor[bot]`; legacy `github-actions[bot]` retained as a fallback) are still exempted so historical commits replayed via auto-rebase don't strand pushes — but the attestor itself was removed in AISDLC-140 sub-4 (attestation is now audit-only) and AISDLC-152 (this task), so no NEW chore commits should be produced. Step 10 below additionally sanitises any leaked tokens out of the chore-commit body before staging, as defense-in-depth.

## Hard dependency — per-worktree sentinel (AISDLC-81)

Step 4 below writes the active-task sentinel at `<worktree>/.active-task` (per-worktree), NOT at the legacy project-level `.worktrees/.active-task` path. This is what makes parallel runs safe across multiple `/ai-sdlc execute` invocations (each in its own Claude Code session): each session gets its own sentinel, and the PreToolUse hook walks up from the developer subagent's cwd to find the right one. The legacy project-level sentinel is no longer written here (the hook still falls back to it for one release for backwards compatibility, deprecated for v0.9.0+).

If you find yourself trying to write `.worktrees/.active-task` at the project root, stop — that's the wrong path and would race with parallel runs.

## Step 0 — Self-heal orchestrator state + sweep merged worktrees

First, ensure the parent (orchestrator) repo is in the right state for worktree creation. The parent's working tree on `main` is **read-only** by Pattern C contract (project memory `project_orchestrator_repo_layout.md`) — all edits happen in `.worktrees/<task-id>/`. This makes it safe to auto-sync the parent to current `origin/main` at the start of every dispatch.

```bash
./scripts/check-orchestrator-state.sh
```

The script (AISDLC-137):
- Auto-corrects `core.bare=true` → `false` (some local editor extensions flip it back periodically)
- Fetches `origin/main`
- If parent's working tree is clean: `git reset --hard origin/main` (untracked files like `.worktrees/` survive)
- If parent's working tree is dirty: warns + skips (operator-protective; never destroys in-progress work)

Skip with `AI_SDLC_SKIP_ORCHESTRATOR_STATE_CHECK=1` (rare — only when you intentionally want a stale parent for debugging).

Then scan `.worktrees/` and remove any whose branch's PR has merged into `main`. This is the eventual-cleanup mechanism — running `/ai-sdlc execute` regularly keeps the worktree directory tidy without any manual intervention.

> **Why `--state all` (AISDLC-204).** The old query used `--state merged`, which returns an empty array once the source branch has been deleted from the remote. This is the normal outcome for squash-merges: this repo's `delete_branch_on_merge: true` policy removes the branch immediately. After deletion, `gh pr list --head <branch> --state merged` finds nothing because `--head` is a current-ref filter, not a historical one. The fix is `--state all` (which finds the PR regardless of source-branch existence) combined with client-side filtering on `.state == "MERGED"` to preserve the original intent: only sweep merged PRs, not abandoned-and-closed ones.

```bash
if [ -d .worktrees ]; then
  for wt in .worktrees/*/; do
    [ -d "$wt" ] || continue
    WT_BRANCH=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)
    [ -z "$WT_BRANCH" ] && continue
    [ "$WT_BRANCH" = "HEAD" ] && continue   # detached, skip
    # Use --state all so squash-merged PRs with deleted source branches are found.
    # Filter client-side: only sweep MERGED, not CLOSED (abandoned work).
    PR_INFO=$(gh pr list --head "$WT_BRANCH" --state all --json number,state,mergedAt --jq '.[0]' 2>/dev/null)
    PR_STATE=$(echo "$PR_INFO" | jq -r '.state // empty' 2>/dev/null)
    if [ "$PR_STATE" = "MERGED" ]; then
      MERGED_AT=$(echo "$PR_INFO" | jq -r '.mergedAt // "unknown"')
      echo "Sweeping merged worktree: $wt (branch $WT_BRANCH merged at $MERGED_AT)"
      git worktree remove --force "$wt" 2>/dev/null || true
    fi
  done
fi
```

This runs SILENTLY when nothing matches. If anything was swept, print one line per removal so the operator can see what happened.

For ad-hoc / manual cleanup of a specific task without waiting for the next `/ai-sdlc execute`, use the `/ai-sdlc cleanup [<task-id>]` companion command.

> **Parallel-runs note.** Step 0 races benignly across concurrent `/ai-sdlc execute` invocations (each in its own Claude Code session): `git worktree remove --force` is idempotent and the second invocation simply prints nothing for the already-swept entry. There's no shared mutable state to protect.

## Step 0.5 — Auto-sync untracked parent task files (AISDLC-217)

After Step 0's sweep, scan the parent's working tree for untracked files matching `backlog/{tasks,completed}/aisdlc-N*.md`. These accumulate in the parent when MCP tool writes bypass Pattern C routing (AISDLC-216), or when an operator pastes files directly into the parent's backlog directory.

This step is a **safety net** (backstop). AISDLC-216 is the upstream fix; Step 0.5 catches the residual cases.

**What it does:**

1. `git ls-files --others --exclude-standard` — lists all untracked files in the parent.
2. Partitions: backlog task files (`backlog/{tasks,completed}/aisdlc-N*.md`) vs. everything else.
3. If non-backlog untracked files exist → **refuses** with an operator-attention message. The operator must manually clean them up (`git clean -f <file>`) before dispatch can proceed.
4. For each backlog file, verifies it is not already on `origin/main` (`git ls-tree origin/main <path>`).
5. Genuinely-new files → creates a temporary sync worktree on a generated branch (`chore/sync-tasks-<sha>`), copies the files, commits, pushes, opens a docs-only PR titled `chore: sync N untracked task files`.
6. **Does NOT block** — logs the sync PR URL and continues. The sync PR is docs-only (`backlog/tasks/` + `backlog/completed/` are under `paths-ignore` for attestation workflows) so it auto-merges once CI passes.
7. If all untracked task files are already on `origin/main` → no-op (logs "already there, skipping").

```bash
SYNC_RESULT=$(node pipeline-cli/bin/ai-sdlc-pipeline.mjs sync-parent --work-dir "$(pwd)" 2>&1)
SYNC_EXIT=$?
if [ "$SYNC_EXIT" -ne 0 ]; then
  echo "ERROR (Step 0.5): $SYNC_RESULT"
  echo "Non-backlog untracked files detected in parent — clean them up and re-run."
  exit 1
fi
# Log sync result (PR URL or no-op message) but don't wait — main dispatch continues.
echo "[Step 0.5] $SYNC_RESULT"
```

> **Implementation note.** The `sync-parent` subcommand is backed by `pipeline-cli/src/steps/00-5-sync-parent.ts` (`syncParentUntrackedFiles`). It follows the same `Runner` injection pattern as all other steps so it is fully hermetic under test. Invoke via `node pipeline-cli/bin/ai-sdlc-pipeline.mjs` (never `pnpm exec` — see CLAUDE.md "CI behavior" / AISDLC-156).

> **Non-blocking contract.** Even when the sync PR opens, Step 0.5 returns immediately and Step 1 proceeds. The parent's untracked files remain until the operator runs `git clean -f backlog/tasks/aisdlc-N*.md` (or until the next Step 0 self-heal after the sync PR merges — at that point the files are on `origin/main`, `git reset --hard origin/main` is safe, and the parent is fully clean again).

## Step 1 — Validate the task

Find the task file and read its frontmatter:

```bash
TASK_ID="$ARGUMENTS"   # e.g. AISDLC-68
TASK_ID_LOWER="$(echo "$TASK_ID" | tr '[:upper:]' '[:lower:]')"
TASK_FILE=$(ls "backlog/tasks/${TASK_ID_LOWER} -"* 2>/dev/null | head -1)
[ -z "$TASK_FILE" ] && { echo "ERROR: no task file for $TASK_ID"; exit 1; }
```

Read the task with `mcp__backlog__task_view` to render its full structure. Then verify:

- **Status** is `To Do` or `In Progress` (not `Draft`, not `Done`, not `Needs Clarification`). If `Done`, refuse — already shipped. If `Draft`, refuse — not ready. If `Needs Clarification` (RFC-0011 §7.3 + Phase 4 / AISDLC-115.5), refuse — the Definition-of-Ready gate flagged the task as not yet executable. Print the refusal message naming the blocked gates and point the operator at the DoR clarification thread (look for the `<!-- ai-sdlc:dor-comment -->` marker in the task body or issue comments). The operator must address the questions, edit the task, and re-run `/ai-sdlc dor-recheck <task-id>` (or wait for the auto-recheck on body edit) before `/ai-sdlc execute` can proceed. Do NOT bypass — the Definition-of-Ready gate is the contract that issues entering execution have been judged actionable.
- **At least one acceptance criterion** exists. If none, refuse — task isn't actionable.
- **Not all ACs already checked** while status is `In Progress` — that's a stale-Done shape; abort with `outcome: aborted`, populate `notes` for the user (e.g. "stale-Done shape: status=In Progress with all ACs checked — needs triage").

If validation fails, print the reason clearly and stop. Don't create a worktree.

### Step 1.5 — Dependency pre-flight (AISDLC-117)

Before creating the worktree, refuse to start a task whose dependencies aren't all Done. This catches the AISDLC-104-style duplicate-dispatch class of bug at source — when a task's siblings haven't merged yet (or the task itself was already shipped in a parallel session), `cli-deps preflight` reports `ok: false` and we abort cleanly with a clear list of blockers.

```bash
# cli-deps is the AISDLC-117 dependency-graph CLI shipped from @ai-sdlc/pipeline-cli.
# Exits 0 if every dependency is in backlog/completed/; exits non-zero with a
# JSON `{ok, reason, blockers, dangling}` envelope on stderr otherwise.
PREFLIGHT_OUT=$(node pipeline-cli/bin/cli-deps.mjs preflight "$TASK_ID" --work-dir "$(pwd)" 2>&1)
PREFLIGHT_EXIT=$?
if [ "$PREFLIGHT_EXIT" -ne 0 ]; then
  echo "ERROR: dependency preflight failed for $TASK_ID:"
  echo "$PREFLIGHT_OUT"
  echo ""
  echo "To inspect the dispatch-ready frontier instead: node pipeline-cli/bin/cli-deps.mjs frontier --format table"
  exit 1
fi
```

This step is fail-closed: if `cli-deps` itself errors (binary not built, broken JSON, etc.) the slash command still aborts rather than dispatching blindly. Run `pnpm --filter @ai-sdlc/pipeline-cli build` if the binary is missing. **Never** invoke pipeline-cli binaries via `pnpm --filter @ai-sdlc/pipeline-cli exec cli-X` — `pnpm exec` does not resolve workspace own-bins, the call silently fails with `Command not found`, and any `|| echo <fallback>` safety net fires unconditionally (CLAUDE.md "## CI behavior", AISDLC-156).

### Step 1.6 — Frontier consultation (operator hint, AISDLC-117)

For `/loop /ai-sdlc execute` runs (and ad-hoc multi-task dispatch), the operator should consult the dispatch-ready frontier before picking a candidate rather than relying on instinct. This is the same data the AISDLC-117 task description called out as the cure for "manual dependency tracing":

```bash
node pipeline-cli/bin/cli-deps.mjs frontier --format table
```

If `$TASK_ID` is on the printed list (or independent of the listed items), proceed. If not, the task's blockers are still open — `node pipeline-cli/bin/cli-deps.mjs blockers $TASK_ID --format table` lists what to ship first. The loop driver SHOULD prefer frontier tasks; the slash command body's Step 1.5 is the hard gate that refuses non-ready tasks regardless of where the dispatch decision came from.

## Step 2 — Compute branch name

The branch pattern lives in `.ai-sdlc/pipeline-backlog.yaml` under `branching.pattern`. Today it's `ai-sdlc/{issueIdLower}-{slug}` where `{slug}` is a kebab-cased version of the task title.

```bash
BRANCH_PATTERN=$(grep -A2 'branching:' .ai-sdlc/pipeline-backlog.yaml | grep 'pattern:' | sed -E "s/.*pattern: *'([^']+)'.*/\1/")
# AISDLC-180: use ai-sdlc-plugin/scripts/compute-slug.mjs to parse the YAML
# frontmatter title properly. The previous shell pipeline (`grep ^title: |
# sed`) returned `>-` literally for any block-scalar title produced by
# backlog.md (every long-titled task), then normalised to an empty slug,
# then yielded a malformed branch like `ai-sdlc/aisdlc-178.1-`. The script
# is dependency-free (no js-yaml), handles every title form the serializer
# emits, and exits non-zero with a clear error if the slug would be empty.
SLUG=$(node ai-sdlc-plugin/scripts/compute-slug.mjs "$TASK_FILE") || {
  echo "ERROR: failed to compute slug for $TASK_ID — see stderr above"
  exit 1
}
BRANCH=$(echo "$BRANCH_PATTERN" | sed "s|{issueIdLower}|$TASK_ID_LOWER|g; s|{slug}|$SLUG|g")
WORKTREE_PATH=".worktrees/$TASK_ID_LOWER"
```

## Step 3 — Set up the worktree (fresh base from latest main)

```bash
# Fetch latest main FIRST so the worktree gets created from the freshest base.
# Costs nothing if main hasn't moved (git fetch is a no-op when remote is unchanged),
# but if main has moved, the developer + reviewers run against current state from
# the start — reducing the chance Step 10.5 (pre-sign rebase) finds drift later.
# (AISDLC-102: fresh base at Step 3 + pre-sign rebase at Step 10.5 are
# paired defenses against attestation invalidation when sibling PRs land mid-run.)
git fetch origin main
mkdir -p .worktrees
git worktree add "$WORKTREE_PATH" -b "$BRANCH" origin/main
```

If `git worktree add` fails because the branch already exists, the operator's prior run left state. Tell them: "Worktree branch `$BRANCH` already exists. Run `/ai-sdlc cleanup $TASK_ID` first, or pick a different task." Then stop.

## Step 4 — Flip task to In Progress + write active-task sentinel

Use `mcp__plugin_ai-sdlc_ai-sdlc__task_edit` to set `status: 'In Progress'`. This makes the dashboard reflect that work has started.

> **Why the plugin's `task_edit` (not upstream `mcp__backlog__task_edit`)?** Upstream re-serialises frontmatter from its known schema and silently strips unrecognised keys — including `permittedExternalPaths`, which this pipeline relies on for cross-repo writes. The plugin's drop-in (AISDLC-73) preserves unknown keys verbatim. Same goes for `mcp__plugin_ai-sdlc_ai-sdlc__task_complete` in Step 10. The `mcp__plugin_<plugin-name>_<server-name>__<tool>` namespace is how Claude Code exposes plugin-supplied MCP tools — globally-registered MCP servers (like `mcp__backlog__*`) use the simpler `mcp__<server>__<tool>` form.

Then write the **per-worktree** active-task sentinel so the PreToolUse hook can resolve `permittedExternalPaths` for cross-repo writes:

```bash
echo "$TASK_ID" > "$WORKTREE_PATH/.active-task"
```

The sentinel lives **inside the worktree** (at `.worktrees/<task-id-lower>/.active-task`), not at the project-level `.worktrees/.active-task` path used by older versions. This is the canonical source of truth for "which task is active for this worktree." The hook walks up from the developer subagent's cwd to find this file, so each parallel `/ai-sdlc execute` run (in its own Claude Code session) has its own sentinel without racing the others. Without it, cross-repo writes are denied.

CRITICAL: this file MUST be deleted at end of run (Step 15) regardless of success/failure, otherwise a future invocation reading the worktree (e.g. `/ai-sdlc cleanup` or another execute that re-uses the path) inherits the stale active task. Treat it as a try/finally — if anything fails between here and Step 15, still delete.

> **Parallel runs are safe.** Multiple `/ai-sdlc execute` invocations can run concurrently against the same project root (each in its own Claude Code session), including with cross-repo writes — each invocation reads/writes its own per-worktree sentinel. The legacy project-level sentinel `.worktrees/.active-task` is no longer written by this pipeline, but the hook still falls back to it for one release for compatibility (deprecated, will be removed in v0.9.0+).

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

When invoking the Agent tool for the developer agent:

- `subagent_type: developer`
- The agent's cwd will be the worktree path
- The PreToolUse hook walks up from the agent's cwd to find `<worktree>/.active-task` (written in Step 4) and resolves `permittedExternalPaths` from that task's frontmatter for cross-repo writes

Watch for `[ai-sdlc-progress]` lines in the agent's tool output and surface them to the user as they appear.

## Step 6 — Parse developer return value

The developer returns a JSON object. Parse it and check:

- If `commitSha` is `null`, the developer couldn't complete the task. Print the `notes` field, revert the task to `To Do` via `mcp__plugin_ai-sdlc_ai-sdlc__task_edit`, leave the worktree on disk for inspection, and stop. Print: "Worktree preserved at `$WORKTREE_PATH`. To clean up: `/ai-sdlc cleanup $TASK_ID`."
- If any of `verifications.{build,test,lint}` is `failed`, treat as developer failure (same rollback as above).
- Otherwise proceed to review.

## Step 7 — Run conditional reviews (classifier-gated subset, incremental delta)

Build the review context once, share across all reviewers:

```bash
cd "$WORKTREE_PATH"
git diff origin/main...HEAD > "/tmp/pr-diff-${TASK_ID}.txt"
git diff --name-only origin/main...HEAD > "/tmp/pr-files-${TASK_ID}.txt"
cd -
```

### Step 7a — Classify the PR (AISDLC-141)

Pre-AISDLC-141 every push fan-outs to all 3 reviewers (testing/critic/security) regardless of PR contents. Now we run the deterministic classifier (RFC-0010 §12) first and only spawn the subset it returns. The classifier is **fail-open**: if the binary is missing, the input is unreadable, or confidence is below 0.7 it returns ALL_REVIEWERS so we never silently skip a review we should have done.

The CLI is shipped from `@ai-sdlc/pipeline-cli` (build it once with `pnpm --filter @ai-sdlc/pipeline-cli build` if the binary is missing). It accepts a unified-diff file, a `git diff --numstat` file, or a paths-only file; we use the paths file we just produced because the deterministic ruleset only cares about paths.

```bash
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$WORKTREE_PATH/.ai-sdlc/artifacts}"
mkdir -p "$ARTIFACTS_DIR"

# AC-4 + AC-5: classify, write the calibration log entry, capture the JSON.
# A non-zero exit from the CLI itself would abort, but the CLI is designed
# to fall open and exit 0 with a fellOpen=true decision instead — see
# pipeline-cli/src/cli/classify-pr.ts.
CLASSIFIER_JSON=$(node pipeline-cli/bin/cli-classify-pr.mjs classify \
  --paths-file "/tmp/pr-files-${TASK_ID}.txt" \
  --issue-id "$TASK_ID" \
  --artifacts-dir "$ARTIFACTS_DIR" 2>/dev/null || echo '{"reviewers":["testing","critic","security"],"fellOpen":true,"fellOpenReason":"invocation-failed","confidence":0}')

# Parse the reviewer subset (one of: 0, 1, 2, or 3 names from
# {testing, critic, security}) plus confidence + fellOpen for PR-body display
# (AC-8). `jq` is available on every operator environment we ship to.
SELECTED=$(printf '%s' "$CLASSIFIER_JSON" | jq -r '.reviewers | join(" ")')
CONFIDENCE=$(printf '%s' "$CLASSIFIER_JSON" | jq -r '.confidence')
FELL_OPEN=$(printf '%s' "$CLASSIFIER_JSON" | jq -r '.fellOpen')

echo "[ai-sdlc-progress] Step 7a: classifier decision: [$SELECTED] (confidence: $CONFIDENCE, fellOpen: $FELL_OPEN)"
```

The classifier reviewer names map to the reviewer subagents like this (the agents themselves keep their existing types — no rename needed):

| Classifier name | Subagent type        |
| --------------- | -------------------- |
| `testing`       | `test-reviewer`      |
| `critic`        | `code-reviewer`      |
| `security`      | `security-reviewer`  |

### Step 7a-bis — Incremental review gate (AISDLC-142)

Pre-AISDLC-142 every push fed each spawned reviewer the FULL PR diff, even when only 5 lines changed since the prior approval. Now we layer a content-hash gate ON TOP of the classifier subset: the same `contentHashV3` algorithm CI uses for attestation tells us whether anything materially changed since the last review.

The gate has three branches (decided by `cli-incremental-decide`, which is fail-open in the same shape as `cli-classify-pr`):

- **`unchanged`** — content-hash matches the marker → SKIP all spawned reviewers, write auto-approved verdicts directly. Update marker with the same hash + new SHA. (AC #3)
- **`delta-only`** — hash differs AND delta is within the safety threshold (default 200 lines, no new top-level dirs) → spawn the classifier-selected reviewers against `git diff <last-reviewed-sha>...HEAD` (delta only) PLUS a "the FULL PR diff was reviewed earlier; this incremental review only covers the delta from <sha>" preamble. Reviewer verdicts STILL apply to the whole PR. (AC #4)
- **`no-marker` / `delta-too-large` / `new-top-level-dir`** — fall back to FULL review against `/tmp/pr-diff-${TASK_ID}.txt`. (AC #5, plus first-push)

Marker storage: a single PR comment whose body contains `<!-- ai-sdlc:last-reviewed-contenthash:<base64url-json> -->`. Mirrors the idempotent-marker pattern from `<!-- ai-sdlc:dor-comment ... -->` and `<!-- ai-sdlc:attestation-fallback-comment -->`.

```bash
# Fetch existing PR comments (if any) so the gate can read the prior marker.
# `gh pr view --json comments` is cheap (one API call) and works against the
# branch's open PR. Empty file when no PR exists yet (first push) — the gate
# treats that as `no-marker` → FULL review.
#
# ── AISDLC-142 round-2 CRITICAL fix ────────────────────────────────────
# Filter PR comments to TRUSTED AUTHORS at the jq boundary BEFORE the marker
# is parsed. Without this filter ANY GitHub user could post a comment
# carrying a forged `<!-- ai-sdlc:last-reviewed-contenthash:<base64url> -->`
# marker (the contentHash is publicly computable from the PR diff), causing
# the next push to skip all 3 reviewers + auto-approve + satisfy the
# required-merge-gate check. This is an authorization-bypass with the same
# blast radius as a forged review approval — keep the filter in lock-step
# with the workflow analyzer's filter.
#
# Trust criteria (either gate is sufficient):
#   - login == "github-actions" (workflow-authored markers from the
#     `ai-sdlc-review.yml` upsert step)
#   - authorAssociation in {OWNER, MEMBER, COLLABORATOR} (push-access humans
#     — they could write the marker via the workflow itself; honoring their
#     direct comment is no escalation)
#
# Note: AISDLC-152 removed the `ai-sdlc-ci-attestor` login from this list
# alongside the AISDLC-87 attestor itself (AISDLC-140 sub-4 made attestation
# audit-only, AISDLC-152 ripped the remaining wiring). Push-access humans +
# the github-actions login cover every legitimate marker author.
#
# We emit a STRUCTURED JSON file so the CLI's `--comments-json-file` flag
# can re-apply the same filter as defense-in-depth (Layer 2).
PR_COMMENTS_JSON="/tmp/pr-comments-${TASK_ID}.json"
PR_COMMENTS_FILE="/tmp/pr-comments-${TASK_ID}.txt"
gh pr view "$BRANCH" --json comments --jq '
  [
    .comments[]
    | select(
        .author.login == "github-actions"
        or .authorAssociation == "OWNER"
        or .authorAssociation == "MEMBER"
        or .authorAssociation == "COLLABORATOR"
      )
    | {
        authorLogin: .author.login,
        authorAssociation: .authorAssociation,
        body: .body
      }
  ]
' > "$PR_COMMENTS_JSON" 2>/dev/null || echo '[]' > "$PR_COMMENTS_JSON"

# Bodies-only mirror for the PRIOR_SHA grep below (already author-filtered
# upstream — only trusted bodies make it here).
jq -r '.[].body' "$PR_COMMENTS_JSON" > "$PR_COMMENTS_FILE" 2>/dev/null \
  || : > "$PR_COMMENTS_FILE"

# Compute the delta numstat ONLY when a marker exists; the CLI no-ops it
# otherwise. We extract the prior reviewedSha from the marker, then run
# `git diff <sha>...HEAD --numstat`. If `gh` returned nothing, `jq` returns
# empty and the numstat step is skipped — the gate falls through to no-marker.
PRIOR_SHA=$(grep -oE '<!-- ai-sdlc:last-reviewed-contenthash:[A-Za-z0-9_-]+ -->' "$PR_COMMENTS_FILE" 2>/dev/null \
  | tail -1 \
  | sed -E 's/.*contenthash:([A-Za-z0-9_-]+) -->/\1/' \
  | { read B64 && [ -n "$B64" ] && printf '%s' "$B64" \
      | base64 -d 2>/dev/null \
      | jq -r '.reviewedSha' 2>/dev/null; } || echo "")

DELTA_NUMSTAT_FILE="/tmp/pr-delta-numstat-${TASK_ID}.txt"
: > "$DELTA_NUMSTAT_FILE"
if [ -n "$PRIOR_SHA" ]; then
  cd "$WORKTREE_PATH"
  # Cap the diff against PRIOR_SHA at the merge-base of HEAD if PRIOR_SHA isn't
  # in the current history (rebase changed history). On failure we leave the
  # numstat file empty — the CLI will treat unreadable input as the safer
  # `delta-too-large` branch and route to FULL review.
  git diff "$PRIOR_SHA"...HEAD --numstat > "$DELTA_NUMSTAT_FILE" 2>/dev/null || : > "$DELTA_NUMSTAT_FILE"
  cd - >/dev/null
fi

# Pass --comments-json-file (NOT --comments-file) so the CLI's trusted-author
# filter runs as defense-in-depth on top of the gh --jq filter above.
INCREMENTAL_JSON=$(node pipeline-cli/bin/cli-incremental-decide.mjs decide \
  --comments-json-file "$PR_COMMENTS_JSON" \
  --base-ref origin/main \
  --head-ref HEAD \
  --repo-root "$WORKTREE_PATH" \
  --numstat-file "$DELTA_NUMSTAT_FILE" \
  --full-diff-paths-file "/tmp/pr-files-${TASK_ID}.txt" 2>/dev/null \
  || echo '{"skip":false,"deltaOnly":false,"reason":"no-marker","currentContentHash":"","priorContentHash":null,"lastReviewedSha":null,"deltaSize":0}')

INCR_SKIP=$(printf '%s' "$INCREMENTAL_JSON" | jq -r '.skip')
INCR_DELTA_ONLY=$(printf '%s' "$INCREMENTAL_JSON" | jq -r '.deltaOnly')
INCR_REASON=$(printf '%s' "$INCREMENTAL_JSON" | jq -r '.reason')
INCR_LAST_SHA=$(printf '%s' "$INCREMENTAL_JSON" | jq -r '.lastReviewedSha // empty')
INCR_CONTENT_HASH=$(printf '%s' "$INCREMENTAL_JSON" | jq -r '.currentContentHash')
INCR_DELTA_SIZE=$(printf '%s' "$INCREMENTAL_JSON" | jq -r '.deltaSize')

echo "[ai-sdlc-progress] Step 7a-bis: incremental decision: $INCR_REASON (skip=$INCR_SKIP, deltaOnly=$INCR_DELTA_ONLY, deltaSize=$INCR_DELTA_SIZE, lastReviewedSha=${INCR_LAST_SHA:-none})"
```

When `INCR_SKIP=true` (AC #3): write the auto-approved verdict for EVERY reviewer in `$SELECTED` directly (no Agent calls), aggregate as APPROVED in Step 8, set the PR-body note to `> Incremental review (AISDLC-142): prior approval reused (no content change since SHA $INCR_LAST_SHA)`, then proceed to Step 8 / Step 10.

When `INCR_DELTA_ONLY=true` (AC #4): the spawned reviewers in Step 7b receive the DELTA diff (`git diff $INCR_LAST_SHA...HEAD`) instead of the full PR diff, plus the preamble described above. Build the delta diff once into a separate file:

```bash
if [ "$INCR_DELTA_ONLY" = "true" ]; then
  cd "$WORKTREE_PATH"
  git diff "$INCR_LAST_SHA"...HEAD > "/tmp/pr-delta-diff-${TASK_ID}.txt" 2>/dev/null \
    || cp "/tmp/pr-diff-${TASK_ID}.txt" "/tmp/pr-delta-diff-${TASK_ID}.txt"
  cd - >/dev/null
fi
```

Reviewers ALWAYS read from `/tmp/pr-delta-diff-${TASK_ID}.txt` when `INCR_DELTA_ONLY=true`, otherwise from `/tmp/pr-diff-${TASK_ID}.txt`.

> **Composes with Step 7a (AISDLC-141, AC #7).** The classifier runs FIRST and decides WHICH reviewers to spawn (the `$SELECTED` subset). The incremental gate then decides WHAT each one reads (skip / delta / full). When the classifier scoped review to e.g. just `[security]` and the incremental gate says `unchanged`, we spawn 0 reviewers AND auto-approve only `security` — the other two are still skipped by the classifier with their AISDLC-141 auto-approved verdicts. Net: minimum work that still satisfies the safety contract.

> **Marker update happens after Step 8 (post-aggregation).** See Step 8 below for the `gh pr comment` upsert. We do NOT update the marker before the reviewers report their verdicts — a marker update before the verdict gate would let a CHANGES_REQUESTED finding silently bind the marker to an un-approved SHA.

### Step 7b — Spawn the selected subset

Detect Codex availability once (the reviewer agents declare `harness: codex`):

```bash
if which codex >/dev/null 2>&1; then
  HARNESS_NOTE=""
else
  HARNESS_NOTE="⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)"
fi
```

Spawn **only the reviewers in `$SELECTED`** in parallel (single message, N Agent tool calls where 0 ≤ N ≤ 3). For each name in `$SELECTED`, dispatch the matching subagent type per the table above. If `$SELECTED` is empty (e.g. the classifier saw an empty diff), skip Step 7b entirely and treat the gate as APPROVED with zero findings.

**AISDLC-142 — incremental short-circuit:** if `INCR_SKIP=true`, do NOT spawn any reviewers in `$SELECTED`. Write the auto-approved verdict (from `cli-incremental-decide auto-approved-verdict --reviewed-sha $INCR_LAST_SHA`) for each one and skip directly to Step 8 aggregation. The classifier-skipped reviewers' AISDLC-141 auto-approved verdicts still apply for the others.

Each spawned-reviewer prompt should contain:

- The review diff:
  - if `INCR_DELTA_ONLY=true` → the delta diff from `/tmp/pr-delta-diff-${TASK_ID}.txt` PLUS a preamble:
    > **Incremental review (AISDLC-142):** the FULL PR diff was reviewed earlier at SHA `$INCR_LAST_SHA`. This incremental review only covers the delta from `$INCR_LAST_SHA` to HEAD ($INCR_DELTA_SIZE lines). Your verdict still applies to the WHOLE PR — only the diff you read is scoped down.
  - otherwise → the full PR diff from `/tmp/pr-diff-${TASK_ID}.txt`
- The task title, description, AC list
- Contents of `.ai-sdlc/review-policy.md` if present (project-specific calibration)
- The branch name + base (`main`)

Each returns a verdict JSON: `{ approved, findings, summary }`. When the classifier fell open (`fellOpen: true`), spawn ALL 3 — the existing safety semantics are preserved (AC-4).

> **Cost note (AC-8).** The classifier-decision line is also surfaced in the PR body (Step 11) as `Classifier decision: [<reviewers>] (confidence: <N.NN>)`. That gives the operator a per-PR view of how often we successfully scope down vs. fall open — feedback for the calibration log.

> **Reviewer concurrency at scale.** N parallel `/ai-sdlc execute` runs each spawn AT MOST 3 reviewer subagents in parallel, so the worst-case concurrent reviewer count is `3N` (unchanged from the pre-AISDLC-141 ceiling — the classifier only ever shrinks fan-out, never grows it). Reviewers are read-only (`disallowedTools: [Edit, Write, Bash?]`) and the only shared resource is the file system, which is safe for concurrent reads. The husky `pre-push` hook (in `.husky/pre-push`) does serialise across runs if multiple finish at the same moment, but the per-run review fan-out itself does not block on anything cross-run.

## Step 8 — Aggregate verdicts

Combine the three verdicts:

- Count findings by severity across all reviewers (`critical`, `major`, `minor`, `suggestion`).
- If `HARNESS_NOTE` is non-empty, prepend it to the aggregated summary so the operator sees the independence warning every time it applies.
- Compute the gate decision:
  - **APPROVED**: all three reviewers approved AND no `critical`/`major` findings → proceed to Step 8.5 marker update, then Step 10.
  - **CHANGES REQUESTED**: any `critical` or `major` findings → enter the iteration loop (Step 9). Do NOT update the marker on this branch — the marker only ever binds to APPROVED states.

Print the aggregation summary to the user before proceeding.

## Step 8.5 — Update the incremental-review marker (AISDLC-142)

ONLY if the gate decision is APPROVED (skip when `[needs-human-attention]` is being shipped from Step 9). Update the PR-comment marker with the freshly-computed contentHash + the SHA we just reviewed against. Subsequent pushes that don't change content can then short-circuit at Step 7a-bis.

```bash
HEAD_SHA=$(cd "$WORKTREE_PATH" && git rev-parse HEAD)
MARKER_BODY=$(node pipeline-cli/bin/cli-incremental-decide.mjs format-marker \
  --content-hash "$INCR_CONTENT_HASH" \
  --reviewed-sha "$HEAD_SHA")

# Idempotent upsert: search existing PR comments for the marker prefix; update
# in-place if present, else create new. Mirrors the pattern at
# .github/workflows/dor-ingress.yml around `<!-- ai-sdlc:dor-comment ... -->`.
#
# ── AISDLC-142 round-2 CRITICAL fix ────────────────────────────────────
# Filter to TRUSTED authors before selecting the prior marker. Without
# this filter an attacker-planted comment (containing the marker prefix
# substring) could be selected as `EXISTING_COMMENT_ID` and either (a)
# overwritten by the PATCH below — silently destroying the attacker's
# evidence — OR more importantly (b) preserved in place when the
# attacker's comment is "newer" than the bot's (`tail -1` keeps the
# latest), which would let the next push's incremental gate read the
# attacker's marker instead of the legitimate one. Same trust criteria
# as the analyze-job's gh --jq filter — keep them in lock-step.
EXISTING_COMMENT_ID=$(gh pr view "$BRANCH" --json comments \
  --jq '
    .comments[]
    | select(
        .author.login == "github-actions"
        or .authorAssociation == "OWNER"
        or .authorAssociation == "MEMBER"
        or .authorAssociation == "COLLABORATOR"
      )
    | select(.body | contains("<!-- ai-sdlc:last-reviewed-contenthash:"))
    | .id
  ' \
  2>/dev/null | tail -1)

COMMENT_BODY=$(printf '%s\n\n%s\n\n%s\n' \
  '## AI-SDLC: incremental review state' \
  '_Auto-managed by `/ai-sdlc execute`. Editing this comment will break incremental review for this PR until the next full review re-creates it._' \
  "$MARKER_BODY")

if [ -n "$EXISTING_COMMENT_ID" ]; then
  gh api "repos/{owner}/{repo}/issues/comments/${EXISTING_COMMENT_ID}" \
    -X PATCH \
    -f body="$COMMENT_BODY" >/dev/null \
    || echo "[ai-sdlc-progress] Step 8.5: marker update failed (non-fatal — next push will re-create)"
else
  gh pr comment "$BRANCH" --body "$COMMENT_BODY" >/dev/null \
    || echo "[ai-sdlc-progress] Step 8.5: marker create failed (non-fatal — next push will re-try)"
fi
```

The marker write is best-effort. A failure here at worst forces the next push back through a FULL review — never a SAFETY regression. The actual review verdicts already landed in the PR via Step 11.

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

## Step 10.5 — Pre-sign rebase + conditional re-review (AISDLC-102)

**Purpose.** Reduce the FREQUENCY of attestation invalidation by ensuring we sign against the latest `origin/main` state. Without this step, every PR that sits in the review queue while a sibling PR merges has its blob SHAs drift the moment we rebase later — invalidating the attestation we just signed and forcing a duplicate CI review run (the AISDLC-93 / PR #102 root case).

This step composes with AISDLC-101 (per-file delta hashing as verifier-side defense). Together they form defense in depth — Step 10.5 minimises *fresh* invalidation by signing the latest state; AISDLC-101 lets the verifier accept envelopes that were valid at sign time but drifted between push and merge due to a sibling merging into the SAME files.

Skip this step entirely if the iteration cap was exceeded (the PR is `[needs-human-attention]` — let the human handle the rebase before flipping Done).

If reviews approved cleanly:

```bash
cd "$WORKTREE_PATH"

# 1. Snapshot the pre-rebase contentHash. This is the AISDLC-94 oracle for
#    "did file content actually change?" — same hash before/after rebase
#    means the reviewers' approval still binds without re-spawning them.
PRE_HASH=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/sign-attestation.mjs" \
  --print-content-hash 2>/dev/null || echo "")

# 2. Fetch latest main with a bounded timeout. On fetch failure, skip the
#    rebase and proceed to Step 10 — flaky network must NOT block signing
#    (the verifier still has AISDLC-101's per-file delta as fallback).
if ! timeout 30 git fetch origin main 2>&1; then
  echo "[ai-sdlc-progress] Step 10.5: git fetch origin main failed (timeout/network); skipping rebase, proceeding to Step 10"
  cd -
  # Fall through to Step 10 unchanged
else
  # 3. Skip rebase if origin/main is already an ancestor of HEAD (the most
  #    common case — main hasn't moved since Step 3 fetched it).
  if git merge-base --is-ancestor origin/main HEAD; then
    echo "[ai-sdlc-progress] Step 10.5: origin/main already ancestor of HEAD; no rebase needed"
    cd -
    # Fall through to Step 10 unchanged
  else
    # 4. Rebase, bounded at 3 attempts to avoid infinite loops if siblings
    #    keep merging mid-run.
    REBASE_ATTEMPTS=0
    REBASE_OK=0
    while [ "$REBASE_ATTEMPTS" -lt 3 ]; do
      REBASE_ATTEMPTS=$((REBASE_ATTEMPTS + 1))
      if git rebase origin/main; then
        REBASE_OK=1
        break
      fi
      # Conflict — abort cleanly (we never auto-resolve; operator owns
      # conflict resolution). `git rebase --abort` restores pre-rebase HEAD.
      git rebase --abort 2>/dev/null || true
      # Re-fetch in case main moved AGAIN while we were rebasing
      timeout 30 git fetch origin main 2>&1 || break
    done

    if [ "$REBASE_OK" -ne 1 ]; then
      cd -
      # Conflict OR rebase loop — abort with structured failure. Operator
      # resolves manually then re-runs `/ai-sdlc execute`.
      if [ "$REBASE_ATTEMPTS" -ge 3 ]; then
        echo "ERROR: Step 10.5 rebase loop — main moved 3 times during rebase attempts."
        echo "       outcome: aborted (rebase-loop)"
      else
        echo "ERROR: Step 10.5 rebase conflict — operator must resolve manually."
        echo "       Run: cd $WORKTREE_PATH && git fetch origin main && git rebase origin/main"
        echo "       Resolve conflicts, then re-run: /ai-sdlc execute $TASK_ID"
        echo "       outcome: aborted (rebase-conflict)"
      fi
      # Return JSON with outcome: aborted, populated notes; do NOT proceed to Step 10.
      exit 1
    fi

    # 5. Rebase succeeded. Compare contentHash to decide whether reviewers'
    #    approval still binds (same content) or re-review is needed (different
    #    content because main now has sibling commits inside our changed files).
    POST_HASH=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/sign-attestation.mjs" \
      --print-content-hash 2>/dev/null || echo "")
    cd -

    if [ -n "$PRE_HASH" ] && [ "$PRE_HASH" = "$POST_HASH" ]; then
      echo "[ai-sdlc-progress] Step 10.5: rebased cleanly, contentHash unchanged ($PRE_HASH); reviewers' approval reused"
      # Fall through to Step 10 unchanged
    else
      echo "[ai-sdlc-progress] Step 10.5: rebased; contentHash changed ($PRE_HASH → $POST_HASH); re-spawning 3 reviewers (1 round)"
      # Re-spawn the three reviewers in parallel, single round only. Build a
      # fresh review context from the post-rebase diff. Re-use Step 7's prompt
      # template but include a "## Post-rebase context" preamble noting that
      # main moved during review and the diff now reflects the rebased state.
      cd "$WORKTREE_PATH"
      git diff origin/main...HEAD > "/tmp/pr-diff-${TASK_ID}.txt"
      git diff --name-only origin/main...HEAD > "/tmp/pr-files-${TASK_ID}.txt"
      cd -

      # Spawn 3 reviewers in parallel (single message, three Agent tool calls)
      # exactly as Step 7 did — code-reviewer, test-reviewer, security-reviewer.
      # If all three approve: proceed to Step 10. If any request changes: this
      # round counts toward Step 9's iteration cap (max 2 dev iterations total).
      # If the cap is already at 2, ship as `[needs-human-attention]` per Step 9.
    fi
  fi
fi
```

After Step 10.5 completes successfully, proceed to Step 10. The signed attestation will bind to the rebased HEAD — which is what CI verifies against the PR head SHA — so the dual-hash predicate (AISDLC-94) matches by construction at push time.

> **Why we re-review on contentHash change.** A rebase that pulls in sibling commits inside our changed files materially alters what CI is asked to merge. The reviewers' prior approval was against the pre-rebase content; if that content is no longer current, the approval no longer binds. The AISDLC-94 `contentHash` is the precise oracle: same hash = byte-identical reviewed content = approval reused; different hash = different content = re-spawn reviewers. This is why Phase 1 of AISDLC-94 was a hard prerequisite for this task.

> **Coordination with AISDLC-101 (verifier-side defense).** Step 10.5 closes the *producer-side* failure mode (we sign stale state then push fresh). AISDLC-101 (per-file delta hashing in the verifier) closes the *post-push* failure mode (sibling merges between our push and our merge). Both layers reduce the attestation-invalidation rate; neither alone closes both gaps.

## Step 10 — Mark task Done + write verdicts file + commit (BEFORE push)

This step lands the entire task lifecycle inside a single PR — Done state, file move, the implementation work, and (after the pre-push hook fires in Step 11) the signed review attestation all merge atomically. Per CLAUDE.md (this command's authority): for tasks shipped via `/ai-sdlc execute`, **Done = "reviews-approved-and-PR-opened"**, not "merged."

Skip this step entirely if the iteration cap was exceeded (the PR is `[needs-human-attention]` — let the human flip Done after they're satisfied via `/ai-sdlc complete <task-id>` or by hand).

> **AISDLC-133 — signing has moved to the pre-push hook.** Prior versions of this command shelled out to `node ai-sdlc-plugin/scripts/sign-attestation.mjs` from this step and committed the resulting envelope alongside the task-Done chore commit. That coupled a deterministic mechanical operation (sign → commit envelope) to a successful main-session turn AND consumed model context for it. The pipeline now writes the aggregated reviewer verdicts to `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` (per-worktree, survives session restart) and stops. The husky `pre-push` hook (`.husky/pre-push` → `scripts/check-attestation-sign.sh`) detects the verdict file at push time, signs the DSSE envelope against the actual HEAD SHA being pushed, commits the envelope as a follow-up chore, and exits 1 to prompt a re-`git push` (which is then a no-op because the idempotent check inside the hook sees the envelope at the new HEAD). See CLAUDE.md "## Hooks → Auto-signed attestations" for the full contract.
>
> The slash command is now responsible for ONE durable artifact at sign time: the verdict file. Everything else is the hook's job.

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
3. **Call `mcp__plugin_ai-sdlc_ai-sdlc__task_edit`** with `id: $TASK_ID`, `status: 'Done'`, `acceptanceCriteriaCheck: [...]`, `finalSummary: '...'`.
4. **Call `mcp__plugin_ai-sdlc_ai-sdlc__task_complete`** with `id: $TASK_ID` — this physically moves `backlog/tasks/<file>.md` → `backlog/completed/<file>.md`.
5. **Write the per-worktree reviewer verdicts file** (AISDLC-133). The husky pre-push hook reads this file in Step 11 to decide whether to auto-sign:

   ```bash
   cd "$WORKTREE_PATH"

   # Refuse early if the contributor hasn't onboarded their signing key yet —
   # the pre-push hook will fail loudly otherwise. /ai-sdlc init-signing-key
   # is a one-time setup pointing at ~/.ai-sdlc/signing-key.pem.
   if [ ! -f "$HOME/.ai-sdlc/signing-key.pem" ]; then
     echo "ERROR: No signing key at ~/.ai-sdlc/signing-key.pem."
     echo "       Run /ai-sdlc init-signing-key once, open the printed onboarding PR"
     echo "       adding your pubkey to .ai-sdlc/trusted-reviewers.yaml, then re-run."
     echo "       (The pre-push hook will refuse to sign without this key.)"
     exit 1
   fi

   # AISDLC-133: write the aggregated reviewer verdicts to the per-worktree
   # verdicts dir (NOT /tmp/ — the previous location did not survive session
   # restart). The pre-push hook reads from this exact path. The directory
   # is .gitignore'd; the durable artifact is the signed envelope at
   # `.ai-sdlc/attestations/<sha>.dsse.json` once the hook signs.
   #
   # Verdict JSON shape (same as the legacy /tmp/ form, unchanged):
   #   [{ agentId, harness, approved,
   #      findings: { critical, major, minor, suggestion } }, ...]
   #
   # Reviewer's full line-level findings live in the PR body for human
   # consumption — only the aggregated structure goes here.
   TASK_ID_LOWER=$(printf '%s' "$TASK_ID" | tr '[:upper:]' '[:lower:]')
   mkdir -p .ai-sdlc/verdicts
   cat > ".ai-sdlc/verdicts/${TASK_ID_LOWER}.json" <<EOF
   <aggregated reviewer verdicts JSON from Step 8>
   EOF

   # Export the iteration count + harness note so the pre-push hook picks
   # them up in Step 11 (the hook reads AI_SDLC_ITERATION_COUNT and
   # AI_SDLC_HARNESS_NOTE from the environment, defaulting to 1 and "" if
   # unset).
   export AI_SDLC_ITERATION_COUNT="$iteration_count"
   export AI_SDLC_HARNESS_NOTE="$HARNESS_NOTE"

   cd -
   ```

   The slash command body MUST NOT call `node ai-sdlc-plugin/scripts/sign-attestation.mjs` here anymore — the pre-push hook owns signing. If you find yourself re-adding that call, stop: you'll end up with two attestations (one bound to the dev commit pre-task-Done, one bound to the chore commit post-task-Done) and the hook's idempotency check at the post-task-Done HEAD will skip cleanly only by accident.

6. **Stage and commit the task-Done file move** in the worktree as a separate chore commit so the developer's commit stays clean. The attestation envelope is NOT staged here — the pre-push hook adds it on its own follow-up commit after step 11.

   Before composing the commit message, **sanitise any GitHub Actions CI-skip magic tokens** out of every interpolated value (`$TASK_ID`, the developer summary, etc.) — see Hard Rule 7 above. The five literal tokens GH Actions parses are `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` (case-insensitive). The chore-commit message we author here MUST NOT contain any of them — `verify-attestation.yml` and `ai-sdlc-review.yml` need to fire on this very commit. Replace each occurrence with its paren-quoted equivalent (`[skip ci]` → `(skip ci marker)`) before piping into `git commit -m`. The `.husky/pre-push` gate (`scripts/check-skip-ci-marker.sh`, AISDLC-88) is the belt-and-braces backstop, but Step 10 catches it cheaper.

   ```bash
   cd "$WORKTREE_PATH"
   # AISDLC-133: stage backlog/* only here. The attestation file (formerly
   # included in this `git add` line) is now produced by the pre-push hook
   # on a SEPARATE chore commit after Step 11 — `.ai-sdlc/attestations/`
   # is intentionally NOT in the add list.
   git add backlog/tasks backlog/completed

   # AISDLC-88: sanitise the chore-commit message body. The five magic
   # tokens GH Actions parses are listed above. We use `sed -E` to
   # rewrite any literal occurrences (case-insensitive) into the
   # paren-quoted form before `git commit -m`. This is defense-in-depth
   # for the prompt rule (Hard Rule 7): even if upstream user-provided
   # text leaks one of the tokens, the chore commit itself stays clean
   # so verify-attestation.yml + ai-sdlc-review.yml fire on it.
   CHORE_BODY="chore: mark $TASK_ID complete

   Auto-generated by /ai-sdlc execute. Reviews approved; task lifecycle landed in this PR.
   The signed review attestation lands on a follow-up chore commit auto-produced by
   the husky pre-push hook (AISDLC-133) at .ai-sdlc/attestations/<head-sha>.dsse.json
   (AISDLC-74) so CI's verify-attestation workflow can skip the duplicate review run.

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
   CHORE_BODY=$(printf '%s' "$CHORE_BODY" | sed -E \
     -e 's/\[[Ss][Kk][Ii][Pp] [Cc][Ii]\]/(skip ci marker)/g' \
     -e 's/\[[Cc][Ii] [Ss][Kk][Ii][Pp]\]/(ci skip marker)/g' \
     -e 's/\[[Nn][Oo] [Cc][Ii]\]/(no ci marker)/g' \
     -e 's/\[[Ss][Kk][Ii][Pp] [Aa][Cc][Tt][Ii][Oo][Nn][Ss]\]/(skip actions marker)/g' \
     -e 's/\[[Aa][Cc][Tt][Ii][Oo][Nn][Ss] [Ss][Kk][Ii][Pp]\]/(actions skip marker)/g')

   git commit -m "$CHORE_BODY"
   cd -
   ```

When the PR merges, the file is already in `backlog/completed/` on `main` — no race with the post-merge workflow. The attestation file (added by the pre-push hook on a separate commit in Step 11) stays in the repo as audit trail (~1-2KB per PR; not a secret — the private key never left the contributor's machine).

## Step 11 — Push branch + open as DRAFT PR (AISDLC-218: 1 CI run per PR)

> **Why DRAFT? (AISDLC-218)** Opening the PR immediately as a regular PR triggers CI run #1 before reviewers have completed and before the attestation envelope is signed. Then the envelope chore commit (auto-produced by the pre-push hook) triggers CI run #2 — identical work done twice. The fix: open as draft first, run reviewers + sign while still draft, then flip draft→ready_for_review as the LAST step (Step 13). CI fires exactly once on the fully-signed state. Observed in 12+ PRs during the 2026-05-06 autopilot session; ~50% CI-minute savings per PR.

### Step 11a — Push branch

```bash
cd "$WORKTREE_PATH"

# AISDLC-133: the husky pre-push hook (`.husky/pre-push`) auto-signs the
# attestation when it sees the verdict file from Step 10. The signing path is:
#
#   1st `git push` → coverage gate passes → attestation hook spots the verdict
#       file at .ai-sdlc/verdicts/<task-id-lower>.json + sees no envelope at
#       current HEAD → signs the envelope at .ai-sdlc/attestations/<sha>.dsse.json
#       → git-add + git-commit (no-verify, single-file) the envelope as a
#       follow-up chore → exits 1 with "re-push required" message.
#
#   2nd `git push` → coverage gate passes → attestation hook sees the envelope
#       file already present at the new HEAD → exits 0 (idempotent) → push
#       proceeds normally to origin.
#
# So this step is a `git push` LOOP capped at 2 attempts. Anything beyond 2
# is a real push failure (network, permissions, non-fast-forward) — escalate.
#
# AISDLC-218: this push does NOT open a PR — the branch lands on origin but
# workflows only fire on pull_request: events. We open a DRAFT PR in Step 11b
# AFTER the push loop completes. This means no CI fires until `gh pr ready`
# in Step 13 (after reviewers + attestation sign).
PUSH_ATTEMPTS=0
LAST_PUSH_RC=0
while [ "$PUSH_ATTEMPTS" -lt 2 ]; do
  PUSH_ATTEMPTS=$((PUSH_ATTEMPTS + 1))
  git push -u origin "$BRANCH"
  LAST_PUSH_RC=$?
  if [ "$LAST_PUSH_RC" -eq 0 ]; then
    break
  fi
  # Hook exited 1 (added attestation chore commit and asked us to re-push)?
  # The new commit is on HEAD; loop and re-push. Anything else (real
  # network/auth failure, non-fast-forward) will surface on the second
  # attempt as the same non-zero exit code and we'll escalate below.
done
# AISDLC-133 round-2 fix: track the actual `git push` exit code rather than
# inferring success from `git ls-remote | grep -q "$BRANCH"`. The remote
# branch can exist (created by the first attempt's hook-sign-then-exit-1
# cycle) even when the second push genuinely failed, which silently
# suppressed the error message. Direct exit-code check is the correct
# success oracle. Also avoids the unanchored-grep false-positive on
# similar branch names (e.g. `feat` matching `feat-foo`).
if [ "$LAST_PUSH_RC" -ne 0 ]; then
  echo "ERROR: 2 push attempts failed (last exit code: $LAST_PUSH_RC); aborting."
  echo "       The most recent failure is unrelated to AISDLC-133 attestation"
  echo "       auto-sign (the hook is idempotent on the second push). Diagnose:"
  echo "       \`git push -u origin $BRANCH\` directly to surface the underlying"
  echo "       error (network, non-fast-forward, auth)."
  exit 1
fi
```

If push fails with non-fast-forward (someone else pushed to the same branch), abort with `outcome: aborted` and populate `notes` for the user (e.g. "non-fast-forward push to `$BRANCH`; cleanup is to delete the remote branch and rerun, but that's destructive — confirm with the operator first"). Do NOT force-push, do NOT delete the remote branch yourself.

> **Husky `pre-push` serialises across parallel runs.** When N concurrent `/ai-sdlc execute` invocations all reach Step 11a at roughly the same moment, the husky `pre-push` hook (a flock-based serialiser in `.husky/pre-push`) ensures only one push is in flight at a time. This keeps the local git index from being clobbered, but does NOT serialise the rest of the pipeline — Steps 5-10 still run fully in parallel across runs. AISDLC-133's auto-sign step in the hook is also serialised by the same boundary — a second concurrent push waiting on the lock will see the first run's attestation chore commit already in HEAD and exit 0 idempotently.

### Step 11b — Open as DRAFT PR

Now that the branch is on origin, open the PR **as a draft**. Opening as draft means GitHub does NOT trigger `pull_request: opened` CI workflows on every workflow that skips drafts (see `pipeline-cli/docs/aisdlc-218-workflow-changes.md` for the list of workflows that need the `ready_for_review` trigger + job-level draft guard added). CI fires only when Step 13 calls `gh pr ready`.

Compose the PR title from `.ai-sdlc/pipeline-backlog.yaml` `pullRequest.titleTemplate` (today: `feat: {issueTitle} ({issueId})`).

Compose the PR body from:
- The developer's `summary` field
- A list of changed files (`git diff --name-only origin/main...HEAD`)
- A `<details>` block with the code-reviewer verdict
- **AISDLC-141 — classifier decision line**: `Classifier decision: [<reviewers>] (confidence: <N.NN>)` (or `Classifier decision: [testing critic security] (fellOpen: <reason>)` when the classifier fell open). This gives the operator per-PR visibility into how often we successfully scope review fan-out down vs. fall open. Use the `$SELECTED`/`$CONFIDENCE`/`$FELL_OPEN` shell vars captured in Step 7a.
- A footer: `References $TASK_ID` (NOT `Closes` — backlog tasks aren't auto-closed by GitHub PR merges; the `scripts/check-task-moved.sh` pre-push hook moves the task file atomically in the originating PR's own diff — AISDLC-220)

```bash
# AISDLC-218: --draft is mandatory. CI does not fire until Step 13 (gh pr ready).
gh pr create \
  --draft \
  --title "<composed title>" \
  --body "<composed body>" \
  --base main \
  --head "$BRANCH"
```

Print the PR URL. Capture it as `MAIN_PR_URL` and the PR number as `MAIN_PR_NUMBER`.

> **Note on Step 7a-bis incremental-review marker.** The marker lookup (`gh pr view "$BRANCH" --json comments`) works on DRAFT PRs — GitHub's REST API returns draft PR data regardless of draft state. The marker upsert in Step 8.5 (`gh pr comment "$BRANCH"`) similarly works on drafts. No special handling needed here.

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

## Step 13 — Flip DRAFT → ready-for-review (AISDLC-218: triggers CI exactly once)

This is the final step of the pipeline and the ONLY moment CI fires for this PR.

```bash
# AISDLC-218: flip draft → ready_for_review. This is the pull_request:
# ready_for_review event that all required-check workflows wait for.
# At this point:
#   - Reviewers have approved (Step 7-9)
#   - Attestation envelope is signed (Step 10 / pre-push hook)
#   - Branch is on origin at the signed HEAD (Step 11a)
#   - PR is open as draft (Step 11b)
#
# CI fires ONCE on this SHA — verify-attestation passes because the
# envelope is already at HEAD, ai-sdlc-review passes because the
# envelope satisfies the required check, and build/test/lint/coverage
# run against the fully-reviewed state.
gh pr ready "$MAIN_PR_NUMBER"
echo "[ai-sdlc-progress] Step 13: PR #$MAIN_PR_NUMBER flipped to ready_for_review — CI will fire once"
```

If `gh pr ready` fails (network, the PR was already marked ready, etc.), do NOT abort — log the error and continue to cleanup. The PR is still open and reviewable; the operator can flip it manually via `gh pr ready <number>` or via the GitHub UI.

> **Why Step 13 comes LAST.** The `ready_for_review` event triggers ALL required-check workflows simultaneously on the signed HEAD. If we flipped the PR to ready BEFORE reviewers run (or before attestation signs), we'd get the 2-CI-run pattern we're eliminating: CI fires once on the unsigned state, fails verify-attestation, then fires again after the attestation chore push. By keeping the PR draft through Steps 11-12 and flipping LAST, we guarantee: (1) attestation is at HEAD, (2) CI fires exactly once, (3) it fires on the state reviewers actually approved. ~50% CI-minute reduction per PR.

> **Workflows that need updating.** To realize the full CI savings, ALL required-check workflows must add `ready_for_review` to their trigger types AND a `if: github.event.pull_request.draft == false` job-level guard. See `pipeline-cli/docs/aisdlc-218-workflow-changes.md` for the complete audit. Until those workflow edits land, some workflows may still fire on the `opened` event for draft PRs — the savings are partial until the workflow edits merge.

## Step 15 — Cleanup sentinel + Report

Always remove the per-worktree active-task sentinel — without this a future invocation reading the worktree could see a stale active task:

```bash
rm -f "$WORKTREE_PATH/.active-task"
```

Run this whether the run succeeded, failed, was rolled back, or escalated. It's the closing bracket of the implicit try/finally started at Step 4. Note: only the per-worktree sentinel is touched here — the legacy project-level `.worktrees/.active-task` is no longer written by Step 4 and is not deleted here either (the hook will simply ignore it when no per-worktree sentinel matches).

Then print a tight summary:

- Task: `$TASK_ID` — `<title>`
- Branch: `$BRANCH` (worktree at `$WORKTREE_PATH`)
- Developer: `<N>` files, commit `<sha>`
- Reviews: `<APPROVED | NEEDS HUMAN ATTENTION>` — `<N>` critical, `<N>` major, `<N>` minor across 3 reviewers (`<HARNESS_NOTE if any>`)
- Iterations: `<N>` (capped at 2)
- PR: `<url>`
- Sibling PRs (if any): `<url>` for each
- Worktree retained for inspection. Will be auto-removed on next `/ai-sdlc execute` once this PR merges.

## Return value (printed to the user)

After Step 15, print a JSON object summarising the run so the operator (or a wrapping `/loop`) can render or post-process:

```json
{
  "taskId": "AISDLC-NN",
  "branch": "ai-sdlc/aisdlc-nn-...",
  "worktreePath": ".worktrees/aisdlc-nn",
  "outcome": "approved | needs-human-attention | developer-failed | aborted",
  "developer": {
    "commitSha": "abc1234 | null",
    "filesChanged": ["..."],
    "filesChangedExternal": [{"repo": "/abs/sibling", "files": ["..."]}],
    "verifications": { "build": "...", "test": "...", "lint": "...", "format": "..." },
    "summary": "...",
    "notes": "..."
  },
  "reviews": {
    "iterations": 1,
    "harnessNote": "" ,
    "verdicts": [
      { "agentId": "code-reviewer", "harness": "claude-code|codex", "approved": true,
        "findings": { "critical": 0, "major": 0, "minor": 0, "suggestion": 0 } },
      { "agentId": "test-reviewer", "harness": "...", "approved": true, "findings": { "...": 0 } },
      { "agentId": "security-reviewer", "harness": "...", "approved": true, "findings": { "...": 0 } }
    ]
  },
  "prUrl": "https://github.com/owner/repo/pull/N | null",
  "siblingPrUrls": ["..."],
  "notes": "anything the operator should know (optional)"
}
```

If the pipeline stopped before opening a PR (developer failure, validation failure, push failure), set `outcome` accordingly, set `prUrl` to `null`, and put the human-readable reason in `notes`. Do not throw — print the JSON.

## What this command DOES NOT do (intentional)

- **Never runs `gh pr merge`.** Per CLAUDE.md, only humans merge.
- **Never runs `git push --force`.** If push fails, asks the operator.
- **Never edits `.ai-sdlc/**` or `.github/workflows/**`.** PreToolUse hook blocks anyway, but the developer prompt makes this explicit.
- **Never auto-resolves rebase conflicts.** Step 10.5 aborts with `outcome: aborted` on conflict; the operator owns conflict resolution.
- **Never spawns more than one developer pipeline per `/ai-sdlc execute` invocation.** Parallel runs come from the operator (or `/loop`) firing the slash command multiple times — each invocation gets its own Claude Code session-scoped pipeline run.
