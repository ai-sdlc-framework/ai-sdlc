# CLAUDE.md reference: git flow, CI, hooks, feature flags

This page holds the detailed text moved out of `CLAUDE.md` (AISDLC-742) to cut the per-call context floor. The operative rules stay in `CLAUDE.md`; the explanation, incident history and implementation detail live here, essentially verbatim. Section headings below are the original `CLAUDE.md` headings.

## Git Flow

- **Always rebase** feature branches onto main; never merge main in.
- Update branch: `git fetch origin && git rebase origin/main`, then `git push --force-with-lease origin HEAD:refs/heads/<branch>` (explicit destination is the canonical spelling; `leaseOnOwnBranch` is the default `spec.governance.allowForcePush` since AISDLC-710, so a lease push of a dispatched task's own branch needs no operator prompt; only that explicit `HEAD:refs/heads/<branch>` spelling (and its `--force-with-lease=<branch>:<sha>` variants) is accepted, bare `HEAD` and omitted remote/refspec forms are refused because git maps them through config; an explicit `never` blocks every lease push).
- Never `gh api pulls/N/update-branch` with merge method. Keep linear history.
- `/ai-sdlc rebase <pr>` automates mechanical conflicts (test additions to same `describe`, prettier drift) and re-signs the attestation only when `contentHash` changed. Escalates semantic conflicts, modify-vs-delete, verification failures, and 3-attempt iteration cap. Refuses force-push to `main`/`master`. **CHANGELOG.md conflicts should not arise on feature branches** — if a rebase surfaces one, remove the CHANGELOG change from the feature branch rather than merging both sides (AISDLC-401).

## CI marker hygiene

GitHub Actions silently skips ALL workflows when ANY commit body contains `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, or `[actions skip]` (substring, case-insensitive). Use the paren-quoted form `(skip ci marker)` in commit messages. Backtick-wrapping does NOT defeat the parser. `scripts/check-skip-ci-marker.sh` enforces on push.

## Branches & Commits

- Branches: `feat/<desc>`, `fix/<desc>`, or `ai-sdlc/issue-<n>`.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`).
- Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.

## PRs

- **Never merge PRs** — only humans merge. The single exception is the release-please rolling PR (`chore: release main`), which an authorized session may land only through the sanctioned release path filed as AISDLC-702 (`cli-merge-if-eligible`, source kind `release`, eligibility derived from GitHub). Until that path ships the rule stands unchanged. The exception covers no other PR and no raw merge command, and the hooks are not loosened (AISDLC-703).
- **Never close** issues or PRs. **Never force-push to main/master.**
- Dismiss stale reviews only with documented reason (truncation, API errors).
- `auto-enable-auto-merge.yml` sets `--auto --squash` on same-repo PRs (AISDLC-400: merge queue dropped 2026-05-23; explicit `--squash` ensures PRs always land as one commit on main regardless of repo-default drift). Setting `--auto` is NOT merging. PRs merge directly once `ai-sdlc/pr-ready` + `Backlog Drift` required checks pass — no merge-queue serialization, no update-branch CI re-run. AISDLC-398's content-addressed envelopes (headBlobSha-based, base-independent) eliminate v4-kick permanently. See `docs/operations/merge-without-queue.md` for the full flow and rollback procedure.

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- `.husky/pre-push` is the canonical gate; local pre-flight makes it a no-op.
- Hook scripts (`ai-sdlc-plugin/hooks/*.js`) use Node built-in `node --test`. Orchestrator + MCP server use Vitest.
- `@ai-sdlc/dogfood` tests (`dogfood/src/runner/exports.test.ts`) import from `dist/runner/index.js` to validate the built exports surface. The `pretest` lifecycle hook in `dogfood/package.json` runs `pnpm build` automatically before `pnpm test`, so `pnpm --filter @ai-sdlc/dogfood test` always works. Do NOT remove the `pretest` hook — it prevents CI failures on PRs where dogfood is selected by the `...[origin/main]` test filter but dist wasn't explicitly built (AISDLC-404).

## Hooks

`.husky/pre-push` chains in order:

