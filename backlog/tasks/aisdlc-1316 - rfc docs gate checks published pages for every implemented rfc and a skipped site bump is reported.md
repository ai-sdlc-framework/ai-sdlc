---
id: AISDLC-1316
title: 'RFC docs gate checks published pages for every implemented RFC, and a skipped site bump is reported'
status: In Progress
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - rfc
  - ci
  - hierarchy
dependencies: []
references:
  - scripts/check-rfc-docs.mjs
  - scripts/check-rfc-docs.test.mjs
  - scripts/check-dark-code.mjs
  - spec/schemas/rfc.schema.json
  - spec/rfcs/README.md
  - reference/src/core/generated-schemas.ts
  - .github/workflows/docs-source-bump.yml
  - .github/workflows/__tests__/docs-source-bump.test.mjs
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/status.ts
  - docs/operations/cli-hierarchy.md
  - package.json
assumes:
  - RFC-0009
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: "file those docs tasks", after the planner''s audit of completed RFCs against the published documentation. Both parts tighten a control (class a): the gate asks more of an implemented RFC and absorbs today''s gaps in a baseline that only shrinks; the workflow change reports a skip that is silent today. The script, its counts and the workflow were read on `main` at b56cecaee on 2026-11-18; `node scripts/check-rfc-docs.mjs` printed "57 RFC(s) walked, 34 enforced, 23 skipped (pre-sign-off)".'
---

## Description

Two gaps let shipped work stay out of the published documentation without any check failing.

### Gap 1: the RFC docs gate does not ask for a published page

What `scripts/check-rfc-docs.mjs` does today (`validateRfc`, lines 283 to 414):

- It decides whether to enforce from the legacy `status` field, not from `lifecycle`: only `Approved`, `Implemented` and `Final` are enforced (line 75). An RFC with `status: Signed Off` (RFC-0056, RFC-0058, RFC-0062) is skipped as "pre-sign-off" (lines 322 to 326).
- `requiresDocs: []` passes with no further check (line 367). Of the 57 RFC files, 42 declare `[]` and 15 declare at least one surface. (The audit counted 43 and 17; the figures here are from the files.)
- For each declared surface it passes when any `.md` file under the mapped folder contains the RFC id as text (`findReferences`, lines 234 to 240). The stronger `docsCoverage` check is opt-in and only RFC-0006 uses it.
- The surface map (lines 60 to 66) is `tutorial`, `operator-runbook`, `api-reference`, `getting-started`, `example`. `operator-runbook` maps to `docs/operations/` and `example` to `docs/examples/`; the website publishes neither. There is no surface for `docs/concepts/`.
- `deferredDocs: true` skips the surfaces with a warning and the deadline is never enforced (lines 369 to 390): RFC-0043 has been overdue since 2026-08-31 and passes.

Result on `main`: 22 RFCs have `lifecycle: Implemented`. Six declare a published surface (RFC-0002, 0003, 0004, 0006, 0008, 0010). Sixteen do not: fifteen declare `[]` (RFC-0009, 0011, 0012, 0013, 0014, 0016, 0019, 0022, 0023, 0024, 0025, 0031, 0035, 0041, 0048) and RFC-0061 declares only `operator-runbook`. RFC-0059 also declares `[]`, but its lifecycle is `Signed Off`, so it is outside the rule below.

### Gap 2: a skipped site bump looks like a success

`.github/workflows/docs-source-bump.yml` moves the website's pin when `docs/` or `spec/` change on `main`. Since the completed task AISDLC-1246, when the site repository is not visible to the `AI_SDLC_PAT` secret, the step at lines 55 to 68 prints one `::warning` and every later step is skipped by `if: steps.site.outputs.reachable == 'true'` (lines 70 to 92). The run ends green. The site was not updated for ten days and nothing an operator or the planner reads said so.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must every implemented RFC have a published page? No: a strategy RFC has nothing for an adopter to read. So the rule is "a published surface or a recorded exemption with a reason", and today's sixteen gaps go into a baseline instead of blocking `main`. Must the bump run be red? No: AISDLC-1246 removed the red run because a failure on every docs push sat beside real failures and still prompted no action. 2. Deleted: nothing. 3. Simplified or optimised: the rule is added to the existing script and its existing `pnpm rfc:check` entry; the skip is reported through the path that already reports a red `main` (`gatherMainHealth` and `reportMainHealth` in `reconcile.ts`). 4. Accelerated: not applicable. 5. Automated: both run without a new workflow or package script.

