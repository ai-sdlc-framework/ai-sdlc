---
id: AISDLC-1376
title: 'Boards on one machine never share a webhook receiver, gh wrapper or state file'
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - hierarchy
  - pipeline-cli
  - webhook
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook.test.ts
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/hierarchy/webhook-repair.ts
  - docs/operations/cli-hierarchy.md
priority: high
---

## Description

**Gap.** The operator requires (2026-11-22) that each repository on a machine has its own webhook service and that the services never conflict. Repairing the amplified-career-site webhook from the ai-sdlc planner session on 2026-11-22 showed three ways one board's run breaks another board's service.

**Observed** (2026-11-22, this machine; four boards on ports 8765, 8767 to 8770).

1. `webhook up --feed gh-forward` for amplified-career-site, run from a shell whose PATH starts with `/Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.ai-sdlc/dispatch/bin` (the ai-sdlc board's gh wrapper), wrote that wrapper into the amplified-career-site agent as its `gh`. launchd then refused it (`Operation not permitted`, exit 126). Fixed by hand to `/opt/homebrew/bin/gh`.
2. Three `webhook up` runs within a minute started three receivers for the same board (ports 8767, 8769, 8770). The two orphans had to be killed by hand.
3. Killing an orphan receiver deleted the board's `webhook.json`, which belonged to the live receiver; status then read "receiver process is not running" until the record was rewritten by hand.

**Facts read in code** (main at ea5d9015d, paths under `pipeline-cli/src/hierarchy/`).

- `webhook-forwarder.ts:79-85` `agentPath` drops only this board's own `bin` directory from PATH; another board's wrapper passes. `resolveRealGh` (`:88`) then returns the first `gh` on that PATH.
- `webhook.ts:607-630`: when the recorded state is not `up`, `webhook up` picks a port and spawns `webhook serve` without checking for a receiver of this board that is still starting or is alive on another port.
- `webhook.ts:759`: the receiver runs `rmSync(stateFile(boardDir))` on stop whether or not the record names its own pid.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: one receiver and one forwarder per board, each touching only its own repository, port, record and agent. 2. Deleted: the paths where one board reads another board's wrapper or record. 3. Simplified: ownership checked by pid and board dir, never by port number alone. 4. Accelerated: none needed. 5. Automated: tests for each observed conflict.

- `agentPath` and `resolveRealGh` skip every board's gh wrapper, not only this board's: any directory ending in `.ai-sdlc/dispatch/bin`, or a `gh` file that carries the wrapper marker. A test with another board's wrapper first on PATH resolves the real gh.
- `webhook up` starts a receiver only when no receiver for this board is alive or starting: take a start lock in the board dir, and before spawning ask `/health` on the scan range for this `boardDir` (AISDLC-1349 added `boardDir` to `/health`). A second `up` within the start window reports the receiver already starting.
- A receiver deletes `webhook.json` on stop only when the record's pid is its own.
- The repair in `webhook-repair.ts` follows the same rules (it reuses `installForwarder`).
- `docs/operations/cli-hierarchy.md`: one paragraph on per-board isolation.

Out of scope: forwarder self-repair (AISDLC-1375).

## Acceptance Criteria

- [ ] #1 A test: with another board's `.ai-sdlc/dispatch/bin` first on PATH, the written agent uses the real `gh`.
- [ ] #2 A test: two `webhook up` calls back to back for one board spawn one receiver.
- [ ] #3 A test: a receiver whose pid is not the recorded one leaves `webhook.json` in place on stop.
- [ ] #4 `docs/operations/cli-hierarchy.md` states the per-board isolation rules.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
