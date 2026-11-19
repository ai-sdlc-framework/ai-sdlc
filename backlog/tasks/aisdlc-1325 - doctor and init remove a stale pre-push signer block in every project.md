---
id: AISDLC-1325
title: 'Doctor and init remove a stale pre-push signer block in every project, with or without the attestation workflow'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - doctor
  - hooks
  - adopter
dependencies: []
references:
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks-seed.test.ts
  - orchestrator/src/cli/commands/init-templates.ts
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/prepush-sign-snippet.test.ts
  - docs/operations/attestation-troubleshooting.md
priority: high
dispatchable: true
dispatchableReason: 'An adopter push is blocked by a hook block this project scaffolded; the fix is bounded to one doctor check, the init re-run and their tests.'
---

## Description

**Gap.** A project that was scaffolded before AISDLC-1261 keeps a pre-push block that searches the Claude Code plugin cache for `check-attestation-sign.sh` and runs the first copy it finds. `ai-sdlc doctor` reports that project as healthy, so nothing tells the adopter to rewrite the hook.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18): its pre-push hook picked `scripts/check-attestation-sign.sh` from a cached 0.33.0 folder and the push was refused. The operator had to delete cached plugin versions by hand to get past it.

**Cause (read from the source).**

- The block scaffolded before AISDLC-1261 (commit `c2bf6638c`) tried `CLAUDE_PLUGIN_ROOT`, then `CLAUDE_PLUGIN_DIR`, then looped over `"$HOME"/.claude/plugins/cache/*/ai-sdlc/*/` and took the first folder that holds `scripts/check-attestation-sign.sh`, in shell glob order. In a git hook neither variable is set, so the cache loop decides, and it picks any old version left on disk.
- Today's template, `HUSKY_PREPUSH_SIGN_SNIPPET` (`orchestrator/src/cli/commands/init-templates.ts:401-408`), is a no-op block. `hasStaleAttestationSignReference` (`:411-413`) and `stripStaleAttestationSignBlock` (`:421-427`) recognise and remove the old block.
- `checkHuskyPrePushGate` (`orchestrator/src/cli/commands/doctor-checks.ts:2784-2824`) returns `pass` at once when `.github/workflows/verify-attestation.yml` does not exist (`attestationEnabled`, `:2778-2782`, used at `:2786`). The stale test at `:2802` is never reached in a project without that workflow. Envelope signing and that workflow are gone, so this is the normal case for a current adopter.
- `fixHuskyPrePushGate` (`:2831-2863`) is the fix of the same check, so `doctor --fix` does not rewrite the hook in that case either.

**Shape.** A stale signer block is a defect in any project, whatever workflows it has. The stale test runs first and unconditionally; the "snippet missing" findings stay behind the workflow test.

**Control.** No control is loosened. The old block signs nothing that the merge gate reads (the gate reads verdict records); removing it removes a dead step that can only refuse a push.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "a pre-push sign gate is only relevant when the attestation workflow exists" was set when signing was optional (AISDLC-555); since the signing removal the old block is wrong everywhere, so the condition no longer holds for the stale test. 2. Deleted: the early `pass` for the stale case, and in every adopter hook the dead cache loop itself. 3. Simplified or optimised: one order of tests in the check, stale first, then the workflow-dependent findings. 4. Accelerated: an adopter gets the finding and the rewrite from one `doctor --fix` instead of deleting cache folders after each plugin update. 5. Automated: the init re-run strips the block without being asked, and tests cover a project with no attestation workflow.

- **Check order.** In `checkHuskyPrePushGate`, read the hook first; when `hasStaleAttestationSignReference` is true return `fail` with the existing title and remediation, whether or not the workflow exists. Otherwise keep today's behaviour (pass when the workflow is absent; the missing-hook and missing-snippet findings only when it is present).
- **Fix.** `fixHuskyPrePushGate` strips the stale block with `stripStaleAttestationSignBlock` in a project without the workflow and writes nothing else there; with the workflow it behaves as today.
- **Init re-run.** A re-run of `ai-sdlc init` in a project whose hook holds the stale block strips it and reports one line naming the hook file, also when the attestation feature is not selected. Check `init-features.ts` hook handling (`:1242-1410`) and change it only if it does not already do this.
- **Message.** The finding says in one sentence that the block runs a script from the plugin cache and may pick an old cached version.
- **Docs.** `docs/operations/attestation-troubleshooting.md` near line 139 still tells the reader to run `sign-attestation-if-consumer.sh`, which no longer exists; replace that instruction with `ai-sdlc doctor --fix`.

Out of scope: how commands and scripts find the plugin (AISDLC-1326 and AISDLC-1327); the other docs that still describe the old hook; this repository's own `.husky/pre-push`.

## Acceptance Criteria

- [ ] #1 A test: a project with no `.github/workflows/verify-attestation.yml` and a pre-push hook that holds the pre-1261 block gets `fail` from `checkHuskyPrePushGate`, with a remediation that names `ai-sdlc doctor --fix`.
- [ ] #2 A test: in that same project `fixHuskyPrePushGate` removes the block, keeps every other line of the hook byte for byte, and a second run of the check passes.
- [ ] #3 A test: a project with no workflow and no stale block still passes, and no hook file is created by the fix.
- [ ] #4 A test: with the workflow present, the existing findings (no hook, stale block, snippet missing) and the existing fix are unchanged.
- [ ] #5 A test: an init re-run in a project with the stale block and without the attestation feature strips the block and prints one line naming the hook file.
- [ ] #6 The check reads `.husky/pre-push` and `.git/hooks/pre-push` as today; a hook found through `core.hooksPath` is covered when the init hook resolution already supports it, and the PR body states which paths are covered.
- [ ] #7 `docs/operations/attestation-troubleshooting.md` no longer tells the reader to run `sign-attestation-if-consumer.sh`.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
