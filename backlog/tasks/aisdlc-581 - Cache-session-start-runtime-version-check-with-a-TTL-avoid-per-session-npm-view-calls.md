---
id: AISDLC-581
title: >-
  Cache session-start runtime version-check with a TTL (avoid per-session npm
  view calls)
status: To Do
assignee: []
created_date: '2026-09-05 22:05'
labels:
  - plugin
  - performance
  - aisdlc-580-followup
dependencies: []
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem
AISDLC-580 wired a version-aware self-heal into `ai-sdlc-plugin/hooks/session-start.js` via the shared `check-stale-runtime-deps.mjs`, which runs 1-3 `npm view <pkg>@<pin> version` registry round-trips on EVERY session start (bounded to an 8s fail-open budget). That's correct and safe (fails open, once per session, not per keystroke), but it adds registry latency to every session start with no caching.

`ai-sdlc-plugin/hooks/check-plugin-version.js` already solves the identical concern with a **24h TTL cache** at `~/.cache/ai-sdlc-plugin/version-check.json` (+ `AI_SDLC_DISABLE_VERSION_CHECK=1` opt-out). The stale-runtime check should reuse the same pattern.

## Scope
1. Add a short-TTL cache (suggest ~1-6h; shorter than the version-check's 24h since a stale runtime is more actionable) to the `check-stale-runtime-deps.mjs` / session-start path so it doesn't hit the registry on every session start — reuse or mirror `check-plugin-version.js`'s cache mechanism (cache dir, TTL, corrupt-cache tolerance).
2. Respect the same disable env var (or a dedicated one) for parity.
3. Keep fail-open behavior + the once-installed-then-stale detection intact (a cache MISS still checks; a cache HIT within TTL skips the network).
4. Hermetic test: cache-hit-within-TTL performs no `npm view`; cache-miss/expired does; corrupt cache tolerated.

## Acceptance Criteria
- Session start does NOT perform an `npm view` when a fresh (within-TTL) stale-runtime cache entry exists.
- Cache miss/expiry still detects a stale runtime and triggers the self-heal.
- Fail-open + corrupt-cache tolerance preserved; hermetic test covering hit/miss/corrupt.
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Low priority — the current behavior is correct + bounded, this is a latency/UX polish. Surfaced by the security + code reviews of [[aisdlc-580]] (PR #1009). Reuses the [[check-plugin-version]] cache pattern.
<!-- SECTION:DESCRIPTION:END -->
