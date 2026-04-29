---
id: AISDLC-86
title: 'Document remote-agent usage policy: read-only tasks only (no /ai-sdlc execute)'
status: Done
assignee: []
created_date: '2026-04-29 16:14'
updated_date: '2026-04-29 16:57'
labels:
  - docs
  - remote-agents
  - policy
  - follow-up
dependencies: []
references:
  - CLAUDE.md
  - ai-sdlc-plugin/commands/execute.md
  - >-
    backlog/completed/aisdlc-85 -
    Verifier-compute-diffHash-from-envelope-subject-SHA-not-PR-head-chore-commit-on-top-regression-from-AISDLC-84.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Empirical 4-for-4 failure rate using Anthropic's Claude Code Routines (CCR) remote agents for `/ai-sdlc execute`:

- 2026-04-29 overnight: AISDLC-78, AISDLC-79, AISDLC-80 all scheduled, all produced 0 PRs
- 2026-04-29 morning: AISDLC-85 scheduled, produced 0 PR

Root causes (all three combine):
1. **No signing key**: `~/.ai-sdlc/signing-key.pem` lives only on the operator's machine. Remote agents can't sign attestations.
2. **Plugin not auto-installed**: CCR clones the repo + spins up a `claude` session but doesn't run `/plugin install ai-sdlc@ai-sdlc`. Skill / Task invocations of `ai-sdlc:execute`, `ai-sdlc:developer`, etc. silently fail to resolve.
3. **No subagent definitions**: even if the plugin loaded, the dev/reviewer agents (`ai-sdlc-plugin/agents/*.md`) may not register as `Task` subagent_types in CCR. Agent falls back to `general-purpose` which doesn't enforce governance hooks.

## Decision

**Remote agents (CCR) are for read-only / monitoring tasks only.** Do not schedule `/ai-sdlc execute` runs as remote agents. The medium-term fix (CI-side attestor — separate task) will eventually unblock this, but until then, scheduling backlog work via remote agents is wasted compute.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. CLAUDE.md updated with explicit policy: "Remote agents (Anthropic CCR via `/schedule`) are read-only by design — use them for status reports, PR scans, metric digests, morning check-ins. Do NOT schedule `/ai-sdlc execute` runs; they will fail (no signing key, plugin not auto-installed, subagents not registered)."
2. List of acceptable remote-agent task patterns:
   - PR status surveys (`gh pr list ...`)
   - Backlog state reports (`ls backlog/...`)
   - Cron-triggered metrics (commit counts, merge cadence)
   - Reading-from-Slack / posting-to-Slack workflows
3. List of explicitly-prohibited patterns:
   - `/ai-sdlc execute <task-id>`
   - Any flow that requires the signing key
   - Any flow that depends on plugin-defined subagents (developer, code-reviewer, test-reviewer, security-reviewer, execute-orchestrator)
4. The `/schedule` skill description gets a short callout pointing at the policy
5. CHANGELOG entry under `ai-sdlc-plugin/CHANGELOG.md`
6. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean

## Out of scope

- Solving the underlying plugin-install issue (separate task — CI-side attestor)
- Asking Anthropic to add plugin auto-install support (deferred indefinitely)
- Self-hosted CI runner (much bigger initiative; separate task if/when needed)

## References

- AISDLC-85 root-cause analysis (the failure mode that surfaced this)
- backlog/completed/aisdlc-77 (release-please tracking — context on CI vs local execution)
- backlog/completed/aisdlc-71 (original /ai-sdlc execute design — assumes local execution)
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 CLAUDE.md updated with explicit policy: 'Remote agents (Anthropic CCR via /schedule) are read-only by design — use them for status reports, PR scans, metric digests, morning check-ins. Do NOT schedule /ai-sdlc execute runs; they will fail (no signing key, plugin not auto-installed, subagents not registered).'
- [x] #2 List of acceptable remote-agent task patterns documented (PR status surveys, backlog state reports, cron-triggered metrics, Slack workflows)
- [x] #3 List of explicitly-prohibited patterns documented (/ai-sdlc execute, any signing-key-dependent flow, any plugin-subagent-dependent flow)
- [x] #4 The /schedule skill description gets a short callout pointing at the policy
- [x] #5 CHANGELOG entry under ai-sdlc-plugin/CHANGELOG.md
- [x] #6 pnpm build && pnpm test && pnpm lint && pnpm format:check clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Documents the empirical 4-for-4 failure rate of running `/ai-sdlc execute` via Anthropic CCR remote agents (`/schedule`). New CLAUDE.md section codifies remote agents as READ-ONLY by design, with explicit lists of acceptable patterns (status reports, PR scans, metric digests, Slack workflows) and prohibited patterns (`/ai-sdlc execute`, signing-key-dependent flows, plugin-subagent-dependent flows). Mentions AISDLC-87 as the planned CI-side attestor that will eventually unblock remote-agent execution.

## Changes
- `CLAUDE.md`: new "Remote agents (/schedule) — read-only by design" section with policy, acceptable patterns, prohibited patterns, and AISDLC-87 reference
- `ai-sdlc-plugin/CHANGELOG.md`: Unreleased > Documentation entry

## Verification
- `pnpm build` — clean
- `pnpm test` — 4849 workspace tests green
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 3 suggestions; test: 0; security: 0)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- AISDLC-87 (CI-side attestor) is the medium-term fix that lifts the read-only restriction
- Reviewer suggestions (deferrable): plain-text section header for consistency; cite specific orchestrator step numbers (Step 5/7/9) instead of "Steps 5-10"; clarify in CHANGELOG that no plugin code shipped (already addressed in body text)
<!-- SECTION:FINAL_SUMMARY:END -->
