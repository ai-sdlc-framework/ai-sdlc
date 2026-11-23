---
id: AISDLC-1314
title: 'Shipped commands and config files have a reference page'
status: Done
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - docs-platform
dependencies: []
references:
  - pipeline-cli/bin/cli-capture.mjs
  - pipeline-cli/bin/cli-capture-lifecycle.mjs
  - pipeline-cli/bin/cli-compliance-audit.mjs
  - pipeline-cli/bin/cli-quality.mjs
  - pipeline-cli/src/cli/capture.ts
  - pipeline-cli/src/cli/capture-lifecycle.ts
  - pipeline-cli/src/capture/capture-lifecycle.ts
  - pipeline-cli/src/cli/compliance-audit.ts
  - pipeline-cli/src/cli/quality.ts
  - pipeline-cli/src/tui/analytics/quality-monitoring-config.ts
  - orchestrator/src/sa-scoring/revision-proposal-config.ts
  - orchestrator/src/cli/commands/init-templates.ts
  - spec/schemas/capture-record.v1.schema.json
  - spec/schemas/compliance-posture.v1.schema.json
  - docs/api-reference/meta.json
  - docs/api-reference/README.md
  - docs/api-reference/compliance.md
  - docs/operations/kpi.md
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: "file those docs tasks", after the planner''s audit of completed RFCs against the published documentation. On `main` at b56cecaee each of the four commands prints its help (`node pipeline-cli/bin/cli-<name>.mjs --help`, run 2026-11-18), and a search of `docs/` found no published page that names them or their config files.'
---

## Description

**Gap.** Four RFCs whose lifecycle is `Implemented` shipped commands and per-repository config files that no published page describes. The website publishes `docs/*.md`, `docs/getting-started/`, `docs/concepts/`, `docs/tutorials/`, `docs/api-reference/` and `docs/whitepapers/`; no file there cites RFC-0022, RFC-0024 or RFC-0025 at all (`grep -rl "RFC-0022\|RFC-0024\|RFC-0025" docs/api-reference docs/concepts docs/tutorials docs/getting-started` prints nothing).

| RFC | Shipped | Where it is named today |
|---|---|---|
| RFC-0024 | `cli-capture` (13 subcommands: `file`, `submit`, `submit-all`, `discard`, `list`, `redact`, `against-current-pr`, `triage`, `migrate-legacy`, `parse-pr-comments`, `append-capture-marker`, `lint-file`, `help-triage`); `cli-capture-lifecycle` (`tick`, `reactivate`, `list-archived`, `show-config`, `volume-report`); `.ai-sdlc/capture-config.yaml`, read by `loadCaptureLifecycleConfig` in `pipeline-cli/src/capture/capture-lifecycle.ts` (line 130) | No file under `docs/` names either command. Correction to the audit: `capture-config.yaml` is named in `pipeline-cli/docs/classifier-substrate.md` and `pipeline-cli/docs/decisions-config.md`, which are not published. |
| RFC-0022 | `cli-compliance-audit` (`export`, `dry-run`, `validate-manifest`; options `--work-dir`, `--period`, `--regime`, `--output-dir`, `--format`); `.ai-sdlc/compliance.yaml`, read at `pipeline-cli/src/cli/compliance-audit.ts` line 580; schema `spec/schemas/compliance-posture.v1.schema.json` | The command is named nowhere. `compliance.yaml` is mentioned in passing in five pages (four on the untrusted PR gate and `docs/operations/signal-ingestion.md`). `docs/api-reference/compliance.md` covers the SDK control mappings (`checkCompliance`, six frameworks), not the posture file or the export. |
| RFC-0025 | `cli-quality` (`report-upstream`, `severity-weights`); `.ai-sdlc/quality-monitoring.yaml`, read by `pipeline-cli/src/tui/analytics/quality-monitoring-config.ts`; `ai-sdlc init` writes a stub (`orchestrator/src/cli/commands/init-templates.ts` line 1172) | `cli-quality` only in `docs/operations/kpi.md` (unpublished); the config file only in one audit under `docs/audits/`. |
| RFC-0031 | `.ai-sdlc/calibration.yaml` with `lockNoProposal` and the thresholds of `orchestrator/src/sa-scoring/revision-proposal-config.ts` (lines 114 to 141, parser at 286 to 331); `ai-sdlc init` writes it (`init-templates.ts` line 852) | Named nowhere. `docs/api-reference/review-calibration.md` is a different subject (review false positives). |

One statement in shipped help text is already stale and belongs in the new page as what is true: `cli-capture-lifecycle --help` says "Run from orchestrator-tick or cron"; `/ai-sdlc orchestrator-tick` is retired (AISDLC-763), and a search of `pipeline-cli/src/hierarchy`, `pipeline-cli/src/dispatch` and `.github/workflows` found no caller of `cli-capture-lifecycle tick`.

