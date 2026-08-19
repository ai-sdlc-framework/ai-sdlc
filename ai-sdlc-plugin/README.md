# AI-SDLC Plugin

Claude Code plugin providing governance rules, review subagents, and MCP tools for the AI-SDLC framework.

## Subagents (`agents/`)

Plugin subagents are `.md` files with YAML frontmatter declaring tool grants, the harness, and the agent role.

> **Harness note:** Claude Code filters the `Agent` tool out of plugin subagent sessions one level deep — plugin subagents cannot spawn other subagents. The `/ai-sdlc execute` slash command (main session) spawns the developer + reviewers directly.

### Developer

| Agent | Harness | Description |
|-------|---------|-------------|
| `developer` | `claude-code` | Implements backlog tasks end-to-end: plan, code, verify, commit, push, open PR |

### Reviewers — Claude variants (default)

Run inside Claude Code sessions. Spawned by `/ai-sdlc execute` Step 7b.

| Agent | Model | Description |
|-------|-------|-------------|
| `code-reviewer` | inherit | Code quality review: bugs, logic errors, conventions |
| `test-reviewer` | inherit | Test coverage review: existence, quality, edge cases |
| `security-reviewer` | inherit | Security review: OWASP vulnerabilities, injection, secret exposure |

### Reviewers — Codex variants (cross-harness)

Shell out to `codex exec` internally. Use when the developer ran on Claude Code (cross-harness independence) or when Codex is preferred for cost/latency reasons.

**Spawning:** `Agent(subagent_type='ai-sdlc:code-reviewer-codex')` in a slash command body, or by choosing the `-codex` suffix in the `/ai-sdlc execute` harness selection step.

| Agent | Harness | Description |
|-------|---------|-------------|
| `code-reviewer-codex` | `codex` | Code quality review via Codex CLI (`codex exec --model o4-mini`) |
| `test-reviewer-codex` | `codex` | Test coverage review via Codex CLI (`codex exec --model o4-mini`) |

> **Why no `security-reviewer-codex`?** Security review stays on Claude Opus (per `feedback_subagent_model_selection.md`) for its reasoning-heavy OWASP analysis. Codex variants are alternatives only for code/test review where o4-mini is adequate.

All Codex reviewer variants return the **same JSON envelope** as their Claude counterparts:

```json
{
  "approved": true,
  "findings": [
    { "severity": "minor", "file": "src/foo.ts", "line": 42, "message": "..." }
  ],
  "summary": "Overall assessment in 1-2 sentences"
}
```

This makes harness selection transparent to the Step 8 verdict aggregator — no parsing changes needed.

### Utility agents

| Agent | Harness | Description |
|-------|---------|-------------|
| `rebase-resolver` | `claude-code` | Resolves mechanical rebase conflicts (CHANGELOG, lock files, prettier drift) |
| `refinement-reviewer` | `claude-code` | Stage B Definition-of-Ready evaluator (RFC-0011 Phase 2b semantic gates) |

## Slash Commands (`commands/`)

| Command | Description |
|---------|-------------|
| `/ai-sdlc execute <task-id>` | Full pipeline: worktree → developer → 3 reviewers → PR |
| `/ai-sdlc execute-parallel [--count N] [--tasks ...]` | Spawn N concurrent execute sessions in tmux (max 5). Resource-gated; operator confirms before spawn. AISDLC-462. |
| `/ai-sdlc execute-parallel-status` | Live status table of all parallel sessions (task, pane, status, step, PR, heartbeat-age). AISDLC-462. |
| `/ai-sdlc execute-parallel-cleanup [--tasks ...]` | Kill in-flight tmux panes; archive session files to `sessions/archived/`. AISDLC-462. |
| `/ai-sdlc review-pr` | Standalone review pass on the current branch |
| `/ai-sdlc rebase <pr>` | Mechanical rebase + re-sign of an open PR |
| `/ai-sdlc triage` | Issue triage (DOR evaluation + PPA trust) |
| `/ai-sdlc pipeline-status` | Pipeline status summary |
| `/ai-sdlc cleanup [<task-id>]` | Remove stale worktrees |

