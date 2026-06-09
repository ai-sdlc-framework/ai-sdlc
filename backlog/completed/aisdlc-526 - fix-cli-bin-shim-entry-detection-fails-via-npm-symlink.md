---
id: AISDLC-526
title: >-
  fix(cli): bin-shim entry detection fails via npm symlink — all commands
  silently exit 0 with no output
status: Done
assignee: []
labels:
  - bug
  - adopter-experience
  - ci:no-issue-required
dependencies: []
priority: high
references:
  - orchestrator/src/cli/index.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
External contributor (GitHub #870, WSL2 Ubuntu, Node 22, installed `@ai-sdlc/orchestrator` via npm) reports: the `isMainEntry` check in `dist/cli/index.js` (source: `orchestrator/src/cli/index.ts`) fails when the CLI is invoked through an npm bin symlink. Result: **every command** (`ai-sdlc --help`, `--version`, `run`, `init`) produces zero output and exits 0 — the CLI looks like it does nothing. This is the first wall a non-dogfood adopter hits; it blocks all use of the package.

Root cause: the "is this module the entry point?" guard (typically `if (process.argv[1] === fileURLToPath(import.meta.url))` or an equivalent `require.main`/realpath comparison) does not account for npm placing a **symlink** in `node_modules/.bin/`. When invoked via the symlink, `process.argv[1]` is the symlink path while `import.meta.url` resolves to the real file, so the equality check is false and the CLI body never runs — silently.

Fix direction (implementer chooses the robust form): make the entry-point detection symlink-safe — e.g. `fs.realpathSync` both sides before comparing, or detect via the npm bin target / `process.argv[1]` basename, or always run when the file is the resolved bin target. Whatever form, it MUST work in all three cases: (a) direct `node dist/cli/index.js`, (b) `npx`/global bin symlink, (c) local `node_modules/.bin/ai-sdlc` symlink. Add a regression test that simulates the symlink-invocation case.

Empirical source: GitHub issue #870 + the contributor's email report ("9 patches"); this is patch #1 and #9 (the same root cause also breaks `ai-sdlc init`).

Scope: `orchestrator/` CLI entry only. Do not change command behavior — only the entry-point detection.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Entry-point detection in orchestrator/src/cli/index.ts is symlink-safe: the CLI body runs (and produces output) when invoked via an npm bin symlink, not just via direct `node dist/cli/index.js`
- [x] #2 `ai-sdlc --help` and `ai-sdlc --version` produce output and exit 0 in all three invocation modes (direct, global bin symlink, local node_modules/.bin symlink); `ai-sdlc init` and `ai-sdlc run` reach their command handlers
- [x] #3 A regression test covers the symlink-invocation case (e.g. compares realpath-resolved entry vs argv[1] through a symlink) so this cannot silently regress
- [x] #4 No change to any command's behavior — only entry-point detection
- [x] #5 pnpm build + pnpm -F @ai-sdlc/orchestrator test + lint + format:check pass
<!-- AC:END -->
