---
id: AISDLC-1037
title: 'Hierarchy mod phase 4: delete the keystroke layer (clear.ts pane script, caller-identity.ts pid walk, check-sender flags); cli-hierarchy clear becomes a rotate request; runbook update'
status: In Progress
assignee: []
created_date: '2026-10-22'
labels:
  - rfc-0058
  - phase-4
  - hierarchy
  - docs
dependencies:
  - AISDLC-1035
  - AISDLC-1036
references:
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/caller-identity.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

RFC-0058 phase 4 (Signed Off 2026-10-22). With all three roles on the module, the tmux keystroke layer is deleted. tmux stays as a window manager only (OQ-3): `cli-hierarchy up`, `attach` and `terminals` keep creating and attaching windows and never send keys.

**Scope.**
1. Delete the pane-text idle detection and the detached keystroke script in `clear.ts`; `cli-hierarchy clear <name>` sends a rotate request by `$.session.send` to the named session and reports the acknowledgement, with a named refusal when the session has no module loaded.
2. Delete `caller-identity.ts` (the pid walk) and the `check-sender` sender flags on every subcommand; the roster-name check in the module is the only mistake guard, as the RFC states. Update the tests that exercised them.
3. `cli-hierarchy up` keeps launching sessions in tmux windows; `attach` and `terminals` are unchanged except for removed key-sending options. `cli-hierarchy status` reads the board as today; the module's pane is the live view.
4. Docs: `docs/operations/cli-hierarchy.md` (the operator runbook for the hierarchy) describes the mod-driven hierarchy, the rotate request, the version floor and probe refusal (OQ-5), the install-tier line (OQ-4), and the "report upstream first, workaround interim" rule for Mods gaps; the troubleshooting entries about unsubmitted resume commands and `unknown` state after a degraded clear are removed or rewritten.
5. Remove the hierarchy-keystroke entries from the dark-code baseline that the deletions make obsolete (the baseline only shrinks).

**Five-step review (requirements first).**
1. Requirement questioned: does anything still need to type into a pane once all roles run on the module? No.
2. Delete: the `clear.ts` keystroke script and idle detection, `caller-identity.ts`, the `check-sender` flags, the related troubleshooting prose.
3. Simplify: `cli-hierarchy clear` is one send plus one acknowledgement.
4. Accelerate: no 30 s pane polls remain anywhere in the hierarchy.
5. Automate: a test asserts no `tmux send-keys` call remains in `pipeline-cli/src/hierarchy/`.

## Acceptance Criteria

- [ ] `clear.ts` holds no pane-text diffing and no key sending; `cli-hierarchy clear <name>` sends a rotate request and reports the acknowledgement or a named refusal (tests).
- [ ] Every `check-sender` flag is deleted with its tests; a ratchet test confines `send-keys` under `pipeline-cli/src/hierarchy/` to the two remaining sites (`tmux.ts` sendExit, `brief-notify.ts`). DEFERRED: deleting `caller-identity.ts` (still the roster identity source for dispatch, resume, executor-start and escalation-chain) and the last two send-keys sites need a module-side replacement and are a follow-up.
- [ ] `cli-hierarchy up`, `attach` and `terminals` still create and attach tmux windows (existing tests pass).
- [ ] `docs/operations/cli-hierarchy.md` and the operator runbook are updated as in Scope 4; `requiresDocs: operator-runbook` of RFC-0058 is satisfied and `deferredDocs` is cleared in the RFC frontmatter.
- [ ] The dark-code baseline has no hierarchy entries to remove (none were listed; no module became dark); `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