### Part A: published-page rule

- **Published surfaces.** `tutorial`, `api-reference`, `getting-started` and a new value `concept` that maps to `docs/concepts/`. Add `concept` to `SURFACE_TO_SUBDIR`, to the enum in `spec/schemas/rfc.schema.json` (and its description), and to the section "`requiresDocs` values" of `spec/rfcs/README.md`; regenerate `reference/src/core/generated-schemas.ts` with `pnpm --filter @ai-sdlc/reference generate-schemas`. `operator-runbook` and `example` stay valid values and are not published surfaces.
- **Rule.** For every RFC whose lifecycle is `Implemented` (resolved as `readRfcLifecycle` does: the `lifecycle` field, else the mapped `status`), one of these must hold: (1) `requiresDocs` names at least one published surface, `deferredDocs` is not `true`, and the existing citation check passes for it; (2) the RFC id is in `exempt` of the baseline file with a non-empty `reason`; (3) the RFC id is in `gaps` of the baseline file. Otherwise the gate fails with the RFC id, the published surfaces and the two ways out. An RFC with another lifecycle is not affected.
- **Baseline.** `scripts/rfc-published-docs-baseline.json`: `{ "gaps": [...], "exempt": [] }`, `gaps` sorted, initial content the sixteen ids above (follow the tree when the work starts), `exempt` entries of the form `{ "id", "reason" }`. The file is a ratchet, modelled on `scripts/check-dark-code.mjs`: an id in `gaps` that satisfies (1) or (2), is not `Implemented`, or names no RFC file fails with "remove it"; an id in `gaps` that is not in the same file on the base ref (`--base-ref`, default `origin/main`; a base ref without the file skips this comparison) fails as growth. The baseline is not placed under `.ai-sdlc/`.
- **No exemption is granted here.** `exempt` ships empty. The developer does not decide which RFC is a strategy RFC; an exemption is added by a later PR whose body names the decision.
- **Docs.** `spec/rfcs/README.md` states the rule, the baseline file and how to leave it, in the section that documents `requiresDocs`.
- **Tests** (`scripts/check-rfc-docs.test.mjs`, fixtures): an `Implemented` RFC passes with a cited published surface; fails with `[]`; fails with only `operator-runbook`; fails with a published surface and `deferredDocs: true`; passes when exempt with a reason; fails when exempt without one; passes when in `gaps`; a stale `gaps` entry fails; a grown `gaps` fails against a base that has the file; a `Signed Off` RFC with `[]` passes; `concept` maps to `docs/concepts/`.

### Part B: the skipped bump is reported

Choice: the run stays green, and the skip is reported where the planner and operator already look, `cli-hierarchy status` and one line to the planner. Rejected: ending the run failed. It is the smaller change, but it restores what AISDLC-1246 removed, and the run list is the place where forty red runs and then ten days of green skips both went unread. Neither option can block a pull request: the workflow runs only on push to `main` and on manual dispatch.

