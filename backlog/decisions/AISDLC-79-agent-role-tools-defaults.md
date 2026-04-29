# Decision: `agent-role.yaml` tools list — intent-driven tier defaults

- **Status:** Accepted
- **Date:** 2026-04-28
- **Task:** AISDLC-79
- **Decision-makers:** AI-SDLC maintainers
- **Related:** Claude Code SDK tool surface (Task, WebFetch, WebSearch, Skill, NotebookEdit), `orchestrator/src/cli/commands/init.ts`

## Context

`ai-sdlc init` writes a starter `agent-role.yaml`. The pre-AISDLC-79 template hardcoded six tools (`Edit, Write, Read, Glob, Grep, Bash`) and silently omitted five tools the Claude Code SDK ships by default:

| Tool | What it does | Default surface? |
|---|---|---|
| `Task` | Spawn sub-agents | SDK default |
| `WebFetch` | Fetch a known URL | SDK default |
| `WebSearch` | Discover sources by query | SDK default |
| `Skill` | Load external skill packs | SDK default |
| `NotebookEdit` | Edit Jupyter notebooks | SDK default |

The omission was unintentional — the template predates these SDK tools and was never updated. Two failure modes resulted:

1. **Capability gap.** Tasks that legitimately need web access or notebook editing get a refusal from the agent because the role's `tools` list doesn't include the SDK tool name.
2. **Capability over-reach.** Bumping the template to "include everything" would silently grant `Task` (sub-agent spawning) and `Skill` (external pack loading) to every freshly initialized project, even when the use-case never needed them. Both increase cost amplification (sub-agents bill independently) and broaden the prompt-injection surface (web reads + skill packs pull untrusted content into context).

The default needs to be intentional, not "whatever the SDK ships."

## Options considered

### Option A — Track the SDK default (REJECTED)

Set `tools` to the full SDK default surface (`Edit, Write, Read, Glob, Grep, Bash, Task, WebFetch, WebSearch, Skill, NotebookEdit`) and let users subtract.

**Pros:** Zero capability gap. New users get every tool the SDK exposes.
**Cons:**
- Silently grants `Task` and `Skill` to projects that have no business spawning sub-agents or loading skill packs. Both are non-trivial security and cost decisions.
- Inverts the principle of least privilege. The role file is supposed to **constrain** the agent, not match the SDK's permissive default.
- Migration risk: existing dogfood projects on the old template would not get the new tools (they only run on `init`), so the SDK-default story only helps fresh installs anyway — at the cost of making fresh installs surprisingly permissive.

### Option B — Single explicit list, document each inclusion (REJECTED)

Keep one template. Update it to include `NotebookEdit` and add inline comments explaining why `Task`, `WebFetch`, `WebSearch`, `Skill` are intentionally omitted. Users edit the file by hand if they need more.

**Pros:** Simple. One file. No new flags.
**Cons:**
- Doesn't help research / data / meta workflows out of the box. Every research-focused project has to re-enable the same three tools by hand.
- Hand-editing YAML is the friction point we built `init` to remove. If we expect users to enable web access manually, we should at least make the choice ergonomic.

### Option C — Tier-based defaults via `init --role <tier>` (CHOSEN)

Three named tiers ship as separate templates. The default tier (`coding`) preserves the pre-AISDLC-79 behavior (no migration burden) plus `NotebookEdit` (parity with the SDK's filesystem editing surface). Higher tiers add tools only when their use-case justifies them.

| Tier | Tools | Use case |
|---|---|---|
| `coding` (default) | `Edit, Write, Read, Glob, Grep, Bash, NotebookEdit` | Bug fixes, small features, refactors |
| `research` | coding + `WebFetch, WebSearch` | Tasks needing external doc / RFC / package-registry lookups |
| `meta` | research + `Task, Skill` | Sub-agent fan-out, skill-pack-driven workflows |

**Pros:**
- Default stays narrow (least-privilege). Tools are added in deliberate steps — web access is one tier up from default; sub-agent spawning is two.
- The `--role` flag is discoverable via `ai-sdlc init --help` and the YAML comments document what each tier excludes and why.
- Zero migration cost for existing users — the default tier is the old default plus `NotebookEdit`. No existing project's `agent-role.yaml` gets overwritten by `init` (the existing skip-if-exists behavior is preserved).
- Each tier is a complete YAML template, so users see the full file and can edit further by hand. No tier inheritance / merging logic to debug.

**Cons:**
- Three templates to maintain instead of one. Mitigated by the comment headers being short and the tier list being closed (we don't expect a fourth tier).
- A user who picks `coding` and then realizes they need web access has to re-run `ai-sdlc init --role research` and accept that the existing file gets skipped. We document that they can either delete the old file first or hand-edit. Acceptable: tier promotion is a deliberate decision, not a thing we want to silently auto-resolve.

## Decision

**Option C.** Three tiers (`coding` default, `research`, `meta`) wired through a new `init --role <tier>` flag. Each tier is a separate complete template with inline comments explaining the inclusions and exclusions.

## Migration

**Nothing changes for current users.**

- `ai-sdlc init` with no flags = `--role coding` = the pre-AISDLC-79 template + `NotebookEdit`. The only delta vs. before is one additional tool in the default `tools:` list.
- `init` already skips existing `agent-role.yaml` files (the "already exists" branch in `initProject`). No project gets its role file overwritten. Projects on the old six-tool template stay on the old six-tool template until a maintainer chooses to regenerate.
- No flag day, no rebuild requirement, no schema change. The agent-role JSON schema's `tools` field is already an open `array<string>` (it doesn't enumerate accepted values), so the new tool names validate without any schema update.

## Mechanism

- **`orchestrator/src/cli/commands/init.ts`** — three template constants (`AGENT_ROLE_YAML_CODING`, `AGENT_ROLE_YAML_RESEARCH`, `AGENT_ROLE_YAML_META`), a typed tier enum (`AgentRoleTier`), a `getAgentRoleYaml(tier)` resolver, the new `--role <tier>` Commander option (default `coding`), and explicit validation that rejects unknown tier names with exit code 1.
- **`orchestrator/src/cli/commands/commands.test.ts`** — six new regression tests covering: default-no-flag, each `--role` value, invalid `--role` rejection, and the `getAgentRoleYaml` / `AGENT_ROLE_TIERS` exports.
- **`orchestrator/CHANGELOG.md`** — entry under `## Unreleased` documenting the new flag, the tier list, and the explicit "no migration required" guarantee.

## Out of scope (deliberately)

- **Mid-task tier promotion.** A running pipeline can't switch tiers — the role file is read once at agent start. Tier choice happens at `init` time. Out of scope to make this dynamic.
- **Schema enforcement of tier names.** `AgentRoleTier` is a TypeScript-side enum; the on-disk `agent-role.yaml` doesn't carry a `tier:` field (the tier is just the choice of template at init time, after which the file is just a `tools` list). If a future task wants to enforce tier metadata in the schema, that's a separate change.
- **Subtractive flags** (`--no-web`, `--no-task`, etc.). Three named tiers cover the workflows we have. We can add subtractive flags later if a real use-case shows up.

## Follow-up

- If a fourth workflow class emerges (e.g. a `data-engineering` tier with notebook-only + bigger file budget), add it as a fourth template + tier-enum entry.
- The dogfood `.ai-sdlc/agent-role.yaml` (this repo's own role file) is **not** regenerated by this change — it has its own custom tool list (`code-editor, terminal, test-runner`) that already diverges from the template. Out of scope to align it; that's a separate dogfood-cleanup task if maintainers want it.
