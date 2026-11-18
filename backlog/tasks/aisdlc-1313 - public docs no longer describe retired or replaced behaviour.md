---
id: AISDLC-1313
title: 'Public docs no longer describe retired or replaced behaviour'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - docs-platform
dependencies: []
references:
  - docs/concepts/proof-of-execution.md
  - docs/getting-started/onboarding.md
  - docs/getting-started/install-agent-brief.md
  - docs/getting-started/README.md
  - docs/api-reference/rfc-0043-ucvg.md
  - docs/operations/merge-without-queue.md
  - docs/whitepapers/proof-of-execution.md
  - docs/concepts/autonomous-orchestrator.md
  - docs/concepts/operator-tui.md
  - docs/concepts/session-hierarchy.md
  - docs/concepts/index.md
  - docs/concepts/meta.json
  - docs/tutorials/08-claude-code-plugin.md
  - scripts/check-docs-retired-terms.test.mjs
  - scripts/check-poe-docs-rebase.test.mjs
  - docs/operations/cli-hierarchy.md
  - docs/operations/attestation-reference.md
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - spec/rfcs/RFC-0059-ephemeral-executors.md
priority: high
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: "file those docs tasks", after the planner''s audit of completed RFCs against the published documentation. Each statement below was read on `main` at b56cecaee on 2026-11-18 and checked against the source or the decision that retired it; line numbers are of that commit.'
---

## Description

**Gap.** The website publishes `docs/*.md`, `docs/getting-started/`, `docs/concepts/`, `docs/tutorials/`, `docs/api-reference/`, `docs/whitepapers/` and `spec/*.md`. Several of those pages describe, in the present tense, behaviour that was replaced or retired. A reader who follows them runs a command that does not exist or looks for a file that is never written. Verify each item against the source named before editing; when the source has changed again, describe what is true at the time of the edit.

### Review evidence: the v6 envelope was replaced by the verdict record (RFC-0061)

RFC-0061 replaced the signed v6 envelope committed in the branch with a verdict record in `refs/ai-sdlc/verdicts/*`; the v6 signer and verifier were deleted (AISDLC-1173), and `spec/rfcs/RFC-0042-proof-of-execution-attestation.md` line 35 says so. Current behaviour: `docs/operations/attestation-reference.md`, `docs/operations/quality-gate.md` and RFC-0061.

1. `docs/concepts/proof-of-execution.md`: line 8 says "Status: Implemented (the v6 attestation envelope is the default)"; lines 19 to 21 describe a DSSE envelope signed by the operator's key and committed under the attestations directory, checked by CI against the signature.
2. `docs/getting-started/onboarding.md`: line 16 says no signing key is needed (RFC-0061). The same page then tells the reader to create one: line 31 (step 5 of the quick-install brief), line 38 (keyring recovery), line 61 ("DSSE attestation signer"), line 76 and lines 227 to 289 (Step 4, "Initialize a Signing Key"), lines 304 and 307 (table rows), lines 421 to 502 (Step 7: `.ai-sdlc/attestations/<head-sha>.dsse.json`, the "v6 default" warning at 435 to 449, the file list at 466 to 477, "Promoting attestation to a hard gate"), lines 583 to 592 (Gap 2) and lines 632 to 641 (troubleshooting).
3. `/ai-sdlc init-signing-key` does not exist: there is no `ai-sdlc-plugin/commands/init-signing-key.md`, and `orchestrator/src/cli/commands/init-templates.ts` line 432 says "the `init-signing-key` command is gone". It is still an instruction in `docs/getting-started/install-agent-brief.md` (line 17, step 5; line 24, keyring recovery), which is the text an adopter pastes into an agent, in `docs/getting-started/onboarding.md` (lines 31, 234, 247, 272, 304, 583 to 590), in `docs/getting-started/README.md` (lines 7 and 261, "signing-key init") and in `docs/tutorials/08-claude-code-plugin.md` (line 97).
4. `docs/api-reference/rfc-0043-ucvg.md`: lines 584 to 586 (build the v6 Merkle tree, sign, write `.ai-sdlc/attestations/<patchId>.v6.dsse.json`) and lines 741 and 751 (`clean-room-sign` "emits signed DSSE envelope"). `pipeline-cli/src/pipeline/clean-room-signer.ts` line 20 says the step no longer signs anything (RFC-0061 phase 3); the verdict is written by `cli-ucvg emit-verdict` and the trusted verdict writer.
5. `docs/operations/merge-without-queue.md` line 100: "AISDLC-491 / AISDLC-448 keep the v6 attestation valid for disjoint PRs across any later rebase", in the present tense. The carry-forward rule that replaced it is on the same page, lines 235 to 237.
6. `docs/whitepapers/proof-of-execution.md` (375 lines, dated 2026-05-21, `reference: "RFC-0042"`) describes the v6 envelope throughout (lines 81, 95, 96, 151, 295, 296, 340) and never names RFC-0061.

