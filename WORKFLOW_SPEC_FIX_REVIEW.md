# Fix-Review Workflow Specification

## Overview

This document specifies the required GitHub Actions workflow for the fix-review pipeline. The workflow should be created at `.github/workflows/ai-sdlc-fix-review.yml`.

## Purpose

The fix-review workflow automatically addresses review findings from AI-SDLC review agents before presenting PRs for human review. When review agents post `REQUEST_CHANGES` on an agent-created PR, this workflow re-invokes the development agent with the review findings as context.

## Workflow File

**Path**: `.github/workflows/ai-sdlc-fix-review.yml`

```yaml
name: AI-SDLC Fix Review

on:
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  issues: write
  pull-requests: write

concurrency:
  group: fix-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  fix-review:
    name: Fix Review Findings
    runs-on: ubuntu-latest
    # Only run on agent-created PRs when review requests changes
    if: >-
      github.event.review.state == 'changes_requested' &&
      startsWith(github.event.pull_request.head.ref, 'ai-sdlc/issue-')
    steps:
      - name: Check if review is from AI-SDLC agents
        id: check-reviewer
        run: |
          REVIEWER="${{ github.event.review.user.login }}"
          # Only trigger for AI-SDLC review agents, not human reviewers
          if [[ "$REVIEWER" =~ ^(ai-sdlc-.*-agent|github-actions\[bot\])$ ]]; then
            echo "is_agent=true" >> "$GITHUB_OUTPUT"
          else
            echo "is_agent=false" >> "$GITHUB_OUTPUT"
            echo "Skipping: review from human reviewer ($REVIEWER)"
          fi

      - uses: actions/checkout@v4
        if: steps.check-reviewer.outputs.is_agent == 'true'
        with:
          ref: ${{ github.event.pull_request.head.ref }}
          token: ${{ secrets.AI_SDLC_PAT }}

      - uses: pnpm/action-setup@v4
        if: steps.check-reviewer.outputs.is_agent == 'true'

      - uses: actions/setup-node@v4
        if: steps.check-reviewer.outputs.is_agent == 'true'
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
        if: steps.check-reviewer.outputs.is_agent == 'true'

      - run: pnpm build
        if: steps.check-reviewer.outputs.is_agent == 'true'

      - name: Install Claude Code CLI
        if: steps.check-reviewer.outputs.is_agent == 'true'
        run: npm install -g @anthropic-ai/claude-code

      - name: Configure git
        if: steps.check-reviewer.outputs.is_agent == 'true'
        run: |
          git config user.name "ai-sdlc[bot]"
          git config user.email "ai-sdlc-bot@users.noreply.github.com"

      - name: Run fix-review pipeline
        if: steps.check-reviewer.outputs.is_agent == 'true'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.AI_SDLC_PAT }}
          # gh CLI uses GH_TOKEN for API calls
          GH_TOKEN: ${{ secrets.AI_SDLC_PAT }}
          GITHUB_REPOSITORY_OWNER: ${{ github.repository_owner }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: |
          PR=${{ github.event.pull_request.number }}
          pnpm --filter @ai-sdlc/dogfood fix-review --pr "$PR"

      - name: Collect pipeline artifacts
        if: always() && steps.check-reviewer.outputs.is_agent == 'true'
        run: |
          mkdir -p .ai-sdlc
          cp /tmp/ai-sdlc-diagnostics-audit.jsonl .ai-sdlc/diagnostics-audit.jsonl 2>/dev/null || true

      - name: Upload pipeline artifacts
        if: always() && steps.check-reviewer.outputs.is_agent == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: ai-sdlc-fix-review-pr-${{ github.event.pull_request.number }}
          path: .ai-sdlc/
          if-no-files-found: ignore
          retention-days: 30
```

## Key Features

### Trigger Conditions

