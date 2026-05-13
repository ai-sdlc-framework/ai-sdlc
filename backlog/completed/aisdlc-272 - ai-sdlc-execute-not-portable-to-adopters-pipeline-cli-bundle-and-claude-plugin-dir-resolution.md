---
id: AISDLC-272
title: /ai-sdlc execute is not portable to adopter projects — pipeline-cli bundle + CLAUDE_PLUGIN_DIR resolution
status: Done
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - blocker
  - plugin
  - execute
  - portability
dependencies: []
priority: critical
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/plugin.json
  - .claude-plugin/marketplace.json
finalSummary: |
  ## Summary
  Fixed /ai-sdlc execute portability for adopter projects by (A) adding an
  `install-runtime-deps.sh` script that self-heals missing pipeline-cli deps in
  the plugin cache, and (B) extending path resolution from a binary two-case branch
  to a five-topology chain that handles CLAUDE_PLUGIN_DIR set+correct, set+useless
  (broken local marketplace install), CLAUDE_PLUGIN_ROOT fallback, plugin cache probe,
  and dogfood monorepo. Resolution is delegated to a new `resolve-pipeline-cli.sh`
  helper. When all topologies fail, the command exits 1 with an actionable error
  message naming the broken topology and fix options.

  ## Changes
  - `ai-sdlc-plugin/scripts/install-runtime-deps.sh` (new): idempotent npm install
    of runtimeDependencies into a plugin cache dir; used as self-heal from resolve script.
  - `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh` (new): 5-topology resolution
    algorithm with self-heal, cache probe, and actionable error on total failure.
  - `ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs` (new): hermetic topology
    tests (1-5) using isolated tmp dirs + fake pipeline-cli bins.
  - `ai-sdlc-plugin/commands/execute.md` (modified): path-resolution preamble updated
    to delegate to resolve-pipeline-cli.sh; PLUGIN_SCRIPTS_DIR now includes
    CLAUDE_PLUGIN_ROOT in fallback chain; PIPELINE_CLI_BIN supports env override.
  - `ai-sdlc-plugin/commands/execute.test.mjs` (modified): fixed 2 pre-existing test
    failures caused by AISDLC-133 architecture drift (Step 10 signing moved to pre-push
    hook); added 5 new AISDLC-272 assertions for multi-topology resolution.
  - `ai-sdlc-plugin/README.md` (modified): expanded path resolution docs to cover all
    5 install topologies + manual self-heal instructions.

  ## Design decisions
  - **Script-based resolution instead of inline bash**: isolates the complex
    5-topology logic into a testable, versioned helper. The execute.md preamble
    becomes a simple delegate call.
  - **PIPELINE_CLI_BIN env override**: allows operators to bypass all resolution
    when they have a known-good install path (e.g. dogfood dev pointing at monorepo).
  - **Self-heal via npm install**: the local marketplace cache never runs npm install,
    so the only portable fix is to run it ourselves when deps are missing. The script
    is idempotent and checks for the sentinel file before running.

  ## Verification
  - `pnpm build` — clean
  - `pnpm test` — 69 execute.test.mjs + 8 resolve-pipeline-cli.test.mjs
  - `pnpm lint` — 0 errors
  - `pnpm format:check` — clean

  ## Follow-up
  - End-to-end verification on a clean adopter project (forge) once TASK-708
    exemption window closes (2026-06-15).
---

## Bug

`/ai-sdlc execute` is a hard upstream blocker for adopters. Hit during the 2026-05-13 forge integration session — operator could not run `/ai-sdlc execute` against TASK-708 (Next 16 bump) from `/Users/dominique/Documents/dev/forge` because the skill's path-resolution logic doesn't actually find pipeline-cli's binaries when the plugin is installed via the marketplace.

The skill body's resolution chain (from `ai-sdlc-plugin/commands/execute.md` "Path resolution conventions"):

```bash
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  PIPELINE_CLI_BIN="$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin"
else
  PIPELINE_CLI_BIN="$(pwd)/pipeline-cli/bin"
fi
```

This assumes one of two install topologies, NEITHER of which holds in the forge case:

1. **Monorepo dogfood** (`$(pwd)/pipeline-cli/bin`): true on this repo (`~/Documents/dev/ai-sdlc/ai-sdlc/`), false in adopter projects.
2. **Marketplace install with bundled deps** (`$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin`): assumes the plugin marketplace bundle ships `node_modules/@ai-sdlc/pipeline-cli/`. The current local-marketplace cache at `~/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.9.0/` has `scripts/` but **no** `node_modules/@ai-sdlc/pipeline-cli/`.

Diagnostic from forge (2026-05-13):

