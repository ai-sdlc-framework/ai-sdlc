---
id: AISDLC-1355
title: 'Setup keeps what init reported, retries what failed, creates the backlog folder and ends with a checked list of operator steps'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - setup
  - doctor
dependencies:
  - AISDLC-1354
references:
  - orchestrator/src/cli/commands/setup.ts
  - orchestrator/src/cli/commands/setup.test.ts
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - orchestrator/src/cli/commands/mcp-setup.ts
  - orchestrator/src/cli/commands/mcp-setup.test.ts
  - pipeline-cli/src/config-manifest/manifest.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/auto-brief.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - docs/getting-started/onboarding.md
  - backlog/config.yml
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the setup command: its init step, its backlog step, its MCP wording and one closing list of live-checked operator steps, with tests; no new service and no setting is written.'
---

## Description

**Gap.** `/ai-sdlc:setup` is meant to be the one first-run command, but it hides what init found, never retries what failed, leaves out the folder that tasks live in, says "already registered" when no client exists, and ends without telling the operator which steps only they can do. A repository can finish setup reporting success while branch protection was never applied, auto-merge is off, and the webhook secret is unset.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running; anything not working says so loudly.

**Cause (read from the source on main).** The failure sequences are inferred from the code; they were not reproduced (unverified).

- **Init output is dropped on success.** `runSetup` calls `runInit` and, on exit code 0, records only `scaffolded .ai-sdlc/` (`orchestrator/src/cli/commands/setup.ts:70-74`); the output is read only on failure (`:76-82`). The output holds the "Next steps" block (`orchestrator/src/cli/commands/init-features.ts:2064`) and warnings such as the no-`package.json` note that the scaffolded workflows will fail (`init-features.ts:1556`).
- **A failed init is never retried.** When init exits non-zero, for example because branch protection could not be applied (`orchestrator/src/cli/commands/init.ts:917`), setup records `not-possible`. On the next run `.ai-sdlc/pipeline.yaml` exists, so setup skips init with "already present" (`setup.ts:62-68`) and finishes with `ok`. Nothing is retried.
- **Plain init cannot simply be run again.** A second `init` is refused with "AI-SDLC is already installed" (`init-features.ts:986-992`); the `--add <feature>` path is the supported re-run (`init.ts:731-760`).
- **Nothing records what completed.** The only completion record is `.ai-sdlc/config-version.yaml`, stamped when the manifest files are all present (`pipeline-cli/src/config-manifest/manifest.ts:306-310`). It says nothing about workflows or branch protection, so a retry must test live state: the workflow files on disk, and the live branch protection through `fetchBranchProtectionStatus` (`orchestrator/src/cli/commands/branch-protection-shared.ts`). No new record file is needed.
- **No backlog folder.** Setup and init create no `backlog/` folder. The board only reads `backlog/tasks/` when it exists, and returns an empty list when it does not (`pipeline-cli/src/hierarchy/auto-brief.ts:91-92`), so nothing is queued and nothing says so. The onboarding page tells the operator to run `mkdir -p backlog/tasks` by hand (`docs/getting-started/onboarding.md:84-88`). Read by running it in a temporary repository (backlog CLI 1.53.0): `backlog init` writes `backlog/config.yml` and the folders `tasks`, `completed`, `drafts`, `decisions`, `docs`, `milestones` and `archive`, with `task_prefix: "task"`. This repository's `backlog/config.yml` sets `task_prefix: 'AISDLC'` and a longer status list. The merge helper reads `task_prefix` from the file on main and falls back to `AISDLC` when there is none (`pipeline-cli/src/governance/merge-if-eligible.ts:179-186`).
- **A misleading MCP line.** With no client detected the step reports `already registered for (no clients)` (`setup.ts:103-108`).
- **The by-hand steps are scattered.** They live in the onboarding page (auto-merge at `:396`, `AI_SDLC_PAT` at `:398-410`) and in init's next steps (`init-features.ts:2113-2114`). Nothing checks them. The webhook receiver starts only when `AI_SDLC_WEBHOOK_SECRET` is set and logs nothing when it is not (`pipeline-cli/src/hierarchy/up.ts:708-715`); the board then polls only.
- **How each can be read.** Read-only calls on this repository, run on 2026-11-19, all worked for an admin: `gh auth status`; `gh secret list` (names only); `gh api repos/{owner}/{repo}` returns `allow_auto_merge`; `gh api repos/{owner}/{repo}/actions/permissions/workflow` returns `can_approve_pull_request_reviews`. That a non-admin gets no value for the last three is inferred from the API documentation, unverified.

