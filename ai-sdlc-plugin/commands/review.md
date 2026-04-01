---
name: review
description: Run AI-SDLC review agents on a pull request
argument-hint: <pr-number>
allowed-tools: Read,Grep,Glob,Bash
---

Run a comprehensive code review on PR #$ARGUMENTS using three review perspectives.

## Step 1: Gather PR context

```bash
# Get the PR diff
gh pr diff $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc > /tmp/pr-diff.txt

# Get PR details
gh pr view $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc --json title,body,headRefName,changedFiles
```

## Step 2: Load review policy

Read `.ai-sdlc/review-policy.md` for calibration context. Apply the golden rule: "When in doubt, approve with a suggestion — do not request changes."

## Step 3: Review from three perspectives

### Testing Review
- Are new/changed functions covered by tests?
- Do tests cover edge cases and error paths?
- Are test assertions meaningful (not just checking truthiness)?
- Defer coverage percentages to codecov — do NOT guess coverage numbers.

### Code Quality Review
- Are there logic errors, off-by-one bugs, or incorrect assumptions?
- Is the code readable and following project conventions?
- Are there unnecessary abstractions or missing error handling?
- Check naming, file organization, and import structure.

### Security Review
- Check for injection vulnerabilities (command, SQL, XSS)
- Look for hardcoded secrets, credentials, or API keys
- Verify input validation at system boundaries
- Check for path traversal, SSRF, and deserialization issues

## Step 4: Report findings

For each finding, provide:
- **Severity**: critical, major, minor, or suggestion
- **File and line**: exact location in the diff
- **Description**: what the issue is and why it matters
- **Recommendation**: how to fix it

Only report issues you are confident are real problems. If you cannot describe a concrete failure scenario, downgrade to suggestion.

**IMPORTANT: Do NOT merge the PR. Only review and report findings.**