## Skills (`skills/`)

| Skill | Description |
|-------|-------------|
| `ai-sdlc-governance` | Auto-loaded governance rules, blocked actions, and pre-commit checklist |
| `decision-rubric` | Five-part rubric (problem → research → options → recommendation + counter-argument → question) for putting non-trivial design/policy decisions to the operator; applies to open questions from any work item (RFC, backlog task, GitHub/Jira/Linear issue) |

## Install topologies + path resolution (AISDLC-245.4, AISDLC-272, AISDLC-557)

Slash command bodies invoke `@ai-sdlc/pipeline-cli` CLIs and plugin-internal scripts. They must work across **six distinct install topologies**:

| # | Topology | `CLAUDE_PLUGIN_DIR` | `CLAUDE_PLUGIN_ROOT` | `pipeline-cli` location |
|---|----------|---------------------|----------------------|-------------------------|
| 1 | Remote marketplace install (bundled deps) | Set — deps present | Set | `$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/` |
| 2 | Local marketplace install (no npm install) | Set — **deps missing** | Set | Self-heal via `install-runtime-deps.sh`, then probe cache |
| 3 | Marketplace (env injection variant) | Unset | Set — deps present | `$CLAUDE_PLUGIN_ROOT/node_modules/@ai-sdlc/pipeline-cli/` |
| 4 | Plugin cache probe (env unset) | Unset | Unset | `~/.claude/plugins/cache/<mp>/ai-sdlc/<version>/node_modules/@ai-sdlc/pipeline-cli/` (read-only — never self-heals) |
| 5 | Dogfood monorepo (this repo) | Unset | Unset | `$(pwd)/pipeline-cli/` relative to repo root |
| 6 | **Self-location fallback (AISDLC-557, last resort)** | Unset | Unset | Self-heal against the directory `resolve-pipeline-cli.sh` itself lives in |

> **Why topology 2 exists:** The local marketplace installer (`/claude plugin install` against a local `marketplace.json`) copies plugin files to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` but does NOT run `npm install`. So `runtimeDependencies` declared in `plugin.json` are never installed for local marketplace setups. The `scripts/install-runtime-deps.sh` self-heal script fills this gap.

> **Why topology 6 exists (AISDLC-557):** a second adopter report found that when `CLAUDE_PLUGIN_DIR` and `CLAUDE_PLUGIN_ROOT` are BOTH unset, self-heal was completely unreachable — topologies 1-3 are the only ones that ever attempt it, and topology 4 (cache probe) deliberately stays read-only (see the security note in `resolve-pipeline-cli.sh` — that's the PR #482 fix for the cache-WALK vulnerability, which is a different failure mode from this one). Topology 6 derives the plugin dir from `resolve-pipeline-cli.sh`'s own on-disk location as a genuine last resort, so self-heal gets a chance to run even when neither env var made it through. This does NOT reintroduce the PR #482 vulnerability: topology 6 only ever targets the exact directory the currently-executing script lives in — no directory is walked, compared, or selected the way the removed cache-walk topology did.

### Resolution algorithm

`scripts/resolve-pipeline-cli.sh` tries each topology in order and exits 0 with the path on the first match, or exits 1 with a clear actionable error naming the broken topology:

```
1. $CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin exists → use it
2. $CLAUDE_PLUGIN_DIR set but deps missing → self-heal via install-runtime-deps.sh
3. $CLAUDE_PLUGIN_ROOT/node_modules/@ai-sdlc/pipeline-cli/bin exists → use it
4. ~/.claude/plugins/cache/*/ai-sdlc/*/node_modules/... exists → use highest version
5. $(pwd)/pipeline-cli/bin exists → use it (dogfood monorepo)
6. Self-location fallback: neither env var set → self-heal against the dir
   this script itself lives in, then retry (AISDLC-557, last resort)
