---
id: AISDLC-557
title: >-
  fix(plugin): make @ai-sdlc/pipeline-cli actually resolvable in a marketplace
  install, so orchestrator-tick and the dependency gates can run for adopters
status: Done
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
- [x] #1 Root cause documented for why a marketplace install leaves the cache
      `node_modules` empty — PARTIAL/HONEST CAVEAT: verified and fixed one
      concrete "failing silently" root cause in `session-start.js` (the
      self-heal failure warning was unconditionally swallowed whenever the
      consumer project had no `.ai-sdlc/agent-role.yaml` yet — exactly the
      state a brand-new adopter repo is in). Could NOT verify from this repo
      whether the underlying `npm install` itself additionally fails in a
      real Claude Code marketplace-cache environment (network/registry/
      installer behaviour is outside what's reproducible here) — did not
      fabricate a fix for that unverified half. See PR body.
- [x] #2 A fresh marketplace-style install ends with `@ai-sdlc/pipeline-cli`
      resolvable via `resolve-pipeline-cli.sh` — verified via hermetic test
      simulating the exact topology (self-location self-heal succeeds), NOT
      a live Claude Code marketplace install (not reproducible in this repo).
- [x] #3 `resolve-pipeline-cli.sh` attempts self-heal even when neither
      `CLAUDE_PLUGIN_DIR` nor `CLAUDE_PLUGIN_ROOT` is set
- [x] #4 `orchestrator-tick` fails with a named, actionable error rather than
      an opaque one when `cli-dispatch.mjs` cannot be resolved
- [x] #5 Step 1.5 announces loudly when the dependency gate could not run;
      a skipped gate must be distinguishable from a passed gate — fixed at
      orchestrator-tick's frontier dependency-readiness gate (its own
      numbered "Step 1.5" heading is unrelated sync-parent/prune-debris
      work; the functional dependency gate is Step 5's frontier
      consultation). See PR body for the mapping.
- [x] #6 Hermetic tests cover the no-env-var self-heal path and the
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

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Two distinct defects fixed, plus a root-cause investigation with an honest
gap noted.

**Defect 2 (self-heal unreachable) — fully fixed.** `resolve-pipeline-cli.sh`
gained a new last-resort topology 6: when neither `CLAUDE_PLUGIN_DIR` nor
`CLAUDE_PLUGIN_ROOT` is set, derive the plugin dir from the script's own
on-disk location and run the same complete/self-heal/retry sequence
topologies 1 and 3 use. This is NOT a reintroduction of the PR #482
cache-walk vulnerability (AISDLC-272) — that fix removed self-heal from a
WALK across `~/.claude/plugins/cache/*/ai-sdlc/*/` that picked an arbitrary
"highest semver" directory; this fallback only ever targets the exact
directory the currently-executing script lives in, granting no privilege an
attacker didn't already have by planting a malicious `resolve-pipeline-cli.sh`
in the first place.

**Defect 1 (nothing installs the package) — root cause partially verified.**
Found and fixed a concrete, verifiable "failing silently" bug in
`hooks/session-start.js`: the self-heal-failure warning
(`__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR`) was captured but then unconditionally
swallowed whenever the consumer project had no `.ai-sdlc/agent-role.yaml` yet
— exactly the state a brand-new adopter repo is in immediately after a
marketplace plugin install, before `ai-sdlc init` has ever run. This is very
likely why the reporter had to manually invoke `resolve-pipeline-cli.sh` by
hand to discover the problem at all — the automatic self-heal warning had
nowhere to surface. Could NOT verify, and did not fabricate a fix for,
whether the underlying `npm install` inside `install-runtime-deps.sh`
additionally fails for a different reason (network reachability, registry
config, Claude Code's installer behaviour) in the real marketplace-cache
environment — that is outside what's reproducible from this repo.

**Loud gates (AC#4/#5).** `orchestrator-tick.md`'s Path Resolution now
delegates to the shared `resolve-pipeline-cli.sh` (gaining self-heal +
a named, actionable error) instead of an unchecked inline two-branch guess.
The frontier dependency-readiness gate (Step 5's `cli-deps frontier` call —
the functional equivalent of `/ai-sdlc execute`'s Step 1.5 for the autonomous
orchestrator path; orchestrator-tick's own numbered "Step 1.5" heading is
unrelated sync-parent/prune-debris work) now distinguishes "gate failed to
run" from "frontier legitimately empty" instead of silently collapsing both
into the same `{"frontier":[]}` shape.

## Changes

- `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh` — new self-location
  fallback topology (last resort)
- `ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs` — hermetic tests for
  the new topology; `runScript`/`installScriptCopy` helpers updated so no
  test can accidentally self-heal against the real repo checkout
- `ai-sdlc-plugin/hooks/session-start.js` — surfaces the runtime-deps warning
  even when `.ai-sdlc/agent-role.yaml` is absent
- `ai-sdlc-plugin/hooks/session-start.test.mjs` — regression tests for the
  fix
- `ai-sdlc-plugin/commands/orchestrator-tick.md` — Path Resolution delegates
  to `resolve-pipeline-cli.sh`; frontier gate loud-failure distinction
- `ai-sdlc-plugin/commands/orchestrator-tick.test.mjs` — body-contract tests
  for both fixes
- `ai-sdlc-plugin/commands/execute.md` — doc-only: topology count/table
  updated to 6
- `ai-sdlc-plugin/README.md` — install-topologies table + resolution
  algorithm updated to document topology 6

## Verification

- `pnpm build` — clean
- `pnpm lint` / `pnpm format:check` — clean
- Touched hermetic test suites run directly via `node --test`: 18/18
  (session-start.test.mjs + resolve-pipeline-cli.test.mjs), 3/3 new
  orchestrator-tick.test.mjs assertions pass. Two PRE-EXISTING, unrelated
  test failures confirmed present on `origin/main` before any of my changes
  (orchestrator-tick.test.mjs "describes manifest emission via
  write-manifest"; execute.test.mjs "bare relative-path invocations" hitting
  the Decision Catalog escalation template) — not introduced by this PR, not
  fixed (out of scope).
- `pnpm test` (full monorepo): first run hit one flaky, unrelated pipeline-cli
  test (`loop.dor-decisions.test.ts`) that passed in isolation on retry.
- `npx backlog-drift check` — 0 error-severity issues (23 info-severity,
  pre-existing, unrelated to this PR).
- `node pipeline-cli/bin/cli-dor-check.mjs --task <this file>` — **currently
  fails Gate 3** (named-thing references `AISDLC-554`/555/556 don't resolve
  to backlog files in this worktree) because AISDLC-554 is a real,
  in-flight, not-yet-merged sibling dependency (branch
  `fix/attestation-runtime-consumer-resolution`) per this task's own
  `dependencies:` frontmatter. This is expected and was anticipated in the
  dispatch instructions ("If AISDLC-554 lands before you push, rebase onto
  origin/main and resolve") — not a defect introduced by this PR. It will
  self-resolve once AISDLC-554 merges to main.

## Follow-up

- None filed — out of scope per this task's boundary. AISDLC-555/556 (the
  hook + visibility halves of the same adopter gap) are already tracked
  separately per the Implementation Notes above.
<!-- SECTION:FINAL_SUMMARY:END -->
