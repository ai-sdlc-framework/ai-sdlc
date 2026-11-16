---
id: AISDLC-1290
title: 'Gate and hierarchy docs match the code merged since 2026-11-08'
status: To Do
assignee: []
created_date: '2026-11-16'
labels:
  - docs
dependencies:
  - AISDLC-1285
  - AISDLC-1288
references:
  - docs/operations/untrusted-contributor-pr-verification.md
  - docs/concepts/untrusted-contributor-verification.md
  - docs/api-reference/rfc-0043-ucvg.md
  - docs/ucvg-test-repo-setup/signing-key-setup.md
  - docs/operations/quality-gate.md
  - docs/operations/attestation-reference.md
  - docs/operations/adopter-attestation-verify-ci.md
  - docs/operations/developer-agent-reference.md
  - docs/operations/cli-hierarchy.md
  - docs/operations/backlog-and-execution-reference.md
  - docs/operations/untrusted-pr-gate.md
  - docs/operations/doctor.md
priority: medium
dispatchable: true
dispatchableReason: 'A docs audit run by the planner on 2026-11-16 over the 33 feature and fix commits merged since 2026-11-08 found five statements that the code made false and eight user-visible changes with no doc mention; each was checked against source on `main`. The operator delegated the decision to file to the planner on 2026-11-16. The dependencies are listed because AISDLC-1285 and AISDLC-1288 edit two of the same files.'
---

## Description

**Gap.** Fourteen hardening changes to the untrusted PR gate and several hierarchy changes landed between 2026-11-08 and 2026-11-16. Some of them did not update the docs. An audit on 2026-11-16 found the items below. Verify each against the source named before editing; when the source has changed again, describe what is true at the time of the edit.

**Decision (planner, 2026-11-16).** An earlier audit of 2026-11-08 was never acted on and its draft was lost. Options weighed: rerun the audit and file from verified findings; rewrite the lost draft from a summary; file only the one finding known by name; drop it. The rerun was chosen: the one known finding was a wrong statement in operator-facing gate docs, and acting on findings older than the code they describe would send an executor after text that may no longer exist. The strongest case against it, that nobody missed the task for eight days, does not hold for wrong statements about where a secret is held.

### Wrong statements

