---
id: AISDLC-1352
title: 'The scaffolded branch protection requires only checks the scaffolded workflows post, and a merge refusal reason shows in status'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - branch-protection
  - doctor
dependencies: []
references:
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - orchestrator/src/cli/commands/init-templates.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/land-eligible.test.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - pipeline-cli/src/hierarchy/pr-rows.ts
  - pipeline-cli/src/hierarchy/pr-rows.test.ts
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the required-contexts list, one doctor comparison, one stored refusal reason, one status line per open pull request and their tests.'
---

## Description

**Gap.** A new adopter gets branch protection that requires a check no scaffolded workflow posts. A pull request on that repository can then never satisfy protection, and the board's merge refusal reason is written to a file that nothing reads, so neither the operator nor `status` says why the pull request waits.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running; anything not working says so loudly.

**Cause (read from the source on main).**

- **A never-posted required check.** The scaffolded protection body requires `ai-sdlc/pr-ready` and `codecov/patch`, plus one approving review (`orchestrator/src/cli/commands/branch-protection-shared.ts:105`, `:111`). The scaffolded gate workflow posts `ai-sdlc/pr-ready` as the name of its aggregate job (`orchestrator/src/cli/commands/init-templates.ts:133-134`); its coverage job runs `pnpm test:coverage` and uploads nothing (`init-templates.ts:117-131`). No scaffolded workflow runs a Codecov upload, so `codecov/patch` is never posted.
- **How `codecov/patch` is posted.** The Codecov GitHub App posts it after a coverage upload. This repository uploads with `codecov/codecov-action` in `.github/workflows/ci.yml:299`, and dropped the check from its own required list (AISDLC-372; comment at `ci.yml:297-298`). `docs/operations/quality-gate.md:231-233` records that the status must come from the app, and that a pull request with no coverage data leaves the check unposted forever. Whether the app is installed on a given repository cannot be read from the repository files.
- **What this repository requires.** Read-only `gh api` on main protection gives required contexts `Backlog Drift` and `ai-sdlc/pr-ready`, review count 0 with one bypass user, admins enforced, strict off.
- **The refusal reason is a file nobody reads.** The merge gate returns "no required checks were resolved" and "required check(s) not green: ..." (`pipeline-cli/src/governance/merge-if-eligible.ts:989` and `:999`). The landing pass records the reason once per head in `notes/land-<pr>-<sha>.refused.txt` (`pipeline-cli/src/hierarchy/land-eligible.ts:169-176`) and stores only a fingerprint and time in the refusal record (`pipeline-cli/src/hierarchy/pr-snapshot.ts:170-173`). Nothing under `pipeline-cli/src` or the plugin hooks reads the `notes` folder besides the writer. The status table prints lane, action, reason, owner and age per open pull request, with no merge refusal (`pipeline-cli/src/hierarchy/pr-rows.ts:111-127`).
- **Doctor does not compare.** The check reads the required contexts for `ai-sdlc/pr-ready`, `ai-sdlc/attestation` and `Backlog Drift` only (`branch-protection-shared.ts:208-212`) and warns when protection is missing (`orchestrator/src/cli/commands/doctor-checks.ts:741-750`). It warns when `backlog/` exists and `Backlog Drift` is not required (`doctor-checks.ts:688-702`), yet no scaffolded workflow posts `Backlog Drift` (a grep of `init-templates.ts` and `init-features.ts` finds none). That warning cannot be cleared on a scaffolded repository; this task records it and leaves it (see out of scope).

**Shape.** The scaffold requires only contexts that the repository's own workflows will post. `codecov/patch` is added only when a workflow in the repository uploads to Codecov. Doctor compares the live required contexts with the names the workflows post and fails on one nobody posts. The reason a pull request was refused for merge shows next to that pull request in `status`.

**Control.** Dropping a never-posted `codecov/patch` from the scaffold does not loosen any control in effect: a required check that nobody posts can never pass, so it blocks every merge (or invites an admin bypass) and gives no coverage signal. An adopter that uploads to Codecov keeps the check, because the scaffold keeps it when a workflow uploads. The required review count and the `ai-sdlc/pr-ready` requirement do not change here (the review count is AISDLC-1353). The status line and the doctor comparison add reporting only.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should the scaffold require a coverage signal it does not produce? No; the scaffold's own gate already has a coverage job, and `ai-sdlc/pr-ready` rolls it up. 2. Deleted: the unconditional `codecov/patch` and the file-only refusal note as the sole record. 3. Simplified: one list of required contexts built from the workflows present, used by the PUT body, the init messages and doctor. 4. Accelerated: the reason shows at the next `status`, not after reading the notes folder. 5. Automated: a doctor failure and tests keep a never-posted context from coming back.

- **Contexts.** `RECOMMENDED_BRANCH_PROTECTION_BODY` becomes a function of the workflows on disk: `ai-sdlc/pr-ready` always, `codecov/patch` only when a file in `.github/workflows/` uses `codecov/codecov-action`. The three messages that name `codecov/patch` (`init-features.ts:1210`, `:2008`, `:2146`) print the list actually applied.
- **Doctor.** A check lists the required contexts on the protected branch and the check names the workflows post (job `name`, else job id; a matrix name is matched by its prefix; `codecov/*` counts as posted when a workflow uploads to Codecov). It fails on a required context nobody posts and names it, and passes with a plain statement otherwise. A `gh` failure or missing protection reports not checked, with the reason, never a pass.
- **Refusal reason.** `recordRefusal` also stores the reason text; the landing pass passes it. The status table prints one line per open pull request that was refused, with the reason and age, and removes it when the pull request lands or is not refused on the latest pass.
- **Tests.** In the test files listed in the references.

Out of scope: the review count and the verdict gate (AISDLC-1353), scaffolding or requiring `Backlog Drift` (the warning at `doctor-checks.ts:688-702` stays as it is), and any change to the merge gate rules in `merge-if-eligible.ts`.

## Acceptance Criteria

- [ ] #1 A test shows the applied protection body requires only `ai-sdlc/pr-ready` when no workflow uploads to Codecov, and adds `codecov/patch` when a workflow in `.github/workflows/` uses `codecov/codecov-action`.
- [ ] #2 A test shows the dry-run output and the three init messages name the contexts actually applied.
- [ ] #3 A test shows the doctor check fails when the protected branch requires `codecov/patch` and no workflow uploads to Codecov, and names the context.
- [ ] #4 A test shows the doctor check passes when every required context is a job name or an uploaded Codecov check, and reports not checked (not pass) when `gh api` fails.
- [ ] #5 A test shows a refused pull request stores its reason in the refusal record and a later successful landing clears it.
- [ ] #6 A test shows the status table prints the refusal reason for an open pull request and prints nothing extra for one that was not refused.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