7. Nothing found → exit 1 with actionable error + PIPELINE_CLI_BIN override hint
```

### Usage in slash command bodies

**Rule: never hardcode `node pipeline-cli/bin/cli-XXX.mjs` or `node ai-sdlc-plugin/scripts/XXX.mjs` in a slash command body.** Use the portable preamble:

```bash
# PLUGIN_SCRIPTS_DIR — resolves plugin-internal scripts (compute-slug.mjs etc.):
# Must be set FIRST — resolve-pipeline-cli.sh lives under PLUGIN_SCRIPTS_DIR.
PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_DIR:-${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}}/scripts"

# PIPELINE_CLI_BIN — resolves across all 5 install topologies (AISDLC-272).
# Override: export PIPELINE_CLI_BIN=/path/to/pipeline-cli/bin to skip resolution.
if [ -z "${PIPELINE_CLI_BIN:-}" ]; then
  PIPELINE_CLI_BIN=$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh") || exit 1
fi
```

Then invoke CLIs as:

```bash
# pipeline-cli binary
node "$PIPELINE_CLI_BIN/cli-deps.mjs" preflight "$TASK_ID" ...

# plugin-internal script
node "$PLUGIN_SCRIPTS_DIR/compute-slug.mjs" "$TASK_FILE"
```

### Manual self-heal (local marketplace installs)

If you installed via a local marketplace and `@ai-sdlc/pipeline-cli` is missing:

```bash
bash ~/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/<version>/scripts/install-runtime-deps.sh
```

Or override `PIPELINE_CLI_BIN` in your shell before launching Claude Code:

```bash
export PIPELINE_CLI_BIN=/path/to/ai-sdlc/pipeline-cli/bin
```

**Note on `CLAUDE_PLUGIN_ROOT`:** for plugin-internal scripts already using `${CLAUDE_PLUGIN_ROOT}` (e.g. `sign-attestation.mjs` invocations in `/ai-sdlc execute` Step 10.5 and `/ai-sdlc rebase`), leave those unchanged — Claude Code injects `CLAUDE_PLUGIN_ROOT` at session start and it is always available in the main session context.

**Enforcement:** `ai-sdlc-plugin/commands/execute.test.mjs` and `orchestrator-tick.test.mjs` both contain assertions (AISDLC-245.4 + AISDLC-272 suites) that scan the command body for bare `node pipeline-cli/bin/...` invocations and fail the test run if found. `ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs` tests each topology in isolation. When adding a new slash command, copy the path-resolution preamble above and add a similar regression test.

## Attestation pre-push hook — shipping + install (AISDLC-555)

`/ai-sdlc execute` Step 10 does not sign attestations inline; it writes reviewer
verdicts to `.ai-sdlc/verdicts/<task-id>.json` and delegates the actual DSSE
sign + commit to a **git pre-push hook** (AISDLC-133). Two things have to be
true for that hook to ever fire in an adopter repo:

1. **The hook script has to ship somewhere the adopter can reach it.** It does:
   `ai-sdlc-plugin/scripts/check-attestation-sign.sh` — installed alongside
   `sign-attestation.mjs` in every topology (marketplace cache,
   `CLAUDE_PLUGIN_ROOT` checkout, or this monorepo). It resolves the signer
   relative to its **own on-disk directory** (not `$CLAUDE_PLUGIN_ROOT`, not the
   worktree root), so it works even when a bare `git push` in a plain terminal
   never inherited any Claude Code env var. This monorepo's own dogfood
   `.husky/pre-push` is unaffected — it still calls the separate, unmodified
   `scripts/check-attestation-sign.sh` copy at the repo root directly.

2. **Something has to WRITE the hook into the adopter's repo.** `ai-sdlc init
   --with-attestation` (or `--add attestation`) already does this — it was
   producing a `.husky/pre-push` block that checked ONLY the repo-relative
   `./scripts/check-attestation-sign.sh` path, which never exists outside this
   monorepo. AISDLC-555 fixed the block (`HUSKY_PREPUSH_SIGN_SNIPPET` in
   `orchestrator/src/cli/commands/init-templates.ts`) to resolve the script the
   same way slash-command bodies do: repo-local copy first (dogfood
   back-compat), then `$CLAUDE_PLUGIN_ROOT` / `$CLAUDE_PLUGIN_DIR` (git push run
   inside a Claude Code session), then a **read-only** plugin-cache probe (bare
   terminal, matching the security posture of `resolve-pipeline-cli.sh`
   topology 4 — never self-heals from a user-writable cache dir).

**Entry point.** `ai-sdlc init --with-attestation` / `--add attestation` is the
canonical, already-discoverable entry point — this is "whatever an adopter
already runs" (task Scope item 3), not a new command to learn.
`applyFeatureSelection()`'s hook-writing block in `init-features.ts` is the
independently callable, reusable **installer**: it takes `(projectDir,
selection, flags, adapters)`, is idempotent (`appendOnce` keyed on the
`# ai-sdlc:attestation-sign-block` sentinel — a second run is a no-op), and
appends to rather than clobbers a pre-existing hook. AISDLC-560's `init`
/ `doctor` work should call this function (or invoke `applyFeatureSelection`
with `selection.attestation = true`) rather than reimplementing hook-writing.

