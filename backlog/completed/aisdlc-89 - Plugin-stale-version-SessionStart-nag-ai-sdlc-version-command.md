---
id: AISDLC-89
title: Plugin stale-version SessionStart nag + /ai-sdlc version command
status: Done
assignee: []
created_date: '2026-04-30 18:27'
updated_date: '2026-04-30 23:38'
labels:
  - plugin
  - ux
  - ops
dependencies: []
references:
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/hooks/
  - ai-sdlc-plugin/commands/
  - ai-sdlc-plugin/README.md
  - .claude-plugin/marketplace.json
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude Code plugins don't auto-update — clients have to explicitly run `/plugin update <name>` to pull a new version. There's no background polling, no version check at session start, no nudge when a new release ships. Today, a client could install ai-sdlc at v0.7.1, never run `/plugin update`, and miss every subsequent release indefinitely.

This task adds a **session-start staleness nag** so updates are visible without forcing them, plus a `/ai-sdlc version` command for explicit query. Same UX pattern as `pnpm`, `gh`, `kubectl`, `terraform` — proven, low-friction, zero surprise.

## Components

### 1. SessionStart hook — `ai-sdlc-plugin/hooks/check-plugin-version.js`

- Fires at every Claude Code session start (registered in `ai-sdlc-plugin/.claude-plugin/plugin.json` `hooks.SessionStart`)
- Fetches `https://raw.githubusercontent.com/ai-sdlc-framework/ai-sdlc/main/.claude-plugin/marketplace.json`
- Parses `plugins[0].version` (the published latest)
- Compares to `ai-sdlc-plugin/.claude-plugin/plugin.json` `version` (the bundled installed version)
- If newer version available, prints a yellow banner to stderr:

  ```
  ⚠ ai-sdlc plugin v<installed> installed, v<latest> available.
    Run: /plugin update ai-sdlc && /reload-plugins
    Changelog: https://github.com/ai-sdlc-framework/ai-sdlc/releases
  ```

- Caches the check result at `~/.cache/ai-sdlc-plugin/version-check.json` with a 24h TTL — `{ checkedAt: ISO8601, latestVersion: 'x.y.z' }`. Subsequent session starts within 24h skip the network call.
- **Silent on fetch failure** (offline, GitHub down, rate-limited) — never blocks session start, never spams.
- Uses Node's built-in `https` module (no new dependencies).

### 2. `/ai-sdlc version` slash command

- New file: `ai-sdlc-plugin/commands/version.md`
- Bypasses the 24h cache — always re-fetches latest
- Output:
  ```
  ai-sdlc plugin
  - Installed: v0.8.0
  - Latest: v0.8.0
  - Last checked: just now
  - Status: ✓ up to date

  (or)

  - Status: ⚠ stale — run /plugin update ai-sdlc && /reload-plugins
  ```

### 3. README + onboarding docs

- Add a "Staying up to date" section to the plugin README explaining: plugins don't auto-update, the nag will tell you when, run `/plugin update <name>` to pull
- Mention in the install instructions

## Threat / failure-mode review

