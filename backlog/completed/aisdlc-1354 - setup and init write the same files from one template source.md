---
id: AISDLC-1354
title: 'Setup and init write the same files from one template source'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - init
dependencies: []
references:
  - pipeline-cli/src/config-manifest/manifest.ts
  - pipeline-cli/src/config-manifest/manifest.test.ts
  - pipeline-cli/src/cli/init.ts
  - pipeline-cli/src/cli/init.test.ts
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/git-remote.ts
  - orchestrator/src/cli/commands/git-remote.test.ts
  - orchestrator/src/cli/commands/setup.ts
  - orchestrator/src/cli/commands/commands.test.ts
  - orchestrator/src/cli/commands/init-template-schema.test.ts
  - orchestrator/src/orchestrator-health-config.test.ts
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to moving two templates into the shared manifest, deleting the duplicates and adapting the tests that import them; no key is dropped.'
---

## Description

**Gap.** Two commands scaffold an adopter repository and they write different files. `/ai-sdlc:setup` runs the orchestrator `init`, which writes its own `pipeline.yaml` and `agent-role.yaml`. `/ai-sdlc:init` runs `cli-init`, which writes the manifest versions of the same two files. A repository gets one set or the other depending on the command, so a fix made to one template never reaches the other path.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running; anything not working says so loudly.

**Cause (read from the source on main).**

- **Path one (setup).** `setup` runs `init --yes --skip-mcp` (`orchestrator/src/cli/commands/setup.ts:177`). `init` writes `pipeline.yaml` and `agent-role.yaml` from its own constants through `initProject` (`orchestrator/src/cli/commands/init.ts:432-436`), using `PIPELINE_YAML` (`init.ts:65-94`) with the org replaced from the git remote (`init.ts:768`) and the tier template `getAgentRoleYaml(tier)` (`init.ts:124-226`; tiers `coding`, `research`, `meta` at `:106-108`). It then calls the manifest (`scaffoldManifestEntries`, `init.ts:480-490`), which skips every file already present (`pipeline-cli/src/config-manifest/manifest.ts:283-286`) and skips operator-input entries (`:287-290`). So under setup the orchestrator templates always win.
- **Path two (`/ai-sdlc:init`).** `cli-init` scaffolds from the manifest only (`pipeline-cli/src/cli/init.ts`, `scaffoldConfig` at `pipeline-cli/src/config-manifest/manifest.ts:278`), with org and repo from the git remote as prompt defaults (`pipeline-cli/src/cli/init.ts:34-45`). It writes `AGENT_ROLE_DEFAULT` (`manifest.ts:74-90`, entry `:131-140`) and `renderPipeline` (`manifest.ts:98-115`, entry `:140-152`).
- **Keys present in only one source.**
  - `pipeline.yaml`, manifest only: `metadata.name: <repo>-pipeline`, `spec.providers.github` (key name `github`) with `config.repo`, and real `org` and `repo` values (they are prompts).
  - `pipeline.yaml`, orchestrator only: `metadata.name: default`, `spec.providers.sourceControl` (key name `sourceControl`) with `config.org` only (stand-in value `your-org`), and the whole `spec.backlog` block (`branching` pattern, targetBranch and cleanup; `pullRequest` titleTemplate, descriptionSections, includeProvenance, closeKeyword).
  - Shared in both: `apiVersion`, `kind: Pipeline`, `spec.triggers` with `issue.assigned`.
  - `agent-role.yaml`, manifest only: `metadata.name: coding-agent`, `spec.role: coding-agent`, `spec.goal: Implement backlog tasks under human review`, `spec.backstory`, and the tools `code-editor`, `terminal`, `test-runner`.
  - `agent-role.yaml`, orchestrator only: `metadata.name: default-agent`, `spec.role: developer`, `spec.goal: Implement issue requirements with tests`, the Claude tool names (`Edit`, `Write`, `Read`, `Glob`, `Grep`, `Bash`, `NotebookEdit`) with the comments on the excluded ones, `constraints.requireTests: true`, `constraints.blockedPaths` (`.github/workflows/**`, `.ai-sdlc/**`) and the commented governance block (`init.ts:116-122`). The `research` and `meta` tiers exist only here.
  - Shared in both: `apiVersion`, `kind: AgentRole`, `constraints.maxFilesPerChange: 15`.
