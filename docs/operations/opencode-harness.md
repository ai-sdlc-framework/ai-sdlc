# OpenCode Harness Execution Path

**Status:** Operational. The `opencode` harness adapter (RFC-0010 v23), the
in-tree `OpenCodeRunner` agent runner, the repo governance assets
(`opencode.json`, `.opencode/agents/developer.md`,
`.opencode/plugins/ai-sdlc-governance.js`), and the standalone contrib runner
(`contrib/runners/opencode/`) all ship in-tree.

**Applies to:** issue dispatch via `OpenCodeRunner`, parallel pipeline stages
with `harness: opencode` (RFC-0010 §13), and ad-hoc attended runs against the
repo.

**Companion docs:** [`adapter-authoring.md`](adapter-authoring.md),
[`codex-execution-path.md`](codex-execution-path.md),
[RFC-0010 §13](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md)

---

## Version contract — v2 only

The installed binary (`opencode v2.0.18`) is the reference. The adapter
declares `requires: { binary: 'opencode', versionRange: '>=2.0.0' }` and the
version probe parses `opencode --version` → `opencode v2.0.18`.

The `>=2.0.0` floor is deliberate: the v1 CLI lacks the entire v2 contract
(`run --standalone`, NDJSON `--format json`, in-process plugins, markdown
agents, the v1/v2 config normalizer). A v1 binary is therefore **unusable for
these stages**, not merely older — it fails the probe and is excluded from the
harness fallback chain.

The repo `opencode.json` sets `autoupdate: false` so the manually-managed
binary stays stable; the per-dispatch config injection repeats it (below).

## Isolation — `--standalone` is required

This machine runs the operator's background opencode service (desktop
`OpenCode.app`, `opencode-cli serve --service`; config in
`~/.config/opencode/service.json`, DB in `~/.local/share/opencode`). Every
programmatic invocation MUST pass `--standalone`: it starts a private server
instance with its own lifecycle and never touches the operator's service.

Consequences:

- All runner/adapter/runner.mjs spawn paths include `--standalone` — do not
  "simplify" it away.
- `opencode mcp list` has NO `--standalone` flag. Do NOT use it to validate a
  dispatch setup (it would query the operator's service). Validate with
  `opencode models` or the smoke run below.

## Local models — built-in LM Studio provider

The built-in `lmstudio` provider defaults to `http://127.0.0.1:1234/v1`
(LM Studio → Server tab). Model refs split on the FIRST slash:
`lmstudio/qwen/qwen3.8-27b` is valid (`provider/model[/variant]`).

- In-tree runner resolution (env read at call time): `ctx.model` →
  `OPENCODE_MODEL` → `AI_SDLC_MODEL`. A bare id without a slash gets an
  `anthropic/` prefix. No resolvable model → the dispatch fails loudly.
- The local model must be **agentic** (tool + MCP loop). The orchestrator
  does not use the non-agentic `generic-llm` provider path for dispatch.
- Practical limits of a ~27B local model: oversized single `write` payloads
  truncate (`Decode error (200 .../v1/chat/completions)` from LM Studio) —
  keep generated files to roughly ≤120 lines per write and retry. A live
  interactive session shares the GPU, so dispatched runs can take minutes;
  the 30 s runner heartbeats exist so the orchestrator does not declare a
  slow-but-alive run dead.

## Project discovery — what opencode reads from your repo

- `opencode.json` at the repo root. The v2 normalizer accepts BOTH v1 and v2
  keys; the repo file deliberately uses v1 keys so its `$schema`
  (`https://opencode.ai/config.json`) stays honest.
- `.opencode/plugins/*.js` — ESM plugins, auto-loaded (the governance plugin).
- `.opencode/agents/*.md` — markdown agents, auto-loaded (the `developer`
  agent); selected per run with `--agent <name>`.
- Watched for content: `.claude/skills`, `~/.claude/skills`,
  `~/.agents/skills`, `AGENTS.md`, `.claude/commands/*.md` (→ commands).
- `~/.config/opencode` is the user-level **service** config — it is NOT
  project configuration and is never read for project policy.

Note: adding the repo `opencode.json` + `.opencode/` also governs the
operator's **own interactive** opencode sessions in this repo (banner, deny
rules, MCP server). That dogfood parity is intended, not an accident.

