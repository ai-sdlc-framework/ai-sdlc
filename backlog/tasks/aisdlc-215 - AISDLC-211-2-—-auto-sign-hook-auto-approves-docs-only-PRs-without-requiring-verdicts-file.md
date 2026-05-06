---
id: AISDLC-215
title: >-
  AISDLC-211 #2 — auto-sign hook auto-approves docs-only PRs without requiring
  verdicts file
status: To Do
assignee: []
created_date: '2026-05-06 13:54'
labels:
  - bug
  - attestation
  - ci
  - framework-bug
dependencies:
  - AISDLC-206
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Decomposed from AISDLC-211 (root cause #2)

Docs-only PRs don't get reviewer fan-out (no real code to review), so no verdicts file gets written. `scripts/check-attestation-sign.sh` requires `<worktree>/.ai-sdlc/verdicts/<task-id>.json` to exist; without it, no auto-sign. Every docs-only PR tonight required manual sign (PR #347, #348, #350, #351).

## Fix

Teach `scripts/check-attestation-sign.sh` to detect docs-only diffs (using `scripts/is-docs-only-changeset.mjs` from AISDLC-206) and emit auto-approved verdicts inline if the verdicts file is missing AND the diff is docs-only.

```bash
# Pseudocode
if [ ! -f "$VERDICTS_FILE" ]; then
  CHANGED_FILES=$(git diff --name-only origin/main...HEAD)
  ALL_DOCS=$(printf '%s\n' "$CHANGED_FILES" | node scripts/is-docs-only-changeset.mjs)
  if [ "$ALL_DOCS" = "true" ]; then
    # Emit synthetic auto-approved verdicts file (gitignored, just for the sign step)
    mkdir -p "$(dirname "$VERDICTS_FILE")"
    cat > "$VERDICTS_FILE" <<EOF
[
  {"agentId":"code-reviewer","harness":"claude-code","approved":true,"findings":{"critical":0,"major":0,"minor":0,"suggestion":0},"summary":"Docs-only PR — auto-approved by check-attestation-sign.sh"},
  {"agentId":"test-reviewer","harness":"claude-code","approved":true,"findings":{"critical":0,"major":0,"minor":0,"suggestion":0},"summary":"Docs-only PR — no code to test."},
  {"agentId":"security-reviewer","harness":"claude-code","approved":true,"findings":{"critical":0,"major":0,"minor":0,"suggestion":0},"summary":"Docs-only PR — no attack surface."}
]
EOF
  else
    # No verdicts file + not docs-only — skip auto-sign as before
    echo "[attestation-sign] no verdicts file at $VERDICTS_FILE and changeset is not docs-only — skipping"
    exit 0
  fi
fi
# ...continue with existing sign logic...
```

Dependencies: AISDLC-206 merged (it is). Ideally also AISDLC-211 #3 first so the regular workflow can ALSO short-circuit (so the envelope isn't strictly needed), but they're independent fixes.

## Acceptance Criteria
- [ ] #1 `scripts/check-attestation-sign.sh` detects docs-only diffs and synthesizes auto-approved verdicts inline if no file exists
- [ ] #2 Hermetic test in `scripts/check-attestation-sign.test.mjs` covers: docs-only PR + missing verdicts → auto-signed; code PR + missing verdicts → no-op (existing behavior)
- [ ] #3 The synthesized verdicts file is gitignored (it's transient — only used for the sign step)
- [ ] #4 The signed envelope's payload reflects "auto-approved by hook" so audit trail is accurate
- [ ] #5 Documentation in CLAUDE.md `## Hooks` section updated to mention the docs-only auto-approve path
<!-- SECTION:DESCRIPTION:END -->