- **Which readers use which key.** Whether anything reads `spec.providers` is inferred, unverified: the source-control adapter resolves from `adapterBindings` and falls back to the GitHub config (`orchestrator/src/adapters.ts:462-490`), not from `providers`.
- **Other files only path one writes** (not part of this task): `quality-gate.yaml`, `autonomy-policy.yaml`, `calibration.yaml`, `embedding-config.yaml` (`init.ts:437-447`).

**Shape.** The manifest is the one template source for `agent-role.yaml` and `pipeline.yaml`. The orchestrator `init` calls it, with the detected org and repo and the chosen tier, and keeps no copy of either template. Every key in the lists above that exists in only one source is kept in the single template. Both commands produce byte-identical files for the same input.

**Control.** No control changes. The `blockedPaths` of the tier template are kept, so this does not loosen the path block that setup users have today. Repositories that already have the files are untouched, because both paths write only a missing file.

**Planner reading (class (a), no control effect; the operator may overrule).** Where the two sources hold different values for the same key, the single template uses the orchestrator value. The conflicts are the `metadata.name` of both files, `spec.role`, `spec.goal`, the tool list of the agent role, and the provider key name (`github` against `sourceControl`). Reason: every repository set up through `/ai-sdlc:setup` already has the orchestrator values, so setup output does not change. Each conflicting value is one string in the manifest templates and the identity test compares the two commands, not a fixed value, so a later change is one edit. Keys present in only one source are kept as they are; no decision is needed for them.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: do two init paths need two templates? No; the manifest already exists for exactly this and the orchestrator already calls it. 2. Deleted: `PIPELINE_YAML`, the three tier constants and `AGENT_ROLE_DEFAULT` as separate copies, and the `initProject` write of the two files. 3. Simplified: one manifest entry per file; the tier and the org and repo reach it as answers. 4. Accelerated: a change to either template needs one edit, which AISDLC-1351 uses for the merge settings. 5. Automated: a test runs both paths on the same input and fails on any byte difference.

- **Manifest.** `agent-role` renders the tier template (answer `tier`, default `coding`) with the union of keys above; `pipeline` renders the union of keys above from the answers `org` and `repo`, with the stand-in values `your-org` and `your-repo` when no remote is detected, as `applyRemoteToPipelineYaml` handles today (`orchestrator/src/cli/commands/git-remote.ts:203-211`).
- **Orchestrator init.** `initProject` stops writing the two files; the manifest call supplies them with the detected remote and the `--role` tier. Workspace mode renders each child repository's `pipeline.yaml` through the same entry (`init.ts:796`).
- **Cleanup.** Delete the duplicate constants and update the four test files that import them (`commands.test.ts`, `init-template-schema.test.ts`, `orchestrator-health-config.test.ts`, `git-remote.test.ts`).
- **Tests.** A test runs the orchestrator `init --yes` and `cli-init` in two temporary repositories with the same remote and tier and compares the two files byte for byte, for each tier.

Out of scope: the values of the merge settings (AISDLC-1351), the four orchestrator-only files, and any change to a repository that already has the files.

## Acceptance Criteria

- [ ] #1 A test shows the orchestrator `init --yes` and `cli-init` write byte-identical `agent-role.yaml` and `pipeline.yaml` for the same remote, for the `coding`, `research` and `meta` tiers.
- [ ] #2 A test shows every key listed above as present in only one source is present in the written files.
- [ ] #3 A test shows `PIPELINE_YAML` and the tier constants no longer exist in `orchestrator/src/cli/commands/init.ts`, and `init` writes the two files only through the manifest.
- [ ] #4 A test shows a repository with no git remote gets the `your-org` and `your-repo` stand-in values in both paths, and a repository that already has either file keeps it unchanged.
- [ ] #5 A test shows workspace mode writes each child repository's `pipeline.yaml` with that child's detected org and repo.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
