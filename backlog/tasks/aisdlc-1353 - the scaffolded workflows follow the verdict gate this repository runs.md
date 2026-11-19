---
id: AISDLC-1353
title: 'The scaffolded workflows follow the verdict gate this repository runs'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - workflows
  - doctor
dependencies: []
references:
  - orchestrator/src/cli/commands/init-templates.ts
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - orchestrator/src/cli/commands/init-workspace.test.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - pipeline-cli/src/cli/attestation.ts
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/consumer-verify-attestation.yml
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - docs/operations/adopter-attestation-verify-ci.md
  - docs/getting-started/onboarding.md
priority: high
dispatchable: true
dispatchableReason: 'Bounded to one new job in the adopter gate template, the removal of one scaffolded workflow, the review stub list entry, two doctor findings with a byte-identical replace, and their tests.'
---

## Description

**Gap.** The workflows a new adopter gets still describe the signed-envelope era. The scaffolded verifier always reports an invalid result and its approving job never runs. The scaffolded gate has no check of the review verdict, so the verdict record that the pipeline writes is never read, and the docs say the gate reads it.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running; anything not working says so loudly.

**Cause (read from the source on main).**

- **Basis.** CLAUDE.md states: the merge gate reads a verdict record in `refs/ai-sdlc/verdicts/*`, no attestation envelope is signed or verified, and schemas v3 to v6 are refused (DEC-0284). Read from the sources: DEC-0284 (operator ruling 2026-10-31, option `drop-legacy`, in `.ai-sdlc/_decisions/events/2026-10-31T05-16-32.250Z__DEC-0284__operator-answered__d74f4cdb9d69.json`) dropped schemas v3 to v5. RFC-0061 (status Implemented, `spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md`) replaced the v6 envelope with the verdict record, and its OQ-3 is the hard v6 cut with names kept.
- **Retired verifier still scaffolded.** The adopter `verify-attestation.yml` template runs `cli-attestation.mjs verify` (`orchestrator/src/cli/commands/init-templates.ts:282`) from an npm install pinned at `0.31.0` (`init-templates.ts:208`, install at `:271`). That command now refuses every call and prints `status=invalid` (`pipeline-cli/src/cli/attestation.ts:786-803`). The result is logged as a notice only (`init-templates.ts:288`). The `approve` job runs only on `valid` (`init-templates.ts:298-303`), so it never runs. The template is written by the attestation set (`init-templates.ts:1158`) and by the workflows bundle (`init-templates.ts:1687`).
- **No verdict check in the adopter gate.** The adopter gate template has jobs `detect`, `lint`, `build-test`, `coverage` and `pr-ready` only (`init-templates.ts:67-134`). This repository's gate has a `verdict-check` job (`.github/workflows/ai-sdlc-gate.yml:636`) that is in the `pr-ready` needs list (`ai-sdlc-gate.yml:1445-1467`); it runs the base tree's CLI, which an adopter does not have.
- **How adopters call the CLI today.** The only adopter route is an npm install of `@ai-sdlc/orchestrator` and `@ai-sdlc/pipeline-cli` at an exact version into a folder under the runner temp directory, outside the checkout (`init-templates.ts:263-272`), then `node <folder>/node_modules/@ai-sdlc/pipeline-cli/bin/cli-attestation.mjs`. The published reusable workflow `.github/workflows/consumer-verify-attestation.yml` does the same, with default version `0.41.0` (`consumer-verify-attestation.yml:35`). `verdict-check` first shipped in 0.41.0 (`docs/operations/adopter-attestation-verify-ci.md`). The registry lists 0.43.0 as the latest version of `@ai-sdlc/pipeline-cli`, and it matches `pipeline-cli/package.json`.
- **What this repository runs in place of the scaffolded verifier.** It has no `verify-attestation.yml`; the check is the `verdict-check` job inside its own gate. The `consumer-verify-attestation.yml` file exists only as the reusable workflow for consumers.
- **The review stub.** The scaffolded `ai-sdlc-review.yml` posts `Post Review Results` as `failure` on every non-draft pull request unless the repository variable `AISDLC_REVIEW_STUB_AUTOPASS` is `true` (`init-templates.ts:715-742`). The scaffolded branch protection does not require that context and the scaffolded gate does not need it (`branch-protection-shared.ts:105`; `init-templates.ts:133-137`), so it is a red status nobody gates on. This repository's `ai-sdlc-review.yml` runs on `pull_request_target` and reviews untrusted contributor pull requests only, with real reviewers; trusted pull requests are reviewed locally by `/ai-sdlc execute` and recorded as a verdict (`.github/workflows/ai-sdlc-review.yml:61-67`).
- **Review requirement.** Read-only `gh api` on this repository's main protection gives `required_approving_review_count: 0`, one bypass user, admins enforced, required contexts `Backlog Drift` and `ai-sdlc/pr-ready`. The scaffold requires 1 (`branch-protection-shared.ts:111`). With the `approve` job never running and no replacement, a non-admin pull request on a scaffolded repository waits for a human review; the merge gate also refuses unless `mergeStateStatus` is `CLEAN` (`pipeline-cli/src/governance/merge-if-eligible.ts:961-964`). A sole owner cannot approve their own pull request (inferred from GitHub behaviour, unverified here).
- **Doctor.** The `feature-workflows` check lists `verify-attestation.yml` as a required file when `trusted-reviewers.yaml` exists (`orchestrator/src/cli/commands/doctor-checks.ts:3078-3082`), and the pre-push check treats the file's presence as "attestation enabled" (`doctor-checks.ts:2937-2941`). Nothing flags the retired verifier or a gate with no verdict job.

