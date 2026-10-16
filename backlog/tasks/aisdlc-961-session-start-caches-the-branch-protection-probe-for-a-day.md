---
id: AISDLC-961
title: 'SessionStart caches the branch-protection probe behind the review-policy banner for 24 hours'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - plugin
  - hooks
  - cost
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/review-policy-banner.js
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - docs/operations/pre-push-and-ci-reference.md
priority: low
dispatchable: true
---

## Description

The SessionStart hook (`ai-sdlc-plugin/hooks/lib/review-policy-banner.js`, probing through `orchestrator/src/cli/commands/branch-protection-shared.ts`) renders the review-policy banner by running `ai-sdlc doctor --only attestation-governance`, which calls `gh repo view` and `gh api repos/<slug>/branches/main/protection` on every session start, including every `/clear` and every compaction. Executors clear after each task and the planner and dispatch clear on context thresholds, so this is about two dozen calls per hour for an answer that changes a few times a month, and it fails silently (banner says enforcement could not be confirmed) whenever the quota is gone.

**Five-step review (requirements first).**
1. Requirement questioned: must the banner probe GitHub on every start? No; the plugin version check already uses a 24-hour cache for the same reason.
2. Delete: the uncached probe.
3. Simplify: cache the probe result under the plugin cache directory keyed by repository slug with a 24-hour TTL; a stale or missing cache still probes once.
4. Accelerate: a cached start renders the banner without spawning doctor.
5. Automate: a node test asserts the second start within the TTL spawns no gh call.

## Acceptance Criteria

- [ ] Two session starts within 24 hours make the branch-protection calls once.
- [ ] `ai-sdlc doctor` run by hand still probes live (the cache serves only the banner).
- [ ] The pre-push and CI reference notes the cache location and TTL.