### Dispatch: three concept pages describe retired or replaced designs

7. `docs/concepts/autonomous-orchestrator.md` presents the RFC-0015 tick loop as the way to run autonomously: lines 33 to 34 (`AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`, `cli-orchestrator.mjs start`) and line 37 (`status`, `tick`, `start`). `docs/operations/billing-and-cost-optimization.md` line 75 states that the `/ai-sdlc orchestrator-tick` loop and the `cli-orchestrator` cron/daemon path are retired (AISDLC-763) in favour of `cli-hierarchy up`. Correction to the audit: the binary `pipeline-cli/bin/cli-orchestrator.mjs` still ships; what is retired is its use as the autonomous loop. The page is on the allowlist of `scripts/check-docs-retired-terms.test.mjs` (lines 40 to 41) waiting for this rewrite.
8. `docs/concepts/operator-tui.md` is in the sidebar (`docs/concepts/meta.json` line 17). The TUI was retired by operator decision on 2026-10-13 ("no further investment; a web dashboard RFC follows", recorded in the completed task AISDLC-891, line 108). Correction to the audit: `pipeline-cli/bin/cli-tui.mjs` still ships behind `AI_SDLC_TUI`; the page does not name that flag, so the command on line 30 fails as written, and line 43 links `pipeline-cli/docs/tui.md`, which does not exist.
9. `docs/concepts/session-hierarchy.md` predates RFC-0058 and RFC-0059. Line 8: "Status: Signed off; roster schema, the bootstrap command and the dispatch brief shipped October 2026". Line 19: the dispatch tier has a "Mid-tier" default model; it is a model-less host (`docs/operations/cli-hierarchy.md` line 862). Line 20: "Executor (N, five by default)"; `up` starts no executor and dispatch spawns one per task (`cli-hierarchy.md` lines 117 to 118; `--executors` is deprecated, line 131). Line 29: "An executor is emptied between tasks"; an executor ends when its verdict is recorded (RFC-0059). Line 39 calls the autonomous orchestrator "the dispatch loop each tier is built on". Correction to the audit: line 26 ("named tmux sessions") is still true; tmux remains the window manager (RFC-0058 OQ-3) and only the keystroke layer was retired.
10. `docs/concepts/index.md` lines 13, 14, 19 and 25 carry the same statuses in its table.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must a retired subject keep a page? A published URL that disappears is a dead link for every outside reference, so a retired subject keeps a short page that says what replaced it; it does not keep a sidebar entry. 2. Deleted: the signing-key steps, the v6 file listings and the tick-loop instructions are removed, not kept beside a correction. 3. Simplified or optimised: current behaviour is stated once in the page that owns it (`attestation-reference.md`, `cli-hierarchy.md`); the public pages summarise and link. 4. Accelerated: not applicable. 5. Automated: the retired-terms gate of AISDLC-893 already scans these paths; it gains the two tokens this task removes.

Per page:

- **Rewrite to current behaviour:** `docs/concepts/proof-of-execution.md` (keep the link to `../operations/attestation-reference.md` and do not use the phrases that `scripts/check-poe-docs-rebase.test.mjs` forbids; name RFC-0061 beside RFC-0042), `docs/concepts/session-hierarchy.md`, the sections of `docs/getting-started/onboarding.md` listed in item 2 (Step 4 is removed and later steps renumbered; Step 7 describes how an adopter sees the review verdict and the `ai-sdlc/pr-ready` result, from what `ai-sdlc init` scaffolds today), `docs/getting-started/install-agent-brief.md` (step 5 and the keyring recovery are removed; the brief embedded in `onboarding.md` lines 22 to 42 stays identical to it), `docs/getting-started/README.md` lines 7 and 261, `docs/tutorials/08-claude-code-plugin.md` line 97, `docs/api-reference/rfc-0043-ucvg.md` at the lines of item 4, `docs/operations/merge-without-queue.md` line 100.
- **Replace with a short "retired" page and remove from the sidebar:** `docs/concepts/autonomous-orchestrator.md` (retired as the autonomous loop by AISDLC-763; points to `session-hierarchy.md`) and `docs/concepts/operator-tui.md` (retired by operator decision 2026-10-13; states that `cli-tui` still ships behind `AI_SDLC_TUI` with no further investment, if that is still true at the time of the edit). Each keeps its frontmatter `title` and `description`, is at most 15 lines and says "retired" in its first paragraph. Remove both names from `docs/concepts/meta.json` and both rows from the table of `docs/concepts/index.md`; correct the status cells of lines 14 and 25 of that page.
- **Dated notice, no rewrite:** `docs/whitepapers/proof-of-execution.md` gains one blockquote directly under the frontmatter: dated, says the paper describes the v6 envelope of RFC-0042 as published on 2026-05-21, that RFC-0061 replaced the envelope with a verdict record outside the branch, and links RFC-0061 and the concept page. The body and the frontmatter are unchanged.
- **Gate.** `scripts/check-docs-retired-terms.test.mjs` already scans every file under `docs/` except `audits`, `upstream-bug-reports` and `whitepapers`, so the paths of this task are covered. Delete the allowlist entry for `docs/concepts/autonomous-orchestrator.md` (the test fails on an entry with no token left). Add the tokens `init-signing-key` and `.v6.dsse.json` to `RETIRED_TOKENS`; a file outside this task's diff that still uses one gets an allowlist entry with the reason "left out of AISDLC-1313", and the PR body lists those files.
- **Stop rule.** If what the scaffold gives an adopter for Step 7 cannot be determined from `ai-sdlc init` output and `docs/operations/adopter-attestation-verify-ci.md`, describe only what is verified, name the open point in the PR body and do not invent a workflow.