**Shape.** The adopter gate runs the same verdict check as this repository, through the published CLI at a pinned version, and `pr-ready` needs it. The retired verifier is no longer scaffolded. Doctor says loudly when a repository still has the old verifier or an old gate, and the safe case (a file that is byte-identical to the old template) is replaced by init or `doctor --fix`; an edited file is reported with the lines to change, never overwritten.

**Control.** Adding the verdict check tightens: a code pull request with no valid verdict record now fails `ai-sdlc/pr-ready` on a scaffolded repository, as it does here, so a pull request that did not go through the pipeline needs an admin bypass. Docs-only and draft pull requests skip it. Removing the retired verifier loosens nothing: it never gated a merge. The review count is not changed here (open question below).

**Open question for the operator (not decided here).** The required approving review count. This repository requires 0 with one bypass user; the scaffold requires 1 and nothing posts an approval any more. Matching this repository would lower the adopter's count from 1 to 0. Proposal only: keep 1 and have the setup summary say plainly that a human review is required, or set 0 with the verdict gate as the review control. The task makes the value one named constant in `branch-protection-shared.ts` and prints it; the value stays 1 until the operator answers.

**Open question for the operator (not decided here).** Whether the scaffold keeps `ai-sdlc-review.yml`. The stub posts a red `Post Review Results` that nothing requires. Proposal only: stop scaffolding it, because trusted pull requests are reviewed locally and recorded as verdicts, and this repository uses the workflow for untrusted contributors only. The alternative is to keep it with the stub text changed to say what it is. The task is implementable either way: the file is one entry in the workflows list, and the doctor and test changes below do not depend on it. Until the operator answers, the entry stays and the stub is unchanged; the developer does not pick.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does an adopter need a separate verifier workflow at all? No; this repository has none, the check is a job of the gate. 2. Deleted: the scaffolded `verify-attestation.yml`, its `approve` job and the constant that detects the approve job. 3. Simplified: one gate workflow carries the verdict check and `pr-ready` needs it, so there is one required check. 4. Accelerated: a missing verdict fails the pull request at once instead of waiting for a review that never comes. 5. Automated: doctor and tests fail on the old verifier, on a gate without the job, and on a pin that is not a published version at or above 0.41.0.

- **Gate template.** Add a `verdict-check` job to `AI_SDLC_GATE_WORKFLOW`, in the `pr-ready` needs list. It checks out the base sha, fetches the head as data only, installs the two npm packages at one pinned version into a folder outside the checkout, and runs `cli-attestation.mjs verdict-check --head --base --repository --pull-request --post-status` with `statuses: write`. Skip conditions: draft, docs-only (the template's existing filter), and fork heads handled as in this repository's job. The pin is one constant, set to a published version of at least 0.41.0.
- **Verifier.** Remove `VERIFY_ATTESTATION_WORKFLOW` from the attestation set and the workflows bundle. Delete `ADOPTER_TEMPLATE_POSTS_APPROVAL` and the two message branches that depend on it in `init-features.ts` (`:1991-1992`, `:2012-2016`); print one line stating the required review count and that nothing posts an approval.
- **Review stub.** Unchanged in this task until the operator answers the second open question; the list entry is the only code that answer touches.
- **Review count.** Name the constant at `branch-protection-shared.ts:111`; value unchanged.
- **Doctor.** One finding when `.github/workflows/verify-attestation.yml` calls `cli-attestation.mjs ... verify`, one when the gate workflow has no `verdict-check` job. Remove the attestation row from the `feature-workflows` list. `--fix` and an init re-run delete the verifier, and rewrite the gate, only when the file is byte-identical to the previous template (the template text's hash is kept as a constant); otherwise they print the file and the change to make.
- **Tests.** In the test files listed in the references.

Out of scope: the `trusted-reviewers.yaml` stub and the attestation pre-push signer (AISDLC-1325), the required contexts list (AISDLC-1352), the reusable `consumer-verify-attestation.yml`, and the Node and pnpm assumptions of the gate jobs.

## Acceptance Criteria

- [ ] #1 A test shows the scaffolded gate has a `verdict-check` job, `pr-ready` needs it, the job calls `cli-attestation.mjs verdict-check --post-status` through an npm install outside the checkout, and the pinned version is at least 0.41.0.
- [ ] #2 A test shows no scaffold set (attestation, workflows, default init) writes `verify-attestation.yml`, and `ADOPTER_TEMPLATE_POSTS_APPROVAL` no longer exists.
- [ ] #3 A test shows the setup summary prints the required review count and that no workflow posts an approval.
- [ ] #4 A test shows the review stub entry is still in the workflows list (it stays until the operator answers the open question).
- [ ] #5 A test shows doctor fails on a `verify-attestation.yml` that calls the retired `verify`, and on a gate workflow with no `verdict-check` job, and passes on the new scaffold.
- [ ] #6 A test shows `doctor --fix` and an init re-run delete a byte-identical old verifier and rewrite a byte-identical old gate, and leave an edited copy unchanged while printing the file name and the change.
- [ ] #7 A test shows the `feature-workflows` check no longer warns when `trusted-reviewers.yaml` exists and `verify-attestation.yml` does not.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
