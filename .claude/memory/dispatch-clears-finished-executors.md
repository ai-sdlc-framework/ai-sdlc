---
name: dispatch-clears-finished-executors
description: As operator-dispatch, clear an executor's context as soon as it reports its task finished, then hand it the next task
metadata:
  type: feedback
---

When an executor reports its task finished (its one-line status `<name>: <task-id> <outcome>, PR <n>, decisions <ids>`), operator-dispatch clears its context with `tmux send-keys -t <paneId> '/clear' Enter`. The paneId comes from `.ai-sdlc/dispatch/hierarchy.json`.

Then dispatch the executor's next task. Under DEC-0045, use `/ai-sdlc:execute <task-id>` plus a line asking it to send operator-dispatch one status line, until the coordinated restart that comes after 667 and 688 merge. After that restart, use `/ai-sdlc:executor`. If Enter does not submit the line, send `C-m`.

**Why:** The user asked for this on 2026-10-03. Stale context, often above 60%, otherwise carries into the next task. The executor protocol (ai-sdlc-plugin/commands/executor.md, Step 6) waits for dispatch to do the clear.

**How to apply:** Clear only after the task is finished. Do not clear while the executor is waiting on a decision, the slot or CI, or while a background poll shell is running ("1 shell still running"). Clearing mid-task destroys uncommitted work. Also, do not clear an executor whose status line raises open items for the planner, such as "needs planner ruling" or "deferred". Wait for the ruling first. On 2026-10-04, epsilon was cleared after 703 while two rulings were pending. The ruling then required 703 rework, and the work had to be handed to a fresh executor with no context. Text in an executor's input box is usually an auto-generated prompt suggestion, not something someone typed. Related: [[route-questions-via-planner]].