Out of scope, named in the PR body as left out: `docs/whitepapers/untrusted-contributor-verification.md` (lines 74 and 111 name v6), `docs/concepts/usage-ledger-model-routing.md` line 40 (links the TUI page, which still resolves), v6 and signing-key text in unpublished pages (`docs/operations/attestation-troubleshooting.md`, `transcript-leaves-migration.md`, `review-policy.md`, `remote-agents-readonly.md`, `init.md`, `mcp-server-signing.md`, `docs/ucvg-test-repo-setup/`, `docs/demo/walkthrough.md`), the first paragraph of `docs/operations/cli-hierarchy.md` and line 57 of `README.md` ("up to five executors"), every file under `spec/rfcs/`, and any source, workflow or config file. The diff has at most 15 files including this task file.

## Acceptance Criteria

- [ ] #1 `grep -rn "init-signing-key" docs/getting-started docs/tutorials docs/concepts docs/api-reference` prints nothing.
- [ ] #2 `docs/getting-started/onboarding.md` has no step that creates a signing key and no `.dsse.json` path; `grep -n -i "dsse\|signing-key.pem" docs/getting-started/onboarding.md docs/getting-started/install-agent-brief.md` prints nothing.
- [ ] #3 The brief inside the fenced block of `docs/getting-started/onboarding.md` and the text below the rule in `docs/getting-started/install-agent-brief.md` have the same numbered steps; `node --test scripts/smoke-install-brief.test.mjs` passes.
- [ ] #4 `docs/concepts/proof-of-execution.md` names RFC-0061 and `refs/ai-sdlc/verdicts`, does not say the v6 envelope is the default, and `node --test scripts/check-poe-docs-rebase.test.mjs` passes without a change to that test.
- [ ] #5 `docs/concepts/session-hierarchy.md` says that dispatch is a model-less host, that one executor is spawned per task and ends when its verdict is recorded, and contains neither "five by default" nor "emptied between tasks".
- [ ] #6 `docs/concepts/autonomous-orchestrator.md` and `docs/concepts/operator-tui.md` are each at most 15 lines, say "retired" in the first paragraph and link the replacement or the decision; neither name is in `docs/concepts/meta.json` nor in the table of `docs/concepts/index.md`.
- [ ] #7 `docs/api-reference/rfc-0043-ucvg.md` no longer says that `clean-room-sign` writes `.v6.dsse.json` or emits a signed envelope; it names `cli-ucvg emit-verdict`.
- [ ] #8 `docs/whitepapers/proof-of-execution.md` differs from `main` only by one dated blockquote under the frontmatter that links RFC-0061.
- [ ] #9 `scripts/check-docs-retired-terms.test.mjs` has no allowlist entry for `docs/concepts/autonomous-orchestrator.md`, lists `init-signing-key` and `.v6.dsse.json` in `RETIRED_TOKENS`, and `node --test scripts/check-docs-retired-terms.test.mjs` passes.
- [ ] #10 `node scripts/check-docs-nav.mjs` passes.
- [ ] #11 The diff has at most 15 files; apart from `scripts/check-docs-retired-terms.test.mjs` and this task file, every file is under `docs/`. The PR body lists each of the 10 items as corrected, already correct or no longer true, and lists the files left out.
- [ ] #12 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
