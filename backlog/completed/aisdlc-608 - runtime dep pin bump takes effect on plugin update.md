---
id: AISDLC-608
title: Runtime-dep pin bump must reliably take effect for adopters (not silently stay stale)
status: Done
priority: high
labels:
  - adopter-facing
  - plugin
  - runtime-deps
dependencies:
  - AISDLC-580
  - AISDLC-607
created: 2026-09-08
---

## Context

Surfaced by an external adopter (local-trades) while verifying the AISDLC-607
`cli-merge-if-eligible` fix. After the plugin bumped to 0.20.1 (raising the
`@ai-sdlc/pipeline-cli` runtimeDependency pin to `>=0.24.1`), `/plugin update`
**did not** upgrade the installed runtime dep from the already-present 0.24.0 —
the adopter stayed on the stale, pre-fix pipeline-cli until they manually forced
a full re-resolve. On other consumer machines the same thing will bite: an
already-fixed-upstream version can be silently masked by a satisfying-but-stale
local install.

AISDLC-580 already added a version-convergence self-heal
(`check-stale-runtime-deps.mjs` → `rm -rf` + reinstall) that is *designed* for
exactly this case, and `session-start.js` wires it in. So the fix here is NOT
"make it version-aware" (it is) — it is closing the gaps that stop that
convergence from actually running for adopters.

## Root-cause gaps (verified on main)

1. **Silent fail-open on a short `npm view` timeout.** `session-start.js` invokes
   `check-stale-runtime-deps.mjs` with a **2000ms** timeout
   (`spawnSync(process.execPath, [staleCheckScript, pluginRoot, '2000'], …)`).
   `check-stale-runtime-deps.mjs` fails OPEN on timeout (by design, to avoid
   blocking offline). A registry `npm view` that takes >2s (common on cold DNS /
   slow networks) therefore silently skips the staleness detection → no reinstall
   → adopter stays on the stale version with no signal. 2s is too aggressive for
   a network round-trip that gates correctness.
2. **Self-heal only runs at session-start, never at `/plugin update` time.**
   `/plugin update` swaps the plugin files (new pin in plugin.json) but does not
   invoke `install-runtime-deps.sh`; the convergence check only fires on the next
   session-start / reload. An adopter who runs `/plugin update` in a live session
   sees no runtime-dep change until they reload/restart, with nothing telling
   them a reload is required.
3. **No explicit operator escape hatch** to force a clean re-resolve on demand
   (the adopter had to manually delete a dep to force it).

## Scope

- **Gap 1:** raise / make-configurable the `check-stale-runtime-deps.mjs` timeout
  used from `session-start.js` (a correctness-gating registry call should get a
  more realistic budget, e.g. 8–10s, or a retry), and/or distinguish
  "timed-out (unknown)" from "confirmed up-to-date" so a timeout does not read as
  "converged." A timeout that masks a real staleness must at minimum surface a
  warning in the governance context, not silently pass.
- **Gap 2:** ensure a pin bump takes effect without a full manual re-resolve —
  e.g. surface an explicit "runtime deps stale — run `<cmd>` or reload" warning
  when `/plugin update` has changed the pin but the installed version hasn't
  converged. (A Claude Code plugin cannot hook `/plugin update` directly, so the
  reliable lever is the session-start warning + a documented one-liner.)
- **Gap 3:** add a `--force` (or `--reinstall`) affordance to
  `install-runtime-deps.sh` that unconditionally `rm -rf`s the managed
  `@ai-sdlc/*` dirs and reinstalls against the current pins, for deterministic
  operator-triggered convergence. Document it in the plugin README's
  troubleshooting section.

## Acceptance Criteria

- [x] AC-1: The session-start staleness check no longer silently fails-open on a
      routine (>2s) `npm view`; the timeout is raised/retried to a realistic
      budget AND a genuine timeout emits a governance-context warning rather than
      reading as "up to date." Hermetic test covers the timeout-vs-converged
      distinction.
- [x] AC-2: `install-runtime-deps.sh --force` (name TBD) unconditionally removes
      + reinstalls the managed `@ai-sdlc/*` runtime deps against current pins,
      independent of the presence/convergence gates. Hermetic test asserts the
      forced path reinstalls even when a satisfying version is already present.
- [x] AC-3: When the installed runtime version does not match the pin's resolved
      target, the operator gets an actionable message (what to run / that a
      reload is needed) — not silence. Test covers the stale-detected warning.
- [x] AC-4: Plugin README troubleshooting documents the "pin bumped but runtime
      still stale after `/plugin update`" case and the `--force` recovery.
- [x] AC-5: Existing behavior preserved — offline / already-converged runs stay
      fast and side-effect-free (no reinstall when genuinely converged); the
      fail-open-on-offline property is retained (only the *silent-on-slow* and
      *masks-staleness* aspects change).
- [x] AC-6: `pnpm build && test && lint` clean; affected-package coverage >=80%.

## Non-goals

- Hooking `/plugin update` itself (not exposed to plugins by Claude Code).
- Changing the runtime-dep pin ranges or the AISDLC-580 convergence algorithm's
  core comparison (only its invocation robustness + an explicit force path).

## References

Reported by adopter local-trades against the AISDLC-607 delivery. Root-cause
surfaces: `ai-sdlc-plugin/hooks/session-start.js` (2000ms stale-check invocation),
`ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs` (fail-open on timeout),
`ai-sdlc-plugin/scripts/install-runtime-deps.sh` (presence/convergence gating,
no force path).
