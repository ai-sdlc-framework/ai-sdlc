---
name: triage
description: Score and triage an issue with the RFC-0008 admission composite (PPA + pillar breakdown). Auto-detects GitHub or Backlog.md.
argument-hint: <issue-id>
allowed-tools: Read, Grep, Glob, Bash, mcp__backlog__task_view
---

Triage issue `$ARGUMENTS` by running it through `@ai-sdlc/orchestrator`'s
admission composite — the RFC-0008 §A.6 implementation
(`P_admission = SA × D-pi_adjusted × ER × (1 + HC)` with pillar
breakdown and tension flags). The orchestrator does the math; this
skill's job is to detect the tracker, resolve the right config root,
invoke `cli-admit`, and present the result with full provenance.

## Step 1 — Detect the tracker

Inspect the form of `$ARGUMENTS`:

- **Backlog.md** when the id matches `^[A-Za-z][A-Za-z0-9]*-\d+$` (e.g. `AISDLC-42`, `task-7`, `INGEST-101`)
- **GitHub** when the id is `\d+` or `#\d+` (e.g. `42`, `#42`)
- If ambiguous, prefer **Backlog** when `backlog/tasks/` exists in the repo, else GitHub.

Allow override: if `$ARGUMENTS` contains `--tracker github` or `--tracker backlog`, honour that.

## Step 2 — Resolve the config root

Cross-repo confusion is the #1 silent failure. Explicitly pin the
config root before fetching the issue:

- **Backlog**: walk up from the task file's directory (or repo cwd) until `.ai-sdlc/` is found. That's the config root.
- **GitHub**: walk up from cwd. If `gh pr view`'s remote URL points at a different repo than the cwd, surface a warning and ask the user to confirm or pass `--config-root <path>`.

Pass that path through to every `cli-admit` call as `--config-root`. The
CLI also auto-walks but explicit pinning eliminates ambiguity in the
report.

## Step 3 — Fetch + score

### Backlog branch

`cli-admit` parses the task file directly — no separate fetch step.
Call `mcp__backlog__task_view` only if you need to render the task
title/body to the user before scoring.

```bash
ID=$ARGUMENTS
CONFIG_ROOT=...   # from Step 2

pnpm --filter @ai-sdlc/dogfood admit \
  --tracker backlog \
  --task-id "$ID" \
  --config-root "$CONFIG_ROOT" \
  --enrich-from-state \
  > /tmp/admit.json 2> /tmp/admit-provenance.json
```

The Backlog adapter does the label/AC/quality-flag mapping internally
(`priority:p*`, `size:[SML]`, `track:*`, `source:*`, `Done`-with-unchecked-ACs
zombie close, etc.). You don't fan signals out by hand.

### GitHub branch

Use the OS tmp dir for the body file (the safe-path guard accepts
`/tmp` on macOS/Linux and `os.tmpdir()` on any platform). Don't
hardcode `--repo`; if the cwd's git remote and the issue's repo
differ, the orchestrator will warn — surface that.

```bash
N=$ARGUMENTS
TMPDIR_REAL=${TMPDIR:-/tmp}

gh issue view "$N" --json number,title,body,labels,authorAssociation,createdAt,comments,reactions \
  > "$TMPDIR_REAL/issue.json"

jq -r '.body' "$TMPDIR_REAL/issue.json" > "$TMPDIR_REAL/issue-body.txt"
TITLE=$(jq -r '.title' "$TMPDIR_REAL/issue.json")
LABELS=$(jq -c '[.labels[].name]' "$TMPDIR_REAL/issue.json")
REACTIONS=$(jq '(.reactions["+1"] // 0) + (.reactions.heart // 0)' "$TMPDIR_REAL/issue.json")
COMMENTS=$(jq '.comments | length' "$TMPDIR_REAL/issue.json")
CREATED_AT=$(jq -r '.createdAt' "$TMPDIR_REAL/issue.json")
ASSOC=$(jq -r '.authorAssociation' "$TMPDIR_REAL/issue.json")
AUTHOR=$(jq -r '.author.login // empty' "$TMPDIR_REAL/issue.json")

pnpm --filter @ai-sdlc/dogfood admit \
  --tracker github \
  --title "$TITLE" \
  --body-file "$TMPDIR_REAL/issue-body.txt" \
  --issue-number "$N" \
  --labels "$LABELS" \
  --reactions "$REACTIONS" \
  --comments "$COMMENTS" \
  --created-at "$CREATED_AT" \
  --author-association "$ASSOC" \
  ${AUTHOR:+--author-login "$AUTHOR"} \
  --config-root "$CONFIG_ROOT" \
  --enrich-from-state \
  > /tmp/admit.json 2> /tmp/admit-provenance.json
```

## Step 4 — Render the result

Parse `/tmp/admit.json` (the verdict) and `/tmp/admit-provenance.json`
(the resolved enrichment context). The shape is:

```json
{
  "admitted": true | false,
  "score": { "composite": 0.0, "dimensions": { ... }, "confidence": 0.0 },
  "reason": "string",
  "pillarBreakdown": {
    "product":     { "signal": 0.0, "interpretation": "..." },
    "design":      { "signal": 0.0, "interpretation": "..." },
    "engineering": { "signal": 0.0, "interpretation": "..." },
    "shared":      { "hcComposite": { ... } },
    "tensions":    [ { "type": "...", "severity": "..." } ]
  },
  "qualityFlags": [
    { "kind": "unchecked-acs-on-done", "detail": "...", "severity": "high" }
  ]
}
```

Provenance (`/tmp/admit-provenance.json`) carries the resolved
context — emit it FIRST so cross-repo confusion is impossible to miss:

```
## Provenance
Tracker:                backlog
Config root:            /Users/.../forge   (resolved from --config-root)
DesignSystemBinding:    forge-ds
DesignIntentDocument:   forge-did
AutonomyPolicy:         forge-autonomy
```

Then in this order:

1. **Verdict line** — admitted/rejected, composite, confidence
2. **Dimensions table** — SA, D-π, M-φ, E-ρ, E-τ, HC, C-κ
3. **Pillar breakdown** — Product / Design / Engineering signals
4. **Tensions** — each flag with type + interpretation
5. **Quality concerns** — when `qualityFlags[]` is non-empty, list each with severity and the one-liner explanation of how it affected the score (e.g. zombie close → defectRiskFactor +0.15)
6. **Reason** — the orchestrator's `reason` string
7. **Suggested labels** — derived from the verdict (admitted + complexity ≤ 3 → `ai-eligible`; tension `PRODUCT_HIGH_DESIGN_LOW` → `needs-design-review`; rejected → `needs-more-info` or `out-of-scope`)

## Step 5 — Offer to apply labels

Don't apply labels automatically — confirm first. If the user agrees,
apply via the right tracker:

- **GitHub**: `gh issue edit <N> --add-label "$LABEL"`
- **Backlog**: ask the user to run `mcp__backlog__task_edit` themselves (it's intentionally not in `allowed-tools` here).

## Notes

- The Backlog adapter (`mapBacklogTaskToAdmissionInput`) is the source
  of truth for Backlog → AdmissionInput mapping. Do **not** restate
  the label table in prose — refer to the adapter.
- If `pnpm --filter @ai-sdlc/dogfood admit` is unavailable (no Node
  workspace, no built dist), say so explicitly. Do not fall back to a
  prose heuristic.
- The skill never writes to GitHub or Backlog without explicit user
  confirmation in Step 5.