1. **`scripts/check-dark-code-on-push.sh`** (AISDLC-687) — runs `node scripts/check-dark-code.mjs`, the same static scan CI runs through `pnpm test`, so a newly dark module, a grown dark baseline or a new test double in production code blocks the push locally. Cheap (no build), so it runs BEFORE the coverage gate. Skip: `AI_SDLC_SKIP_DARK_CODE_GATE=1`. Hermetic tests: `scripts/check-dark-code-on-push.test.mjs` (run via `pnpm test:dark-code-push-gate`).
2. **`scripts/check-coverage.sh`** — 80% lines coverage threshold per package. Skip: `AI_SDLC_SKIP_COVERAGE_GATE=1`.
3. **`scripts/squash-attestation-chores.sh`** — squashes stacked `chore: sign attestation` commits at HEAD into one to keep history clean. Must run before attestation-sign. No-op when 0 or 1 such commits. Skip: `AI_SDLC_SKIP_SQUASH_CHORES=1`.
4. **`scripts/pre-push-fixups.sh`** (AISDLC-386) — orchestrates two mechanical fixup sub-hooks in dependency order (task-move → attestation-sign) in a single pass. (mcp-bundle-sync removed by AISDLC-385 — bundle now distributed via npm.) Each sub-hook is invoked with `AI_SDLC_INTERNAL_NO_EXIT_1=1` so it does its work but exits 0 instead of 1. After all sub-hooks complete, if any fixup ran, the orchestrator exits 1 ONCE with a consolidated "re-run git push" message. This collapses the worst-case 3-push chain into 2. Exit 0 silently when no fixups are needed.
5. **`scripts/check-task-moved.sh`** (defense-in-depth) — auto-moves backlog task file from `backlog/tasks/` to `backlog/completed/` when any commit in the push range has `(AISDLC-N)` in its subject. Commits as `chore: auto-close AISDLC-N (AISDLC-220)`. **Silent skip when file is already git-tracked in `backlog/completed/`** (AISDLC-402): uses `git ls-files` to check tracked state; when the dev subagent already moved the file (the `/ai-sdlc execute` path), exits 0 with zero log noise and zero chore commits, eliminating the double-push for 95%+ of PRs. On the re-push after the orchestrator ran, this is an idempotent no-op. **Order is load-bearing — MUST run BEFORE attestation-sign:** attestation's contentHashV4 binds `{path, headBlobSha}` per file; task move must happen before sign. Skip: `AI_SDLC_SKIP_TASK_MOVE=1`.
6. **`scripts/check-attestation-sign.sh`** (defense-in-depth) — auto-signs DSSE attestation when `<worktree>/.active-task` exists, `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` exists, and no envelope at HEAD. On the re-push after the orchestrator ran, this is an idempotent no-op. When no verdict file exists (docs-only PRs, chore commits, ad-hoc pushes), exits 0 as a no-op — docs-only PRs skip `verify-attestation.yml` entirely via `paths-ignore` (AISDLC-388) and do not require an attestation status posted (AISDLC-214 + AISDLC-387 + AISDLC-388). Skip: `AI_SDLC_SKIP_ATTESTATION_SIGN=1`.

**Master bypass (emergency only):** `AI_SDLC_BYPASS_ALL_GATES=1 git push` stops the entire pre-push chain — the orchestrator and all sub-hooks check this var at the very top and exit 0 immediately with a `[<hook>] AI_SDLC_BYPASS_ALL_GATES=1 — skipping` message to stderr. Use exclusively during RFC-0042 / gate-rewrite cutover windows; document every use in the PR body. Per-gate `AI_SDLC_SKIP_*` vars continue to work independently. See [`docs/operations/emergency-bypass.md`](emergency-bypass.md) for the full runbook.

**Worktree hooks (AISDLC-693).** `core.hooksPath` is `.husky/_`, which is gitignored and generated by `prepare`; a worktree with no hooks directory runs NO pre-commit, commit-msg or pre-push gate, silently. Step 3 (`pipeline-cli/src/steps/hooks-check.ts`) fails closed when the directory git resolves for hooks has no executable `pre-push` while the main checkout has one (on a fresh worktree it installs with scripts enabled, then runs `prepare` once if still needed), install scripts are never disabled, and `ai-sdlc doctor` check `worktree-hooks` lists affected worktrees (`--fix` runs `prepare` where `node_modules` exists). Root `engines.node` is `>=22.22.1` (`lint-staged` floor) with a matching `.nvmrc`.

`set -euo pipefail` aborts on first failure. `git push --no-verify` bypasses everything. All gates have hermetic tests at `scripts/<name>.test.mjs` wired via `test:task-move-gate` / `test:attestation-sign-gate` / `test:pre-push-fixups-gate`. (`test:mcp-bundle-sync-gate` removed by AISDLC-385.)

The Definition-of-Ready check and the backlog-drift check are no longer local hooks (AISDLC-712, DEC-0056 row 3): they run in CI ("Evaluate backlog tasks changed by PR", "Backlog Drift"). Agents may still run `node pipeline-cli/bin/cli-dor-check.mjs --task <path>` and `npx backlog-drift check` by hand.

## CI behavior

