---
id: AISDLC-1336
title: 'The first pull request of a new adopter is explained and the auto-merge workflow names its missing secret'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - docs
dependencies:
  - AISDLC-1332
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.test.ts
  - pipeline-cli/src/governance/release-merge.ts
  - pipeline-cli/src/governance/release-merge.test.ts
  - orchestrator/src/cli/commands/init-templates.ts
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - orchestrator/src/cli/commands/setup.ts
  - orchestrator/src/cli/commands/setup.test.ts
  - docs/operations/init.md
  - docs/getting-started/onboarding.md
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to two refusal messages, one workflow template step, two output lines, two doc pages and their tests.'
---

## Description

**Gap.** The pull request that adds `.ai-sdlc/` to a project for the first time cannot be merged by `cli-merge-if-eligible`, and nothing tells the adopter why or what to do. The refusal reads like a network fault. Separately, the scaffolded auto-merge workflow fails on that same pull request with a message that points at the wrong cause.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18): `cli-merge-if-eligible 1 --source-kind backlog --dry-run` refused with `could not read .ai-sdlc/agent-role.yaml from main as GitHub serves it`. The operator merged that first pull request by hand. On the same pull request the `enable-auto-merge` job failed with `gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable`.

**Cause (read from the source).**

- The merge policy is read only from the default branch, by design, so a pull request cannot change the rules that judge it: `pipeline-cli/src/governance/merge-if-eligible.ts:1491-1513` (`readFileFromMain`, defined at line 153). Before the first merge, `.ai-sdlc/agent-role.yaml` is not on `main`, so the read returns nothing.
- The refusal text at `merge-if-eligible.ts:1510-1512` and the twin at `pipeline-cli/src/governance/release-merge.ts:732` give one message for every cause (no file, no access, network fault). Neither says that the first pull request which adds `.ai-sdlc/` is merged by a person.
- `orchestrator/src/cli/commands/init-templates.ts:788,810,843` set `GH_TOKEN: ${{ secrets.AI_SDLC_PAT }}` on every `gh` step of `enable-auto-merge`. In a project that has not yet created the `AI_SDLC_PAT` secret, GitHub passes an empty value, so `gh` reports a missing `GH_TOKEN`. The variable is set; the secret behind it is not, and the message does not say so.
- The `init` next steps (`orchestrator/src/cli/commands/init-features.ts:2114`) and `docs/operations/init.md:180` mention the secret but not that the first pull request is merged by hand. `docs/getting-started/onboarding.md:398` (section 8.2) does the same. `renderSetupReport` in `orchestrator/src/cli/commands/setup.ts:143-156` says nothing about it.

**Shape.** Both refusals say, in one sentence, that when `.ai-sdlc/agent-role.yaml` is not on the default branch yet, the first pull request which adds `.ai-sdlc/` is merged by a person, and that every later pull request goes through `cli-merge-if-eligible`. The refusal is still a refusal, and the policy is still read only from the default branch. The `enable-auto-merge` job gets a first step that checks the secret is set and, when it is not, fails with one line that names `AI_SDLC_PAT` and the repository setting where it is created. The job still fails when the secret is missing, as today. `init` output, the `setup` report and the two adopter pages state the first-merge rule. A test proves that every scaffolded workflow step that runs `gh` sets `GH_TOKEN`.

**Control.** No control changes. The policy source stays the default branch. The refusal stays fail-closed. The auto-merge workflow still does not arm without a token.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "the policy must come from the trusted branch" stays; it is the control. What is missing is the reason, not the rule. 2. Deleted: the guess work. One clear sentence replaces a message that looks like a fault. 3. Simplified or optimised: one shared sentence for both refusals, one preflight step instead of a longer workflow. 4. Accelerated: the adopter learns about the first-merge rule in the refusal, in `init` and `setup` output, before the first stuck pull request. 5. Automated: one test fails when any scaffolded `gh` step lacks `GH_TOKEN`, so a new workflow cannot bring the problem back.

- **Refusal text.** In `merge-if-eligible.ts` and `release-merge.ts`, extend the refusal with: the file may not be on the default branch yet; the first pull request that adds `.ai-sdlc/` is merged by a person; later ones use this command. Keep the existing leading text so current matches still hold.
- **Workflow template.** In `init-templates.ts`, add a first step to `enable-auto-merge` that exits non-zero with a plain line when `secrets.AI_SDLC_PAT` is empty. Keep `GH_TOKEN` on every `gh` step.
- **Output.** `init-features.ts` next steps and `setup.ts` report each carry one line about the first pull request.
- **Docs.** `docs/operations/init.md` and `docs/getting-started/onboarding.md` state the first-merge rule next to the secret setup.
- **Tests.** Extend the three test files named in the criteria.

Out of scope: any way to read the policy from the pull request or to let the first pull request merge by command (a design decision, not made here); falling back to the default workflow token when the secret is missing (a design decision); the status description length in the review stub (AISDLC-1332).

## Acceptance Criteria

- [ ] #1 A test in `merge-if-eligible.test.ts` makes the policy read fail and asserts the refusal still starts with `could not read .ai-sdlc/agent-role.yaml from main` and also names the first pull request rule and that a person merges it.
- [ ] #2 A test in `release-merge.test.ts` asserts the same sentence in the release refusal.
- [ ] #3 A test in `init-features.test.ts` parses every workflow template scaffolded by init and fails when a step whose `run` text contains `gh ` has no `GH_TOKEN` in its `env`.
- [ ] #4 A test asserts the first step of `enable-auto-merge` fails with a line naming `AI_SDLC_PAT` when the secret is empty, and that the template still has no fallback to `github.token`.
- [ ] #5 A test asserts the `init` next steps with workflows selected include the first pull request rule, and a test in `setup.test.ts` asserts the report includes it.
- [ ] #6 `docs/operations/init.md` and `docs/getting-started/onboarding.md` each state that the first pull request which adds `.ai-sdlc/` is merged by a person.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