**Shape.** Setup prints what init reported. A re-run applies the missing parts through `init --add`, based on live checks. It creates the backlog folders. Its MCP line says plainly when no client was found. It ends with one list of operator-only steps, each checked live on every run and printed as done, not done, or unknown with the reason, and for each not-done step the exact command or the name of the settings page. Setup never sets a secret or a repository setting.

**Control.** No control changes. The operator-only steps stay operator-only (credentials and repository settings): setup reads and reports them and never writes them. A retry of branch protection runs only when the live read finds none, so it cannot overwrite a rule the operator customised.

**Planner reading (class (a), no control effect; the operator may overrule).** Whether setup writes `backlog/config.yml`, and with which `task_prefix`: setup creates the folders always, and runs `backlog init` non-interactively with its defaults (prefix `task`) only when `backlog/config.yml` is absent and the `backlog` command is on the path; otherwise it lists the command as a not-done step. The folder creation, the report and the live checks do not depend on this reading.

**Planner reading (class (a), no control effect; the operator may overrule).** The closing list has no "Allow GitHub Actions to create and approve pull requests" entry. The scaffolded `verify-attestation.yml` header names it as required only for its `approve` job (`orchestrator/src/cli/commands/init-templates.ts:176-177`), that job never runs today because the verifier always reports invalid, and AISDLC-1353 removes the workflow. Nothing else needs the setting, so setup does not ask the operator to turn it on.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should setup try to perform the operator-only steps? No; they are credentials and repository settings, so setup checks and reports them. 2. Deleted: the skip of init on an existing `pipeline.yaml`, the discarded init output, the "(no clients)" wording and the by-hand `mkdir`. 3. Simplified: one list of operator-only steps, each with a live check and a fix text, rendered by the same code that tests it. 4. Accelerated: the operator sees every open step at the end of the first run, not on the day a pull request stalls. 5. Automated: a re-run repairs what the live checks find missing, and tests cover each branch.

- **Keep init output.** On success and on failure, the report includes init's "Next steps" block and its `note:` and warning lines, verbatim, under the init step.
- **Retry.** Replace the skip at `setup.ts:62` with live checks: for missing scaffolded workflow files run `init --add workflows`; for absent branch protection (and not an HTTP 403 plan limit) run `init --add branch-protection`; the baseline init runs only when `.ai-sdlc/pipeline.yaml` is absent. A step that still fails stays `not-possible` with the reason, and the exit code is non-zero.
- **Backlog.** Create `backlog/tasks/` and `backlog/completed/` when absent, report each as created or present, and handle `backlog/config.yml` per the planner reading above.
- **MCP wording.** With no client detected, say `no MCP client found; nothing registered` and give the command to run once one is installed.
- **Operator steps list.** One closing list, checked live: `gh` authenticated (`gh auth status`; fix `gh auth login`); `AI_SDLC_PAT` secret present (`gh secret list`; fix `gh secret set AI_SDLC_PAT`); "Allow auto-merge" on (`allow_auto_merge`; Settings, General, Pull Requests, Allow auto-merge); webhook secret set (`AI_SDLC_WEBHOOK_SECRET` in this shell; without it the board polls only). A check that cannot run prints unknown with the reason, never done.
- **Tests.** In the test files listed in the references.

Out of scope: setting any secret or repository setting, the contents of the scaffolded workflows (AISDLC-1353), the branch protection contexts (AISDLC-1352), the merge settings (AISDLC-1351), and starting the webhook receiver.

## Acceptance Criteria

- [ ] #1 A test shows a successful init's "Next steps" block and its pnpm note appear in the setup report.
- [ ] #2 A test shows a second setup run, after an init that failed on branch protection, runs `init --add branch-protection` and reports the result, instead of skipping init.
- [ ] #3 A test shows a second run does not run `init --add branch-protection` when the live read finds a rule, and does not when the plan returns HTTP 403.
- [ ] #4 A test shows setup creates `backlog/tasks/` and `backlog/completed/` in an empty repository and reports them as present on the next run.
- [ ] #5 A test shows the report with no MCP client says no client was found and does not contain "already registered".
- [ ] #6 A test shows the closing list prints done, not done or unknown for each of the four steps, with the exact command or settings page name for each not-done step, and shows unknown (not done) when a call fails.
- [ ] #7 A test shows setup runs no command that writes a secret or a repository setting (no `gh secret set`, no `gh api` with a method other than GET).
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
