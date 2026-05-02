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

Execute backlog task `$ARGUMENTS` end-to-end. The Step 0-13 pipeline below runs inline in the main Claude Code session — worktree creation, developer subagent fan-out, 3 parallel reviewer subagents, attestation signing, PR open.

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
7. **Never write GitHub Actions CI-skip magic tokens into commit messages (AISDLC-88).** GitHub Actions parses five literal substrings — `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` — case-insensitively, and SUPPRESSES every workflow on commits that carry any of them. That silently disables verify-attestation, ai-sdlc-review, and the CI-side attestor in one stroke. If you genuinely need to mention these tokens in a commit body, use the **paren-quoted form**: `(skip ci marker)` instead of `[skip ci]`. Backtick-wrapping (`` `[skip ci]` ``) does NOT defeat the parser — the literal bracketed substring is still present. The `.husky/pre-push` `check-skip-ci-marker.sh` gate (AISDLC-88) blocks pushes that violate this; only the AISDLC-87 CI-side attestor's own `chore(ci): sign review attestation [skip ci]` commit (authored by `ai-sdlc-ci-attestor[bot]` per `.github/workflows/ai-sdlc-review.yml`; legacy `github-actions[bot]` retained as a fallback) is exempt. Step 10 below additionally sanitises any leaked tokens out of the chore-commit body before staging, as defense-in-depth.

## Hard dependency — per-worktree sentinel (AISDLC-81)

Step 4 below writes the active-task sentinel at `<worktree>/.active-task` (per-worktree), NOT at the legacy project-level `.worktrees/.active-task` path. This is what makes parallel runs safe across multiple `/ai-sdlc execute` invocations (each in its own Claude Code session): each session gets its own sentinel, and the PreToolUse hook walks up from the developer subagent's cwd to find the right one. The legacy project-level sentinel is no longer written here (the hook still falls back to it for one release for backwards compatibility, deprecated for v0.9.0+).

If you find yourself trying to write `.worktrees/.active-task` at the project root, stop — that's the wrong path and would race with parallel runs.

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

> **Parallel-runs note.** Step 0 races benignly across concurrent `/ai-sdlc execute` invocations (each in its own Claude Code session): `git worktree remove --force` is idempotent and the second invocation simply prints nothing for the already-swept entry. There's no shared mutable state to protect.

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
PREFLIGHT_OUT=$(pnpm --filter @ai-sdlc/pipeline-cli exec cli-deps preflight "$TASK_ID" --work-dir "$(pwd)" 2>&1)
PREFLIGHT_EXIT=$?
if [ "$PREFLIGHT_EXIT" -ne 0 ]; then
  echo "ERROR: dependency preflight failed for $TASK_ID:"
  echo "$PREFLIGHT_OUT"
  echo ""
  echo "To inspect the dispatch-ready frontier instead: pnpm --filter @ai-sdlc/pipeline-cli exec cli-deps frontier --format table"
  exit 1
fi
```

This step is fail-closed: if `cli-deps` itself errors (binary not built, broken JSON, etc.) the slash command still aborts rather than dispatching blindly. Run `pnpm --filter @ai-sdlc/pipeline-cli build` if the binary is missing.

### Step 1.6 — Frontier consultation (operator hint, AISDLC-117)

For `/loop /ai-sdlc execute` runs (and ad-hoc multi-task dispatch), the operator should consult the dispatch-ready frontier before picking a candidate rather than relying on instinct. This is the same data the AISDLC-117 task description called out as the cure for "manual dependency tracing":

```bash
pnpm --filter @ai-sdlc/pipeline-cli exec cli-deps frontier --format table
```

If `$TASK_ID` is on the printed list (or independent of the listed items), proceed. If not, the task's blockers are still open — `cli-deps blockers $TASK_ID --format table` lists what to ship first. The loop driver SHOULD prefer frontier tasks; the slash command body's Step 1.5 is the hard gate that refuses non-ready tasks regardless of where the dispatch decision came from.

## Step 2 — Compute branch name

The branch pattern lives in `.ai-sdlc/pipeline-backlog.yaml` under `branching.pattern`. Today it's `ai-sdlc/{issueIdLower}-{slug}` where `{slug}` is a kebab-cased version of the task title.

```bash
BRANCH_PATTERN=$(grep -A2 'branching:' .ai-sdlc/pipeline-backlog.yaml | grep 'pattern:' | sed -E "s/.*pattern: *'([^']+)'.*/\1/")
TITLE=$(grep -E '^title:' "$TASK_FILE" | sed -E 's/title: *"?([^"]+)"?/\1/')
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-50)
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

CRITICAL: this file MUST be deleted at end of run (Step 13) regardless of success/failure, otherwise a future invocation reading the worktree (e.g. `/ai-sdlc cleanup` or another execute that re-uses the path) inherits the stale active task. Treat it as a try/finally — if anything fails between here and Step 13, still delete.

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

Spawn **three subagents in parallel** (single message, three Agent tool calls):

