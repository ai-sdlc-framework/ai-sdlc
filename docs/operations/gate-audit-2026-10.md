# PR gate audit, October 2026 (AISDLC-805)

Audit of every requirement that gates a pull request, worked under the five-step production algorithm (DEC-0090, CLAUDE.md). Companion artifacts: the shrink-only registry [`.ai-sdlc/gates.yaml`](../../.ai-sdlc/gates.yaml) and its ratchet test `scripts/check-gate-registry.test.mjs`.

## Five-step review (requirements first)

1. **Requirement questioned, and who set it.** Each gate below, individually. Every one was added after a named task or incident (the origin column), and none had been re-examined since. Where the origin is "unknown" that is itself a finding. The root `pnpm test` chain was set by the tasks that each appended their own `pnpm test:<gate>` entry; six PRs went DIRTY on 2026-10-10 from editing that one line.
2. **Deleted.** Class (a), applied in this PR: the hand-maintained 58-entry chain (53 entries removed) is replaced by a glob runner. Everything else that would loosen a governance or trust-chain control is proposed as its own decision in [Proposed decisions](#proposed-decisions) and is **not** applied here.
3. **Simplified.** Gates with the same property are marked MERGE (attestation verified twice, DoR evaluated twice, auto-merge armed by two workflows, task-move and attestation-sign each invoked twice in `.husky/pre-push`).
4. **Accelerated.** `node --test` over the discovered files runs every gate suite in one process pool (about 24 s wall clock on a warm laptop for the scripts and workflow tests) instead of 50 sequential `pnpm` invocations.
5. **Automated.** `scripts/check-gate-registry.test.mjs` derives the live gate set and fails when a gate is added without a registry entry (which needs a decision id) or an entry lacks origin or owner.

Velocity impact: positive. The change removes the conflict-prone chain line and adds no gate that runs on a PR beyond one fast hermetic test.

## Method and data limits

- Source: `gh api repos/{owner}/{repo}/actions/workflows/<file>/runs?created>=2026-09-10` and the jobs endpoint, queried 2026-10-11.
- **The runs API returns at most 1000 runs per query.** For busy workflows that cap is reached well inside 30 days, so the window column shows the real start of the sample (for example `ai-sdlc-gate` covers 2026-10-01 to 2026-10-11, not 30 days). Rates are over that window.
- **Failure rate** = failures / (successes + failures); cancelled and skipped runs are excluded from the denominator and reported separately.
- **False-positive rate** is measured as a proxy: a failed run on a head SHA that later has a successful run on the same SHA with no code change (a re-run, or a flake). It cannot see a failure that was fixed by a rebase (new SHA) and counted as real. Where a figure cannot be obtained the cell says so; nothing is estimated.
- **Job-level figures** come from the last 60 non-cancelled `ai-sdlc-gate` runs, not the full window. Per-job false-positive rate was not measured (only the workflow-level proxy is).
- **Cost** is median wall clock from `run_started_at` to `updated_at` of completed runs. Skipped runs report meaningless durations and are excluded. Hooks have no run history: local cost is stated from what the script does, marked "not measured".
- Owners are roles (`engineering`, `security`, `operator`), as the repository records no per-gate human owner.

## Surface 1: workflows that fire on pull request events (10)

| Gate | Property protected | Origin | Owner | Window / runs | Median cost | Failure rate | False-positive proxy | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|---|
| `ai-sdlc-gate.yml` | one CI run per PR, rolls up to `ai-sdlc/pr-ready` | AISDLC-727, DEC-0056 | engineering | 2026-10-01.. / 1000 (439 ok, 141 fail, 418 cancelled) | 576 s | 24.3 percent (141 of 580) | 0 of 141 | KEEP | the one required quality workflow; cancelled runs are superseded pushes |
| `ai-sdlc-review.yml` | CI-side reviewers when no local attestation | AISDLC-381, 141, 142, 147 | security | 2026-10-05.. / 1000 (287 ok, 1 fail, 711 cancelled) | 273 s | 0.3 percent (1 of 288) | 0 of 1 | DEMOTE (dual trigger) | fires on both `pull_request` (499) and `pull_request_target` (501); the AISDLC-381 transitional `pull_request` trigger was to be dropped, and it is why 711 runs are cancelled |
| `auto-enable-auto-merge.yml` | arms squash auto-merge on same-repo PRs | AISDLC-381, 400 | engineering | 2026-10-10.. / 1000 (900 ok, 1 fail, 99 cancelled; 634 `check_suite`, 339 `pull_request_target`, 27 `status`) | 979 s | 0.1 percent (1 of 901) | 0 of 1 (not SHA-measured) | KEEP | automation not a quality gate; trigger fan-out (check_suite, status) is the cost, not the property |
| `auto-rearm-on-dequeue.yml` | keeps auto-merge armed | AISDLC-369, 381, 400 | engineering | 2026-09-14.. / 1000 (990 ok, 5 fail, 5 cancelled; 150 are `schedule`) | 26 s | 0.5 percent (5 of 995) | not obtained | MERGE into `auto-enable-auto-merge.yml` | the merge queue it was written for was dropped by AISDLC-400; both workflows keep auto-merge armed |
| `dor-ingress.yml` | Definition of Ready on changed task files; issue ingress | RFC-0011 s5.2, AISDLC-161, 379 | engineering | 2026-09-14.. / 703 (387 ok, 25 fail, 25 cancelled, 266 skipped) | 67 s | 6.1 percent (25 of 412) | 0 of 25 | MERGE (PR half) into `gate-job:dor-readiness-gate` | the rollup already runs `dor-readiness-gate` (AISDLC-588/591) on the same property |
| `isolated-review.yml` | isolated reviewer run (RFC-0047 Phase 4) | RFC-0047, AISDLC-596 | security | 2026-09-16.. / 1000 (0 ok, 2 fail, 998 skipped) | not obtainable (skipped durations are meaningless; the 2 failures have no success to compare) | 100 percent of the 2 that ran | 0 of 2 | DELETE | executes on about 0.2 percent of PRs and never succeeded in the window; opt-in feature that is effectively off |
| `require-issue-link.yml` | external PRs link an issue | AISDLC-443, 700 | engineering | 2026-10-02.. / 1000 (729 ok, 0 fail, 7 cancelled, 263 skipped) | 59 s | 0 percent (0 of 729) | not applicable | KEEP | protects the external-contributor flow; 0 failures means it never blocks the internal flow |
| `rfc-lifecycle-check.yml` | RFC promotions follow the ladder | AISDLC-350, 417 | engineering | 2026-09-30.. / 37 (25 ok, 1 fail, 11 skipped) | 32 s | 3.8 percent (1 of 26) | 0 of 1 | KEEP | cheap, path-gated, catches a real class |
| `untrusted-pr-gate.yml` | untrusted authors cannot change governance or trust-chain paths | RFC-0043 P5, AISDLC-501, 704.6, 740 | security | 2026-10-01.. / 1000 (773 ok, 160 fail, 62 cancelled) | 177 s | 17.2 percent (160 of 933) | 1 of 164 failing SHAs | KEEP (investigate) | trust boundary; the failure rate is high and undiagnosed here: of 100 sampled failures 69 are `ai-sdlc/*` branches and 31 are `release-please--branches--main`, yet the latest failed run shows every job green. File a diagnosis (DEC below) |
| `verify-attestation.yml` | DSSE review attestation verifies | AISDLC-214, 381, 388, 704.6 | security | 2026-10-06.. / 1000 (508 ok, 1 fail, 175 cancelled, 314 skipped) | 179 s | 0.2 percent (1 of 509) | 1 of 1 | MERGE into `gate-job:attestation-gate` | the rollup job `attestation-gate` (4 s median, 5 of 37 fail) checks the same envelope; this workflow also double-triggers (429 `pull_request`, 571 `pull_request_target`) |

Not PR-event but adjacent and noted for completeness: `ai-sdlc-fix-ci.yml` (`workflow_run`, 1000 runs, 1000 skipped, zero successes since 2026-10-02: a DELETE candidate for the planner), `ci.yml` (push to `main` and nightly only since AISDLC-727; 783 of its window runs are pre-727 PR runs), `main-health-monitor.yml` (post-merge, 221 ok, 21 fail, 36 cancelled, 338 s), `release.yml`, `scorecard.yml`, `flaky-tests.yml`, `trusted-reviewers-drift.yml`, and the five issue-event workflows. None gate a PR.

## Surface 2: jobs in the `ai-sdlc/pr-ready` rollup (14)

Sample: last 60 non-cancelled `ai-sdlc-gate` runs (per-job false-positive rate not measured; workflow-level proxy is 0 of 141).

| Gate | Property protected | Origin | Owner | Median cost | Failure rate (of completed) | Verdict | Reason |
|---|---|---|---|---|---|---|---|
| `detect` | classify affected packages and docs-only | AISDLC-727, 712.1 | engineering | 9 s | 0 of 50 | KEEP | feeds every other job's skip decision, which is what makes the rest cheap |
| `lint` | eslint, prettier, clock discipline | AISDLC-140 | engineering | 96 s | 1 of 60 (1.7 percent) | KEEP | fast, rarely wrong |
| `build-test` | build and test affected packages | AISDLC-727 | engineering | 452 s | 14 of 37 (37.8 percent) | KEEP | real defect catcher; the largest single cost |
| `coverage` | package floors plus 90 percent patch coverage | AISDLC-726, 372, 376 | engineering | 479 s | 13 of 36 (36.1 percent) | KEEP | single coverage gate by decision (AISDLC-726) |
| `integration` | cross-package integration | AISDLC-727, 400 | engineering | 117 s | 2 of 37 (5.4 percent) | KEEP | catches merge-skew class |
| `backlog-drift` | task references resolve | AISDLC-796; required since AISDLC-125 | engineering | 23 s | 3 of 45 (6.7 percent) | KEEP | required context |
| `first-run-smoke` | fresh install, init, doctor, one task | AISDLC-771 | engineering | 52 s | 0 of 31 | DEMOTE to nightly only | 0 failures on PRs in the sample and it already runs nightly; PR run is duplicate coverage |
| `test-python` | Python SDK matrix | unknown | engineering | 25 s (3 versions when run) | 0 of 6 | KEEP | path-gated: 50 of 52 runs skipped, costs nothing when irrelevant |
| `test-go` | Go SDK | AISDLC-215, 388 | engineering | 93 s | 0 of 2 | KEEP | path-gated: 50 of 52 skipped |
| `attestation-gate` | code PRs carry valid attestation | AISDLC-388 | security | 4 s | 5 of 37 (13.5 percent) | KEEP | trust chain; absorbs `verify-attestation.yml` |
| `dependency-review-gate` | dependency and action additions | AISDLC-712.1 | security | 8 s | 0 of 14 | KEEP | path-gated, 8 s |
| `dor-readiness-gate` | task files pass DoR | AISDLC-588, 591, RFC-0046 | engineering | 4 s | 1 of 46 (2.2 percent) | KEEP | absorbs the PR half of `dor-ingress.yml` |
| `independence-policy-gate` | reviewer independence | AISDLC-591 | security | 7 s | 0 of 37 | KEEP | trust chain, 7 s |
| `pr-ready` | the rollup | AISDLC-388, 712.1 | engineering | 3 s | 24 of 49 (49 percent) | KEEP | a rollup fails whenever any job fails; it is the signal, not a cause |

## Surface 3: required branch-protection contexts (2)

Read from `repos/{owner}/{repo}/branches/main/protection/required_status_checks`: `Backlog Drift`, `ai-sdlc/pr-ready`.

| Gate | Property | Origin | Owner | Cost | Failure / FP | Verdict | Reason |
|---|---|---|---|---|---|---|---|
| `ai-sdlc/pr-ready` | the rollup is green | AISDLC-388 | operator | 3 s | see Surface 2 | KEEP | the single required gate |
| `Backlog Drift` | task references resolve | AISDLC-125, 796 | operator | 23 s | 3 of 45 / not measured | MERGE into `ai-sdlc/pr-ready` | `pr-ready` already depends on the `backlog-drift` job, so the separate required context checks the same property twice |

Finding: CLAUDE.md "Operator action" tells operators to PATCH required checks with `strict=true`, while the "CI behavior" section states `strict=false`. One is stale (not changed here; see decision D8).

## Surface 4: pre-push scripts (9 in `.husky/pre-push`)

Local cost and failure rate are **not measured** (hooks write no run history). "Cheap" below is from the script's own header comment.

| Gate | Property | Origin | Owner | Cost | Verdict | Reason |
|---|---|---|---|---|---|---|
| `check-substrate-contract.mjs` | substrate type-registry integrity | AISDLC-453, RFC-0028 s4 | engineering | under 5 s per its header | KEEP | no-op in a fresh adopter repo |
| `check-skip-ci-marker.sh` | no CI-skip tokens in commits | AISDLC-88, 727 | engineering | instant text scan | KEEP | one such commit silently disables every workflow |
| `check-dark-code-on-push.sh` | no unwired module or test double | AISDLC-687, 552 | engineering | cheap static scan | KEEP | duplicate of `pnpm dark-code:check` in the chain, deliberately early feedback |
| `squash-attestation-chores.sh` | stacked sign commits collapse | AISDLC-369 | engineering | git-only | MERGE into `pre-push-fixups.sh` | a mechanical fixup like the two the orchestrator already runs |
| `check-changelog-edit.sh` | warns on CHANGELOG edits | AISDLC-401 | engineering | instant | DELETE | warn-only, exits 0; release-please conflict class is also caught at rebase time |
| `check-followups-on-push.sh` | follow-ups tracked or declined | unknown | engineering | git-only | KEEP (insufficient data) | origin unknown, but "no failure in 30 days" cannot be established without hook logs |
| `pre-push-fixups.sh` | ordered task-move then attestation-sign | AISDLC-386 | engineering | per sub-hooks | KEEP | the orchestrator the other two should fold into |
| `check-task-moved.sh` (second, direct call) | task file in `backlog/completed` | AISDLC-220, 402 | engineering | silent no-op when moved | MERGE (drop the direct call) | the orchestrator already runs it first; the direct call is described as "defense-in-depth" |
| `check-attestation-sign.sh` (second, direct call) | attestation signed and verified | AISDLC-133, 214, 618 | security | verifier run | MERGE (drop the direct call) | same duplicate-invocation; trust-chain, so a decision |

## Surface 5: pre-commit steps (4 lines, 3 gates)

| Gate | Property | Origin | Owner | Cost | Verdict | Reason |
|---|---|---|---|---|---|---|
| attestation-only short-circuit | skip tsc and lint-staged for envelope-only commits | AISDLC-371 | engineering | saves 10-15 s per the script comment | KEEP | it removes cost, it is not a gate |
| `check-backlog-ascii.sh` | ASCII backlog filenames | AISDLC-92, 727 | engineering | instant | KEEP | filename-only |
| `lint-staged` | prettier and eslint on staged files | unknown | engineering | not measured | KEEP | duplicated by `lint`, but it is the fast local form |
| `typecheck-workspace.mjs` | whole-workspace tsc on every commit | unknown | engineering | not measured; repo-wide tsc, the slowest local step | DEMOTE to pre-push | commit-time whole-workspace tsc duplicates the CI `build-test` job and the origin is unknown |

## Surface 6: root `pnpm test` chain (58 entries before, 6 after)

| Gate | Property | Origin | Owner | Verdict | Reason |
|---|---|---|---|---|---|
| 53 `pnpm test:<x>` / `docs:test` / `rfc:test` entries | each runs one or two `node --test` files | one task each | engineering | **DELETE (applied, class a)** | replaced by `pnpm test:gates`, the glob runner; every previously chained file still runs (see below) |
| `pnpm -r test` | all package suites | baseline | engineering | KEEP | |
| `pnpm test:gates` | glob runner (new) | AISDLC-805 | engineering | KEEP | `scripts/run-gate-tests.mjs` |
| `pnpm docs:check` | generated docs in sync | unknown | engineering | KEEP | |
| `pnpm rfc:check` | RFC docs-drift | AISDLC-165 | engineering | KEEP | |
| `pnpm dark-code:check` | no dark modules | AISDLC-552 | engineering | KEEP | |
| `pnpm sync:plugin-runtime-deps:check` | plugin dep list in sync | unknown | engineering | KEEP | |

Before and after: all 75 test files named by the old chain are discovered by the runner (verified by diffing the old set, extracted from the chain, against `node scripts/run-gate-tests.mjs --list`; zero missing). The runner discovers 36 test files the old chain did not name explicitly (some were covered by the old `ai-sdlc-plugin/commands/*.test.mjs` glob; the rest were never chained, for example `check-backlog-ascii`, `check-skip-ci-marker`, `dor-ingress`, and the plugin hook and command tests), because they live in a discovered directory. Two discovered files fail on `main` today and are listed in the runner's shrink-only `KNOWN_RED` map with reasons; both are findings:

- `scripts/check-rm-guard.test.mjs`: 7 `rm` calls with unguarded variable paths in shipped shell scripts (never enforced because never chained).
- `ai-sdlc-plugin/agents/rebase-resolver.test.mjs`: asserts a CHANGELOG merge rule that AISDLC-401 removed.

The old per-gate `test:*` aliases remain in `package.json` for targeted local runs; they are no longer part of the chain.

## Surface 7: `agent-role.yaml` blockedActions and blockedPaths (11 + 7)

The file holds 11 `blockedActions` and 7 `blockedPaths` on `main` today (the task text quoted 30, which does not match the file). All are governance or trust-chain controls; none run in CI, so cost, failure and false-positive rates are not obtainable (the PreToolUse hook writes no run history).

| Gate | Origin | Owner | Verdict | Reason |
|---|---|---|---|---|
| `gh pr merge*` | AISDLC-602, 703, 753 | operator | KEEP | merging is gated by `cli-merge-if-eligible` |
| `git merge*` | baseline (Git Flow) | operator | KEEP | linear history |
| `git push --force*`, `git push -f*` | AISDLC-663, 710 | operator | KEEP | lease form is allowed separately |
| `gh pr close*`, `gh issue close*` | baseline | operator | KEEP | |
| `git branch -D*`, `git branch -d*` | baseline | operator | MERGE into one pattern | same property; pending confirmation that the matcher is case-sensitive |
| `git reset --hard*` | AISDLC-450, 358 | operator | KEEP | sanctioned only inside `check-orchestrator-state.sh` |
| `git checkout -- .`, `git restore .` | baseline | operator | KEEP | |
| `opencode.json`, `opencode.jsonc`, `.opencode/**` | AISDLC-660 | security | KEEP | |
| `**/opencode.json`, `**/opencode.jsonc`, `**/.opencode/**` | AISDLC-660 | security | MERGE with the three root forms | if `**/` matches the root path the root entries are redundant; matcher semantics need confirming first |
| `scripts/verify-attestation.mjs` | AISDLC-383.7 | security | KEEP | the verifier must not be editable by the agent it verifies |

## Surface 8: CLAUDE.md rule sections (19 `##` sections, 10 rule-bearing `###` sections, 66491 bytes)

Cost is the size re-read at every session start. Failure and false-positive rates do not apply to prose (no run history); where a hook already enforces the rule the verdict says so. Sizes of `##` sections include their `###` children.

| Section | Bytes | Origin | Owner | Verdict | Reason |
|---|---|---|---|---|---|
| Git Flow | 1254 | baseline, AISDLC-401 | engineering | KEEP | |
| CI marker hygiene | 345 | AISDLC-88 | engineering | DELETE (prose) | `check-skip-ci-marker.sh` enforces it and prints the rule on failure |
| Branches & Commits | 229 | baseline | engineering | KEEP | |
| PRs | 1261 | AISDLC-703, 400 | operator | KEEP | merge rule |
| Testing | 1101 | AISDLC-726, 404 | engineering | KEEP | |
| Hooks | 5347 | AISDLC-386, 402, 618, 693 | engineering | DEMOTE to `docs/operations` | enumerates each hook's flags and history; the hooks are self-describing |
| CI behavior | 3364 | AISDLC-727, 406, 156 | engineering | KEEP | |
| `###` Dark-code gate | 1338 | AISDLC-552 | engineering | DEMOTE | the gate's failure message names the next step |
| Feature flags | 2047 | AISDLC-410, 411 | engineering | DELETE (prose) | both flags are default-on since May 2026; detail lives in `docs/operations` |
| Five-step production algorithm | 1182 | DEC-0090 | operator | KEEP | |
| Decision authority | 4729 | AISDLC-703, DEC-0039 | operator | KEEP | |
| Code Style | 125 | baseline | engineering | KEEP | |
| Scope Creep Prevention | 3725 | AISDLC-308 | operator | KEEP | |
| `###` Reviewer gate (308) | 322 | AISDLC-308 | engineering | MERGE into the reviewer agent prompts | already restated in each agent body |
| `###` Read-only agent constraint | 294 | AISDLC-308 | engineering | DELETE (prose) | enforced by agent frontmatter `disallowedTools` |
| `###` Subagent model defaults | 1641 | AISDLC-761 | engineering | DEMOTE | `model-pins.test.mjs` enforces pins |
| OQ-resolution prohibition | 2713 | AISDLC-298 | operator | KEEP | |
| `###` RFC-0035 Decision Catalog | 952 | AISDLC-392 | operator | KEEP | |
| `###` Reviewer gate (298) | 242 | AISDLC-298 | engineering | MERGE into reviewer agent prompts | |
| Review attestations | 10725 | AISDLC-398, 409, 419, 448, 618 | security | DEMOTE (compress) | largest section; mostly version history. Keep the current-schema rules, move history to `docs/operations` |
| Remote agents | 2662 | AISDLC-442 | engineering | DEMOTE | `/ai-sdlc execute` detects CCR and refuses with a pointer |
| RFCs | 2921 | AISDLC-165, 311 | engineering | KEEP | |
| Backlog Workflow | 14671 | many | engineering | DEMOTE (compress) | largest block; the DoR and OQ gate sections restate what the code prints |
| `###` Drift gate | 416 | AISDLC-125 | engineering | MERGE into Testing | |
| `###` Upstream-OQ gate | 1361 | AISDLC-296 | engineering | DEMOTE | the gate message names the override |
| `###` DoR ingress workflow gate | 1820 | AISDLC-379 | engineering | DEMOTE | same |
| Releases | 3307 | AISDLC-401 | operator | KEEP | |
| Plugin MCP server routing | 3183 | AISDLC-99, 216 | engineering | DEMOTE | resolver errors are self-explanatory |
| `###` Pattern C hard guards | 1394 | AISDLC-358 | engineering | DEMOTE | `check-orchestrator-state.sh` prints the recovery command |

## Surface 9: reviewer subagents per code PR

Verdict and cost distributions are not in Actions history (reviews run in the operator session or via Codex). Rates and cost are **not obtainable** from `gh`; token cost per reviewer would need the usage ledger, not queried here. Recent change AISDLC-722 already reduced the default to two reviewers for PRs touching no trust-chain path.

| Gate | Property | Origin | Owner | Verdict | Reason |
|---|---|---|---|---|---|
| `code-reviewer` | code quality, scope creep, inline OQ resolution | AISDLC-298, 308 | engineering | KEEP | |
| `code-reviewer-codex` | same, billed to Codex | AISDLC-142 | engineering | MERGE with `code-reviewer` | one gate with two backends; the registry should treat it as one |
| `test-reviewer` | test adequacy | AISDLC-308 | engineering | KEEP | |
| `test-reviewer-codex` | same, billed to Codex | AISDLC-142 | engineering | MERGE with `test-reviewer` | as above |
| `security-reviewer` | trust-chain and security review (opus) | baseline | security | KEEP | the one role worth the model cost |
| `correctness-reviewer` | behavioural correctness | unknown | engineering | KEEP (insufficient data) | origin unrecorded in the agent file |
| `refinement-reviewer` | task refinement, not PR review | unknown | engineering | KEEP | not a PR gate; listed because it is a reviewer agent |
| `review-executor`, `review-executor-codex` | review probes (haiku) | AISDLC-761 | engineering | KEEP | probes feed reviewers |
| `review-planner`, `review-synthesizer` | plan and merge reviewer output | unknown | engineering | KEEP (insufficient data) | |

## Proposed decisions

Nothing governance or trust-chain is deleted in this PR. Each item below is a class (b) decision (a change to required checks, workflow gates, hooks, role restrictions or CLAUDE.md rule sections is a governance surface per CLAUDE.md "Decision authority"). Every decision lists a non-weakening fallback so a lapsed timebox leaves the control in place. The audit row above is each decision's body.

| Id | Summary | Options | Non-weakening fallback |
|---|---|---|---|
| D1 | Delete `isolated-review.yml` (998 of 1000 runs skipped, 0 successes) | `delete`, `keep` | `keep` |
| D2 | Merge `verify-attestation.yml` into rollup job `attestation-gate`, drop the `pull_request` leg of the dual trigger | `merge`, `keep` | `keep` |
| D3 | Merge the PR half of `dor-ingress.yml` into `dor-readiness-gate` | `merge`, `keep` | `keep` |
| D4 | Drop the transitional `pull_request` trigger from `ai-sdlc-review.yml` (711 of 1000 runs cancelled) | `drop-trigger`, `keep` | `keep` |
| D5 | Merge `auto-rearm-on-dequeue.yml` into `auto-enable-auto-merge.yml` (merge queue dropped by AISDLC-400) | `merge`, `keep` | `keep` |
| D6 | Run `first-run-smoke` nightly only (0 failures in 31 PR runs) | `nightly-only`, `keep` | `keep` |
| D7 | Drop `Backlog Drift` as a separate required context; `ai-sdlc/pr-ready` already depends on it | `drop-context`, `keep` | `keep` |
| D8 | Reconcile the CLAUDE.md `strict=true` / `strict=false` contradiction on branch protection | `strict-false`, `strict-true` | `strict-true` |
| D9 | Remove the duplicate direct invocations of `check-task-moved.sh` and `check-attestation-sign.sh` in `.husky/pre-push`; fold `squash-attestation-chores.sh` into `pre-push-fixups.sh` | `dedupe`, `keep` | `keep` |
| D10 | Delete the warn-only `check-changelog-edit.sh` | `delete`, `keep` | `keep` |
| D11 | Move `typecheck-workspace.mjs` from pre-commit to pre-push | `move`, `keep` | `keep` |
| D12 | Trim CLAUDE.md: delete CI marker hygiene, Feature flags, Read-only agent constraint prose; demote Hooks, Review attestations history and Backlog Workflow detail to `docs/operations` (about 28 KB of 66 KB) | `trim`, `keep` | `keep` |
| D13 | Merge the paired `**/opencode*` and `git branch -d/-D` role entries after confirming matcher semantics | `merge`, `keep` | `keep` |
| D14 | Diagnose `untrusted-pr-gate.yml` 17.2 percent failure rate before any change (run-level failure with all jobs green) | `diagnose`, `ignore` | `diagnose` |
| D15 | Disposition of `ai-sdlc-fix-ci.yml` (1000 runs, all skipped since 2026-10-02) | `delete`, `diagnose-skip-condition`, `keep` | `keep` |

## Findings that need no decision

- `scripts/check-rm-guard.test.mjs` and `ai-sdlc-plugin/agents/rebase-resolver.test.mjs` were never chained and fail on `main`; each needs a fix task (recorded in the runner's `KNOWN_RED` map, shrink-only).
- The old chain did not name 36 existing test files explicitly; they now run.
- `check-followups-on-push.sh`, `lint-staged`, `typecheck-workspace.mjs`, `docs:check`, `sync:plugin-runtime-deps:check`, `test-python` and three reviewer agents have no recorded origin.
