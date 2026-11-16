---
id: AISDLC-1288
title: 'Untrusted PR gate comment says why each file was blocked: protected path or file type not allowed'
status: To Do
assignee: []
created_date: '2026-11-16'
labels:
  - pipeline-cli
  - untrusted-pr-gate
  - bug
dependencies: []
references:
  - pipeline-cli/src/pipeline/ast-gate.ts
  - pipeline-cli/src/pipeline/ast-gate.test.ts
  - pipeline-cli/src/cli/ucvg.ts
  - pipeline-cli/src/cli/ucvg.test.ts
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/__tests__/untrusted-pr-gate.test.mjs
  - docs/concepts/untrusted-contributor-verification.md
priority: medium
dispatchable: true
dispatchableReason: 'Observed on the first live gate run with the flag on (fork PR #2683, run 43722211855, 2026-11-15): `sdk-python/src/ai_sdlc/compliance/mappings.py` was blocked because `.py` is not in `allowedMutationGlobs`, and the bot comment told the contributor the path "is protected". The planner confirmed the cause in source on 2026-11-16; the operator delegated the decision to the planner the same day.'
---

## Description

**Gap.** Stage 1 of the gate blocks a file for one of three reasons, and tells the contributor only one of them.

- `runAstGate` (`pipeline-cli/src/pipeline/ast-gate.ts`) pushes a path onto `offendingPaths` when the path cannot be normalised, when it matches `protectedPaths`, and when it matches no entry of `allowedMutationGlobs`. The result has no reason per path.
- The comment the workflow posts is written inline in `.github/workflows/untrusted-pr-gate.yml` (step "Stage 1 — Post block comment + label"). It reads only the paths and prints "The following paths are protected and may not be changed by untrusted contributors".
- `buildBlockedComment` in `ast-gate.ts` renders the same comment and also lists the content findings, but nothing outside tests calls it. The two copies have already drifted.
- The workflow passes the paths as one string joined with spaces, so a path that contains a space is printed as two paths.

On fork PR #2683 a Python file was blocked for its file type and the contributor was told it was a protected path.

**Decision (planner, 2026-11-16).** Options weighed: (a) record a reason per path and render the comment from one function; (b) change only the sentence in the workflow to cover both cases; (c) add a second outcome value beside `abort-protected-path`; (d) leave it. Option (a) was chosen. The strongest case against it is that (b) is a two-line change and (a) touches the workflow of a security gate for a wording gain. (a) was kept because the outcome and every blocking rule stay as they are, the duplicate renderer is the cause of the drift, and the space-joined path list is a defect that (b) leaves in place. (c) changes the report schema and every reader of the outcome for no gain to the contributor.

**Shape.** The gate result says why each path was blocked. One function renders the comment, and the workflow posts what that function returns.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does the contributor need the reason? Yes: "protected" tells them to stop, "file type not allowed" tells them a maintainer has to review it by hand; these lead to different actions. Does the gate need two renderers? No. 2. Deleted: the inline comment text in the workflow. 3. Simplified or optimised: one renderer, one JSON read. 4. Accelerated: not applicable. 5. Automated: tests on the reasons, on the rendered comment and on the workflow step.

- **Result.** `AstGateResult` gains a list with one entry per blocked path: the path and a reason, one of `protected-path`, `file-type-not-allowed`, `invalid-path`. `offendingPaths` stays, with the same content as today, so existing readers do not change. `outcome` stays `abort-protected-path` for all three; no new outcome value.
- **Renderer.** `buildBlockedComment` groups the paths by reason under three plain sentences: paths that are protected; paths whose file type is outside the allowed list (the comment says a maintainer reviews these by hand); paths that are not valid. It keeps the content findings section. A group with no path is not printed.
- **CLI.** `cli-ucvg` gets a way to print the comment for a gate result (a flag on `ast-gate` or a subcommand; choose the smaller change) so the workflow does not rebuild it.
- **Workflow.** The step posts the text the CLI returns. It no longer splits a space-joined string of paths. The label, the trigger, the permissions and every `if:` condition of the workflow stay as they are.
- **Docs.** `docs/concepts/untrusted-contributor-verification.md` quotes the old comment; update the quote and describe the three reasons.

Out of scope: the content of `protectedPaths` and `allowedMutationGlobs` in `.ai-sdlc/untrusted-pr-gate.yaml` (operator decision); any change to which files are blocked.

## Acceptance Criteria

- [ ] #1 For a change set with one path matching `protectedPaths`, one path outside `allowedMutationGlobs` and one path that cannot be normalised, the result lists each path with the reason `protected-path`, `file-type-not-allowed` and `invalid-path` respectively; a test covers it.
- [ ] #2 `outcome` and `offendingPaths` are equal to today's values for every existing case in `ast-gate.test.ts`; no existing assertion on them changes.
- [ ] #3 `buildBlockedComment` for a result with only a `file-type-not-allowed` path does not say the path is protected and says a maintainer reviews it by hand; a test covers it.
- [ ] #4 A path that contains a space appears once, whole, in the rendered comment; a test covers it.
- [ ] #5 The workflow step posts the comment text produced by `cli-ucvg` and contains no copy of the comment sentences; `untrusted-pr-gate.test.mjs` covers both.
- [ ] #6 The diff of `.github/workflows/untrusted-pr-gate.yml` changes no trigger, permission, `if:` condition, secret or environment; the PR body states this.
- [ ] #7 `docs/concepts/untrusted-contributor-verification.md` shows the new comment and the three reasons.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