## Permissions and governance — three layers

1. **Declarative** — `opencode.json` `permission`: a deny-only mirror of
   `.ai-sdlc/agent-role.yaml`. v1 key renames apply (`bash`→`shell`,
   `write`/`patch`→`edit`, `task`→`subagent`); patterns are case-sensitive
   wildcards and evaluation is **last-match-wins**; `deny` short-circuits
   before the plugin hook, and under `--auto` the hook may still override
   effect+message. Everything not explicitly denied falls through to the
   normal permission flow (auto-approved under `--auto`, prompted in
   interactive sessions) — the exact Claude Code PreToolUse semantics.
2. **Agent frontmatter** — `.opencode/agents/developer.md` carries only
   `permission: { task: "deny" }` (dispatch agents do not spawn subagents)
   plus `mode: all` and description.
3. **In-process plugin (authoritative)** — `.opencode/plugins/ai-sdlc-governance.js`
   re-applies the full `agent-role.yaml` policy at runtime: segment-aware
   command analysis (`&&`/`||`/`;`-split, first match per segment),
   worktree-relative path resolution, `permittedExternalPaths` via the active
   task, stash/branch hygiene floors, and telemetry. Keep the declarative
   layer and `agent-role.yaml` in sync when editing either.

**force-with-lease carve-out (known, intentional, strict):** the config denies
`git push --force*` and then re-allows `git push --force-with-lease*` (the
Definition of Done requires a lease push after the mandatory rebase). A bare
prefix glob is NOT safe, so the plugin (authoritative) allows ONLY a strict
lease: `--force-with-lease[=<ref>[:<sha>]]` with

- no other force flag (`--force`, `-f`/`-fu`) and no
  `--all/--branches/--tags/--mirror/--prune/--delete` (long options are
  matched by unambiguous-prefix, so `--mirr` counts as `--mirror`; an ambiguous
  prefix fails closed);
- every destination a plain branch name, `heads/<name>` or `refs/heads/<name>`:
  no `+` refspec, no glob (`*`), no `:dst` delete, no tags/notes refs, and never
  `main`/`master` (after stripping `refs/`/`heads/`, and including a final path
  component of `main`/`master`);
- `HEAD`, `@`, or no refspec at all resolved to the current branch of the
  session directory (`git -C <dir>` honoured) and denied when that branch is
  `main`/`master`, detached, or cannot be resolved (fail closed).

Command text is normalised before analysis (quote/`$VAR`/`${IFS}` obfuscation,
backslash-newline continuations, `env`/`command`/`exec`/`nice`/`time` prefixes).
`git -c alias.*` and push-rewriting `-c remote.*.push|mirror` are denied. A
force-ish push inside `bash -c`, `eval`, `xargs`, `$(...)` or backticks cannot
be verified statically and is denied — run the push as a plain top-level
command. The declarative layer re-denies the common bypass shapes after the
allow (last-match-wins) as defence in depth; globs cannot express the grammar,
so the plugin decides. The **old Claude Code hook denies even
`--force-with-lease`** — an existing spec conflict in the Claude layer,
deliberately not "fixed" in the port (flagged for the governance RFC).

**Policy snapshot:** `agent-role.yaml` (blockedActions/blockedPaths) and the
active task's `permittedExternalPaths` are read once when the plugin is set up,
so a later shell write to those files (shell writes are not path-governed) cannot
weaken enforcement. Limitation: a session that starts after such a write sees the
written state; dispatched runs load the plugin before the agent acts. Path checks
resolve symlinks (deepest existing ancestor) before comparing.

**Dispatched-run caveats:**

