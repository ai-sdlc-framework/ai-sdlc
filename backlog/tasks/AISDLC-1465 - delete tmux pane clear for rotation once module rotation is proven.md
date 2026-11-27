---
id: AISDLC-1465
title: "Delete tmux pane /clear for rotation once module rotation is proven in real runs (DEC-0455 a)"
status: To Do
priority: high
labels:
  - pipeline-cli
  - ai-sdlc-plugin
  - hierarchy
dependencies:
  - AISDLC-1464
references:
  - pipeline-cli/src/hierarchy/tmux.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - docs/operations/cli-hierarchy.md
---

## Description

DEC-0455 option a (operator, 2026-11-27) restores RFC-0058 for rotation: each session's hooks module rotates itself as code (`handoff write` via `$.process.run`, then `$.command.run({command:'clear'})`, `executor.ts` ~379-411). AISDLC-1107 moved executor clearing to tmux `/clear` typed into the pane after the 2026-10-28 incident, where the failures were model cooperation ("I can't clear my own context") and delivery, not the code-driven clear. DEC-0415 (finish-migration) requires a typed path to be deleted only after its Mods replacement is proven in real runs. AISDLC-1464 adds the rotation log that provides that proof.

**Five-step review (requirements first).**
1. Question: the requirement is "a session over its context threshold is cleared with a handoff written". It is not "dispatch types /clear". The pane path exists only as AISDLC-1107's workaround.
2. Delete: every tmux `send-keys` path used for rotation (typed `/clear`, and any rotate fallback that types), once the evidence gate below holds.
3. Simplify: one rotation path, the module's. When it fails, the log line and a status alert report it; nothing types into the pane.
4. Accelerate: none.
5. Automate: status alert when a session is over threshold with no logged rotation within one tick interval after crossing it.

**Evidence gate (do not start before it holds).** The AISDLC-1464 rotation log shows at least 5 successful module rotations in real runs, covering executor and planner roles, with handoff ok and clear ok and no fallback. The implementer quotes the log lines in the PR body. If the gate fails, stop and return `prUrl: null` with the failing log lines; the planner takes it back to the operator.

## Acceptance Criteria
- [ ] #1 PR body quotes at least 5 rotation-log lines (executor and planner) showing module rotations with handoff ok, clear ok, no fallback.
- [ ] #2 No rotation code path calls `tmux send-keys`; a vitest case asserts the over-threshold path performs zero `send-keys` calls.
- [ ] #3 `cli-hierarchy status` alerts when a session is over its threshold and no rotation was logged within one tick interval after crossing it; tested.
- [ ] #4 RFC-0058 interim exceptions for rotation are removed, and `docs/operations/cli-hierarchy.md` describes the single module rotation path.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
