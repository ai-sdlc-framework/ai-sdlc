---
id: AISDLC-1433
title: A knowledge backend declares the local paths that check-scope and doctor verify
status: To Do
priority: medium
labels:
  - pipeline-cli
  - orchestrator
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1432
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/scope-check.ts
  - pipeline-cli/src/cli/context.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - docs/operations/doctor.md
  - docs/operations/knowledge-store.md
---

## Description

**Five-step review (requirements first).**
1. Question: Requested by the enterprise planner (ai-sdlc-enterprise RFC-0002 remote knowledge backend, item 7) on 2026-11-26; operator ruled 2026-11-26 through the decision rubric (decision record filing; cite as 'the item-7 decision record'). The push gate protects only `protectedRoot` (`scope-check.ts:56-79`: tracked files, git-ignored probe) and, for a range, `protectedRoots` (`:107-114`). A remote backend that keeps a local replica or cache elsewhere (project-relative) has no coverage: the replica could be committed. Only the backend knows where it writes.
2. Delete: nothing; the `files` backend declares none (its roots are already checked).
3. Simplify: add optional `localPaths?(): string[]` to `KnowledgeStore` (`knowledge-store.ts:63`): project-relative paths where the backend keeps content locally. `checkKnowledgeScope` and `checkKnowledgeScopeRange` apply to each declared path the same checks as `protectedRoot`: git-ignored (`check-ignore`), untracked (`ls-files`), absent from the pushed range (`underRoot` over `diff-tree`); reuse `toRepoRelative` so a path outside the repo is skipped. Note `checkKnowledgeScopeRange` does not open a store today; it opens one (with `projectRoot`, from AISDLC-1432) only when the backend is not `files`.
   Doctor: the registry is `orchestrator/src/cli/commands/doctor-checks.ts` (`DOCTOR_CHECKS`, `:3617`; `docs/operations/doctor.md` lists the checks; `ai-sdlc-plugin/commands/doctor.md` only wraps it; the brief's `manifest.ts ~356` is `pipeline-cli/src/config-manifest/manifest.ts`, which scaffolds config and is not where checks live). Add a `knowledge-backend` check there. Orchestrator does not import pipeline-cli knowledge code, so, as `config-manifest` does (`resolveCliInit`, `:2958`), it shells out to a pipeline-cli bin: add a small `cli-context check-backend --format json` subcommand (`pipeline-cli/src/cli/context.ts`) that reports `backendModule` resolves, the factory opens, each declared path is git-ignored. Core change: none beyond registering the check and one new `cli-context` subcommand; no change to `DoctorCheckAdapters`. Severity: fail when the module does not resolve or the factory does not open; fail when a declared path is not git-ignored; warn when a non-`files` backend declares zero paths; pass for `files`. Provisional: Product (RFC-0053 signer) reviews the RFC-0053 amendment; the change is additive to the DEC-0427 seam. Write interface shape (OQ-A: async writes) is undecided; this task changes no `put`/`update` signature and does not make any write sync or async.
4. Accelerate: none.
5. Automate: tests (AC #1 to #5).

## Acceptance Criteria
- [ ] #1 `KnowledgeStore.localPaths?(): string[]` is optional; `FilesKnowledgeStore` does not implement it; no `put`/`update` signature changes.
- [ ] #2 `checkKnowledgeScope` reports a declared path that is not git-ignored or has tracked files; `checkKnowledgeScopeRange` reports a declared path present in a pushed commit (tests in `knowledge.test.ts` with a registered in-memory backend and a temp git repo). A backend without `localPaths` is unchanged.
- [ ] #3 `cli-context check-backend` reports unresolved module, factory open failure, non-ignored paths and the zero-paths warning.
- [ ] #4 The `knowledge-backend` doctor check in `doctor-checks.ts` maps that report to fail/warn/pass; doctor tests cover each, and `docs/operations/doctor.md` and `docs/operations/knowledge-store.md` describe it.
- [ ] #5 A project on `files` sees no new finding.
- [ ] #6 Targeted `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/knowledge/knowledge.test.ts src/knowledge/knowledge-backend.test.ts` and `pnpm --filter @ai-sdlc/orchestrator exec vitest run src/cli/commands/doctor-checks.test.ts`, then `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
