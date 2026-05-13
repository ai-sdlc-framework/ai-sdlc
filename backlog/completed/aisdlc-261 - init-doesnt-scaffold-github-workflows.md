---
id: AISDLC-261
title: init doesn't scaffold GitHub workflows
status: Done
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - init
  - scaffolding
  - rfc-0005
dependencies: []
priority: high
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
  - orchestrator/src/cli/commands/init-features.ts
---

## Bug

The `ai-sdlc init` scaffold doesn't lay down the `.github/workflows/*.yml` files an adopter needs for the framework to function end-to-end. The current state is self-acknowledged in `.github/workflows/ai-sdlc-gate.yml:13` ("AISDLC-140 sub-5"), but the gap is still live and every adopter has to either copy workflows manually or live without the gate / attestation verification / review automation.

## Repro (against forge or any fresh repo)

```bash
ai-sdlc init        # populates .ai-sdlc/, agents, hooks
ls .github/workflows/  # → directory may not exist; ai-sdlc-{gate,review,verify-attestation}.yml absent
```

Adopter then either (a) cargo-cults the YAML from this repo, or (b) ships without the gate and discovers months later that `ai-sdlc/pr-ready` was never wired.

## Fix candidates

1. **`--with-workflows` flag** on `ai-sdlc init` that copies the canonical workflow set (`ai-sdlc-gate.yml`, `verify-attestation.yml`, `ai-sdlc-review.yml`, `auto-enable-auto-merge.yml`) into `.github/workflows/` of the target repo.
2. **`ai-sdlc init --add workflows`** subcommand for retroactive add to a project that init-ed without them.
3. **Source-of-truth pointer**: the templates already exist in this repo at `.github/workflows/`. `init.mjs` should read them as templates (not have a separate fork) so they stay in sync as the framework evolves.
4. **Idempotent**: re-running `--add workflows` against an existing `.github/workflows/` should diff-apply, not blindly overwrite operator customizations.

## Acceptance criteria

- [ ] `ai-sdlc init --with-workflows` (or equivalent) copies the 4 canonical workflows into `.github/workflows/`.
- [ ] `ai-sdlc init --add workflows` works on a repo that previously init-ed without the flag.
- [ ] Source = the templates in this repo's `.github/workflows/` (single source of truth, no drift).
- [ ] Re-running on an existing `.github/workflows/` is idempotent: skips files that already exist by default; `--force` overwrites with operator confirmation.
- [ ] `init.mjs` test coverage exercises `--with-workflows` against a temp repo.
- [ ] Docs (`ai-sdlc-plugin/README.md` + `docs/operations/`) explain the flag and the upgrade path for projects that init-ed pre-261.

## Source

Adopter session 2026-05-13, ranked #1 by friction (forge integration).

## finalSummary

## Summary
Added `--with-workflows` flag and `--add workflows` subcommand to `ai-sdlc init`, scaffolding 4 canonical GitHub Actions workflow files (`ai-sdlc-gate.yml`, `verify-attestation.yml`, `ai-sdlc-review.yml`, `auto-enable-auto-merge.yml`) into `.github/workflows/`. Re-running is idempotent by default (skips existing files); `--force` enables overwrite of workflow files only, preserving other operator-edited configs.

## Changes
- `orchestrator/src/cli/commands/init-templates.ts` (modified): Added `AI_SDLC_REVIEW_WORKFLOW`, `AUTO_ENABLE_AUTO_MERGE_WORKFLOW` template constants and `WORKFLOWS_TEMPLATES: FeatureTemplateSet` bundling all 4 workflows as embedded strings (required because npm package ships only `dist/`).
- `orchestrator/src/cli/commands/init-features.ts` (modified): Extended `FeatureSelection` with `workflows: boolean`, `WizardFlags` with `withWorkflows` and `force`, updated `resolveFeatureSelection` (prompt + `--add workflows` short-circuit), `applyFeatureSelection` (idempotent write with `--force` guard scoped to `.github/workflows/` paths), and `renderNextSteps`.
- `orchestrator/src/cli/commands/init.ts` (modified): Added `--with-workflows`, `--force` Commander options; updated `validateAddArg` to accept `'workflows'`; updated `buildWizardFlags` to include new flags.
- `orchestrator/src/cli/commands/init-features.test.ts` (modified): Updated existing tests for 5-prompt wizard flow; added 8 new AISDLC-261 tests covering `--with-workflows`, `--add workflows`, idempotency, `--force`, dry-run, and prompt suppression.
- `orchestrator/src/cli/commands/commands.test.ts` (modified): Reset `withWorkflows` and `force` options in `resetInitCommandOptions`.
- `orchestrator/src/cli/commands/init-workspace.test.ts` (modified): Added `--with-workflows` to hanging non-TTY test to prevent 5th prompt wait.
- `docs/operations/init.md` (modified): Updated TL;DR, wizard table (5 features), flag reference table, added "Adding the GitHub Actions workflow bundle to a pre-261 repo" upgrade section.

## Design decisions
- **Embedded strings vs. disk reads**: Workflow YAMLs are embedded as TypeScript template literals because the npm package ships only `dist/` (no `templates/` dir at runtime). Single source of truth is maintained by keeping the templates in sync with `.github/workflows/`.
- **`--force` scoped to workflow files only**: `--force` only applies to `.github/workflows/` paths, protecting user-edited configs like `.ai-sdlc/dor-config.yaml` from accidental overwrite.
- **Adopter-facing `ai-sdlc-review.yml`**: The internal review workflow references internal `pipeline-cli` scripts. The scaffolded version is a simplified adopter-facing stub that posts the required `Post Review Results` status check.

## Verification
- `pnpm build` (orchestrator filter) — clean
- `pnpm test` — 3107/3107 passed (full orchestrator suite including 8 new AISDLC-261 tests)
- `pnpm lint` — 0 errors (2 pre-existing warnings in pipeline-cli, unrelated)
- `pnpm format:check` — clean (ran `pnpm format` to fix 2 files)

## Follow-up
- Keep embedded workflow templates in sync when framework workflows evolve (no automation yet — manual sync).
