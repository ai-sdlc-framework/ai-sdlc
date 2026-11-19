---
id: AISDLC-1359
title: 'Pipeline code and hook messages name the installed CLI, not a path inside this repository'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - hooks
dependencies:
  - AISDLC-1358
references:
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/cli/hierarchy.test.ts
  - pipeline-cli/src/orchestrator/reconcile.ts
  - pipeline-cli/src/orchestrator/reconcile.test.ts
  - pipeline-cli/src/next-step/gh-issue.ts
  - pipeline-cli/src/next-step/gh-issue.test.ts
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/usage/launch.ts
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.test.mjs
  - ai-sdlc-plugin/hooks/lib/hierarchy-role.js
  - ai-sdlc-plugin/hooks/lib/hierarchy-role.test.mjs
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
  - ai-sdlc-plugin/hooks/permission-check.js
  - ai-sdlc-plugin/hooks/permission-check.test.mjs
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to the repository-relative bin paths and messages that are real faults in an adopter repository, listed one by one, reusing the bin-directory pattern already in dispatch.ts.'
---

## Description

**Gap.** In a repository that has the plugin installed, several pipeline paths and hook messages name `pipeline-cli/bin/...` as if it were in the working directory. Some quietly do nothing (the usage ingest and the pre-spawn reconcile skip), some fail on a missing file (the finish verify), and the hook messages tell an agent to run a command that does not exist at that path.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running automatically; anything not working says so loudly.

**Cause (read from the source on main).** Each entry was re-read on the current checkout. Not run on an adopter repository.

Real faults in an adopter repository:

- `pipeline-cli/src/cli/hierarchy.ts:762` runs `<repoRoot>/pipeline-cli/bin/cli-attestation.mjs verify`. In an adopter the file is missing, `node` fails, and the finish step refuses with the stderr first line.
- `pipeline-cli/src/cli/hierarchy.ts:1454` passes `<repoRoot>/pipeline-cli/bin/cli-usage.mjs` to `launchUsageIngestDetached`, which returns `false` when the file is missing (`pipeline-cli/src/usage/launch.ts:44-45`). The tick's usage ingest never runs and nothing says so. (The Stop hook has its own resolver, `ai-sdlc-plugin/hooks/usage-ingest.js:53-63`, so usage is still ingested there.)
- `pipeline-cli/src/cli/hierarchy.ts:1531` builds `<repoRoot>/pipeline-cli/bin/cli-dispatch.mjs` and returns quietly when it is missing (`hierarchy.ts:1532`). The reconcile pass before the spawn step never runs in an adopter.
- `pipeline-cli/src/orchestrator/reconcile.ts:621` defaults `cliAttestationBin` to `<workDir>/pipeline-cli/bin/cli-attestation.mjs`; it is used for `emit-leaf` (`reconcile.ts:701`). A caller can override it, so this is a default fault only.
- Hook texts tell an agent to run `node pipeline-cli/bin/cli-decisions.mjs escalate` or `node pipeline-cli/bin/cli-merge-if-eligible.mjs`: `ai-sdlc-plugin/hooks/lib/governance-resolver.js:372`, `ai-sdlc-plugin/hooks/enforce-blocked-actions.js:85`, `:234`, `:414`, `:587`, `:654`, `:700`, and `ai-sdlc-plugin/hooks/permission-check.js:76`. The sanctioned path named in a refusal does not exist in an adopter, so the agent cannot follow the message.
- `pipeline-cli/src/next-step/gh-issue.ts:84` needs `dogfood/dist/dispatch-from-issue.js`, a package of this repository. The failure is loud, but its fix, `pnpm --filter @ai-sdlc/dogfood build` (`gh-issue.ts:88`), cannot work in an adopter.

Already guarded, no change:

- `pipeline-cli/src/hierarchy/up.ts:102` and `:122` name `pnpm --filter @ai-sdlc/pipeline-cli build`, but `ensureFreshRepoBuild` returns first when `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh` is missing (`up.ts:111-112`), which is every adopter.
- `orchestrator/src/execute.ts:1598` fetches an adapter from the framework's own repository name. The result is discarded and the error is swallowed (`.catch(() => {})`), so it is a wasted lookup, not an adopter fault (inferred from reading; not run).

Dead on main as well, not an adopter-only fault:

