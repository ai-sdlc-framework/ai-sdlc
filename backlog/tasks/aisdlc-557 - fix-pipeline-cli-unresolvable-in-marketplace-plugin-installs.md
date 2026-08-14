---
id: AISDLC-557
title: >-
  fix(plugin): make @ai-sdlc/pipeline-cli actually resolvable in a marketplace
  install, so orchestrator-tick and the dependency gates can run for adopters
status: To Do
assignee: []
labels:
  - adoption
  - plugin
  - orchestrator
  - ci:no-issue-required
priority: high
dependencies:
  - AISDLC-554
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/commands/execute.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Second adopter report, 2026-08-14, plugin 0.9.0 marketplace cache install in a
consumer repo. `@ai-sdlc/pipeline-cli` is not present in the plugin cache's
`node_modules` at all, and the plugin's own resolver fails through every
topology it knows:

```
$ bash .../0.9.0/scripts/resolve-pipeline-cli.sh
resolve-pipeline-cli.sh: ERROR — @ai-sdlc/pipeline-cli binary not found.
Tried all install topologies: ... $ echo $? -> 1
```

Blast radius is much wider than attestation. Everything that shells out to
`cli-dispatch.mjs` / `cli-deps.mjs` is unreachable in a consumer repo:
`orchestrator-tick` (Pattern X — the single-session parallel drain), the whole
Dispatch Board, `dispatch-worker`, and `/ai-sdlc execute` Steps 1.5 and 1.6.

The operator-facing consequence is the important part: the documented
single-session parallel path cannot run, so adopters are pushed onto the one
path that occupies their session serially — and then hand-roll the pipeline
shape themselves.

**Step 1.5 is only fail-closed when the binary exists.** With `cli-deps.mjs`
missing there is nothing to fail closed: the step is unreachable and dispatch
proceeds with no warning that a dependency gate was skipped. The reporter hit
exactly the duplicate-dispatch class of bug that gate exists to prevent —
dispatched a task whose dependency was still an open PR, branched off that
branch, and the dependent went DIRTY when the dependency squash-merged.

### Two distinct defects

1. **Nothing installs the package.** `install-runtime-deps.sh` exists but is
   evidently not running (or not succeeding) in a marketplace cache install —
   the cache `node_modules/` is empty. Determine whether it is never invoked,
   invoked without a writable prefix, or failing silently, then fix the actual
   cause rather than the symptom.
2. **The self-heal path is unreachable in the exact case that needs it.**
   `resolve-pipeline-cli.sh` only attempts `install-runtime-deps.sh` inside the
   `if [ -n "$CLAUDE_PLUGIN_DIR" ]` branch. When neither `CLAUDE_PLUGIN_DIR`
   nor `CLAUDE_PLUGIN_ROOT` is set, it walks the whole topology list and exits 1
   without ever trying to heal.

AISDLC-554 bumped the `@ai-sdlc/pipeline-cli` pin to `^0.14.0` and added
`@ai-sdlc/orchestrator`, which is necessary but NOT sufficient: a correct
dependency list does nothing if the install never runs. That is why this is
filed separately rather than folded into 554.

### Scope

- Root-cause why a marketplace install ends with an empty cache `node_modules`.
- Make self-heal reachable regardless of which plugin env var is set (derive
  the plugin dir from the script's own location as a last resort).
- Adopt the Step 7a pattern at every call site: when a CLI is missing, say so
  and name the fix. Where the missing binary disables a GATE (Step 1.5), it
  must be loud — a skipped dependency gate must never look like a passed one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Root cause documented for why a marketplace install leaves the cache
      `node_modules` empty
- [ ] #2 A fresh marketplace-style install ends with `@ai-sdlc/pipeline-cli`
      resolvable via `resolve-pipeline-cli.sh`
- [ ] #3 `resolve-pipeline-cli.sh` attempts self-heal even when neither
      `CLAUDE_PLUGIN_DIR` nor `CLAUDE_PLUGIN_ROOT` is set
- [ ] #4 `orchestrator-tick` fails with a named, actionable error rather than
      an opaque one when `cli-dispatch.mjs` cannot be resolved
- [ ] #5 Step 1.5 announces loudly when the dependency gate could not run;
      a skipped gate must be distinguishable from a passed gate
- [ ] #6 Hermetic tests cover the no-env-var self-heal path and the
      gate-unavailable warning
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The reporter explicitly praised Step 7a's classifier as the model to copy: it
anticipates the binary being absent, degrades in the safe direction, and says
so. AC#4/#5 are asking for that same shape — with the caveat that fail-open is
right for a classifier and wrong for a dependency gate, where the safe
direction is to refuse or at minimum warn unmissably.

Related: AISDLC-555 (ship + install the pre-push hook), AISDLC-556 (warn when
verdicts are written with no reachable signer). This task is the runtime-install
half; those two are the hook and visibility halves of the same adopter gap.
<!-- SECTION:NOTES:END -->