1. **Where the reviewers run.** `docs/operations/untrusted-contributor-pr-verification.md`, section "Reviewer execution model (in-sandbox, inference.local)", says the reviewers run inside the same sandbox as Stage 2 and that the process never holds `ANTHROPIC_API_KEY`. In fact `cli-ucvg sandbox-run` (`pipeline-cli/src/cli/ucvg.ts`) runs the reviewers in the host process on the runner by default, and a host-side inference proxy holds the key. Only with `AI_SDLC_UCVG_REVIEWERS_IN_CONTAINER=1` (and the proxy running) do they run in a separate proxy-only container. `.github/workflows/untrusted-pr-gate.yml` does not set that variable.
2. **Skipped status.** When the flag is off or the author is trusted, the workflow posts the context `ai-sdlc/untrusted-pr-gate-skipped` ("No review ran: ..."); the context `ai-sdlc/untrusted-pr-gate` is never `success` in those cases (AISDLC-1268). Three docs still say it is: `docs/concepts/untrusted-contributor-verification.md` (status table), `docs/api-reference/rfc-0043-ucvg.md` (status table), `docs/ucvg-test-repo-setup/signing-key-setup.md` ("a neutral success status (skipped)").
3. **Reason codes of `verdict-check`.** `pipeline-cli/src/attestation/verdict-check.ts` also returns `pr-mismatch` and `not-clean-room`. The lists in `docs/operations/quality-gate.md`, `docs/operations/attestation-reference.md` and `docs/operations/adopter-attestation-verify-ci.md` stop at `tier-short`.
4. **`--pull-request` is required.** `pipeline-cli/src/cli/attestation.ts` requires it. The "Local dry run" example in `docs/operations/adopter-attestation-verify-ci.md` omits it and fails as written.
5. **Paths an untrusted run cannot write.** `docs/operations/developer-agent-reference.md` names only `.ai-sdlc/**` and `.github/workflows/**`. Since AISDLC-1276 the list also has `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `scripts/**`, `CLAUDE.md` and `.mcp.json`, and an untrusted run cannot write outside its own worktree (`pipeline-cli/src/steps/untrusted-protected-paths.ts`, `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`).

### Changes with no doc mention

6. `AI_SDLC_UCVG_REVIEWERS_IN_CONTAINER=1`: belongs beside item 1.
7. Held-task triage (AISDLC-1244): `cli-hierarchy status` prints `held: <task> (waits on <dep>) [<class>]`; the classes are `waiting`, `operator-gated`, `absent`, `circular` and `failed-dependency` (`pipeline-cli/src/hierarchy/held-triage.ts`); a hold that cannot clear is routed to the planner once. Belongs in `docs/operations/cli-hierarchy.md` under `status`.
8. Outsider-issue check (AISDLC-1269, `pipeline-cli/src/next-step/gh-issue.ts`): an issue whose author is not an owner, member or collaborator is refused unless a maintainer applies the `execute-approved` label; the title is capped at 500 bytes and the description at 20000 bytes. Belongs in `docs/operations/backlog-and-execution-reference.md`.
9. `maxDiffBytes` (default 200000) in `.ai-sdlc/untrusted-pr-gate.yaml`: add it to the config sections of `docs/operations/untrusted-pr-gate.md`, `docs/operations/untrusted-contributor-pr-verification.md` and `docs/api-reference/rfc-0043-ucvg.md`.
10. The clean-room signer refuses to sign unless the upstream suite and the new tests both passed (`pipeline-cli/src/pipeline/clean-room-signer.ts`), and the sandbox image is pinned by digest with `AI_SDLC_SANDBOX_IMAGE` as the override (`pipeline-cli/src/pipeline/sandbox-runner.ts`). Belongs in `docs/operations/untrusted-contributor-pr-verification.md`.
11. `cli-attestation verdict-check --require-clean-room`, which the gate passes for fork heads: `docs/operations/quality-gate.md` and `docs/operations/attestation-reference.md`.
12. The `check-artifact` job of `verdict-writer.yml`, which ends green without writing when the run has no verdict artifact: `docs/operations/quality-gate.md`.
13. `check-plugin-version.js --deps`: `docs/operations/doctor.md`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must every item be documented? Items 1 to 5 are false statements and must change. Items 6 to 13 are flags, labels and config keys an operator or adopter has to know to use; none is internal. 2. Deleted: the false paragraphs are replaced, not kept beside a correction. 3. Simplified or optimised: each fact is stated once in its reference doc; other docs link to it. 4. Accelerated: not applicable. 5. Automated: none here; a check that a PR changing a CLI flag also changes a doc is a separate question for the planner.

- Correct items 1 to 5 in the files named.
- Add items 6 to 13 to the files named, each as one short paragraph or table row in the section that already covers the subject.
- Docs only: no source, workflow or config file changes.
- When an item turns out to be already documented or no longer true, leave it and say so in the PR body.

## Acceptance Criteria

- [ ] #1 `docs/operations/untrusted-contributor-pr-verification.md` states that the reviewers run in the host process by default with a host-side proxy holding the key, and describes `AI_SDLC_UCVG_REVIEWERS_IN_CONTAINER=1`.
- [ ] #2 No doc says the context `ai-sdlc/untrusted-pr-gate` is `success` when the flag is off or the author is trusted; the three docs of item 2 name `ai-sdlc/untrusted-pr-gate-skipped`.
- [ ] #3 The three reason-code lists of item 3 include `pr-mismatch` and `not-clean-room`.
- [ ] #4 Every `verdict-check` example in `docs/operations/adopter-attestation-verify-ci.md` passes `--pull-request`.
- [ ] #5 `docs/operations/developer-agent-reference.md` lists the paths of item 5 and the worktree limit.
- [ ] #6 Items 7 to 13 are each described in the file named for them.
- [ ] #7 The diff contains only files under `docs/`.
- [ ] #8 The PR body lists each of the 13 items as corrected, added, already present or no longer true.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
