---
id: AISDLC-561
title: >-
  fix(hooks): stop telling every agent the review policy is "active" when
  nothing enforces it, and make the reviewer set explicit
status: Done
assignee: []
labels:
  - adoption
  - attestation
  - onboarding
  - ci:no-issue-required
priority: critical
dependencies:
  - AISDLC-560
references:
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
updated_date: '2026-10-09 19:02'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adopter report, 2026-08-16. The SessionStart hook tells the coding agent, at the
start of every single session:

> Review policy is active at .ai-sdlc/review-policy.md — consult it before
> reviewing code.

That is true about a file existing and false about anything being enforced. The
reporter calls it "the single most misleading string in the setup, because it is
the one an autonomous agent reads at the start of every session."

The consequence is not hypothetical and not small: **an agent that believes
review is active will not build its own, and will not report the absence.** It
did not, for 200+ merged PRs. The one string that should have prompted the
question instead actively suppressed it.

A related gap: three reviewer agents are defined (`code-reviewer`,
`security-reviewer`, `test-reviewer`, plus `-codex` variants), and **only
`code-reviewer` has ever produced a transcript** in that repo. Nothing indicates
whether the others are opt-in, how to enable them, or that they were simply
never wired. Three defined agents and one that has ever run is a configuration
question nobody was prompted to answer.

### Scope

- The hook must describe what is true. If nothing enforces the policy, say the
  policy is **available**, not **active** — and ideally name what is missing and
  how to fix it, rather than leaving the agent to infer.
- Derive the wording from real state (does enforcement exist?) rather than from
  the presence of a file. A string that is unconditionally optimistic is the
  bug; replacing one adjective with another equally unconditional one is not a
  fix.
- Make the reviewer set explicit at the point an adopter will see it: which
  reviewers run by default, which are opt-in, and how to enable them.

Raised to critical 2026-10-09: first-run defect in the public-relations push window (see AISDLC-771).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [x] #1 With enforcement absent, the session banner does NOT assert the policy
      is active, and states what is missing
- [x] #2 With enforcement present, the banner says so — the two cases are
      distinguishable to a reader
- [x] #3 The wording is computed from inspected state, not from file existence
- [x] #4 The reviewer set (default vs opt-in, and how to enable) is stated
      where an adopter encounters it, not only in framework docs
- [x] #5 Hermetic tests cover both banner states and are mutation-sensitive
- [x] #6 Verified in a repo outside this monorepo
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The `dependencies:` entry in frontmatter is load-bearing: "is enforcement
configured?" is the same question `ai-sdlc doctor` must answer, so the banner
should consume that check rather than reimplementing it and drifting from it.

Note for whoever picks this up: `session-start.js` is being modified by PR #962
(AISDLC-557) — credential redaction and a module-local error capture. Rebase
rather than branching from an older main.
<!-- SECTION:NOTES:END -->

## Final Summary

## Summary
The SessionStart review-policy banner now derives its wording from `ai-sdlc doctor`'s attestation-governance check instead of from the policy file existing. It reports ENFORCED, AVAILABLE but NOT ENFORCED (naming what is missing and the fix), or AVAILABLE but not confirmed, and always states the reviewer set (default vs opt-in and how to enable).

## Changes
- `ai-sdlc-plugin/hooks/session-start.js` (modified): uses the banner helper
- `ai-sdlc-plugin/hooks/lib/review-policy-banner.js` (new): runs `ai-sdlc doctor --only attestation-governance`, classifies output, renders banner
- `ai-sdlc-plugin/hooks/review-policy-banner.test.mjs` (new): hermetic, mutation-sensitive tests for all three states
- `orchestrator/src/cli/commands/doctor.ts` (modified): new `--only <id>` option
- `orchestrator/src/cli/commands/doctor.test.ts` (modified): tests for `--only`

## Design decisions
- **Single source of truth**: the hook shells out to the doctor check rather than reimplementing it; missing CLI, 6s timeout or bad output yields "not confirmed", never "active".
- **Cost**: session start can take up to 6s (the check may call `gh`) when the policy file exists.
- **Commit scope** is `orchestrator` because commitlint rejects `hooks`.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed (40 plugin hook tests, 158 doctor tests, orchestrator 5024, dark-code:check)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- AC6 checked in a temp git repo outside the monorepo with the real built CLI.
- 3 reviews approved (Claude-native code/test reviewers after Codex quota exhaustion; security on opus)

## Follow-up
- declined: `doctor --only X --fix` still runs all fixes (minor, flagged by two reviewers; the hook never passes --fix)
