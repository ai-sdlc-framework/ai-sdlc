---
name: triage
description: Score and triage an issue with the RFC-0008 admission composite (PPA + pillar breakdown). Auto-detects GitHub or Backlog.md.
argument-hint: <issue-id>
allowed-tools: Read, Grep, Glob, Bash, mcp__backlog__task_view
---

Triage issue `$ARGUMENTS` by running it through `@ai-sdlc/orchestrator`'s
admission composite — the RFC-0008 §A.6 implementation
(`P_admission = SA × D-pi_adjusted × ER × (1 + HC)` with pillar
breakdown and tension flags). The orchestrator already does the math;
this skill's job is to detect the tracker, fetch the issue, normalize
it into `AdmissionInput`, and present the result.

## Step 1 — Detect the tracker

Inspect the form of `$ARGUMENTS`:

- **Backlog.md** when the id matches `^[A-Za-z][A-Za-z0-9]*-\d+$` (e.g. `AISDLC-42`, `task-7`, `INGEST-101`)
- **GitHub** when the id is `\d+` or `#\d+` (e.g. `42`, `#42`)
- If ambiguous, prefer **Backlog** when `backlog/tasks/` exists in the repo, else GitHub.

Allow override: if `$ARGUMENTS` contains `--tracker gh` or `--tracker backlog`, honour that.

## Step 2 — Fetch the issue

### Backlog branch

Call `mcp__backlog__task_view` with the id. The returned task carries
`title`, `description`, `labels` (string array), `status`, `priority`,
`assignee`, `created_date`, `created_by`. Reactions and comments are
not first-class on Backlog, default both to `0`.

### GitHub branch

```bash
gh issue view <N> --json number,title,body,labels,authorAssociation,createdAt,comments,reactions \
  > /tmp/issue.json
```

Don't hardcode `--repo`. The current working directory's git remote
already drives `gh`. If the user supplies `--repo OWNER/NAME` in
`$ARGUMENTS`, pass it through.

## Step 3 — Normalize to AdmissionInput

Build the args `cli-admit` expects. Write the body to `/tmp/issue-body.txt`
(safer than shell-quoting multi-line markdown):

| AdmissionInput field | GitHub source | Backlog source |
|---|---|---|
| `--title` | `.title` | `.title` |
| `--body-file` | `.body` → `/tmp/issue-body.txt` | `.description` → `/tmp/issue-body.txt` |
| `--issue-number` | `.number` | numeric tail of the id (e.g. `42` for `AISDLC-42`) |
| `--labels` (JSON array of strings) | `.labels[].name` | `.labels` |
| `--reactions` | `(.reactions["+1"] // 0) + (.reactions.heart // 0)` | `0` |
| `--comments` | `(.comments \| length)` | `0` |
| `--created-at` | `.createdAt` | `.created_date` |
| `--author-association` | `.authorAssociation` | `OWNER` if `created_by` matches a maintainer in `.ai-sdlc/`, else `MEMBER` |
| `--author-login` | `.author.login` (if present) | `.created_by` |

For Backlog, the issue number passed to `cli-admit` is just the
numeric tail — `cli-admit` only uses it for the `itemId` provenance
string (`#42`), so cross-tracker collisions are harmless for the
score itself. Track the full id (`AISDLC-42`) separately in the report.

## Step 4 — Score with the admission composite

```bash
pnpm --filter @ai-sdlc/dogfood admit \
  --title "$TITLE" \
  --body-file /tmp/issue-body.txt \
  --issue-number "$ISSUE_NUMBER" \
  --labels "$LABELS_JSON" \
  --reactions "$REACTIONS" \
  --comments "$COMMENTS" \
  --created-at "$CREATED_AT" \
  --author-association "$AUTHOR_ASSOC" \
  --author-login "$AUTHOR_LOGIN" \
  --enrich-from-state \
  ${CODE_AREA:+--code-area "$CODE_AREA"} \
  2>/tmp/admit-stderr.txt | tail -1 > /tmp/admit-result.json
```

`--enrich-from-state` opens `.ai-sdlc/state.db` and resolves the
`DesignSystemBinding`, `DesignIntentDocument`, and `AutonomyPolicy` from
`.ai-sdlc/` — that's what wires C2 readiness, C3 defect risk, C4
autonomy factor, and C5 design-authority weight into the composite.

If `cli-admit` writes anything to `/tmp/admit-stderr.txt`, surface it
in the report — it's typically a config-load warning, not fatal.

## Step 5 — Render the result

Parse `/tmp/admit-result.json`. The shape is:

```json
{
  "admitted": true | false,
  "score": {
    "composite": 0.0,
    "dimensions": { "soulAlignment": 0.0, "demandPressure": 0.0, ... },
    "confidence": 0.0
  },
  "reason": "string",
  "pillarBreakdown": {
    "product":     { "signal": 0.0, "interpretation": "..." },
    "design":      { "signal": 0.0, "interpretation": "..." },
    "engineering": { "signal": 0.0, "interpretation": "..." },
    "shared":      { "hcComposite": { ... } },
    "tensions":    [ { "type": "PRODUCT_HIGH_DESIGN_LOW", "severity": "..." } ]
  }
}
```

Present back to the user in this exact order:

1. **Verdict line** — admitted or rejected, composite score, confidence
2. **Dimensions table** — SA, D-π, M-φ, E-ρ, E-τ, HC, C-κ
3. **Pillar breakdown** — Product / Design / Engineering signals with interpretations
4. **Tensions** — each tension flag with its type and what it means (e.g. `PRODUCT_HIGH_DESIGN_LOW` → "design system not ready for the work product wants")
5. **Reason** — the orchestrator's `reason` string
6. **Suggested labels** — derived from the verdict:
   - admitted + complexity ≤ 3 → `ai-eligible`
   - admitted + tension `PRODUCT_HIGH_DESIGN_LOW` → also `needs-design-review`
   - rejected → `needs-more-info` (low confidence) or `out-of-scope` (SA hard gate)

## Step 6 — Offer to apply labels

Don't apply labels automatically — confirm first. If the user agrees,
apply via the right tracker:

- **GitHub**: `gh issue edit <N> --add-label "$LABEL"`
- **Backlog**: use the `mcp__backlog__task_edit` MCP tool with `addLabels`. (Not in the allowed-tools above — instruct the user to run `/backlog task edit` themselves, or escalate by asking the user to enable that tool.)

## Notes

- This skill replaces the pre-RFC-0008 4-signal heuristic. The composite
  comes from `@ai-sdlc/orchestrator`; do **not** reimplement scoring in
  prose.
- If `pnpm --filter @ai-sdlc/dogfood admit` is unavailable (no Node
  workspace, no built dist), say so explicitly. Do not fall back to the
  old prose heuristic — the score wouldn't be RFC-0008 conformant and a
  silent fallback hides the gap.
- The skill is **stateless w.r.t. the tracker**: it never writes to
  GitHub or Backlog without explicit user confirmation in Step 6.
