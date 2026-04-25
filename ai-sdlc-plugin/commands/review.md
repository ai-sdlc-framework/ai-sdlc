---
name: review
description: Run AI-SDLC review agents on a pull request (testing + critic + security)
argument-hint: <pr-number>
allowed-tools: Read, Grep, Glob, Bash
---

Review PR #$ARGUMENTS by invoking `@ai-sdlc/orchestrator`'s
`executeReview()` for the three review perspectives. The orchestrator
already drives the LLM-based `ReviewAgentRunner` and applies the
meta-review pass that filters medium-confidence findings; this skill's
job is to fetch context, fan out to the three review types, and
present the structured verdicts.

## Step 1 — Fetch PR context

Don't hardcode `--repo` — let the cwd's git remote drive `gh`.

```bash
PR=$ARGUMENTS

# Diff + metadata for the review agents
gh pr diff "$PR" > /tmp/pr-diff.txt
gh pr view "$PR" --json number,title,body,headRefName,changedFiles > /tmp/pr.json

# Linked issue (if any) — feeds acceptance-criteria extraction
LINKED=$(gh pr view "$PR" --json body --jq '
  (.body | scan("(?i)(?:closes|fixes|resolves)\\s+#([0-9]+)"))[0][0] // empty
')
if [ -n "$LINKED" ]; then
  gh issue view "$LINKED" --json number,title,body > /tmp/issue.json
fi
```

If there's no linked issue, omit `--issue-file` from the calls below —
`cli-review` falls back to the PR title/body.

## Step 2 — Run the three review types

```bash
for TYPE in testing critic security; do
  pnpm --filter @ai-sdlc/dogfood review \
    --pr "$PR" \
    --diff-file /tmp/pr-diff.txt \
    --type "$TYPE" \
    ${LINKED:+--issue-file /tmp/issue.json} \
    > "/tmp/review-$TYPE.json" 2>"/tmp/review-$TYPE.stderr"
done
```

Each call writes a structured `ReviewVerdict` JSON to its own file:

```json
{
  "approved": true | false,
  "findings": [
    { "severity": "critical"|"major"|"minor"|"suggestion",
      "file": "path",
      "line": 42,
      "message": "string" }
  ],
  "summary": "string"
}
```

If any of the three calls writes to stderr, surface it — typically a
config issue, not a true review failure.

## Step 3 — Present verdicts

For each review type in order (testing, critic, security):

1. Header line — `Testing: APPROVED with 2 suggestions` or `Critic: CHANGES REQUESTED — 1 critical, 3 major`
2. Summary — the orchestrator's `summary` string
3. Findings — only critical and major; minor and suggestion go in a collapsed list

End with a combined verdict line:

- **All three approved** → `READY TO MERGE` (but never run `gh pr merge` — see Step 5)
- **Any critical** → `BLOCKED — fix critical findings`
- **Major findings only** → `CHANGES REQUESTED — see findings above`
- **Suggestions only** → `APPROVED with suggestions` (per the golden rule from `.ai-sdlc/review-policy.md`: when in doubt, approve with a suggestion)

## Step 4 — Calibration context

Read `.ai-sdlc/review-policy.md` if it exists and apply its calibration
overrides to the verdicts. The orchestrator already filters
medium-confidence findings via the meta-review pass; the policy file
captures additional project-specific guidance (e.g. "do not flag
unused `_var` parameters").

If you suppress a finding because it matches a policy rule, say so
explicitly — `(suppressed by .ai-sdlc/review-policy.md: <rule>)`.

## Step 5 — Never merge

Do **not** run `gh pr merge` regardless of verdict. The skill reports;
humans merge. This is a hard rule from CLAUDE.md.

## Notes

- The skill replaces the prior prose review prompts. Do **not**
  reimplement the three review checklists in markdown — the orchestrator's
  `ReviewAgentRunner` is the source of truth for review prompts.
- If `pnpm --filter @ai-sdlc/dogfood review` is unavailable (no Node
  workspace, no built dist), say so explicitly. Do not fall back to
  inline review prose — that would skip the meta-review filter and
  produce non-conformant verdicts.
- For a focused subset (e.g. only security), pass `--type security` to
  the loop variable directly — the wrapper supports a single type.