```
CLAUDE_PLUGIN_DIR=<unset>   ← Claude Code harness doesn't set it in this context
CLAUDE_PLUGIN_ROOT=<unset>
Skill's fallback path: $(pwd)/pipeline-cli/bin
Resolves to:           /Users/dominique/Documents/dev/forge/pipeline-cli/bin  ← doesn't exist
Plugin cache layout:   ~/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.9.0/
                       (has scripts/, but no node_modules/@ai-sdlc/pipeline-cli/)
Pipeline-cli actually lives at: /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/pipeline-cli/bin/
                                (the monorepo, not bundled in the plugin)
```

## Two distinct sub-gaps

### 269.A — Plugin marketplace bundle should ship pipeline-cli

The plugin's `runtimeDependencies: { "@ai-sdlc/pipeline-cli": "^0.10.0" }` declaration in `.claude-plugin/plugin.json` (re-added in PR #453) is supposed to make Claude Code's marketplace installer fetch the dep — but the local-marketplace cache layout doesn't show it. Either:

- The runtime-deps mechanism only works for remote marketplaces, not local ones (and we need a separate ship-it-anyway path for local installs)
- The runtime-deps mechanism is supposed to populate `<plugin-dir>/node_modules/@ai-sdlc/pipeline-cli/` but doesn't in practice
- We need to vendor pipeline-cli into the plugin tarball itself (vs declaring it as a runtime dep)

Whichever path we choose, the contract should be: after a marketplace install, `$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/` resolves on every adopter machine.

### 269.B — CLAUDE_PLUGIN_DIR resolution in skill Bash invocations

`CLAUDE_PLUGIN_DIR` was unset when the execute skill's Bash hook fired in this harness setup. Either Claude Code doesn't always inject it for plugin-supplied skills, OR it's only injected for certain invocation types (slash-command-body vs hook vs subagent vs skill body).

The skill body's logic needs to handle three states symmetrically:

- **Set + correct**: `$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/` exists → use it.
- **Set + useless**: env var is set but the bundled deps aren't there (broken install) → detect + fall through with a clear error.
- **Unset entirely**: env var was never injected → use a documented fallback (probably resolve via `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/node_modules/@ai-sdlc/pipeline-cli/bin/` or a `npm root -g` lookup).

The current "either CLAUDE_PLUGIN_DIR or `$(pwd)/pipeline-cli/bin`" branch is too binary — it skips the most common adopter case (env unset, monorepo path doesn't exist).

## Three honest fallbacks (operator-evaluated 2026-05-13)

The operator considered three near-term options and picked C:

- **A — Hand-bridge the paths** (export `CLAUDE_PLUGIN_DIR=/path/to/ai-sdlc-monorepo`, retry): ~5 min hack but Step 0 self-heal would run against forge's git state with scripts written for ai-sdlc's layout. Likely to half-succeed and leave the worktree in a weird state. Wrong move for shipping production work.
- **B — Implement TASK-708 inline** (no framework backstop, drive the bump directly): Multi-hour, real but predictable. Defers the upstream gap.
- **C — Defer + file the upstream gap (chosen)**: file this task, leave TASK-708 To Do, exemption still valid until 2026-06-15. Pick up when upstream ships portable execute OR when there's a dedicated dev-day for the bump.

This task IS option C.

## Acceptance criteria

- [ ] **269.A**: `npm install @ai-sdlc-framework/ai-sdlc` from a fresh adopter project (clean home dir, no existing plugin cache) results in `$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/` resolving — OR an equivalent ship-it path that the skill body can use.
- [ ] **269.B**: The skill body's path resolution handles all three CLAUDE_PLUGIN_DIR states (set+correct, set+useless, unset) without falling through to the monorepo-only `$(pwd)/pipeline-cli/bin` assumption. When all paths fail, exit with a clear actionable error message naming the missing binary and the install topology that's broken.
- [ ] Test added that simulates each install topology (local marketplace, remote marketplace, monorepo dogfood, broken install) and asserts the skill body resolves correctly OR fails with the expected error.
- [ ] `ai-sdlc-plugin/README.md` documents the supported install topologies + the resolution algorithm.
- [ ] Verified end-to-end on a clean adopter project (e.g. forge) — `/ai-sdlc execute <task-id>` produces a worktree, dispatches the dev subagent, opens a PR.

## Out of scope

- TASK-708 (the Next 16 bump in forge) — that's the downstream consumer this fix unblocks. Forge keeps the exemption until 2026-06-15.
- Other adopter-friction findings filed in PR #468 (AISDLC-261..268) — those are separate upstream gaps.
- Replacing the Claude Code plugin distribution mechanism — work within the harness as it ships.

## Source

Adopter session 2026-05-13 (forge / TASK-708 dispatch attempt). Tracked as forge-side "upstream gap #10" in the operator's notes.
