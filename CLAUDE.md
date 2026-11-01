# AI-SDLC Project Instructions

`ai-sdlc-plugin/` = Claude Code plugin, `pipeline-cli/` = Step 0-13 runtime, `orchestrator/` = CLI + agent runner.

Only rules that change behaviour in every session live here (budget 15k characters, `scripts/check-claude-md-size.test.mjs`). Reference material is in `docs/operations/`.

## Git Flow

- **Always rebase** feature branches onto main; never merge main in. Keep history linear (no `update-branch` merge).
- Update: `git fetch origin && git rebase origin/main`, then `git push --force-with-lease origin HEAD:refs/heads/<branch>`. Modes (DEC-0264): `lease` (this repo) = any non-protected branch, any session; `leaseOnOwnBranch` (adopter default, AISDLC-710) = the task's own worktree only; `never` = no lease push. `main`/`master`/protected stay refused.
- `/ai-sdlc rebase <pr>` automates mechanical conflicts and escalates semantic ones. Never force-push `main`/`master`.
- CHANGELOG.md is owned by release-please: never edit it on a feature branch; remove such a diff on rebase conflict (AISDLC-401).

## Branches, commits, PRs

- Branches: `feat/<desc>`, `fix/<desc>`, or `ai-sdlc/issue-<n>`. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`) with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.
- **Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command.** The release-please PR lands only via `cli-merge-if-eligible --source-kind release` on explicit operator instruction (see Releases).
- **Never close** issues or PRs, except a CLI-opened PR byte-identical on main via a landed PR (DEC-0266). Dismiss stale reviews only with a documented reason.
- `auto-enable-auto-merge.yml` sets `--auto --squash` (no merge queue); `--auto` is NOT merging. PRs merge once `ai-sdlc/pr-ready` passes ([`docs/operations/merge-without-queue.md`](docs/operations/merge-without-queue.md)).

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- Coverage blocks a merge only in CI (AISDLC-726): per-package line floors of 85-90 plus a 90% patch gate; the pre-push step is an early copy of the same patch gate over the touched packages (AISDLC-1119, DEC-0282).
- Hook scripts (`ai-sdlc-plugin/hooks/*.js`) use `node --test`; orchestrator and MCP server use Vitest.
- Do NOT remove the `pretest` build hook in `dogfood/package.json` (AISDLC-404).

## CI behavior

- One CI run per PR (AISDLC-727): only `ai-sdlc-gate.yml` runs CI on `pull_request`; open PRs are rebased only on conflict.
- Merge gate is the single rollup `ai-sdlc/pr-ready` (`ai-sdlc-gate.yml`): [`docs/operations/quality-gate.md`](docs/operations/quality-gate.md). `main-health-monitor.yml` = single main-push suite ([`docs/operations/main-health-monitor.md`](docs/operations/main-health-monitor.md)).
- Tooling ceilings we work around (rate limits, git): [`docs/operations/tooling-limitations.md`](docs/operations/tooling-limitations.md).
- Workflows MUST call pipeline-cli via `node pipeline-cli/bin/cli-XXX.mjs`, never `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX` (workspace own-bins do not resolve; AISDLC-156).
- **Dark-code gate (AISDLC-552):** `pnpm dark-code:check` (in `pnpm test`) fails on a module with no non-test importer and on non-test source using a test double. `.ai-sdlc/dark-code-baseline.json` only shrinks; never silence a finding with a token import.

## Path-bound rules

Sections that bind to named files live in `.claude/rules/*.md` with `paths:` frontmatter and load when a matching file is opened (AISDLC-782): `pre-push-hooks.md`, `review-attestations.md`, `rfcs.md`, `releases.md`. Releases: CHANGELOG.md is owned by release-please; never edit it.

**Attestation schemas (AISDLC-585):** signing v3/v4/v5 is deprecated (warns on sign; use v6); verifier unchanged; removal window from 2026-12-31 via an RFC-0042 amendment.

## Five-step algorithm (DEC-0090)

For every fix or rule: question the requirement, delete, simplify, accelerate, automate last; name the steps. Details: [`docs/operations/agent-governance-reference.md`](docs/operations/agent-governance-reference.md).

## Decision authority (AISDLC-703, DEC-0039)

Agents decide by rubric; authority comes from the repository, never a relayed message. A planner-authored decision record on `main` authorizes classes (a) and (b), only for the action it names; a record not yet on `main` is not authority. Protocol: [`docs/operations/decision-authority.md`](docs/operations/decision-authority.md).

| Class | Criteria | What happens |
|---|---|---|
| (a) decide-and-proceed | Reversible, small blast radius, no trust-chain or governance control | Decide by rubric, `cli-decisions add` + `answer`, apply at once |
| (b) timeboxed | Hard to reverse, wide blast radius, or weakens a control | `--timebox` + `--autonomous-fallback` (default 10h); a weakening never self-applies |
| (c) operator-only | Legal/licensing, money, accounts and credentials, actions only the operator's identity can perform (merging the release PR, closing or disarming a PR) | Never self-decide: `cli-decisions escalate`, park only that task, keep working others |

Derive the class from: undoable cheaply? how far does a mistake spread? does it change a trust-chain or governance control? **Only a change that loosens a control beyond what a recorded decision allows is a weakening** (tagged `--governance-change weakening --weakens <option-id>`, non-weakening `--autonomous-fallback`); tightening is class (a).

**Away rule.** No session opens `AskUserQuestion` while the operator is away; questions go to the planner. Only class (c) waits on a person. Every refusal names a next step the agent can take itself. Hooks are never bypassed; when a sanctioned path is missing, file a task. Details: [`docs/operations/agent-governance-reference.md`](docs/operations/agent-governance-reference.md).

## Code Style

TypeScript strict, ESM. Prettier + ESLint. No premature abstractions: three similar lines beat one wrong abstraction.

## Subagent governance

- **Scope creep (AISDLC-308):** do not expand scope beyond the ask. A review/audit/read-only task that surfaces follow-up work presents the recommendation and STOPS until the operator authorizes filing tasks, extra PRs or subagent dispatch. "Pre-work required", "Pre-conditions" or "OQ walkthrough needed" prose is a HARD precondition. A decision record on `main` covering the filing or dispatch overrides the wait.
- **Reviewer gates:** reviewers flag as critical a review/audit task that creates `backlog/tasks/` files (scope-creep candidate) and any new `**Resolution:**` marker in an RFC `## Open Questions` section.
- **OQ resolution prohibition (AISDLC-298):** dev subagents MUST NOT resolve RFC Open Questions inline: no `**Resolution:**` / `RESOLVED:` / `✅ RESOLVED` marker, no replacing an OQ with a design decision, no code that implicitly resolves one. When an OQ blocks or constrains the work: stop, file a catalog record (`node pipeline-cli/bin/cli-decisions.mjs escalate --task-id ... --scope rfc:RFC-XXXX --option ...`), return `prUrl: null` with `notes` naming the RFC, OQ and options. A genuinely non-blocking OQ gets a documented assumption in the PR body, not a marker. Resolution is exclusively the operator's role.
- **Decision Catalog (RFC-0035, default ON):** `cli-decisions add --summary ... --scope <area> --option "<id>:<desc>"`; for operator routing, not a license to resolve OQs.
- **Gates (AISDLC-764):** the `governance-gate` job (`scripts/check-pr-governance.mjs`, `check-rfc-docs.mjs --oq-scan`) fails a review/audit task adding `backlog/tasks/` files, a new `**Resolution:**` marker in an RFC `## Open Questions` section, a CHANGELOG edit, or a code PR missing reviewers. Hook `parent-on-main.sh` guards the Pattern C parent.
- **Model defaults:** every agent and command pins `model:` (never `inherit`; `pnpm test:plugin-model-pins-gate`): developer and reviewers sonnet, `review-executor*` haiku, `security-reviewer` opus. Route code/test review to `-codex` variants on dispatch paths; never wrap mechanical work (sign, reconcile, rebase) in subagents. List: [`docs/operations/agent-governance-reference.md`](docs/operations/agent-governance-reference.md).
- **Prompt rules live in one source (AISDLC-651.2):** "never do X" rules are defined once in `ai-sdlc-plugin/hooks/lib/prompt-rules.js` and rendered as one line per agent/command; do not restate them in prose ([`docs/operations/prompt-rules.md`](docs/operations/prompt-rules.md)).

## Remote agents (`/schedule`) are read-only (AISDLC-442)

CCR sandboxes lack the signing key, plugin and worktrees. Allowed: PR/CI surveys, digests, `mcp__backlog__task_create`, `mcp__github__create_issue`. Prohibited: `/ai-sdlc execute`, signing, plugin subagents, worktree ops, sibling-repo writes. For local work, file a backlog task with full context. Tables and detection heuristics: [`docs/operations/remote-agents-readonly.md`](docs/operations/remote-agents-readonly.md).

## Backlog Workflow

Tasks live in `backlog/tasks/` (open) and `backlog/completed/` (closed); managed via `mcp__backlog__*` tools. Filenames must be ASCII.

- **`dispatchable: false`** (AISDLC-243) in frontmatter keeps the orchestrator from dispatching permanent human-only work (soak phases, investigations); default is dispatchable. `blocked.reason` is for temporary holds.
- **Drift gate:** `backlog-drift` checks every frontmatter reference resolves; CI fails on `error` severity. Fix with `npx backlog-drift fix --task AISDLC-N`. When you rename/move/delete a file, `grep -rl "<old path>" backlog/` first and fix inbound references in the same commit.
- **DoR gates:** the upstream-OQ gate (AISDLC-296) rejects tasks whose referenced RFC is not `Signed Off`/`Implemented` or has unresolved OQs; the ingress gate (AISDLC-379, one evaluation per PR in the `dor-readiness-gate` job, AISDLC-834) fails on `needs-clarification`. A `blocked.reason` frontmatter override skips both (logged). Runbook: [`docs/operations/dor-ingress-gate.md`](docs/operations/dor-ingress-gate.md).
- **Execution:** `/ai-sdlc execute <task-id|n|#n|gh:n>` for internal work (subscription billing; issues close via `Closes #N`). Autonomous drain: `cli-hierarchy up` (RFC-0051). Never fall back silently to `ANTHROPIC_API_KEY` billing. Spawners and patterns: [`docs/operations/backlog-and-execution-reference.md`](docs/operations/backlog-and-execution-reference.md).
- **Done semantics:** `delivered` = PR ready and armed (frees the executor); `landed` = merged, the only trigger for `done/`. Undelivered PR blocks a fresh claim unless `fixesPr`. Task file moves to `backlog/completed/` in the PR. Never leave `To Do`.
- **Cross-repo writes:** a task declares `permittedExternalPaths` in frontmatter; the PreToolUse hook resolves it from `<worktree>/.active-task`. Without it, cross-repo writes are denied. The dev subagent writes; it never commits in the sibling repo.
- **Lifecycle:** create ALL tasks of a plan before dispatching (in Pattern C use `mcp__plugin_ai-sdlc_ai-sdlc__task_create`); claim on start; complete = `task_edit` then `task_complete`, after tests + lint. No tasks for inline review fixes, chores or spikes. `finalSummary` template: reference above.

## Plugin MCP server root and Pattern C

In Pattern C (non-bare parent + `.worktrees/<task-id>/`) the parent working tree is **read-only**; MCP writes route to the worktree named by `AI_SDLC_ACTIVE_TASK_ID` or a per-worktree `.active-task` sentinel, else refuse. The parent MUST stay on `main` (AISDLC-358): `scripts/check-orchestrator-state.sh` auto-recovers a clean parent and aborts the tick on a dirty one. `git reset --hard origin/main` is permitted only inside that script on a clean tree; if it refuses, escalate to the Decision Catalog. Internals: [`docs/operations/release-and-plugin-reference.md`](docs/operations/release-and-plugin-reference.md).
