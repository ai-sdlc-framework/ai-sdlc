---
name: fix-pr
description: Automatically fix CI failures, review findings, and coverage issues on a PR
argument-hint: <pr-number>
---

Fix all issues on PR #$ARGUMENTS. Follow these steps exactly:

## Step 1: Gather PR context

Run these commands to collect all failure information:

```bash
# Get PR details
gh pr view $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc --json title,headRefName,body,state

# Get CI check status
gh pr checks $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc

# Get review agent findings (latest review)
gh pr view $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc --json reviews --jq '.reviews[-1].body'

# Get codecov patch details
gh api repos/ai-sdlc-framework/ai-sdlc/commits/$(gh pr view $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc --json headRefOid --jq '.headRefOid')/check-runs --jq '.check_runs[] | select(.name | contains("codecov")) | {name: .name, conclusion: .conclusion, summary: .output.summary[0:500]}'

# Get CI failure logs if build/test failed
gh pr checks $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc 2>&1 | grep "fail" | head -5
```

## Step 2: Checkout the PR branch

```bash
gh pr checkout $ARGUMENTS
```

## Step 3: Analyze and categorize issues

Categorize each issue as:
- **CI failure** — build error, test failure, lint error, format error
- **Review finding (real)** — legitimate bug, missing test, security issue
- **Review finding (false positive)** — matches a pattern in `.ai-sdlc/review-policy.md`
- **Coverage gap** — new lines not covered by tests

For false positives: update `.ai-sdlc/review-policy.md` with more specific calibration instead of fixing non-issues.

## Step 4: Fix issues in priority order

1. **CI failures first** — build must pass before anything else
2. **Coverage gaps** — write missing tests
3. **Real review findings** — fix legitimate bugs/issues
4. **Format/lint** — run `pnpm lint` and `pnpm format:check`, fix any issues

## Step 5: Verify fixes locally

```bash
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

ALL of these must pass before committing.

## Step 6: Commit and push

```bash
git add <specific files>
git commit -m "fix: address CI failures and review findings on PR #$ARGUMENTS"
git push
```

## Step 7: Report status

After pushing, report:
- What was fixed
- What was identified as a false positive (and if the review policy was updated)
- What the user needs to review

**IMPORTANT: Do NOT merge the PR. Only fix and push. The human merges.**
