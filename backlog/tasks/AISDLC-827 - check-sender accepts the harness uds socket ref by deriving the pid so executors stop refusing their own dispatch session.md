---
id: AISDLC-827
title: >-
  check-sender accepts the harness uds socket ref by deriving the pid, so executors stop refusing their own dispatch session
status: To Do
assignee: []
created_date: '2026-10-12'
labels:
  - hierarchy
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/peer-guard.ts
  - ai-sdlc-plugin/commands/executor.md
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (verified 2026-10-12 23:40Z).** Executors alpha and beta refused every message from the dispatch session with `not my dispatch session`, so dispatch could not deliver resume notes. The harness envelope reports the sender as `from="uds:/tmp/cc-socks/18365.sock" from-name="ai-sdlc-operator-dispatch"` and no pid. The executor passes that string as `--sender-ref`. `checkDispatchSender` (`pipeline-cli/src/hierarchy/peer-guard.ts`) compares a ref only with the roster entry's `name` or `tmuxSession`, so a `uds:` ref never matches, although `18365` is exactly the pid the roster holds for dispatch (`hierarchy.json`: operator-dispatch pid 18365, status running). The guard is a mistake guard (DEC-0038), and today it refuses the one sender it exists to accept.

**Five-step review (requirements first).**
1. Requirement questioned: "the sender is checked by pid or by harness session ref against the roster" (RFC-0051, check-sender). Kept: it is cheap and it stops look-alike sessions from other projects. What was wrong is the ref format the check understands.
2. Delete: nothing; the fail-open warning path (no pid, no ref) stays as is.
3. Simplify: `check-sender` derives the pid from a `uds:<path>/<pid>.sock` ref (the harness's actual format) and compares it like `--sender-pid`; a ref that is neither a roster name, a tmux session nor a socket path is refused as today. The executor instruction documents the two forms the harness emits.
4. Accelerate: dispatch messages to executors work again immediately; no resume note is lost.
5. Automate: none.

**Velocity impact.** Positive: restores the one message path the hierarchy relies on. Note for dispatch until this lands: assignments and resume notes travel on the board (`cli-dispatch resume --note`), not in messages, so the drain does not wait on this fix.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `checkDispatchSender` accepts a ref of the form `uds:<dir>/<pid>.sock` when `<pid>` equals a running dispatch entry's pid; unit tests cover match, non-match, and a malformed socket ref (refused)
- [ ] #2 `cli-hierarchy check-sender --sender-ref uds:/tmp/cc-socks/<dispatch-pid>.sock` exits 0 against a roster fixture; against another pid it exits 1 with `not my dispatch session`
- [ ] #3 `executor.md` names both ref forms (`uds:` socket path, harness session ref) and states the pid is derived from the socket name
- [ ] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
