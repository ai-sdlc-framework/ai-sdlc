---
id: AISDLC-450
title: Clarify hard-rule wording on git reset --hard (script-sanctioned vs ad-hoc)
status: Done
assignee: []
created_date: '2026-05-27 22:09'
labels:
  - governance
  - operator-friction
  - skill-body
  - vision-alignment
dependencies:
  - AISDLC-447
references:
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/commands/execute.md
  - scripts/check-orchestrator-state.sh
  - CLAUDE.md
  - VISION.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Origin: 2026-05-27 session where parent worktree was dirty with 29 entries (out-of-sync v6 envelopes + workflow files). Hard rule #6 in orchestrator-tick + execute skills says "Never run destructive git operations. No `git reset --hard`." But CLAUDE.md describes `scripts/check-orchestrator-state.sh` which DOES `git reset --hard origin/main` when parent is clean. Operator had to nudge ("why can't you reset main?") to break the deadlock; I had refused action.

The rule's INTENT is "don't ad-hoc destroy state." The wording conflates that with "never invoke the sanctioned recovery script."



<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [ ] AC-1: Hard rule reworded in execute.md + orchestrator-tick.md: "Never run `git reset --hard` UNLESS via the sanctioned check-orchestrator-state.sh script OR after explicit operator authorization in the current session."
- [ ] AC-2: When parent is dirty + sanctioned script refuses, escalate to Decision Catalog with timebox 1h (depends on AISDLC-447): "Parent dirty — operator-authorize reset or triage?"
- [ ] AC-3: Document the distinction in CLAUDE.md "Hooks" section: sanctioned reset = OK, ad-hoc reset = blocked
- [ ] AC-4: Worked example added to orchestrator-tick skill body showing the dirty-parent → decision-catalog flow

<!-- AC:END -->

## References

- ai-sdlc-plugin/commands/orchestrator-tick.md (Hard rules section)
- ai-sdlc-plugin/commands/execute.md (Hard rules section)
- scripts/check-orchestrator-state.sh
- CLAUDE.md "Pattern C hard guards" section
- VISION.md §4 (Honest failure modes)
- AISDLC-447 (timebox dependency for AC-2)

