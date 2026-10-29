---
id: AISDLC-942
title: 'Rollback runbook: how to back out a release and a plugin version pin'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - docs
  - release
  - operations
dependencies: []
references:
  - docs/operations/release-flow.md
  - docs/operations/release-and-plugin-reference.md
  - docs/operations/emergency-bypass.md
  - docs/operations/doctor.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/hooks/check-plugin-version.js
priority: medium
dispatchable: true
---

## Description

The release docs describe how a release goes out (release-please PR, npm publish, plugin version pins) and nothing describes how it comes back. A bad plugin release reaches every roster session at the next SessionStart through the version check, and the only documented recovery is the emergency bypass, which is for gates, not versions. The playbook gap analysis (2026-10-16, gap 14) asks for a rollback runbook.

**Five-step review (requirements first).**
1. Requirement questioned: "releases are forward-only; fix forward". True for the CHANGELOG and tags; false for what sessions run, which is a pin that can point anywhere.
2. Delete: nothing to delete.
3. Simplify: rollback is a pin change plus a dist-tag move; the runbook names the exact files and commands and nothing else.
4. Accelerate: a rollback must be doable by one person in under ten minutes without reading the release flow.
5. Automate: deferred; the runbook records which steps are candidates for a `cli-release rollback` command once it has been exercised twice.

Velocity impact: neutral until a bad release; then it replaces an unplanned investigation.

## Acceptance Criteria

- [ ] AC-1: `docs/operations/rollback.md`, linked from the operations README and from `release-flow.md`, covers three cases: (a) npm package published with a defect (move the `latest` dist-tag back, deprecate the version), (b) plugin manifest version or `runtimeDependencies` pin pointing at a bad version (pin change in both manifests, `manifests-agree` and `runtime-deps-pins` doctor checks as the verification), (c) a merged `main` commit that must be reverted (a revert PR through the normal gate; never a history rewrite).
- [ ] AC-2: Each case lists the exact commands, the verification step, and who may run it (operator for npm and dist-tags, class (c); any session for a revert PR, class (a)).
- [ ] AC-3: The runbook states what rollback never touches: CHANGELOG.md (release-please owns it), tags, published versions (deprecate, never unpublish).
- [ ] AC-4: `emergency-bypass.md` gains one line pointing to the runbook for version problems.
- [ ] AC-5: `pnpm lint` and `pnpm format:check` pass; docs-only.

## Notes

Origin: playbook gap analysis 2026-10-16 (gap 14).
