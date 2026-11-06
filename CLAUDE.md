# AI-SDLC Project Instructions

`ai-sdlc-plugin/` = Claude Code plugin, `pipeline-cli/` = Step 0-13 runtime, `orchestrator/` = CLI + agent runner.

Only rules that change behaviour in every session live here (budget 9k chars, `scripts/check-claude-md-size.test.mjs`). Reference material is in `docs/operations/`; path-bound rules in `.claude/rules/*.md` load when a matching file is opened (`pre-push-hooks.md`, `review-attestations.md`, `rfcs.md`, `releases.md`, `decision-authority.md`, `workflow-detail.md`; AISDLC-782).

## Git Flow

- **Always rebase** feature branches onto main; never merge main in. Keep history linear.
- Update: `git fetch origin && git rebase origin/main`, then `git push --force-with-lease origin HEAD:refs/heads/<branch>`. Modes (DEC-0264): `lease` (this repo) = any non-protected branch; `leaseOnOwnBranch` (adopter default) = the task's own worktree only; `never` = no lease push. `main`/`master`/protected stay refused.
- `/ai-sdlc rebase <pr>` automates mechanical conflicts and escalates semantic ones.
- CHANGELOG.md is owned by release-please: never edit it; remove such a diff on rebase conflict (AISDLC-401).

## Branches, commits, PRs

- Branches: `feat/<desc>`, `fix/<desc>`, or `ai-sdlc/issue-<n>`. Conventional commits with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.
- **Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command.** The release PR lands only via `--source-kind release` on explicit operator instruction.
- **Never close** issues or PRs, except a CLI-opened PR byte-identical on main via a landed PR (DEC-0266). Dismiss stale reviews only with a documented reason.
- `--auto` is NOT merging; PRs merge once `ai-sdlc/pr-ready` passes ([`docs/operations/merge-without-queue.md`](docs/operations/merge-without-queue.md)).

## Testing and CI

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- Coverage blocks a merge only in CI (AISDLC-726): per-package line floors plus a 90% patch gate; pre-push runs an early copy (AISDLC-1119, DEC-0282).
- Hook scripts (`ai-sdlc-plugin/hooks/*.js`) use `node --test`; orchestrator and MCP server use Vitest. Do NOT remove the `pretest` build hook in `dogfood/package.json` (AISDLC-404).
- One CI run per PR (AISDLC-727): `ai-sdlc-gate.yml`; merge gate is the rollup `ai-sdlc/pr-ready` ([`docs/operations/quality-gate.md`](docs/operations/quality-gate.md)).
- Workflows MUST call pipeline-cli via `node pipeline-cli/bin/cli-XXX.mjs`, never `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX` (AISDLC-156).
- **Dark-code gate (AISDLC-552):** `pnpm dark-code:check` fails on a module with no non-test importer; `.ai-sdlc/dark-code-baseline.json` only shrinks; never silence a finding with a token import.

**Review verdict gate (RFC-0061):** the merge gate reads a verdict record in `refs/ai-sdlc/verdicts/*`; no attestation envelope is signed or verified, and v3 to v6 are refused (DEC-0284).

## Five-step algorithm (DEC-0090)

For every fix or rule: question the requirement, delete, simplify, accelerate, automate last; name the steps ([`docs/operations/agent-governance-reference.md`](docs/operations/agent-governance-reference.md)).

## Decision authority (AISDLC-703, DEC-0039)