- **GitHub rate-limited / 403** → silent skip, no banner, no error to stderr (don't break sessions)
- **Network offline** → silent skip
- **Malformed marketplace.json** → silent skip + log to `~/.cache/ai-sdlc-plugin/last-error.log`
- **Cache file corrupted** → ignore + re-fetch
- **User opts out** → respect `AI_SDLC_DISABLE_VERSION_CHECK=1` env var (document in README)

## What this task deliberately does NOT do

- **Auto-run `/plugin update`** — Claude Code doesn't expose a hook-callable plugin-update API, and even if it did, mutating the install without consent is bad UX.
- **PostToolUse polling on every `/ai-sdlc *` command** — too noisy; SessionStart covers it.
- **Critical-update / security-patch tier** — YAGNI until we ship a security fix that demands it; revisit if/when that need is real.
- **In-process auto-restart** — restarting Claude Code is the user's call.

## Why it's worth doing

Today's friction (this session): user installed v0.7.0, lived through v0.7.1 and v0.8.0 releases, only discovered the gap when `execute-orchestrator` (v0.8.0 feature) was missing. The nag would've surfaced "v0.8.0 available" at the first session of the day after v0.8.0 shipped, costing one terminal line and saving a 30-minute diagnosis loop.

## References

- `ai-sdlc-plugin/.claude-plugin/plugin.json` (hooks registration)
- `ai-sdlc-plugin/hooks/check-plugin-version.js` (new)
- `ai-sdlc-plugin/commands/version.md` (new)
- `ai-sdlc-plugin/README.md` (modified)
- `.claude-plugin/marketplace.json` (the file the hook fetches via raw.githubusercontent.com)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SessionStart hook at `ai-sdlc-plugin/hooks/check-plugin-version.js` fetches marketplace.json from main, parses latest version, compares to bundled plugin.json version
- [x] #2 When latest > installed, hook prints a yellow banner naming the gap and the update command, once per session start
- [x] #3 Hook caches the result at `~/.cache/ai-sdlc-plugin/version-check.json` with 24h TTL; cache hits skip the network call
- [x] #4 Hook is silent on fetch failure (offline, 403, malformed JSON) — never blocks session start, never spams stderr
- [x] #5 `AI_SDLC_DISABLE_VERSION_CHECK=1` env var disables the check entirely
- [x] #6 `/ai-sdlc version` slash command bypasses cache, prints installed/latest/last-checked + up-to-date or stale status
- [x] #7 Hook registered in `ai-sdlc-plugin/.claude-plugin/plugin.json` under `hooks.SessionStart`
- [x] #8 README has a 'Staying up to date' section explaining the nag + manual update flow
- [x] #9 Hook tested with Node built-in test runner (`.test.mjs`) covering: stale → banner, fresh → silent, cache hit → no fetch, fetch failure → silent, opt-out → silent
- [x] #10 All tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Adds a SessionStart hook that nags clients when their installed plugin version is older than the marketplace's latest, plus a `/ai-sdlc version` slash command. Pattern matches `pnpm`, `gh`, `kubectl`, `terraform`. Closes the gap surfaced this session: user installed v0.7.0 + missed two releases silently before discovering execute-orchestrator was missing.

## Changes

- `ai-sdlc-plugin/hooks/check-plugin-version.js` — NEW SessionStart hook + `--print` mode for the slash command
- `ai-sdlc-plugin/hooks/check-plugin-version.sh` — NEW shell wrapper (consistent with `session-start.sh`)
- `ai-sdlc-plugin/hooks/check-plugin-version.test.mjs` — NEW 10 tests using local node:http server (deterministic, no real network)
- `ai-sdlc-plugin/commands/version.md` — NEW slash command
- `ai-sdlc-plugin/.claude-plugin/plugin.json` + `ai-sdlc-plugin/plugin.json` — hook registered in both
- `README.md` — new "Staying up to date" section in Claude Code Plugin block

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean
- `node --test ai-sdlc-plugin/hooks/check-plugin-version.test.mjs` — 10/10 pass in 423ms
- 3 parallel reviews APPROVED (0 critical, 0 major, 10 minor, 3 suggestions across all reviewers); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable)

## Follow-up (non-blocking minors from reviews)

- **Code minor**: stdin-drain branch gated on `isTTY === false` but pipes are `undefined` — dead code under real hook invocation. The 100ms `setTimeout(main).unref()` fallback handles it correctly. Could be cleaned up.
- **Code minor**: `compareSemver` falls back to `localeCompare` for non-triple inputs — `'1.2'` vs `'1.2.0'` returns non-zero. marketplace.json ships full triples so this isn't biting today.
- **Code minor**: no User-Agent + no redirect-following on the HTTPS request. raw.githubusercontent.com works fine today; future infra change could silently degrade.
- **Security low**: `AI_SDLC_PLUGIN_MARKETPLACE_URL` env override honored in production (intended for tests). An attacker with env-var control could redirect, but impact is bounded — banner displays a hardcoded changelog URL, no code execution.
- **Security low**: response body has no max-size cap. A malicious server could stream gigabytes before timeout. Recommend 64KB cap with `req.destroy()`.
- **Test minor**: cleanup is per-test try/finally rather than `afterEach`. Edge cases not directly tested: CLAUDE_PLUGIN_ROOT unset, marketplace.json shape variations (empty plugins[], non-string version), ANSI escape assertion.

All findings are quality polish; none block. Could be picked up in a future polish PR.
<!-- SECTION:FINAL_SUMMARY:END -->
