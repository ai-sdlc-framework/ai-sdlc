---
id: AISDLC-1318
title: 'Concept pages for the PR lifecycle and the workflow engine'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - docs
dependencies:
  - AISDLC-1315
references:
  - docs/concepts/meta.json
  - docs/concepts/index.md
  - docs/concepts/staged-review.md
  - docs/concepts/dor-gate.md
  - docs/operations/cli-hierarchy.md
  - docs/operations/workflow-engine.md
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - spec/rfcs/RFC-0056-composable-workflow-graph.md
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
  - pipeline-cli/src/workflow/engine.ts
  - pipeline-cli/src/workflow/execute-host.ts
  - pipeline-cli/src/workflow/overlay.ts
  - scripts/check-docs-nav.mjs
  - scripts/check-rfc-docs.mjs
priority: medium
dispatchable: true
dispatchableReason: "Operator order of 2026-11-18: 'do the recommended pages for rfc 54 and 56', after the planner's audit of completed RFCs against the published documentation."
---

## Description

**Gap.** Two features that run by default have no page on the public website.

- **PR lifecycle (RFC-0054, lifecycle Signed Off).** The reconciler takes a task's pull request from ready to merged: it classifies the PR, writes `landing/<pr>.json` on the board and runs one action per state. It is described only in `docs/operations/cli-hierarchy.md` (sections `webhook`, "PR reconciler" and "Land and repair before new tasks").
- **Workflow engine (RFC-0056, lifecycle Signed Off).** `ai-sdlc-pipeline next-step` runs the execute pipeline as a node and edge document, with no environment flag (`docs/operations/workflow-engine.md`, first paragraph). It is described only in `docs/operations/workflow-engine.md`.

The website publishes `docs/*.md`, `docs/getting-started/`, `docs/tutorials/`, `docs/api-reference/`, `docs/concepts/`, `docs/whitepapers/` and `spec/*.md`, with navigation from the `meta.json` files. `docs/operations/` and `spec/rfcs/` are not published. A search of the published directories on 2026-11-18 found no page that names `workflow.yaml`, `cli-workflow`, `landing/` or the reconciler of the hierarchy, and `docs/concepts/meta.json` lists neither subject. An adopter reading the site cannot learn that either feature exists.

**Shape.** `docs/concepts/` has one short page for each of the two features, listed in `docs/concepts/meta.json` and in the tables of `docs/concepts/index.md`. Each page states only what the code does today.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must these two be public? Yes: both run on every adopter's repository by default, and each has a file or command the adopter touches (`.ai-sdlc/pr-lifecycle.yaml`, `.ai-sdlc/workflow.yaml`). 2. Deleted: nothing. 3. Simplified or optimised: each page is an overview of 35 to 60 lines that links to the runbook for detail; no runbook text is copied. 4. Accelerated: not applicable. 5. Automated: `scripts/check-docs-nav.mjs` already fails on a `meta.json` entry with no file.

- **Two new pages.** `docs/concepts/pr-lifecycle.md` and `docs/concepts/workflow-engine.md`. Style model: `docs/concepts/staged-review.md` (frontmatter `title` and `description`, one opening paragraph, the `> **RFC:** ... · **Status:** ...` line, short `##` sections, "Where to go next"). `docs/concepts/dor-gate.md` shows the link to a runbook.
- **Content of each page.** What it is; why it exists; how it behaves by default; the commands and the config file an adopter touches; a link to the RFC and a link to the runbook.
- **Shipped behaviour only.** Take every statement from the source and the operations doc, not from the RFC's proposal text. Check each stated behaviour, command name, file name and default value against the source before writing it, and list in the PR body the source file behind each one. Sources to start from: `pipeline-cli/src/hierarchy/reconcile.ts`, `pr-state.ts` and `pr-lifecycle-config.ts` for the PR lifecycle; `pipeline-cli/src/workflow/engine.ts`, `execute-host.ts` and `overlay.ts` for the engine. When the operations doc and the source disagree, the source wins; name the disagreement in the PR body and do not edit the operations doc here.
- **Known limits to respect.** Found while drafting this task; verify each:
  - The `land-prep` action of RFC-0054 is not built; `docs/operations/cli-hierarchy.md` says the state `behind-or-dirty` is served by `reenter`. Do not describe `land-prep` as present.
  - RFC-0054 carries the note "Amended by RFC-0061": the `content-hash-mismatch` state and the re-sign path are gone. Do not describe them.
  - RFC-0056 phase 5 is not built (the RFC schedules it behind a later RFC that has no file yet). Do not describe it.
  - `docs/operations/workflow-engine.md` speaks of a signed envelope carrying `workflowDigest` and of an escape hatch `AI_SDLC_WORKFLOW_ENGINE=0` to be removed after one release. Read `pipeline-cli/src/workflow/digest.ts` and `execute-host.ts` and state only what is true now.
