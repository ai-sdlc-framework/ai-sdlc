---
id: AISDLC-870
title: >-
  auto-clear gives the session a handoff turn before /clear; a clear never
  discards unsaved session context
status: Done
assignee: []
created_date: '2026-10-14'
labels:
  - hierarchy
  - reliability
  - planner
dependencies: []
references:
  - pipeline-cli/src/hierarchy/clear.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
drift_log:
  - date: '2026-10-23'
    type: ref-deleted
    detail: 'Referenced file no longer exists: pipeline-cli/src/hierarchy/auto-clear.ts'
    resolution: flagged
  - date: '2026-10-23'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/hooks/context-auto-clear.js
    resolution: flagged
drift_checked: '2026-10-23'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`pipeline-cli/src/hierarchy/auto-clear.ts` (Stop hook `ai-sdlc-plugin/hooks/context-auto-clear.js`, which runs `cli-hierarchy auto-clear`) measures the transcript. Over the role threshold it refreshes the CLI-generated handoff (board and catalog state between the markers) and schedules `clear --self`. The session itself gets no turn: the prose outside the markers (open rulings, in-flight work, what the operator asked for) is never written. On 2026-10-14 (about 16:00Z) the planner was auto-cleared midway through a 24h drain-bottleneck review with the operator; the review context was lost and rebuilt from scratch. No planner file existed under `.ai-sdlc/dispatch/handoff/` at all.

**Context.** Open task AISDLC-815 moves hierarchy clears onto a context threshold. This task changes what happens at that threshold: the session is told to write its handoff first.

**Five-step review (requirements first).** Requirement questioned: "the hook must drive the clear". The hook cannot know a safe turn boundary or what prose matters; the session can. So the hook only warns, and the session clears itself through the existing handoff routine. Delete: the hard clear-without-handoff path. Simplify: one warn threshold at about 80% of the clear threshold that injects a Stop-hook message ("write your handoff now, then /clear; start no new work"), and a hard cap at threshold plus 25% that still clears, but only after verifying the role's handoff file mtime is newer than the warning; otherwise it writes a marker and injects the message once more, and past the cap it clears with the reason logged on the board. Accelerate: no polling; the hook already runs on every Stop. Automate: the resume command after a clear reads the handoff first (already the case).

## Fix

1. `auto-clear.ts`: add the warn threshold and a warning marker recording the warn time per role; at the warn threshold return the Stop-hook message instructing the session to run the handoff routine (the planner, dispatch and executor commands already document it) and not to start new work.
2. Gate `clear --self` on the role's handoff file having an mtime newer than the warning marker. Handoff paths: the planner's is where `handoff write --role planner` writes it (`.claude/memory/project_planner_handoff_*.md`); use the per-role path for the others. If not newer, write the marker and inject the message once more; at the hard cap (threshold plus 25%) clear anyway and log the reason on the board.
3. `context-auto-clear.js` and `clear.ts`: pass the new outcomes through; an executor with in-flight work is never cleared (existing behaviour, kept).
4. Update `ai-sdlc-plugin/commands/planner.md` (Handoff routine section) to say the warning is the cue, and `docs/operations/cli-hierarchy.md`.

## Acceptance Criteria

- [ ] #1 At the warn threshold the Stop hook returns a message telling the session to run the handoff routine and not to start new work.
- [ ] #2 A clear is only issued once the role's handoff file has been rewritten after the warning (mtime check), or at a hard cap of threshold plus 25% with the reason logged on the board.
- [ ] #3 The planner's handoff path for the mtime check is the one `handoff write --role planner` writes (`.claude/memory/project_planner_handoff_*.md`); each role uses its own path.
- [ ] #4 Unit tests cover warn, handoff, clear; warn, no handoff, hard cap; and executor-inflight never cleared (existing).
- [ ] #5 `docs/operations/cli-hierarchy.md` documents the warn threshold, the mtime gate and the hard cap.

**Velocity impact.** Neutral to positive: one extra session turn per clear, in exchange for no context rebuilds after a clear (the 2026-10-14 loss cost a full review restart).

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, no trust-chain control touched); operator-requested 2026-10-14.
<!-- SECTION:DESCRIPTION:END -->
