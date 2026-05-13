---
id: AISDLC-263
title: init wizard breaks in non-TTY (CI / agent bash) context
status: Done
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
finalSummary: |
  ## Summary
  Added a non-TTY guard in `resolveFeatureSelection` (init-features.ts) that detects
  `!process.stdin.isTTY` before entering the interactive prompt path. When the guard
  fires, the wizard auto-falls-through to `ALL_FEATURES` defaults (equivalent to `--yes`)
  and logs a message informing the operator. This eliminates the hang + unhandled
  `ExitPromptError` that previously occurred in CI runners, agent bash sessions, Docker
  containers without `-it`, and any piped-input context. No `ExitPromptError` ever reaches
  the user.

  ## Changes
  - `orchestrator/src/cli/commands/init-features.ts` (modified): added Path 2b between
    the `--yes` short-circuit and the interactive prompt block; checks `!process.stdin.isTTY`
    and returns `ALL_FEATURES` with a descriptive log message.
  - `orchestrator/src/cli/commands/init-features.test.ts` (modified): added `beforeAll`
    TTY stub in the outer `resolveFeatureSelection` describe (sets `isTTY=true` so prompt
    tests aren't broken by the non-TTY test runner), nested AISDLC-263 describe with two
    new tests covering the auto-fall-through and `--yes`-wins-over-non-TTY cases.
  - `ai-sdlc-plugin/README.md` (modified): added `ai-sdlc init — CI-safe by default
    (AISDLC-263)` section documenting the auto-fall-through and recommending `--yes` for
    CI scripts.

  ## Design decisions
  - **Auto-fall-through (not exit 1)**: chosen because adopters running `ai-sdlc init`
    in CI should just work without adding flags. Exit 1 would require adopters to change
    their scripts; auto-fall-through preserves the happy path.
  - **`--yes` path checked before non-TTY guard**: `--yes` is explicit user intent so
    it wins first; no non-TTY log noise when the flag is present.
  - **Test TTY stubbing via `Object.defineProperty`**: `process.stdin.isTTY` is a
    non-writable property in the runtime; `Object.defineProperty` with `configurable: true`
    is the only reliable way to stub it hermetically in Vitest without mocking the module.

  ## Verification
  - `pnpm build` — clean
  - `pnpm test` — 3101 passed (0 failed)
  - `pnpm lint` — 0 errors (2 pre-existing warnings in pipeline-cli/src/steps/00-sweep.ts)
  - `pnpm format:check` — clean

  ## Follow-up
  (none)
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

- [x] `ai-sdlc init < /dev/null` either succeeds with `--yes` defaults or exits 1 with the clear error message.
- [x] No `ExitPromptError` reaches the user.
- [x] Test added in `init-features.test.ts` that runs init with stdin closed and asserts the chosen behavior.
- [x] If auto-fall-through is the chosen behavior, document it in `ai-sdlc-plugin/README.md` so adopters know `init` is CI-safe by default.

## Source

Adopter session 2026-05-13, ranked #3 by friction. Hit during agent-driven init from a Claude Code session.
