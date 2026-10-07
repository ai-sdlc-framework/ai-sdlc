# CLAUDE.md reference: RFCs, releases, plugin MCP and Pattern C

This page holds the detailed text moved out of `CLAUDE.md` (AISDLC-742) to cut the per-call context floor. The operative rules stay in `CLAUDE.md`; the explanation, incident history and implementation detail live here, essentially verbatim. Section headings below are the original `CLAUDE.md` headings.

## RFCs

Live in `spec/rfcs/RFC-NNNN-*.md`. Process: [`spec/rfcs/README.md`](../../spec/rfcs/README.md). Template: [`spec/rfcs/RFC-0001-template.md`](../../spec/rfcs/RFC-0001-template.md).

**Lifecycle field** (frontmatter, separate from sign-off checklist): `Draft` → `Ready for Review` → `Signed Off` → `Implemented`, or `Superseded`. Drafts land on main early — sign-off doesn't gate visibility. Legacy `status:` field retained for `scripts/check-rfc-docs.mjs`'s `requiresDocs` gate.

**Number lookup**: the canonical registry of every shipped, in-flight, withdrawn, and reserved RFC number is the [Registry](../../spec/rfcs/README.md#registry) table in `spec/rfcs/README.md` (AISDLC-165). To pick the next available number, read the "Next available number" line at the bottom of that table — do NOT scan the filesystem, the registry includes reservations that have no file yet.

**`requires:` vs `assumes:` — dependency-kind semantics (AISDLC-311).** RFC frontmatter splits inter-RFC dependencies into two explicit fields:

- **`requires:`** — runtime-code dependency. This RFC's implementation IMPORTS code from the listed RFCs. They MUST ship (lifecycle `Implemented`) before this RFC's implementation can ship. Use when removing the dep would cause a TypeScript / Node `import` error.
- **`assumes:`** — design-contract dependency. This RFC reads the listed RFCs as a design contract (type shape, schema, naming, semantics) but does NOT code-import. They only need to EXIST at `Ready for Review` or higher. Use when removing the dep would only leave a comment or design rationale stale.

**Example**: RFC-0031 (calibration-driven DID revision) assumes RFC-0009's DID schema as a design contract — its shipped code (`orchestrator/src/sa-scoring/revision-proposal.ts`) only imports `crypto.randomUUID`, not any RFC-0009 module. Correct: `assumes: [RFC-0009]`, not `requires: [RFC-0009]`.

**Gate composition:**
- **DoR upstream-OQ gate** — tasks BLOCK dispatch on open OQs / pre-`Signed Off` lifecycle of RFCs they list under `requires:` (or `references:` for legacy backward-compat). Tasks that list an RFC under `assumes:` are documentation-only — the gate does NOT block on the target's OQ / lifecycle status.
- **Lifecycle promotion** — when an RFC is promoted to `Implemented`, its `requires:` entries SHOULD also be `Implemented` (warning during AISDLC-311 soak window). `assumes:` entries only need to exist.
- **Docs-drift linter** (`scripts/check-rfc-docs.mjs`) — `requires:` / `assumes:` entries must reference real RFC IDs. When the RFC declares `implementedBy:` (source-tree paths) and the target also does, the linter scans for actual imports; missing imports surface a deprecation warning suggesting `assumes:`.

See [`spec/rfcs/README.md#requires-vs-assumes--dependency-kind-semantics-aisdlc-311`](../../spec/rfcs/README.md#requires-vs-assumes--dependency-kind-semantics-aisdlc-311) for the full contract.

## Releases

**CHANGELOG.md is managed exclusively by release-please. Contributors MUST NOT edit it manually.**

### release-please rolling PR model (AISDLC-401)

`release.yml` fires on every push to `main`, runs `googleapis/release-please-action@v4`, and
maintains a **single rolling PR** (`chore: release main` on branch `release-please--branches--main`).
The rolling PR accumulates version bumps + CHANGELOG entries from conventional-commit messages.
Regular feature PRs MUST NOT touch CHANGELOG.md — parallel-merge conflicts are the penalty
(root cause of AISDLC-401, made visible after AISDLC-400 dropped the merge queue).

The pre-push hook (`scripts/check-changelog-edit.sh`) WARNs when a feature branch touches
CHANGELOG.md. If you see that warning, revert the CHANGELOG changes — release-please will
reconstruct them from your commit messages. See [`docs/operations/release-flow.md`](release-flow.md) for the full flow.

**Landing the release PR.** The governance hook refuses raw `gh` merge commands (including `--auto` arming). When the operator explicitly instructs a release, arm the release-please PR with `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm` (drop `--arm` to merge now). The CLI verifies the PR from GitHub (release branch, same repo, base `main`, release-only files whose content changes only version values, effective release author set (`governance.releaseAuthors`, else `mergeAuthors`, else the release-please bots; an explicit empty `releaseAuthors` disables the release path), green checks and CLEAN), squash-merges, and audits the call; the caller-role restriction (set `AI_SDLC_CALLER_ROLE=operator` from a plain shell) is a CLI role mistake guard (DEC-0038), not a security boundary; no hook-level control exists yet and a follow-up task adds one. When the release PR is authored by a shared PAT identity that agents also push as (this repo's setup), the author check is NOT the control; the controls are the exact release branch, content-based file validation and green checks. Release merges also need `governance.allowMerge: onGreenClean` or `governance.allowReleaseMerge: true` on main (a narrower grant for release PRs only; `allowMerge: never` does NOT stop release merges while `allowReleaseMerge: true`, so to stop all agent merges also leave `allowReleaseMerge` unset/false or set `releaseAuthors: []`; neither key affects GitHub's own auto-merge once armed). Never cut a release without an explicit operator instruction.

### Package configuration

`.github/workflows/release.yml` runs `pnpm -r publish --no-git-checks` with no `--access` flag. Every non-`"private": true` workspace package MUST carry:

```jsonc
"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
```

Without it, npm rejects with E402 silently per-package while the overall job appears green. `pnpm lint:publishable` (wired into `pnpm test`) catches regressions; the operator should also wire it as an explicit CI step in `.github/workflows/ci.yml`.

When adding a new publishable package: add to `pnpm-workspace.yaml`, add the `publishConfig` block (or mark `"private": true`), add to `release-please-config.json` if release-please should track its version. release-please does NOT add `publishConfig` automatically.

## Plugin MCP server — project root resolution (AISDLC-99, AISDLC-216)

The plugin's MCP server (`mcp__plugin_ai-sdlc_ai-sdlc__*` tools) resolves the project directory in this order: `AI_SDLC_PROJECT_ROOT` env → `CLAUDE_PROJECT_DIR` env → walk up from `process.cwd()` for an ancestor with `backlog/` → throw. Almost always falls through to the cwd-walk and finds the right project. Override with `AI_SDLC_PROJECT_ROOT=/abs/path` before launching Claude Code.

### Pattern C routing (AISDLC-216)

In Pattern C (non-bare parent repo + `.worktrees/<task-id>/` isolates), the parent's working tree is **read-only**. The MCP server starts from the parent's cwd and `process.cwd()` resolves to the parent root — without extra routing, writes would accumulate as untracked debris in the parent rather than landing in the correct worktree.

After resolving the candidate root, the resolver checks for Pattern C: if `<root>/.worktrees/` exists and contains at least one subdirectory, the root is a Pattern C parent and the following routing applies:

1. **`AI_SDLC_ACTIVE_TASK_ID` env var** — if set, routes to `<parent>/.worktrees/<task-id-lower>/`
2. **Per-worktree `.active-task` sentinels** — scans `<parent>/.worktrees/<id>/.active-task` (matches `pipeline-cli/src/steps/04-flip-status.ts` write location and `findWorktreeSentinel` pattern). When multiple worktrees have sentinels (parallel runs), the most-recently-modified one wins.
3. **No signal → refuse** with the Pattern C error message.

The typical Pattern C setup: `/ai-sdlc execute <task-id>` automatically writes `.worktrees/<task-id>/.active-task` (per AISDLC-81). For sessions where the env-var path is preferred (e.g. operator manually launching Claude Code into a multi-worktree project), set `AI_SDLC_ACTIVE_TASK_ID=AISDLC-NNN` before launch.

### Pattern C hard guards (AISDLC-358)

The parent working tree MUST be on `main` at all times. This is enforced by `scripts/check-orchestrator-state.sh` (called at Step 0 of every `/ai-sdlc execute` and `/ai-sdlc orchestrator-tick`) and by the inline `runParentBranchGuard()` check at the top of every `runOrchestratorTick()` call in `pipeline-cli/src/orchestrator/loop.ts`.

Guard logic (two outcomes):

- **Parent on non-main branch, clean working tree** → auto-recover: `git checkout main && git reset --hard origin/main`. Logs `[orchestrator-state] auto-recovered parent from '<branch>' to main`.
- **Parent on non-main branch, dirty working tree** → REFUSE. Prints the offending branch name, the dirty paths, and the manual recovery command. Exits non-zero (`check-orchestrator-state.sh`) or throws `ParentNotOnMainError` (TypeScript loop). The orchestrator tick is aborted; no frontier work proceeds.

Recovery (operator): stash or commit your changes in the parent, then run `git checkout main && git reset --hard origin/main`.

**Sanctioned vs. ad-hoc reset (AISDLC-450):** `git reset --hard origin/main` is ONLY permitted when invoked by `scripts/check-orchestrator-state.sh` on a verifiably clean working tree. Ad-hoc `git reset --hard` by the Conductor or a subagent (outside the script) is forbidden — if the script refuses (dirty parent), escalate to the Decision Catalog (see `/ai-sdlc orchestrator-tick` Step 0).

