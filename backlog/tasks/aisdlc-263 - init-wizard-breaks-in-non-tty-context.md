---
id: AISDLC-263
title: init wizard breaks in non-TTY (CI / agent bash) context
status: To Do
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - init
  - non-tty
  - ci
dependencies: []
priority: high
references:
  - orchestrator/src/cli/commands/init-features.ts
---

## Bug

`ai-sdlc init` invokes `inquirer` for interactive prompts. When `process.stdin.isTTY === false` (CI runner, agent bash, `init | tee`, etc.), the prompt hangs indefinitely then throws an unhandled `ExitPromptError` with no actionable message.

## Repro

```bash
ai-sdlc init < /dev/null   # or in any CI step, agent bash, container without -it
# → hangs ~30s, then ExitPromptError + stack trace
```

## Expected behavior

When `!process.stdin.isTTY`:

- **Auto-fall-through to `--yes` defaults** (preferred): the wizard's interactive prompts should default to safe values silently, so adopters can run `ai-sdlc init` in CI / from agents without explicit `-y`.
- **OR a clear pre-flight error**: `ERROR: ai-sdlc init requires a TTY for interactive prompts. Pass --yes to accept defaults non-interactively, or run from a terminal.` — exit 1.

Either way, **never** the unhandled rejection + stack dump.

## Acceptance criteria

- [ ] `ai-sdlc init < /dev/null` either succeeds with `--yes` defaults or exits 1 with the clear error message.
- [ ] No `ExitPromptError` reaches the user.
- [ ] Test added in `init.test.mjs` that runs init with stdin closed and asserts the chosen behavior.
- [ ] If auto-fall-through is the chosen behavior, document it in `ai-sdlc-plugin/README.md` so adopters know `init` is CI-safe by default.

## Source

Adopter session 2026-05-13, ranked #3 by friction. Hit during agent-driven init from a Claude Code session.