PR merge gate is the single rollup check `ai-sdlc/pr-ready` produced by `.github/workflows/ai-sdlc-gate.yml` (re-actors/alls-green pattern); see [`docs/operations/quality-gate.md`](quality-gate.md) for archetype gating, cutover, and rollback.

**Main health monitor** (AISDLC-406): `.github/workflows/main-health-monitor.yml` fires on every push to `main` and runs the full test suite (`pnpm -r test` + workflow YAML tests). When any test fails, it creates a GitHub issue titled `[main-health] main is RED at <commit>` assigned to `@deefactorial`. This is the reactive complement to the no-queue direct-merge model (AISDLC-400): per-PR CI uses affected-package filtering and cannot detect cross-package merge-skew regressions, but the health monitor always runs the full suite post-merge. See [`docs/operations/main-health-monitor.md`](main-health-monitor.md) for the triage runbook. Motivating incident: AISDLC-398 + AISDLC-400 + AISDLC-405 each had green per-PR CI but combined to break `main`.

Workflows MUST invoke pipeline-cli CLIs via `node pipeline-cli/bin/cli-XXX.mjs` directly — never via `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX`. `pnpm exec` does not resolve workspace own-bins, so the latter form silently fails with `Command not found` and any `|| echo <fallback>` safety net fires unconditionally. `pipeline-cli/src/cli/bin-invocation.test.ts` enforces both directions of this rule. See AISDLC-156 + the "Invoking from CI" section of `pipeline-cli/README.md`.

### Dark-code gate (AISDLC-552)

`pnpm dark-code:check` (wired into `pnpm test`) fails when a module has **no
non-test importer and no barrel re-export** — code that ships with passing unit
tests, three reviewer approvals, and zero runtime effect. Reachability counts
static imports, `export … from`, dynamic `import()`, and `.mjs` bin shims —
resolved to actual file paths, so two same-named modules never mask each other;
**a module imported only by its own test is dark by definition**.

`.ai-sdlc/dark-code-baseline.json` records the 25 modules that were already dark
when the gate landed, so it fails only on NEWLY dark modules. It is a **ratchet**:
shrink it as modules get wired (`--update-baseline` after wiring), never grow it
by hand. Entry points that are legitimately never imported go in its `allowlist`
with a required reason. Do NOT silence a finding with a token import — that
recreates exactly the condition being detected. A second rule flags non-test source that imports or calls a test double (`fake-*`/`mock-*`/`stub-*` modules, `createStub*`/`Fake*`/`Mock*` exports); resolve by wiring a real implementation or adding a `stubAllowlist` entry `{ path, capability, reason }`, and the `stubSites` baseline is shrink-only. It cannot see an interface with no implementation at all (nothing to import); capability outcome reporting covers that.

## Feature flags

- **`AI_SDLC_DEPS_COMPOSITION`** (RFC-0014): gates the dependency-graph composition layer. **On by default since AISDLC-410 (2026-05-23, operator override-path promotion).** Opt out via `AI_SDLC_DEPS_COMPOSITION=off` (or `0`/`false`/`no`, case-insensitive); truthy values (`1`/`true`/`yes`/`on`) are honored for backward-compat. Phase 1 surface = `cli-deps snapshot` writes `$ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl`; `cli-deps gc/inspect` operate on those files. See [`docs/operations/deps-composition.md`](deps-composition.md) and [`pipeline-cli/docs/deps.md`](../../pipeline-cli/docs/deps.md). Phases 2-4 (PPA composition, DoR blast-radius, Slack digest) ship behind the same flag. Phase 5 ships the corpus aggregator (`cli-deps-corpus aggregate`) + operator-override capture (`cli-deps log-override`) + the hybrid promotion runbook at [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md).
- **`AI_SDLC_AUTONOMOUS_ORCHESTRATOR`** (RFC-0015): gates the autonomous pipeline orchestrator. **On by default since AISDLC-411 (2026-05-23, operator override-path promotion).** Opt out via `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off` (or `0`/`false`/`no`, case-insensitive); truthy values (`experimental`/`1`/`true`/`yes`/`on`) are honored for backward-compat and remain ON. Phase 1 surface = `cli-orchestrator {start,tick,status}` (invoke directly via `node pipeline-cli/bin/cli-orchestrator.mjs`). Phases 2-5 (failure playbook, DoR/dep admission filters, `events.jsonl` writer, soak corpus + promotion) ship behind the same flag. Phase 5 ships the corpus aggregator (`cli-orchestrator-corpus aggregate`) + chaos-test harness (`pipeline-cli/src/orchestrator/chaos.test.ts`) + the hybrid promotion runbook at [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md). See [`pipeline-cli/docs/orchestrator.md`](../../pipeline-cli/docs/orchestrator.md) and [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).