- `pipeline-cli/src/orchestrator/playbook/handlers/attestation-verify-mismatch.ts:38` runs `scripts/check-attestation-sign.sh`. That file is not tracked on main (`git ls-files` finds none), so the handler fails here too.
- The `verify` command that `hierarchy.ts:762` runs is retired and always prints `status=invalid` and exits 1 (`pipeline-cli/src/cli/attestation.ts:785-803`), so the finish step's verify (`pipeline-cli/src/hierarchy/playbook.ts:393-397`) reads as failed even in this repository (inferred from reading; not run).

The pattern to reuse: `pipeline-cli/src/cli/dispatch.ts:513` derives the bin directory from the running module (`path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin')`). The AISDLC-1328 fix (commit `d52c91b2d`) did the same for the plugin scripts: `resolvePluginScriptsDir` returns the first candidate that holds the marker file and stops with a typed error otherwise (`pipeline-cli/src/cli/next-step.ts:65-76`). In the hooks, `resolveBin` in `ai-sdlc-plugin/hooks/lib/hierarchy-role.js:305-313` already tries `PIPELINE_CLI_BIN`, the plugin install and the monorepo copy, for one bin name.

**Shape.** Code that runs a pipeline-cli bin derives the directory from the running module, as `dispatch.ts` does. Hook messages name the resolved path when one exists, and otherwise the bin file name with the sentence that it is in the pipeline-cli bin directory (`$PIPELINE_CLI_BIN`). The `dogfood` message says the path is not available outside this repository.

**Control.** Does not change a control. Hook refusals deny exactly what they denied; only the suggested command text changes. The "never do X" rule texts stay defined once in `ai-sdlc-plugin/hooks/lib/prompt-rules.js`, which holds no path and is not edited.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must a message hard-code a path? No; the hook can resolve it or name the bin. 2. Deleted: the four hard-coded repository paths in the code and the repeated literal in the eight hook messages. 3. Simplified: one `resolveBin(name)` in the hooks (the existing function with the bin name as a parameter) and one module-derived bin directory in the TypeScript. 4. Accelerated: no new lookup is introduced; each uses the first existing candidate. 5. Automated: tests run each path from a working directory that has no `pipeline-cli/`.

- **TypeScript.** `hierarchy.ts:762`, `:1454`, `:1531` and `reconcile.ts:621` take the bin directory from the running module. `:1531` keeps its guard but logs one warning line when the bin is missing instead of returning silently.
- **Hooks.** Generalise `resolveBin` in `hooks/lib/hierarchy-role.js` to take the bin name. Build each message through it in the three hook files. When no candidate exists, the message says `cli-decisions.mjs in your pipeline-cli bin directory ($PIPELINE_CLI_BIN)`.
- **gh-issue.** When `dogfood/` is not present in the working directory, the failure says the API-key path exists only inside the framework repository and names no build command.
- **Tests.** In the test files listed in the references.

**Open question for the operator (not decided here).** The retired attestation parts: the re-sign handler (`attestation-verify-mismatch.ts`) calls a script that is not tracked, and the finish verify calls the retired `verify`. Proposal only: file a separate task to delete the handler and the verify call, because the review verdict gate no longer reads an attestation (the merge gate reads the verdict record). This task changes neither; it only moves their path default at `hierarchy.ts:762` and `reconcile.ts:621` to the module-derived directory.

Out of scope: the dispatch module's bins (AISDLC-1358), the `execute.ts:1598` lookup, the retired attestation handlers, the scaffolded workflows (AISDLC-1353).

## Acceptance Criteria

- [ ] #1 A test shows the finish verify (`hierarchy.ts:762`) builds its bin path from the module directory, with a working directory that has no `pipeline-cli/`.
- [ ] #2 A test shows the tick's usage ingest receives an existing bin path from a working directory that has no `pipeline-cli/`.
- [ ] #3 A test shows the pre-spawn reconcile runs from a working directory that has no `pipeline-cli/`, and logs one warning line when the bin is missing.
- [ ] #4 A test shows the default `cliAttestationBin` in `reconcile.ts` is module-derived and an explicit option still wins.
- [ ] #5 A test of each of the three hook files shows the refusal text contains the resolved bin path when `PIPELINE_CLI_BIN` is set, and the sentence naming the bin directory when no candidate exists.
- [ ] #6 A test shows no hook message contains the literal `node pipeline-cli/bin/` when `PIPELINE_CLI_BIN` points elsewhere.
- [ ] #7 A test shows `prompt-rules.js` is unchanged and its rule texts hold no path (the existing prompt-rules test still passes).
- [ ] #8 A test shows the `gh-issue` failure names no `pnpm --filter @ai-sdlc/dogfood` command when `dogfood/` is absent, and keeps it when `dogfood/` exists.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