**Husky vs. non-husky (AC #4).** `resolveHookTarget(projectDir, adapters)`
decides the target file:

- `package.json` parses and does **not** declare a `husky` dependency →
  `.git/hooks/pre-push` — git's own native hook path, always executed
  regardless of husky configuration.
- Everything else (no `package.json`, unreadable/malformed `package.json`, or
  `husky` IS declared) → `.husky/pre-push` — the pre-AISDLC-555 default. This
  fails open to the common case: most repos running `ai-sdlc init
  --with-attestation` are JS/TS projects that already use, or will shortly
  `npm install` and pick up, husky.

Either target is `chmod 0755`'d after every write/append — a freshly written
hook that isn't executable is silently never run by git, which would have
looked like AC #2 passing when it hadn't.

**Verified end-to-end outside the monorepo (AC #5):** a scratch git repo (no
ai-sdlc git history, no inherited hooks) with a fake plugin install directory
(built `@ai-sdlc/orchestrator` + `@ai-sdlc/pipeline-cli`, plus the two
`ai-sdlc-plugin/scripts/*` files) reproduced the full round trip in two
configurations: (a) `CLAUDE_PLUGIN_ROOT` set (the `/ai-sdlc execute` push path)
and (b) neither env var set, with the fake plugin install placed under
`~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/` (the bare-terminal
`git push` path). Both produced a **committed v6 DSSE envelope** from a verdict
file present at push time, and a second run was a clean idempotent no-op.

## `ai-sdlc init` — CI-safe by default (AISDLC-263)

`ai-sdlc init` runs the interactive feature wizard by default. When `process.stdin` is not a TTY (CI runners, agent bash sessions, Docker containers without `-it`, piped input), the wizard automatically falls through to `--yes` defaults — all features on — rather than hanging or throwing an unhandled error.

```bash
# These all work without hanging or prompting:
ai-sdlc init               # in any CI step / agent bash
ai-sdlc init < /dev/null   # explicit non-TTY simulation
```

When auto-fall-through fires, the CLI prints:

```
Non-TTY stdin detected — auto-accepting all feature defaults (equivalent to --yes).
Pass --yes explicitly to suppress this message.
```

To be explicit, pass `--yes` (recommended for CI scripts — makes intent clear and suppresses the auto-fall-through log line):

```bash
ai-sdlc init --yes
```

## Cross-harness review

See `docs/operations/cross-harness-review.md` for the bidirectional convention, cost/latency comparison, and Codex CLI prerequisites.

## MCP Server (`mcp-server/`)

The plugin bundles an MCP server (`@ai-sdlc/plugin-mcp-server`) exposing task management and verdict aggregation tools. See `mcp-server/src/tools/` for the tool definitions.

## Testing

```bash
# Agent definition tests (Node built-in runner)
node --test ai-sdlc-plugin/agents/agents.test.mjs

# Command body tests
node --test ai-sdlc-plugin/commands/execute.test.mjs

# Path resolution topology tests (AISDLC-272)
node --test ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs

# MCP server tests (Vitest)
pnpm --filter @ai-sdlc/plugin-mcp-server test
```
