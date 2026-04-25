---
name: fix-pr
description: Fix CI failures and review findings on a PR by chaining cli-fix-ci + cli-fix-review
argument-hint: <pr-number>
allowed-tools: Read, Grep, Glob, Bash
---

Fix PR #$ARGUMENTS by chaining `@ai-sdlc/orchestrator`'s `executeFixCI()`
and `executeFixReview()` in priority order. Both already implement
retry tracking via `RETRY_MARKER` comments (capped at
`MAX_FIX_ATTEMPTS = 3` and `MAX_REVIEW_FIX_ATTEMPTS = 2`), branch-name
sanitization, and PR-number validation — this skill's job is to wire
them up, not reimplement the recipe.

## Step 1 — Gather PR context

Don't hardcode `--repo`. The cwd's git remote drives `gh`.

```bash
PR=$ARGUMENTS

gh pr view "$PR" --json number,title,headRefName,body,state,statusCheckRollup \
  > /tmp/pr.json

# Most recent failed CI run on the PR head ref (drives cli-fix-ci's --run-id)
HEAD_SHA=$(gh pr view "$PR" --json headRefOid --jq '.headRefOid')
RUN_ID=$(gh run list --commit "$HEAD_SHA" --status failure --limit 1 --json databaseId --jq '.[0].databaseId // empty')
```

If `RUN_ID` is empty, there are no failing CI runs on the head SHA —
skip Step 2.

## Step 2 — Fix CI failures (if any)

```bash
if [ -n "$RUN_ID" ]; then
  pnpm --filter @ai-sdlc/dogfood fix-ci \
    --pr "$PR" \
    --run-id "$RUN_ID" \
    > /tmp/fix-ci.json 2>/tmp/fix-ci.stderr
fi
```

`executeFixCI` checks the `<!-- ai-sdlc-fix-ci-attempt -->` marker
comments on the PR and refuses to retry past `MAX_FIX_ATTEMPTS`. If it
hits the cap, surface the message — don't paper over it.

## Step 3 — Fix review findings

`executeFixReview` reads the latest review on the PR, filters by
severity, and pushes a fix commit. It also tracks
`<!-- ai-sdlc-fix-review-attempt -->` markers and caps at
`MAX_REVIEW_FIX_ATTEMPTS = 2`.

```bash
pnpm --filter @ai-sdlc/dogfood fix-review \
  --pr "$PR" \
  > /tmp/fix-review.json 2>/tmp/fix-review.stderr
```

If the latest review state is `APPROVED` with no findings, this is a
no-op — surface that.

## Step 4 — False-positive triage

If `cli-fix-review` reports a finding the user disagrees with, the
right move is to update `.ai-sdlc/review-policy.md` with a more
specific calibration rule, **not** to fix the non-issue. The
orchestrator's `ReviewFeedbackStore` learns from these calibration
updates.

The skill should:
- Not edit `.ai-sdlc/review-policy.md` automatically
- Instead surface the finding and say "to suppress this finding, add a rule to `.ai-sdlc/review-policy.md`. Want me to draft one?"

## Step 5 — Verify locally

After both wrappers complete, run the verification suite locally if
the workspace allows it:

```bash
pnpm build && pnpm test && pnpm lint && pnpm format:check
```

If any of these fail, the wrappers' fixes were incomplete — surface
the failure and stop. Do not push partial fixes.

## Step 6 — Report

Present:

- What was fixed by `executeFixCI` (commit SHA, files changed)
- What was fixed by `executeFixReview` (commit SHA, findings addressed)
- What was identified as a false positive
- Whether retry caps were hit (`MAX_FIX_ATTEMPTS` / `MAX_REVIEW_FIX_ATTEMPTS`)
- Local verification status (build / test / lint / format)
- What the human still needs to review

## Step 7 — Never merge

Do **not** run `gh pr merge`. The skill fixes and surfaces; humans merge.
This is a hard rule from CLAUDE.md.

## Notes

- The skill replaces the prior prose recipe. Do **not** reimplement
  the categorization / fix-priority logic in markdown — the
  orchestrator's `executeFixCI` and `executeFixReview` are the source
  of truth, and they preserve retry semantics that the prose version
  cannot.
- If `pnpm --filter @ai-sdlc/dogfood fix-ci` or `fix-review` is
  unavailable, say so. Do not fall back to inline manual fixing —
  that loses the retry-marker dedupe and could re-attempt a fix that
  has already failed twice.
