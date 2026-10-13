# AI-SDLC Project Instructions

`ai-sdlc-plugin/` = Claude Code plugin, `pipeline-cli/` = Step 0-13 runtime, `orchestrator/` = CLI + agent runner.

Only rules that change behaviour in every session live here (re-read every turn; budget 15k characters, enforced by `scripts/check-claude-md-size.test.mjs`). Reference material is in `docs/operations/`, one pointer per moved section.

## Git Flow

- **Always rebase** feature branches onto main; never merge main in. Keep history linear (no `update-branch` merge).
- Update: `git fetch origin && git rebase origin/main`, then `git push --force-with-lease origin HEAD:refs/heads/<branch>`. Only that explicit spelling (and `--force-with-lease=<branch>:<sha>`) is accepted. `leaseOnOwnBranch` is the default `allowForcePush` (AISDLC-710); `never` blocks every lease push.
- `/ai-sdlc rebase <pr>` automates mechanical conflicts and escalates semantic ones. Never force-push `main`/`master`.
- CHANGELOG.md is owned by release-please: never edit it on a feature branch; remove such a diff on rebase conflict (AISDLC-401).

## Branches, commits, PRs

- Branches: `feat/<desc>`, `fix/<desc>`, or `ai-sdlc/issue-<n>`. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`) with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.
- **Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`, rendered into the session hard rules; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command.** The release-please PR (`chore: release main`) lands only via `cli-merge-if-eligible --source-kind release` on explicit operator instruction (see Releases).
- **Never close** issues or PRs. Dismiss stale reviews only with a documented reason (truncation, API errors).
- `auto-enable-auto-merge.yml` sets `--auto --squash` (no merge queue); `--auto` is NOT merging. PRs merge once `ai-sdlc/pr-ready` passes ([`docs/operations/merge-without-queue.md`](docs/operations/merge-without-queue.md)).

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- Coverage is NOT a local gate; CI is the single gate (AISDLC-726): per-package line floors of 85-90 plus a 90% patch gate.
- Hook scripts (`ai-sdlc-plugin/hooks/*.js`) use `node --test`; orchestrator and MCP server use Vitest.
- Do NOT remove the `pretest` build hook in `dogfood/package.json` (AISDLC-404).
- `CLAUDE.md` stays under 15k characters; move reference material to `docs/operations/` with a pointer.

## Hooks (pre-push chain)

`.husky/pre-push` runs, in order: dark-code check (`AI_SDLC_SKIP_DARK_CODE_GATE=1`), `squash-attestation-chores.sh`, `pre-push-fixups.sh`, `check-task-moved.sh` (moves the task file to `backlog/completed/`; must run BEFORE attestation-sign), `check-attestation-sign.sh` (signs/verifies the DSSE envelope). Per-gate skips are `AI_SDLC_SKIP_*` and are never a routine shortcut. Emergency only: `AI_SDLC_BYPASS_ALL_GATES=1` (document in the PR body; [`docs/operations/emergency-bypass.md`](docs/operations/emergency-bypass.md)).

- **Worktree hooks (AISDLC-693):** `core.hooksPath` is `.husky/_` (gitignored, made by `prepare`); a worktree without it runs NO gate. Never disable install scripts. `ai-sdlc doctor` check `worktree-hooks` lists affected worktrees.
- DoR and backlog-drift run in CI only; run by hand: `node pipeline-cli/bin/cli-dor-check.mjs --task <path>`, `npx backlog-drift check`.
- Per-hook behaviour and skips: [`docs/operations/pre-push-and-ci-reference.md`](docs/operations/pre-push-and-ci-reference.md).

## CI behavior

- One CI run per PR (AISDLC-727): only `ai-sdlc-gate.yml` runs CI on `pull_request`; open PRs are rebased only on conflict.
- Merge gate is the single rollup `ai-sdlc/pr-ready` (`ai-sdlc-gate.yml`): [`docs/operations/quality-gate.md`](docs/operations/quality-gate.md). `main-health-monitor.yml` = single main-push suite ([`docs/operations/main-health-monitor.md`](docs/operations/main-health-monitor.md)).
- Workflows MUST call pipeline-cli via `node pipeline-cli/bin/cli-XXX.mjs`, never `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX` (workspace own-bins do not resolve; AISDLC-156).
- **Dark-code gate (AISDLC-552):** `pnpm dark-code:check` (in `pnpm test`) fails on a module with no non-test importer and on non-test source using a test double. `.ai-sdlc/dark-code-baseline.json` only shrinks; never silence a finding with a token import.

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
- **Model defaults:** every agent and command pins `model:` (never `inherit`; `pnpm test:plugin-model-pins-gate`): developer and reviewers sonnet, `review-executor*` haiku, `security-reviewer` opus. Route code/test review to `-codex` variants on dispatch paths; never wrap mechanical work (sign, reconcile, rebase) in subagents. List: [`docs/operations/agent-governance-reference.md`](docs/operations/agent-governance-reference.md).
- **Prompt rules live in one source (AISDLC-651.2):** "never do X" rules are defined once in `ai-sdlc-plugin/hooks/lib/prompt-rules.js` and rendered as one line per agent/command; do not restate them in prose ([`docs/operations/prompt-rules.md`](docs/operations/prompt-rules.md)).

## Review attestations

