---
name: triage
description: Score and triage a GitHub issue using the Product Priority Algorithm (PPA)
argument-hint: <issue-number>
allowed-tools: Read,Grep,Glob,Bash
---

Triage issue #$ARGUMENTS by scoring it with the Product Priority Algorithm and recommending a routing strategy.

## Step 1: Gather issue context

```bash
gh issue view $ARGUMENTS --repo ai-sdlc-framework/ai-sdlc --json title,body,labels,author,createdAt,comments
```

## Step 2: Score with PPA signals

Evaluate these signals (0-1 scale each):

- **Conviction**: How well-defined is the problem? Clear reproduction steps? Specific files referenced?
- **Demand**: How many users affected? Comments/reactions? Related issues?
- **Consensus**: Alignment with project roadmap? Related to known priorities?
- **Effort**: Estimated complexity (1=trivial, 10=massive rewrite)

Weight by author trust level:
- `OWNER`/`MEMBER`/`COLLABORATOR`: baseline conviction=0.3, demand=0.2, consensus=0.2
- External contributors: need external validation signals

## Step 3: Complexity assessment

Estimate task complexity (1-10):
- **1-3**: Simple bug fix, config change, docs update → AI-eligible
- **4-6**: Moderate feature, multi-file refactor → AI with review
- **7-10**: Architectural change, new subsystem → Human-led

## Step 4: Recommend routing

Based on PPA score and complexity:
- **Score > 0.3 AND complexity 1-3**: Auto-route to AI agent (`ai-eligible` label)
- **Score > 0.3 AND complexity 4-6**: Route to AI with human review
- **Score > 0.3 AND complexity 7+**: Flag for human lead
- **Score < 0.3**: Needs more information or demand signals

## Step 5: Report

Present the triage assessment:
- PPA score breakdown (conviction, demand, consensus, effort)
- Complexity rating with justification
- Recommended routing strategy
- Suggested labels to add
