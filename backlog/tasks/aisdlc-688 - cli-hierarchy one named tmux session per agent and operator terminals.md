---
id: AISDLC-688
title: >-
  cli-hierarchy: one named tmux session per agent, terminal titles that match the agent name, and an attach / open-terminals surface for the operator
status: In Progress
assignee:
  - dispatch-executor-beta
created_date: '2026-10-03'
labels:
  - rfc-0051
  - pipeline-cli
  - operator-experience
dependencies: []
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/down.ts
  - pipeline-cli/src/hierarchy/tmux.ts
  - pipeline-cli/src/hierarchy/roster.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/brief-notify.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/parallel-dispatch.md
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`cli-hierarchy up` starts every tier as a WINDOW inside one detached tmux session named
`ai-sdlc-hierarchy`. On the first real restart after a machine shutdown (2026-10-03)
this was the operator's main friction, in his words: the agents "shouldn't be attached
to the same session, they should each have their own session"; he wants "7 terminals
open, one with each of the agents ... and I want that terminal name to be the same as
the agent name"; switching windows inside one terminal is "cumbersome and inefficient
for a human".

What happened with the shipped layout:

- After `up`, nothing was visible in any of the operator's terminals: the session is
  detached and the command prints no instruction for seeing the agents.
- Attaching a second terminal to the same session mirrors the first (both follow the
  same current window), so two terminals cannot show two agents.
- The operator's terminals were already tmux clients (VS Code terminal profile), so
  `tmux attach` nests; the working command is `tmux switch-client`, which the tool
  never mentions.
- Terminal tabs showed the process name, not the agent.

The planner worked around it by hand: one tmux session per agent in the same session
group as `ai-sdlc-hierarchy` (`new-session -d -s <agent> -t ai-sdlc-hierarchy`, then
`select-window`), `set-titles on` with the session name as the title, and a small
script plus a VS Code tasks file that opens one named terminal per agent. This task
makes that the product behaviour.

Operator-filed 2026-10-03 through the planner session.

## Conventions
- TypeScript strict, ESM, Vitest, 80% line coverage on new code.
- All tmux calls go through the existing injected runner in `tmux.ts`; tests assert on
  the recorded argv, no real tmux in unit tests.
- Session and window names are validated with the existing name rule before they reach
  a tmux argv (no shell interpolation).
- Adopter-facing: nothing may assume VS Code or macOS; the VS Code helper is an opt-in
  generator, the tmux behaviour is the contract.

## Scope
1. **One session per agent.** `up` creates one detached tmux session per roster entry,
   named exactly the roster name (`planner`, `operator-dispatch`, `executor-alpha`,
   ...), each with a single window running that agent. The roster keeps recording
   `tmuxSession` and `tmuxWindow`; `tmuxSession` now equals the agent name. `status`,
   `down`, `brief --notify` and the stuck-entry handling resolve targets from the
   roster and therefore keep working; add tests for each against the new layout.
2. **Backward compatibility.** A roster written by the old layout (all entries in
   `ai-sdlc-hierarchy`) is still stopped cleanly by `down` and reported by `status`.
   `up` on top of an old-layout roster refuses with a one-line instruction to run
   `down` first; it never mixes layouts.
3. **Titles.** For each session `up` sets the terminal title to the agent name
   (`set-titles on`, `set-titles-string` scoped to that session, not `-g`) and puts
   the agent name in `status-left`, so a terminal attached to it is labelled without
   operator configuration. Global tmux options are not modified.
4. **`cli-hierarchy attach <name>`.** Shows one agent in the current terminal: uses
   `switch-client` when `TMUX` is set, `attach-session` otherwise; unknown name lists
   the roster names and exits non-zero. `up --attach` attaches to the dispatch session
   (or the planner when one was started) using the same rule.
5. **Tell the operator how to see the agents.** On success `up` prints one line per
   started agent with the exact command to show it (`cli-hierarchy attach <name>`),
   and `status` gains an `ATTACHED` column (yes or no per session).
6. **`cli-hierarchy terminals --vscode [--out <dir>]`.** Writes a VS Code `tasks.json`
   with one task per roster entry (label = agent name, dedicated panel, runs
   `cli-hierarchy attach <name>`) and a compound task that opens all of them.
   Refuses to overwrite an existing `tasks.json` without `--force`; `--print` writes
   to stdout for operators who merge by hand.
7. **Docs.** `docs/operations/parallel-dispatch.md` gets a short "Watching the
   agents" section: the per-agent sessions, `attach`, the VS Code helper, and the
   note that a VS Code tab shows the title only when `terminal.integrated.tabs.title`
   includes `${sequence}`.

## Acceptance Criteria
- [ ] `up --executors 2 --no-planner` issues one `new-session -d -s <name>` per started agent and no `new-window`; the roster's `tmuxSession` equals each agent's name (asserted on recorded tmux argv).
- [ ] With two clients attached to two different agent sessions, selecting a window in one does not change the other (documented as the reason for the layout; covered by the argv assertions that no shared session exists).
- [ ] `down` and `status` work against both a new-layout roster and an old single-session roster fixture; `up` over an old-layout roster refuses with the `down` instruction.
- [ ] `attach <name>` uses `switch-client` when `TMUX` is set and `attach-session` when it is not; an unknown name exits non-zero and lists the valid names.
- [ ] `up` output contains one `cli-hierarchy attach <name>` line per started agent; `status` shows the `ATTACHED` column.
- [ ] `terminals --vscode --print` emits valid JSON with one task per roster entry plus the compound task, and refuses to overwrite an existing file without `--force`.
- [ ] No global tmux option is set by any command (asserted: no `set-option -g` in recorded argv).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