- **Status line.** Use the RFC's `lifecycle` value from its frontmatter and one plain clause on what is not built. No dates of future work.
- **Link rule.** `docs/operations/` and `spec/rfcs/` are not published, so every link to a file there is the absolute GitHub address (the `blob/main` address of the file in the `ai-sdlc-framework/ai-sdlc` repository, as written out in criterion 2), as in `docs/concepts/staged-review.md` (RFC link) and `docs/concepts/dor-gate.md` (runbook link). The site also rewrites a relative link into an unpublished directory to GitHub (AISDLC-854), but the concept pages use the absolute form; follow them. Links between concept pages are relative (`./session-hierarchy.md`).
- **Navigation.** Add `pr-lifecycle` and `workflow-engine` to `pages` in `docs/concepts/meta.json`, after `session-hierarchy` and after `two-tier-pipeline`. Add one row for each to the table "The five pillars" in `docs/concepts/index.md` (pillar Dispatch for the PR lifecycle, Pipeline runtime for the engine).
- **No RFC edit.** `requiresDocs` cannot name a concept page: its values map only to `docs/tutorials/`, `docs/operations/`, `docs/api-reference/`, `docs/getting-started/` and `docs/examples/` (`SURFACE_TO_SUBDIR` in `scripts/check-rfc-docs.mjs`). Leave both RFC files unchanged. Each new page names its RFC id in the text.

Out of scope: any file under `docs/operations/`, `spec/rfcs/` or `pipeline-cli/`; publishing `docs/operations/`; the `deferredDocs` field of RFC-0056.

## Acceptance Criteria

- [ ] #1 `docs/concepts/pr-lifecycle.md` and `docs/concepts/workflow-engine.md` exist, each with `title` and `description` frontmatter, the `> **RFC:**` line and the sections of the style model; each is at most 80 lines.
- [ ] #2 `docs/concepts/pr-lifecycle.md` contains `RFC-0054` and a link to `https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/cli-hierarchy.md`; `docs/concepts/workflow-engine.md` contains `RFC-0056` and a link to `https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/workflow-engine.md`; each links its RFC file at the same GitHub base.
- [ ] #3 `grep -nE '\]\((\.\./)+(operations|spec)' docs/concepts/pr-lifecycle.md docs/concepts/workflow-engine.md` prints nothing.
- [ ] #4 `docs/concepts/meta.json` lists `pr-lifecycle` and `workflow-engine`, and `docs/concepts/index.md` has a row for each; `node scripts/check-docs-nav.mjs` exits 0.
- [ ] #5 Neither page describes `land-prep`, `content-hash-mismatch`, a re-sign path or RFC-0056 phase 5 as present.
- [ ] #6 The PR body lists, for each page, every stated behaviour, command, file name and default with the source file that shows it, and names any disagreement found between an operations doc and the source.
- [ ] #7 Apart from the task file under `backlog/` and the review ledger, the diff contains exactly four files: the two new pages, `docs/concepts/meta.json` and `docs/concepts/index.md`.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