- **Workflow.** In the unreachable branch of the step "Check the site repository is visible to the token", also append the same sentence to `$GITHUB_STEP_SUMMARY`. No other change: triggers, permissions, step names and the `if:` conditions stay.
- **Reconcile.** Beside `gatherMainHealth` in `pipeline-cli/src/hierarchy/reconcile.ts`: read the latest completed run of `docs-source-bump.yml` on `main` (`gh run list --workflow docs-source-bump.yml --branch main --status completed --limit 1`), and, only when its run id differs from the recorded one, its steps (`gh run view <id> --json jobs`). State is `skipped` when the run concluded `success` and the step "Open or update the bump PR in the site repository" concluded `skipped`; `failed` when the run concluded `failure`; otherwise `ok`. Record `{ runId, state, since }` in `docs-source-bump.json` in the board directory, where `since` is the creation time of the first run seen in the current state. When the state changes to `skipped` or `failed`, send the planner one line through the `notifyPlanner` path that `reportMainHealth` uses; send nothing while the state is unchanged. A `gh` error leaves the record untouched and is not reported as a skip.
- **Status.** `cli-hierarchy status` (`pipeline-cli/src/hierarchy/status.ts`) prints `docs site pin: bump <state> since <date>` with the reason for `skipped` (site repository not visible to the workflow token) when the recorded state is `skipped` or `failed`, and nothing when it is `ok` or no record exists.
- **Docs.** `docs/operations/cli-hierarchy.md`, section `status`: the new line and what clears it.
- **Tests.** `.github/workflows/__tests__/docs-source-bump.test.mjs` asserts the job summary line and that the run still has no failing path for an unreachable repository; unit tests for the three states, for "no second message while unchanged", for the `gh` error case and for the status line.
- **Stop rule.** If `gh run view --json jobs` does not return step conclusions with the credentials reconcile runs under, or the planner path cannot carry a line that is not about a pull request, stop and report in the verdict notes; do not add a token, a secret or a workflow permission.

Out of scope: writing any missing page; changing `requiresDocs` in any RFC; enforcing `deferredDocsDeadline`; enforcing on `status: Signed Off`; whether the bump should be pulled by the site repository instead (the question AISDLC-1246 recorded for the operator); files under `.ai-sdlc/`; granting the token access.

## Acceptance Criteria

- [ ] #1 `node scripts/check-rfc-docs.mjs` fails, naming the RFC, when an RFC with `lifecycle: Implemented` has no published surface in `requiresDocs`, is not in `exempt` and is not in `gaps`; tests assert the `[]` case, the `operator-runbook`-only case and the `deferredDocs: true` case on fixtures.
- [ ] #2 `concept` is a `requiresDocs` value in `scripts/check-rfc-docs.mjs`, `spec/schemas/rfc.schema.json` and `spec/rfcs/README.md`, mapped to `docs/concepts/`; `reference/src/core/generated-schemas.ts` matches the schema (`pnpm build` leaves no diff in it).
- [ ] #3 `scripts/rfc-published-docs-baseline.json` exists, `gaps` lists exactly the `Implemented` RFCs without a published surface on the base tree, and `exempt` is empty.
- [ ] #4 The gate fails on a `gaps` entry that no longer needs to be there and on a `gaps` entry absent from the baseline of the base ref; a test asserts each case.
- [ ] #5 An `exempt` entry without a non-empty `reason` fails; a test asserts it.
- [ ] #6 `pnpm rfc:check` passes on the PR head, and no file matching `spec/rfcs/RFC-*.md` is in the diff.
- [ ] #7 `.github/workflows/docs-source-bump.yml` writes the skip sentence to `$GITHUB_STEP_SUMMARY` when the site repository is not visible; `on`, `permissions`, the step names and every existing `if:` are unchanged; `node --test .github/workflows/__tests__/docs-source-bump.test.mjs` passes.
- [ ] #8 Reconcile records `skipped`, `failed` or `ok` for the latest completed bump run and sends the planner one line only when the state changes to `skipped` or `failed`; unit tests cover the three states, the unchanged state and a `gh` error.
- [ ] #9 `cli-hierarchy status` prints the `docs site pin:` line for a recorded `skipped` or `failed` state and no such line otherwise; a unit test asserts both.
- [ ] #10 `docs/operations/cli-hierarchy.md` describes the line under `status`; `spec/rfcs/README.md` describes the rule and the baseline.
- [ ] #11 No file under `.ai-sdlc/` is in the diff; the diff has at most 15 files.
- [ ] #12 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