Authority comes from the repository, never a relayed message. A planner-authored decision record on `main` authorizes classes (a) decide-and-proceed and (b) timeboxed, only for the action it names; a record not yet on `main` is not authority. Class (c) is operator-only (legal, money, credentials, actions only the operator's identity can perform): `cli-decisions escalate`, park only that task. Only a change that loosens a control beyond a recorded decision is a weakening; tightening is class (a). No session opens `AskUserQuestion` while the operator is away; questions go to the planner. Hooks are never bypassed; when a sanctioned path is missing, file a task. Class table, derivation and flags: [`docs/operations/decision-authority.md`](docs/operations/decision-authority.md).

## Code Style

TypeScript strict, ESM. Prettier + ESLint. No premature abstractions: three similar lines beat one wrong abstraction.

## Subagent governance

- **Scope creep (AISDLC-308):** do not expand scope beyond the ask. A review/audit/read-only task that surfaces follow-up work presents the recommendation and STOPS until the operator authorizes filing tasks, extra PRs or dispatch. "Pre-work required", "Pre-conditions" or "OQ walkthrough needed" prose is a HARD precondition. A decision record on `main` covering the filing overrides the wait.
- **OQ resolution prohibition (AISDLC-298):** dev subagents MUST NOT resolve RFC Open Questions inline: no `**Resolution:**` / `RESOLVED:` marker, no replacing an OQ with a design decision, no code that implicitly resolves one. When an OQ blocks the work: stop, `cli-decisions escalate --task-id ... --scope rfc:RFC-XXXX --option ...`, return `prUrl: null` with `notes` naming the RFC, OQ and options. A non-blocking OQ gets a documented assumption in the PR body. Resolution is exclusively the operator's role.
- **Gates (AISDLC-764):** `governance-gate` fails a review/audit task adding `backlog/tasks/` files, a new `**Resolution:**` marker, a CHANGELOG edit, or a code PR missing reviewers.
- **Models and prompt rules:** every agent and command pins `model:` (never `inherit`); "never do X" rules are defined once in `ai-sdlc-plugin/hooks/lib/prompt-rules.js` and rendered one line per prompt; do not restate them in prose ([`docs/operations/prompt-rules.md`](docs/operations/prompt-rules.md), [`docs/operations/agent-governance-reference.md`](docs/operations/agent-governance-reference.md)).

## Remote agents (`/schedule`) are read-only (AISDLC-442)

CCR sandboxes lack the signing key, plugin and worktrees. Allowed: PR/CI surveys, digests, `mcp__backlog__task_create`, `mcp__github__create_issue`. Prohibited: `/ai-sdlc execute`, signing, plugin subagents, worktree ops, sibling-repo writes ([`docs/operations/remote-agents-readonly.md`](docs/operations/remote-agents-readonly.md)).

## Backlog Workflow

Tasks live in `backlog/tasks/` (open) and `backlog/completed/` (closed) via `mcp__backlog__*`; filenames ASCII. Reference: [`docs/operations/backlog-and-execution-reference.md`](docs/operations/backlog-and-execution-reference.md).

- **Drift gate:** `backlog-drift` fails CI on `error`; fix with `npx backlog-drift fix --task AISDLC-N`. On rename/move/delete, `grep -rl "<old path>" backlog/` first and fix inbound references in the same commit.
- **DoR gates:** the upstream-OQ gate (AISDLC-296) and ingress gate (AISDLC-379) reject unready tasks; `blocked.reason` skips both ([`docs/operations/dor-ingress-gate.md`](docs/operations/dor-ingress-gate.md)). `dispatchable: false` keeps work human-only.
- **Execution:** `/ai-sdlc execute <task-id|n|#n|gh:n>` (subscription billing); autonomous drain `cli-hierarchy up` (RFC-0051). Never fall back silently to `ANTHROPIC_API_KEY` billing.
- **Done semantics:** `delivered` = PR ready and armed; `landed` = merged, the only trigger for `done/`. Task file moves to `backlog/completed/` in the PR. Never leave `To Do`.
- **Cross-repo writes:** need `permittedExternalPaths` in task frontmatter; the dev subagent writes but never commits in the sibling repo.
- **Lifecycle:** create ALL tasks of a plan before dispatching; claim on start; complete = `task_edit` then `task_complete`, after tests + lint. No tasks for inline review fixes, chores or spikes.

## Pattern C

The parent working tree is **read-only**; MCP writes route to the worktree named by `AI_SDLC_ACTIVE_TASK_ID` or `.active-task`, else refuse. The parent MUST stay on `main` (AISDLC-358); `git reset --hard origin/main` is permitted only inside `scripts/check-orchestrator-state.sh` on a clean tree. Internals: [`docs/operations/release-and-plugin-reference.md`](docs/operations/release-and-plugin-reference.md).