1. **Event**: `pull_request_review.submitted`
2. **State**: Only when `review.state == 'changes_requested'`
3. **Branch Pattern**: Only on branches matching `ai-sdlc/issue-*`
4. **Reviewer Filter**: Only for AI-SDLC review agents (not human reviewers)

### Retry Limit

The orchestrator implementation (`orchestrator/src/fix-review.ts`) enforces a retry limit:
- Default: 2 attempts (configurable via `Pipeline.spec.stages[].onFailure.maxRetries`)
- Uses hidden marker `<!-- ai-sdlc-fix-review-attempt -->` in comments
- When limit is reached, comments on PR and stops

### Automatic Re-Review

After the agent pushes fixes:
1. The `pull_request.synchronize` event triggers
2. The existing `ai-sdlc-review.yml` workflow runs automatically
3. Review agents re-analyze the updated code
4. Loop continues until all agents approve or retry limit is reached

### Security

- Sandboxed execution with JIT credentials
- Uses same security context as main pipeline
- Kill switch and guardrail validation apply

## Implementation Files

The following files implement the fix-review functionality:

- `orchestrator/src/fix-review.ts` - Core orchestration logic
- `orchestrator/src/fix-review.test.ts` - Unit tests
- `dogfood/src/cli-fix-review.ts` - CLI entry point
- `dogfood/src/cli-fix-review.test.ts` - CLI tests

## Configuration

The fix-review pipeline respects the following configuration:

### Pipeline Stage Configuration

```yaml
apiVersion: ai-sdlc.dev/v1
kind: Pipeline
spec:
  stages:
    - name: review
      type: review-agent
      onFailure:
        maxRetries: 2  # Max fix-review attempts (default: 2)
      timeout: 30m
```

### Notification Templates

```yaml
spec:
  notifications:
    templates:
      fix-review-success:
        title: "Fix-Review Applied"
        body: "Attempt {attempt} of {max} — pushed review fixes to `{branch}`."
      fix-review-limit:
        title: "Fix-Review Retry Limit Reached"
        body: "This PR has reached the maximum number of automated review-fix attempts ({max}). Manual intervention is needed."
      fix-review-agent-failed:
        title: "Fix-Review Agent Failed"
        body: "The agent failed to address review findings: {details}"
```

## Workflow Placement

⚠️ **Note**: This workflow file cannot be created by the agent due to blocked path constraints (`.github/workflows/**`). A human with appropriate permissions must create this file.

Once the workflow is created, the fix-review loop will be fully automated:

1. Agent creates PR
2. Review agents analyze → REQUEST_CHANGES
3. **Fix-review workflow triggers** ← NEW
4. Agent addresses findings, pushes fixes
5. Review agents re-run (via `synchronize` trigger)
6. Repeat until approved or limit reached
7. Human review (only when agents approve or limit reached)

## Testing

Test the workflow manually:

```bash
# Create a test PR with review findings
gh pr create --base main --head ai-sdlc/issue-test --title "Test fix-review"

# Post a review that requests changes (as an agent would)
gh pr review --request-changes --body "### Testing Review\n\nPlease add tests."

# Verify the fix-review workflow runs
gh run list --workflow=ai-sdlc-fix-review.yml
```

## Acceptance Criteria

- [x] Orchestrator implementation (`fix-review.ts`)
- [x] CLI wrapper (`cli-fix-review.ts`)
- [x] Unit tests for orchestrator
- [x] Unit tests for CLI
- [x] Export in orchestrator index
- [x] Package.json script
- [x] Workflow specification document
- [ ] Workflow file created at `.github/workflows/ai-sdlc-fix-review.yml` (requires manual creation)
- [ ] Integration test with actual PR review

## Related Files

- `.github/workflows/ai-sdlc-review.yml` - Review agents workflow (already exists)
- `.github/workflows/ai-sdlc-fix-ci.yml` - CI fix workflow (similar pattern)
- `orchestrator/src/fix-ci.ts` - Reference implementation