**Shape.** Four pages under `docs/api-reference/`, each in that section's `meta.json`, written from the command's `--help` output and the source, so an adopter can find every subcommand and every config key the code reads.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does a shipped command need a published page? Yes when an adopter is expected to run it or edit its config file; `ai-sdlc init` writes two of these files into the adopter's repository with no page explaining them. A command that turns out retired or dark gets no page. 2. Deleted: nothing. 3. Simplified or optimised: one page per RFC, command and config file together; no page repeats the RFC's design rationale, it links the RFC. 4. Accelerated: not applicable. 5. Automated: none here; whether a shipped RFC must have a published page is the subject of the RFC docs gate, not of this task.

- **Verify first.** For each command run `node pipeline-cli/bin/cli-<name>.mjs --help` and each subcommand's `--help` after `pnpm build`; for each config file read the loader named in the table. Document what the code does at the time of the edit. A subcommand, option or key that the code does not read is not documented.
- **Pages** (new, each with frontmatter-free Markdown in the style of the existing pages of `docs/api-reference/`, a first line naming the RFC with a link to its file on GitHub, and the invocation form `node pipeline-cli/bin/cli-<name>.mjs`):
  - `docs/api-reference/capture.md`: both capture commands, every subcommand with its arguments, where records are written (drafts, `backlog/captures/`, archive), the keys and defaults of `capture-config.yaml`, and how `tick` is run today (by hand or by the adopter's own scheduler, if the search above still holds).
  - `docs/api-reference/compliance-audit.md`: the three subcommands and five options, the layout of the exported bundle and manifest, what `validate-manifest` checks, the fields of `compliance.yaml` from the schema, and what the export does when the file is absent (`compliance-audit.ts` lines 998 to 1002).
  - `docs/api-reference/quality-monitoring.md`: the two subcommands, the keys of `quality-monitoring.yaml` with defaults, and the order in which `report-upstream` resolves the repository URL (`quality.ts` lines 28 and 85).
  - `docs/api-reference/calibration-config.md`: the keys of `calibration.yaml` with defaults and validation errors, including `lockNoProposal`, and which shipped entry point loads it. If no shipped command or exported function reaches the loader, write no page and name it in the PR body.
- **Navigation.** Add each new page to `docs/api-reference/meta.json` and to the tables of `docs/api-reference/README.md`. Add one sentence to `docs/api-reference/compliance.md` that links `compliance-audit.md` for the posture file and the export.
- **Retired or dark.** If a command exits with an error on `--help`, is refused by a feature flag that nothing sets, or is named as retired in `docs/operations/`, leave it out and name it, with the evidence, in the PR body.
- **Stop rule.** Docs only. If the help text or a loader contradicts its RFC, document the code, name the contradiction in the PR body, and change neither the RFC nor the source.

Out of scope: any source, RFC, schema or config file; the `requiresDocs` frontmatter of the four RFCs; `docs/operations/` pages; the other commands under `pipeline-cli/bin/`.

## Acceptance Criteria

- [ ] #1 `docs/api-reference/capture.md` names every subcommand that `node pipeline-cli/bin/cli-capture.mjs --help` and `node pipeline-cli/bin/cli-capture-lifecycle.mjs --help` print, and every key that `cli-capture-lifecycle show-config` prints.
- [ ] #2 `docs/api-reference/compliance-audit.md` names the three subcommands and the five options that `node pipeline-cli/bin/cli-compliance-audit.mjs --help` prints, and every top-level property of `spec/schemas/compliance-posture.v1.schema.json`.
- [ ] #3 `docs/api-reference/quality-monitoring.md` names both subcommands of `node pipeline-cli/bin/cli-quality.mjs --help` and every key that `quality-monitoring-config.ts` reads.
- [ ] #4 `docs/api-reference/calibration-config.md` names every key of the raw config type in `revision-proposal-config.ts`, including `lockNoProposal`, with its default; or the PR body states that the loader is not reachable and the page was not written.
- [ ] #5 Each page that exists cites its RFC id (`RFC-0024`, `RFC-0022`, `RFC-0025`, `RFC-0031`) and is listed in `docs/api-reference/meta.json` and in `docs/api-reference/README.md`; `node scripts/check-docs-nav.mjs` passes.
- [ ] #6 Every command line in the new pages uses `node pipeline-cli/bin/cli-<name>.mjs`; the PR body quotes the `--help` output of each of the four commands as run on the PR head.
- [ ] #7 The diff contains only files under `docs/api-reference/` and this task file, at most 8 files.
- [ ] #8 The PR body names every command, subcommand or config file left out as retired or dark, with the evidence, or states that none was.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