- **Required for code PRs.** `/ai-sdlc execute` runs three reviewers and writes a DSSE envelope `.ai-sdlc/attestations/<patch-id>.v6.dsse.json`. `verify-attestation.yml` posts `ai-sdlc/attestation`, which feeds the `ai-sdlc/pr-ready` rollup; branch protection requires only `ai-sdlc/pr-ready`. Docs-only PRs skip it.
- **v6 is the default schema** (RFC-0042): Merkle tree over `.ai-sdlc/transcript-leaves.jsonl` (`cli-attestation.mjs emit-leaf`). Opt out with `--schema-version v5` or `AI_SDLC_V5_LEGACY=1`.
- **Lockstep (AISDLC-618):** `PATCH_ID_EXCLUSIONS` (`pipeline-cli/src/attestation/patch-id.ts`) has THREE copies that change together: `ATTESTATION_PATH_EXCLUSIONS` in `scripts/verify-attestation.mjs` and `PATCH_ID_EXCLUSIONS_FALLBACK` in `scripts/check-attestation-sign.sh`. Never add source, tests, configs or RFCs to `CONTENTHASH_SHARED_CHURN_FILES`.
- A v6 envelope proves a real review ran against the exact code, not reviewer independence (AISDLC-568).
- Algorithms, rebase relaxations, history: [`docs/operations/attestation-reference.md`](docs/operations/attestation-reference.md), [`docs/operations/attestation-troubleshooting.md`](docs/operations/attestation-troubleshooting.md).
- `ai-sdlc-review.yml` (`Analyze PR`, `Post Review Results`) is the CI review tier for UNTRUSTED PRs only (fork, non-collaborator, or a bot such as Dependabot; AISDLC-824); trusted PRs never enter it.

## Remote agents (`/schedule`) are read-only (AISDLC-442)

CCR sandboxes lack the signing key, plugin and worktrees. Allowed: PR/CI surveys, digests, `mcp__backlog__task_create`, `mcp__github__create_issue`. Prohibited: `/ai-sdlc execute`, signing, plugin subagents, worktree ops, sibling-repo writes. For local work, file a backlog task with full context. Tables and detection heuristics: [`docs/operations/remote-agents-readonly.md`](docs/operations/remote-agents-readonly.md).

## RFCs

`spec/rfcs/RFC-NNNN-*.md` ([process](spec/rfcs/README.md)). Lifecycle: `Draft` → `Ready for Review` → `Signed Off` → `Implemented` (or `Superseded`). Next number: the README Registry's "Next available number" line, never a file scan. `requires:` = runtime-code dependency (must be `Implemented`); `assumes:` = design-contract dependency (must exist); the DoR upstream-OQ gate blocks on `requires:` only. Semantics: [`docs/operations/backlog-and-execution-reference.md`](docs/operations/backlog-and-execution-reference.md).

## Backlog Workflow

Tasks live in `backlog/tasks/` (open) and `backlog/completed/` (closed); managed via `mcp__backlog__*` tools. Filenames must be ASCII.

- **`dispatchable: false`** (AISDLC-243) in frontmatter keeps the orchestrator from dispatching permanent human-only work (soak phases, investigations); default is dispatchable. `blocked.reason` is for temporary holds.
- **Drift gate:** `backlog-drift` checks every frontmatter reference resolves; CI fails on `error` severity. Fix with `npx backlog-drift fix --task AISDLC-N`. When you rename/move/delete a file, `grep -rl "<old path>" backlog/` first and fix inbound references in the same commit.
- **DoR gates:** the upstream-OQ gate (AISDLC-296) rejects tasks whose referenced RFC is not `Signed Off`/`Implemented` or has unresolved OQs; the ingress gate (AISDLC-379) fails `Evaluate backlog tasks changed by PR` on `needs-clarification`. A `blocked.reason` frontmatter override skips both (logged). Runbook: [`docs/operations/dor-ingress-gate.md`](docs/operations/dor-ingress-gate.md).
- **Execution:** `/ai-sdlc execute <task-id|n|#n|gh:n>` for internal work (subscription billing; issues close via `Closes #N`). Autonomous drain: `cli-hierarchy up` (RFC-0051). Never fall back silently to `ANTHROPIC_API_KEY` billing. Spawners and patterns: [`docs/operations/backlog-and-execution-reference.md`](docs/operations/backlog-and-execution-reference.md).
- **Done semantics:** the task file moves to `backlog/completed/` in the PR's own diff (dev subagent before push; `check-task-moved.sh` otherwise). Never leave `To Do` after implementation.
- **Cross-repo writes:** a task declares `permittedExternalPaths` in frontmatter; the PreToolUse hook resolves it from `<worktree>/.active-task`. Without it, cross-repo writes are denied. The dev subagent writes; it never commits in the sibling repo.
- **Lifecycle:** create ALL tasks of a plan before dispatching (in Pattern C use `mcp__plugin_ai-sdlc_ai-sdlc__task_create`); claim on start; complete = `task_edit` then `task_complete`, after tests + lint. No tasks for inline review fixes, chores or spikes. `finalSummary` template: reference above.

## Releases

**CHANGELOG.md is managed exclusively by release-please; never edit it** (one rolling `chore: release main` PR; [`docs/operations/release-flow.md`](docs/operations/release-flow.md)). Land the release PR only on explicit operator instruction: `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm` (drop `--arm` to merge now). Every non-private workspace package needs `publishConfig` (`pnpm lint:publishable`). See [`docs/operations/release-and-plugin-reference.md`](docs/operations/release-and-plugin-reference.md).

## Plugin MCP server root and Pattern C

In Pattern C (non-bare parent + `.worktrees/<task-id>/`) the parent working tree is **read-only**; MCP writes route to the worktree named by `AI_SDLC_ACTIVE_TASK_ID` or a per-worktree `.active-task` sentinel, else refuse. The parent MUST stay on `main` (AISDLC-358): `scripts/check-orchestrator-state.sh` auto-recovers a clean parent and aborts the tick on a dirty one. `git reset --hard origin/main` is permitted only inside that script on a clean tree; if it refuses, escalate to the Decision Catalog. Internals: [`docs/operations/release-and-plugin-reference.md`](docs/operations/release-and-plugin-reference.md).
