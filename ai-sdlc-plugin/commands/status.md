---
name: status
description: Show AI-SDLC pipeline status for the current branch or a specific issue/task
argument-hint: [issue-id]
allowed-tools: Read, Bash, mcp__backlog__task_view
---

Show the current AI-SDLC pipeline status. Auto-detects the issue
tracker the same way the `triage` skill does — Backlog.md or GitHub.

## Step 1 — Detect mode

- If `$ARGUMENTS` is empty → **branch mode** (look up open PRs on the
  current branch)
- If `$ARGUMENTS` matches `^[A-Za-z][A-Za-z0-9]*-\d+$` (e.g.
  `AISDLC-42`) → **Backlog task mode**
- If `$ARGUMENTS` is `\d+` or `#\d+` → **GitHub issue mode**

Don't hardcode `--repo`. The cwd's git remote drives `gh`.

## Step 2a — Branch mode (no argument)

```bash
BRANCH=$(git branch --show-current)
echo "Branch: $BRANCH"

PR_NUM=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number // empty')
if [ -n "$PR_NUM" ]; then
  gh pr view "$PR_NUM" --json number,title,state,statusCheckRollup,reviews
  gh pr checks "$PR_NUM"
else
  echo "No open PR on this branch."
fi
```

## Step 2b — GitHub issue mode

```bash
gh issue view "$ARGUMENTS" --json number,title,state,labels,assignees

# Find linked PRs via "Closes #N" / "Fixes #N" backlinks
gh pr list --search "linked:$ARGUMENTS" --json number,title,state,headRefName,statusCheckRollup
```

## Step 2c — Backlog task mode

Use `mcp__backlog__task_view` with id `$ARGUMENTS`. The task carries
`title`, `status`, `labels`, `priority`, `assignee`. Map `status` to a
pipeline stage:

| Backlog status | Pipeline stage |
|---|---|
| `Draft` | not yet ready (missing AC) |
| `To Do` | admitted, awaiting agent |
| `In Progress` | agent working |
| `Done` (still in `backlog/tasks/`) | closing — needs `task_complete` |
| File in `backlog/completed/` | closed |

Then look for a PR that mentions the task id in its body or branch name:

```bash
gh pr list --search "$ARGUMENTS in:title,body" --json number,title,state,statusCheckRollup
```

## Step 3 — Report

Present a clear status summary:

- **Issue / task** — title, state/status, labels (which pipeline stage)
- **PR** — number, state, CI checks (pass/fail/pending), review state
- **Coverage** — codecov status if available (`gh pr checks` output already includes it)
- **Next action** — what needs to happen next:
  - CI failing → "run `/fix-pr <N>`"
  - Reviews requesting changes → "run `/fix-pr <N>`" or "address review findings"
  - All green → "ready for human merge"
  - Backlog task in `Done` but file still in `backlog/tasks/` → "run `mcp__backlog__task_complete` to archive"

## Notes

- Status is presentation, not orchestration. Don't try to invoke
  `cli-admit` or any other scoring CLI from this skill — that's the
  triage skill's job.
- Don't apply labels or change status. Status is read-only.
