---
id: AISDLC-1163
title: 'Hierarchy module rotates at the configured contextThresholds instead of hardcoded 150k/120k, and the generated handoff block gains a Pending asks section fed by handoff note --kind asked|settled'
status: In Progress
assignee: []
created_date: '2026-11-02'
labels:
  - hierarchy
  - planner
  - context
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - ai-sdlc-plugin/mods/tests/hierarchy.test.ts
  - pipeline-cli/src/hierarchy/thresholds.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/handoff.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

Two follow-ups that AISDLC-1159 lists as out of scope in its Notes.

(a) Thresholds. `cli-hierarchy status` prints "context clear thresholds (tokens): planner ..., operator-dispatch ..., executor ..." (`status.ts:334`) from `resolveThresholds` (`pipeline-cli/src/hierarchy/thresholds.ts:24`), which reads `contextThresholds` in `<boardDir>/config.json`. The module that actually rotates ignores that file: `PLANNER_ROTATE_AT_TOKENS = 150_000` (`planner.ts:21`, compared at `planner.ts:162`), `ROTATE_AT_TOKENS = 120_000` (`executor.ts:22`, compared at `executor.ts:573`) and `DISPATCH_ROTATE_AT_TOKENS = 120_000` (`dispatch.ts:23`, compared at `dispatch.ts:528`). An operator who sets a threshold sees it in `status` and gets a rotation at the constant. The defect covers all three roles, not only the planner.

(b) Pending asks. `renderHandoff` (`handoff.ts:227`) emits Next action, Roster, Board, Open decisions, Rulings in force, Outward actions and Transcript. Nothing structured records an ask the planner made to the operator or a peer that is still waiting for an answer. AISDLC-1159 AC-2 makes the model-written `## RESUME HERE` prose carry pending asks on a threshold rotation; that prose is only as good as the turn that writes it, and it is not refreshed by `handoff write` from the CLI (dispatch-triggered rotations, crashes, the fallback path in 1159 AC-1). The outward-action ledger (`noteLedger`, `handoff.ts:186`; kinds `filed|commented|opened|closed|sent`, `url` required) is append-only and rendered as the newest 20 entries, so it cannot express "still open".

**Five-step review (requirements first).**
1. Requirement questioned: (a) must the rotation threshold be the value `status` shows? Yes; a displayed setting that does not act is worse than none. (b) must open asks survive a rotation without depending on the model writing prose? Yes; the operator confirmed on 2026-11-02 that continuity without a reminder is the requirement.
2. Delete: the three role constants as the source of truth (they stay only as the fallback defaults, which already live in `DEFAULT_CONTEXT_THRESHOLDS`).
3. Simplify: (a) the module reads `<boardDir>/config.json` `contextThresholds` once at registration through the same `$.process.run` node one-liner it already uses to read board files (`executor.ts:306`), falls back per role to the current constants on a missing or invalid value, and each role compares against `state.rotateAt`. (b) two ledger kinds, `asked` and `settled`, with `--ref <key>` (a free key such as a draft path or `DEC-NNNN`) in place of `--url`; `renderHandoff` adds `## Pending asks` listing every `asked` entry with no later `settled` entry for the same ref, read from the whole ledger, not the 20-entry window.
4. Accelerate: changing a threshold takes effect on the next session start with no plugin release; a rotated planner sees its open asks in the first `handoff read`.
5. Automate: module tests for configured, missing and invalid thresholds per role; handoff tests for the pending-asks fold; `planner.md` tells the planner to `handoff note --kind asked` when it asks and `--kind settled` when answered.

Velocity impact: operators can tune rotation per role without a code change, and an ask left open across a rotation is shown to the next session instead of found by transcript archaeology.

## Acceptance Criteria

- [ ] AC-1: The hierarchy module resolves each role's rotation threshold from `<boardDir>/config.json` `contextThresholds` (same validation as `resolveThresholds`: positive integers only, per-role fallback); `planner.ts:162`, `executor.ts:573` and `dispatch.ts:528` compare against the resolved value. Module tests cover configured, absent and malformed config for each role.
- [ ] AC-2: The module logs the thresholds it resolved once at registration; a test asserts `cli-hierarchy status` and the module agree for the same config file.
- [ ] AC-3: `cli-hierarchy handoff note --kind asked --ref <key> --summary <text>` and `--kind settled --ref <key>` are accepted (`--url` stays required for the existing kinds only); unknown kinds still refuse.
- [ ] AC-4: `renderHandoff` emits `## Pending asks` with each unsettled `asked` entry (`at`, ref, summary), computed over the whole ledger file; `(none)` when empty. Tests cover ask-then-settle, two asks on different refs, and an ask older than the 20-entry render window.
- [ ] AC-5: `planner.md` (Handoff routine and the asking step) and `docs/operations/cli-hierarchy.md` (thresholds and outward-action ledger sections) describe both changes.

## Notes

Origin: AISDLC-1159 Notes ("Out of scope, follow-ups to file separately if wanted"), both halves. Neither half is covered by AISDLC-1159: its AC-2 puts pending asks in the model-written RESUME prose; this task adds the structured, CLI-generated section. Premise widened: the hardcoded threshold affects executor (`executor.ts:22`) and dispatch (`dispatch.ts:23`) as well as the planner. Related: AISDLC-815 (thresholds config), AISDLC-1049 (ledger), AISDLC-1150 (dispatch over-context restart).
