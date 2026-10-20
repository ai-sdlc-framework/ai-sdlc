---
id: AISDLC-988
title: 'resolve-pipeline-cli refuses a stale dist at hierarchy launch'
status: In Progress
assignee: []
created_date: '2026-10-20'
labels:
  - hierarchy
  - tooling
dependencies: []
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/up.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

`ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh` prefers the repo's own build when it is fresh (`:159-165`, "using this repo's own pipeline-cli build ..., not the plugin cache") but when the build is missing or older than its sources it only writes `REPO_WARN` (`:167`) and at `:170` prints "WARNING — ...; falling back to the plugin install, which may be older than this repo's sources" to stderr, then continues to the plugin cache topologies. Only the `up.js` launch-env case at `:148` is a hard error. The plugin cache ships the last release (0.30.0 at the time of writing), which lacks newer subcommands (`reenter`, the `cli-dispatch` rule), so for several days dispatch ran old code while the warning scrolled past in a tmux pane nobody read.

Fix: in the hierarchy launch path the warning becomes a refusal. `cli-hierarchy up` (`pipeline-cli/src/cli/hierarchy.ts:480`, dispatching to `pipeline-cli/src/hierarchy/up.ts`) runs the resolve check first and, on a stale or missing repo build, either rebuilds with `pnpm --filter @ai-sdlc/pipeline-cli build` when `--rebuild` is passed, or exits non-zero printing that exact command; it never falls through to the cache when the cwd is this monorepo. The resolve script gains a `--strict` flag (or an env) that the hierarchy path sets, so other callers keep the fallback. `ai-sdlc doctor` reports a stale repo build as a finding. `docs/operations/cli-hierarchy.md` documents the refusal and the rebuild flag.

**Five-step review (requirements first).**
1. Requirement questioned: is a fallback to the plugin cache ever right inside the monorepo? No; the monorepo's own sources are the truth, so the cache fallback is deleted for that topology.
2. Delete: the silent cache fallback in the monorepo topology when strict.
3. Simplify: one freshness check, one flag, one rebuild command.
4. Accelerate: a stale dist is caught at launch, not days later from a missing subcommand.
5. Automate: `--rebuild` performs the fix; doctor surfaces it.

## Acceptance Criteria

- [ ] `cli-hierarchy up` in the monorepo refuses to launch on a repo build older than its sources, printing the rebuild command, and `--rebuild` performs the build then launches; tests cover refuse, rebuild and fresh.
- [ ] `resolve-pipeline-cli.sh --strict` (or its env) exits non-zero instead of falling back to the plugin cache; default behaviour for other callers is unchanged, with a test for each.
- [ ] `ai-sdlc doctor` reports a stale repo build as a finding.
- [ ] `docs/operations/cli-hierarchy.md` documents the refusal, the flag and the rebuild command.
