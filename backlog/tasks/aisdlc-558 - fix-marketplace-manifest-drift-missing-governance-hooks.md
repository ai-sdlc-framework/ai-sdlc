---
id: AISDLC-558
title: >-
  fix(plugin): reconcile .claude-plugin/plugin.json with plugin.json — the
  marketplace manifest is missing two governance hooks
status: To Do
assignee: []
labels:
  - adoption
  - plugin
  - governance
  - ci:no-issue-required
priority: high
dependencies:
  - AISDLC-554
references:
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/scripts/install-runtime-deps.test.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Surfaced by AISDLC-554 review. The plugin ships **two** manifests, and they
have drifted apart in more than the dependency list AISDLC-554 resynced:

    diff ai-sdlc-plugin/plugin.json ai-sdlc-plugin/.claude-plugin/plugin.json

`.claude-plugin/plugin.json` is missing, relative to the top-level file:

1. The entire **`SubagentStart`** hook — `hooks/subagent-start.sh`, which
   injects AI-SDLC governance into every subagent.
2. The **`PreToolUse` `Write|Edit`** matcher — `hooks/enforce-blocked-actions.sh`
   on file writes. The `Bash` matcher is present; the write-policy one is not.

If the marketplace installer reads `.claude-plugin/plugin.json` — which this
repo's own history (AISDLC-77, AISDLC-120, AISDLC-272) treats as the canonical
manifest — then every marketplace-installed adopter is running without subagent
governance injection and without write-policy enforcement, while the dogfood
monorepo (which reads the top-level file) has both. That is a governance
difference between us and our adopters, in the direction that matters least
safely, and nothing detects it.

AISDLC-554 added a test asserting the two manifests declare identical
`runtimeDependencies`, which closes the specific hole it introduced. It
deliberately did NOT extend that assertion to `hooks`, because making the two
files fully identical is a decision with real consequences and needs the
question below answered first.

### The question to answer first

**Which manifest does the Claude Code marketplace installer actually read?**
Do not guess — this determines whether the drift is a live adopter bug or dead
weight. Note that `install-runtime-deps.sh` reads `"$PLUGIN_DIR/plugin.json"`
(the top-level file), so the two files are consumed by different code paths
today.

### Scope

- Determine authoritatively which manifest the installer consumes, and record
  the evidence in the PR body.
- Reconcile the two files. Preferred outcome: one manifest is generated from
  the other, or one is deleted, so drift becomes structurally impossible rather
  than merely tested for.
- If both must exist, extend the AISDLC-554 sync test to cover `hooks`,
  `mcpServers`, and `userConfig` — not just `runtimeDependencies`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 The manifest the marketplace installer reads is identified, with
      evidence, and documented
- [ ] #2 Adopters receive the `SubagentStart` hook and the `Write|Edit`
      write-policy hook, verified on a marketplace-style install rather than
      inferred from the file contents
- [ ] #3 Drift is prevented structurally (generation or deletion), or by a
      test covering every shared key rather than `runtimeDependencies` alone
- [ ] #4 If adopters have been running without these hooks, the impact window
      is stated plainly in the PR body
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Found while fixing AISDLC-554, when review caught that the runtimeDependencies
bump had been applied to only one of the two manifests. The dependency half is
fixed and tested there; this task covers the hooks half and the underlying
duplication that allowed both to drift.
<!-- SECTION:NOTES:END -->