- `subagent_type: code-reviewer`
- `subagent_type: test-reviewer`
- `subagent_type: security-reviewer`

Each prompt should contain:

- The PR diff (from `/tmp/pr-diff-${TASK_ID}.txt`)
- The task title, description, AC list
- Contents of `.ai-sdlc/review-policy.md` if present (project-specific calibration)
- The branch name + base (`main`)

Each returns a verdict JSON: `{ approved, findings, summary }`.

> **Reviewer concurrency at scale.** N parallel `/ai-sdlc execute` runs each spawn 3 reviewer subagents in parallel, so the worst-case concurrent reviewer count is `3N`. Reviewers are read-only (`disallowedTools: [Edit, Write, Bash?]`) and the only shared resource is the file system, which is safe for concurrent reads. The husky `pre-push` hook (in `.husky/pre-push`) does serialise across runs if multiple finish at the same moment, but the per-run review fan-out itself does not block on anything cross-run.

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
3. **Call `mcp__plugin_ai-sdlc_ai-sdlc__task_edit`** with `id: $TASK_ID`, `status: 'Done'`, `acceptanceCriteriaCheck: [...]`, `finalSummary: '...'`.
4. **Call `mcp__plugin_ai-sdlc_ai-sdlc__task_complete`** with `id: $TASK_ID` — this physically moves `backlog/tasks/<file>.md` → `backlog/completed/<file>.md`.
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
   # The helper does this in one call (it imports buildPredicate +
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

6. **Stage and commit the move + attestation** in the worktree as a separate chore commit so the developer's commit stays clean.

   Before composing the commit message, **sanitise any GitHub Actions CI-skip magic tokens** out of every interpolated value (`$TASK_ID`, the developer summary, etc.) — see Hard Rule 7 above. The five literal tokens GH Actions parses are `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` (case-insensitive). The chore-commit message we author here MUST NOT contain any of them — `verify-attestation.yml` and `ai-sdlc-review.yml` need to fire on this very commit. Replace each occurrence with its paren-quoted equivalent (`[skip ci]` → `(skip ci marker)`) before piping into `git commit -m`. The `.husky/pre-push` gate (`scripts/check-skip-ci-marker.sh`, AISDLC-88) is the belt-and-braces backstop, but Step 10 catches it cheaper.

   ```bash
   cd "$WORKTREE_PATH"
   git add backlog/tasks backlog/completed .ai-sdlc/attestations

   # AISDLC-88: sanitise the chore-commit message body. The five magic
   # tokens GH Actions parses are listed above. We use `sed -E` to
   # rewrite any literal occurrences (case-insensitive) into the
   # paren-quoted form before `git commit -m`. This is defense-in-depth
   # for the prompt rule (Hard Rule 7): even if upstream user-provided
   # text leaks one of the tokens, the chore commit itself stays clean
   # so verify-attestation.yml + ai-sdlc-review.yml fire on it.
   CHORE_BODY="chore: mark $TASK_ID complete

   Auto-generated by /ai-sdlc execute. Reviews approved; task lifecycle landed in this PR.
   Signed review attestation included at .ai-sdlc/attestations/<head-sha>.dsse.json
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

When the PR merges, the file is already in `backlog/completed/` on `main` — no race with the post-merge workflow. The attestation file stays in the repo as audit trail (~1-2KB per PR; not a secret — the private key never left the contributor's machine).

## Step 11 — Push and open PR

```bash
cd "$WORKTREE_PATH"
git push -u origin "$BRANCH"
```

If push fails with non-fast-forward (someone else pushed to the same branch), abort with `outcome: aborted` and populate `notes` for the user (e.g. "non-fast-forward push to `$BRANCH`; cleanup is to delete the remote branch and rerun, but that's destructive — confirm with the operator first"). Do NOT force-push, do NOT delete the remote branch yourself.

> **Husky `pre-push` serialises across parallel runs.** When N concurrent `/ai-sdlc execute` invocations all reach Step 11 at roughly the same moment, the husky `pre-push` hook (a flock-based serialiser in `.husky/pre-push`) ensures only one push is in flight at a time. This keeps the local git index from being clobbered, but does NOT serialise the rest of the pipeline — Steps 5-10 still run fully in parallel across runs.

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

- Task: `$TASK_ID` — `<title>`
- Branch: `$BRANCH` (worktree at `$WORKTREE_PATH`)
- Developer: `<N>` files, commit `<sha>`
- Reviews: `<APPROVED | NEEDS HUMAN ATTENTION>` — `<N>` critical, `<N>` major, `<N>` minor across 3 reviewers (`<HARNESS_NOTE if any>`)
- Iterations: `<N>` (capped at 2)
- PR: `<url>`
- Sibling PRs (if any): `<url>` for each
- Worktree retained for inspection. Will be auto-removed on next `/ai-sdlc execute` once this PR merges.

## Return value (printed to the user)

After Step 13, print a JSON object summarising the run so the operator (or a wrapping `/loop`) can render or post-process:

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
