---
name: status
description: Show AI-SDLC pipeline status for the current branch or a specific issue
argument-hint: [issue-number]
allowed-tools: Read,Bash
---

Show the current AI-SDLC pipeline status.

## If an issue number is provided ($ARGUMENTS)

```bash
# Get issue details and labels
gh issue view $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc --json title,state,labels,assignees

# Find linked PRs
gh pr list --repo ai-sdlc-framework/ai-sdlc --search "Closes #$ARGUMENTS OR Fixes #$ARGUMENTS" --json number,title,state,headRefName,statusCheckRollup
```

## If no issue number (check current branch)

```bash
# Get current branch
git branch --show-current

# Check for open PRs on this branch
gh pr list --repo ai-sdlc-framework/ai-sdlc --head $(git branch --show-current) --json number,title,state,statusCheckRollup,reviews

# Show recent CI status
gh pr checks $(gh pr list --repo ai-sdlc-framework/ai-sdlc --head $(git branch --show-current) --json number --jq '.[0].number') --repo ai-sdlc-framework/ai-sdlc 2>/dev/null || echo "No open PR on this branch"
```

## Report

Present a clear status summary:
- **Issue**: title, state, labels (which pipeline stage)
- **PR**: number, state, CI checks (pass/fail/pending)
- **Reviews**: approved/changes-requested/pending
- **Coverage**: codecov status if available
- **Next action**: what needs to happen next (fix CI, address reviews, ready to merge, etc.)