- `external_directory` is denied by default in dispatched runs, so a task's
  `permittedExternalPaths` cross-repo writes do NOT work under the opencode
  runner today (the declarative deny short-circuits the plugin's allowance).
- The project's `.opencode/plugins/*` and local MCP `command`s execute with the
  operator's privileges. Do not dispatch opencode against an UNTRUSTED PR
  checkout: its plugin code and MCP commands run before any governance applies.

**Harness config floor:** `opencode.json`, `opencode.jsonc` and `.opencode/**`
are denied for edits (declaratively and by the plugin) so an agent cannot
rewrite the policy that governs it. Adding them to `agent-role.yaml`
blockedPaths is an operator follow-up.

**Per-stage tool policy:** dispatched runs get a `permission` block in the
per-dispatch config: web tools and `external_directory` are denied by default.
A stage with an explicit `allowedTools` list that contains no edit-capable
tool (reviewer/classifier-type) runs WITHOUT `--auto`, with only its mapped
tools allowed.

**Snapshots:** v2 snapshots every step by default (the interactive undo
feature). The repo config keeps that for interactive use; dispatched runs get
`snapshot: false` injected per dispatch (see below).

## Dispatch — in-tree runner (`OpenCodeRunner`)

`orchestrator/src/runners/opencode.ts` mirrors `ClaudeCodeRunner`'s git flow
so behavior is consistent across runners:

1. baseline worktree snapshot (pre-existing untracked noise excluded)
2. `opencode run --standalone [--auto] --format json --model <ref> [--agent <name>] -- <prompt>`
   spawned in the worktree; 30 s heartbeats; line-buffered NDJSON parse
   (`step_start` / `text` / `tool_use` / `step_finish` / `error`)
3. exit 0 with a stream-level error and no final text → failure; otherwise
   tokens via `opencode session export --standalone <id>` (stream totals are
   the fallback)
4. `git add -- <changed>` → optional lint/format auto-fix → commit with the
   stage template + `Co-Authored-By`; cross-repo write warnings

There is **no in-tree auto-retry** (Claude Code precedent); contract retry
lives in the contrib runner (below).

**Child env channels** (set per dispatch):

| Env | Value | Consumer |
|---|---|---|
| `OPENCODE_BIN` | explicit binary path | `resolveOpenCodeBin` (→ `which opencode` → `~/.opencode/bin/opencode`) |
| `OPENCODE_AGENT` | optional, e.g. `developer` | `--agent` flag |
| `OPENCODE_MODEL` / `AI_SDLC_MODEL` | model ref | `--model` (after `ctx.model`) |
| `AI_SDLC_PROJECT_ROOT` | `ctx.workDir` | governance plugin root resolution |
| `AI_SDLC_ACTIVE_TASK_ID` | `ctx.issueId` | `permittedExternalPaths` — the sentinel files do **not** resolve from inside a real worktree, so the plugin needs this |
| `OPENCODE_CONFIG_CONTENT` | per-dispatch virtual config | opencode v2 config loader (below) |

**AISDLC-529:** a runner discovered via env (`OPENCODE_MODEL` /
`AI_SDLC_MODEL` set) registers with `source: 'env'` and NEVER auto-wins
over the `claude-code` default.

### Per-dispatch config injection (`OPENCODE_CONFIG_CONTENT`)

opencode v2 reads this env var as a **virtual config document merged LAST**
(per-key override; keys omitted here — `permission`, `agent` — survive from
the project's `opencode.json`). Verified against the installed 2.0.18 binary
(including that project permission survives and the env `snapshot` wins).

The runner builds it per dispatch:

- `autoupdate: false` — the binary must not self-update between the run and
  the `session export` that follows.
- `snapshot: false` — step snapshots are an interactive feature; the
  throwaway dispatch worktree does not need them (repo config keeps the
  default for interactive sessions).
- `mcp` — the project's `mcp` table with relative local `command` paths
  **re-anchored at the main clone root** (found via
  `git rev-parse --git-common-dir`, which resolves to the main repo's `.git`
  even from a linked worktree). Build artifacts are git-ignored
  (AISDLC-385) and absent from worktrees, so the relative path in the
  project config dangles there. Entries whose re-anchored script does not
  exist in the main clone either are dropped (a dead entry just adds a
  failed spawn to every run); `remote` entries, executable names, and
  flag-like args are never re-anchored.

## Dispatch — harness adapter (parallel stages)

Pipeline YAML: `harness: opencode` on any stage. `OpenCodeAdapter`
(`orchestrator/src/harness/adapters/opencode.ts`):

- `invoke` delegates to `runOpenCode` (the spawn primitive), passing the
  dispatcher's **complete stage prompt** through. The issue-framing
  `buildPrompt` is deliberately NOT applied on top — a stage prompt and an
  issue prompt are different shapes.
- Version probe: `opencode --version` against `>=2.0.0` (fail →
  `HarnessProbeFailed` warning, does not block load).
- Capabilities: all true; `maxContextTokens` declared 1 M — a conservative
  bound mirroring the claude-code precedent while the actual window varies by
  model (see RFC-0010 §13.3 matrix).
- `getAccountId()` = `sha256('opencode:' + key).slice(0,16)` over
  `OPENCODE_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`; **null for
  local inference** (no subscription window to pool).
- `availableModels()` = `OPENCODE_MODEL ?? AI_SDLC_MODEL ?? lmstudio/qwen/qwen3.8-27b`.
- Result mapping: stdout → `outputText`; export/stream tokens → input/output;
  cost (0 locally); exit 0 + stream error + empty stdout → `failure`;
  rejection with `(signal SIGTERM|SIGKILL)` → `timeout`; `artifactPaths`
  always `[]` (worktree writes, mirroring the claude-code adapter).

## Contrib external runner

`contrib/runners/opencode/runner.mjs` — a standalone `node` script (no build
step) for operators who want the dispatch outside the orchestrator package:
same contract (inline issue-framing prompt, spawn + NDJSON, session-export
tokens, git commit) **plus one contract retry via `--session <id>`** on
transport failure — the retry lives here, not in-tree. Emits a single JSON
result on stdout; exit 0/1. See `contrib/runners/README.md`.

## Tokens and cost accounting

Per-step `step_finish` parts carry `tokens` + `cost`, but the **final
step_finish is not guaranteed** — treat `opencode session export
--standalone <sessionID>` as authoritative (fast local DB read, no model
call). Mapping: `input` → inputTokens, `output + reasoning` → outputTokens,
`cache.read` → cacheReadTokens. Export message records carry `type`/`outcome`
—a trailing `idle` / `succeeded` record is the clean-completion signal.
Local models report cost 0.

## Telemetry

The governance plugin's `tool.execute.after` hook appends
`{ts, sid, tool, action, project}` to
`~/.local/share/opencode/usage-data/tool-sequences.jsonl` (override with
`AI_SDLC_TELEMETRY_DIR`) — the same shape as the Claude Code
`collect-tool-sequence.js` pipeline. Rewiring the engine to consume the
opencode path is a follow-up task.

## Smoke test (pre-PR checklist)

```bash
cd <repo>   # needs opencode.json + .opencode/ + a built mcp-server/dist
~/.opencode/bin/opencode run --standalone --auto --format json \
  --model lmstudio/qwen/qwen3.8-27b --agent developer \
  "reply with exactly: OK. Do not run any shell commands and do not modify any files."
# then, with the sessionID from the stream:
~/.opencode/bin/opencode session export --standalone <sessionID>
```

Expect: `step_start` + a text part of `OK` (no tool events); the export's
message records ending `idle` / `succeeded`; and **zero git side effects**
(HEAD unchanged, no new files). A 16 k-token input on the first step is
normal (251-line agent prompt + governance banner + AGENTS.md + MCP tools).

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `Decode error (200 POST .../v1/chat/completions)` | local model truncated an oversized response, or LM Studio hiccup | retry; keep generated files ≤ ~120 lines per write |
| Run takes many minutes | a live interactive session shares the GPU | not a failure — heartbeats are the liveness signal; let it finish |
| MCP tools missing in dispatch runs | `mcp-server/dist` not built in the **main** clone | `pnpm` build the mcp-server there; the injection then re-anchors it (fail-soft otherwise) |
| MCP server failure in an interactive **worktree** session | dist is git-ignored, absent from worktrees | rebuild dist in that worktree, or accept the soft-fail |
| `MODULE_TYPELESS_PACKAGE_JSON` warning | plain-node import of the ESM plugin | harmless — opencode's Bun runtime does not print it |
| Session appears to "never finish" (no final `step_finish`) | known v2 quirk — the final step_finish is not guaranteed | check `session export`; `idle`/`succeeded` is authoritative |
| `--agent developer: agent not found` | run outside the repo (no `.opencode/` discovery) | run from the repo root, or pass the agent via config |

