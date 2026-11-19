---
id: AISDLC-1351
title: 'The scaffolded agent role states the merge settings, and a board that cannot merge says so'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - governance
  - doctor
dependencies:
  - AISDLC-1354
references:
  - pipeline-cli/src/config-manifest/manifest.ts
  - pipeline-cli/src/config-manifest/manifest.test.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/land-eligible.test.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/operational.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/status.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - .ai-sdlc/agent-role.yaml
priority: high
dispatchable: true
dispatchableReason: 'Bounded to one template constant, one landing-pass note, two printed lines, one doctor check and their tests; the template value is one named constant so the operator answer changes one line.'
---

## Description

**Gap.** A new adopter board starts with an `agent-role.yaml` that says nothing about merging. The board then never merges and never says why. The operator sees pull requests that stay open and no line that explains it.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running; anything not working says so loudly.

**Cause (read from the source on main).**

- **Nothing is written.** The scaffolded agent role comments out `allowForcePush` and sets no merge key (`orchestrator/src/cli/commands/init.ts:116-122` holds the only governance text, and the three tier templates end with it at `:154`, `:185`, `:216`). The manifest default template has no `governance` block at all (`pipeline-cli/src/config-manifest/manifest.ts:74-90`).
- **Defaults close everything.** `allowMerge` defaults to `never`, `mergeAuthors` to an empty list and `operational` to an empty list (`ai-sdlc-plugin/hooks/lib/governance-resolver.js:13-24`, `:71-78`). The key `allowMerge` accepts `never` or `onGreenClean`; any other value is ignored and keeps the default (`governance-resolver.js:219-224`). `operational` accepts only the nine names of the closed set (`governance-resolver.js:80-90`).
- **The landing pass is skipped, twice, with no record.** The dispatch tick runs it only when `operational` holds `land-eligible-prs` (`pipeline-cli/src/hierarchy/dispatch-loop.ts:1144`). Inside the pass, an empty `mergeAuthors` returns an empty report at once (`pipeline-cli/src/hierarchy/land-eligible.ts:96`), so no note, refusal or error is written.
- **`up` prints only two of the keys.** It logs `allowForcePush` and `operational` (`pipeline-cli/src/hierarchy/up.ts:479-482`) and warns only when `allowForcePush` is `never` (`up.ts:483-486`). It does not print `allowMerge` or `mergeAuthors`; the policy type holds neither (`pipeline-cli/src/hierarchy/operational.ts:56-64`). `status` prints no merge line.
- **Doctor has no check.** The only governance check reports `allowForcePush` (`orchestrator/src/cli/commands/doctor-checks.ts:2166`, registered at `:3319-3324`).
- **What this repository sets.** `.ai-sdlc/agent-role.yaml` sets `allowMerge: onGreenClean`, `mergeAuthors` with one login, and the nine `operational` actions.

**Shape.** The scaffolded file states the three keys with values. A board whose settings mean it will never merge says so in `up`, in `status`, in one landing note and in doctor, each in one line that names the key to change. The reporting does not depend on which values the scaffold writes.

**Control.** Reporting parts: no control changes. Template part: depends on the open question below. Writing `allowMerge: onGreenClean` for a new adopter would loosen the default for that adopter (agents may then merge through the gated helper); writing `never` keeps it as it is. Nothing here changes the gate itself.

**Open question for the operator (not decided here).** Which values the scaffold writes for a new adopter. Proposal only: under setup, `allowMerge: onGreenClean`, `mergeAuthors` set to the authenticated `gh` login, and the `operational` list this repository uses, all printed in the setup summary. The alternative is `allowMerge: never` with `mergeAuthors` and `operational` written empty and the loud line below. The task is implementable either way: the values are one named constant in `pipeline-cli/src/config-manifest/manifest.ts`, and every reporting change below reads the resolved policy, not the constant. Until the operator answers, the constant holds `allowMerge: never` with `mergeAuthors` and `operational` empty (today's effective values, so nothing is loosened), and the developer does not pick the other value.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does a new board need merge settings written at all, if the defaults are safe? The defaults are safe but silent; the requirement is that the state is visible, so the file and the output must state it. 2. Deleted: the quiet return on an empty author list, and the reliance on a reader knowing the defaults. 3. Simplified: one function that resolves the three keys and returns a one-line statement, used by `up`, `status`, the landing pass and doctor. 4. Accelerated: the operator sees the state at `up` and at setup, not after days of open pull requests. 5. Automated: a doctor check and tests fail when a key is missing or the template and the resolver disagree.

- **Template.** Both scaffold sources write `governance.allowMerge`, `mergeAuthors` and `operational` explicitly, from one exported constant (value `never` and two empty lists until the operator answers the open question). After AISDLC-1354 there is one template source, so this is one edit.
- **Landing pass.** With an empty `mergeAuthors`, `landEligiblePrs` writes one note per board and day (or returns a `reason` field on the report) saying that no merge author is set and which file to edit. When `operational` lacks `land-eligible-prs`, the dispatch tick records the same kind of note instead of skipping silently.
- **`up` and `status`.** Each prints one line when `allowMerge` is `never`, when `mergeAuthors` is empty, or when `land-eligible-prs` is not granted. The `policy (...)` line of `up` also names `allowMerge` and the author count.
- **Doctor.** A new check reports the three keys and where each came from (set or default), fails on a key that is absent from the file or malformed, and passes with a plain statement when the values are set, including `never`.
- **Tests.** In the test files listed in the references.

Out of scope: the values themselves (open question), the merge gate rules, branch protection (AISDLC-1352) and setup output (AISDLC-1355).

## Acceptance Criteria

- [ ] #1 A test shows both scaffold paths write `allowMerge`, `mergeAuthors` and `operational` into `agent-role.yaml`, and the resolver reads back the constant's values.
- [ ] #2 A test shows `landEligiblePrs` with an empty `mergeAuthors` records a note or reason that names `mergeAuthors` and the file, and does not call `gh`.
- [ ] #3 A test shows a dispatch tick with `operational` lacking `land-eligible-prs` records a note naming the missing grant.
- [ ] #4 A test shows `up` prints a merge-off line for `allowMerge: never`, one for an empty author list, and none when merging is fully configured.
- [ ] #5 A test shows `status` prints the same lines under the same conditions.
- [ ] #6 A test shows the doctor check fails on a file with no `governance` block, warns or fails on a malformed `allowMerge`, and passes with the three keys set, including `allowMerge: never`.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
