---
id: AISDLC-483
title: >-
  feat: default code/test review dispatch to the Codex harness and dev/subagent
  dispatch to Sonnet (cost control)
status: To Do
assignee: []
created_date: '2026-05-30 20:30'
labels:
  - feature
  - cost
  - dispatch
  - codex
  - subagent
dependencies: []
references:
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 2026-05-30 cost incident (26% of weekly usage in a single session) traced to subagents inheriting Opus 4.8 because agent frontmatter was `model: inherit` and dispatch paths did not pin per-role models or harnesses. A companion task (AISDLC-482-sibling, shipped in PR #777) pinned the frontmatter defaults (developer/code-reviewer/test-reviewer = sonnet; security-reviewer = opus), but the DISPATCH paths themselves still route all reviewer calls to the Claude-native agents by default.

The dispatch paths — `/ai-sdlc execute` (Step 7 reviewer fan-out in `ai-sdlc-plugin/commands/execute.md`), `/ai-sdlc orchestrator-tick` (Step 2.5 Phase B reviewer dispatch), and any manual `Agent(code-reviewer)` call in slash-command bodies — should ALSO:

(a) Route code-review and test-review to `code-reviewer-codex` / `test-reviewer-codex` by default. Codex CLI is installed at `/opt/homebrew/bin/codex` (v0.128.0 confirmed 2026-05-30); Codex plan billing = zero Claude usage, making it cost-free for the bulk of review work.

(b) Keep security-review on the Claude-native `security-reviewer` agent at opus — reasoning-heavy work that Codex does not handle reliably.

(c) Keep developer dispatch on sonnet (already pinned in frontmatter; dispatch layer should not override this downward or upward).

(d) Expose a documented override (env var or per-command flag) for cases where a Claude-native reviewer is explicitly wanted (e.g. when Codex is not installed or a team disables it).

This makes the cheap path the default everywhere, not just in agent frontmatter, and closes the gap where ad-hoc `Agent(...)` calls or manual execute invocations silently pick the expensive model.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] AC-1: The canonical reviewer fan-out in `/ai-sdlc execute` (Step 7) selects `code-reviewer-codex` and `test-reviewer-codex` by default; security-reviewer stays on the Claude-native agent at opus. A documented env var (e.g. `AI_SDLC_REVIEWER_HARNESS=claude`) overrides to the Claude-native reviewer for all three review roles.
- [ ] AC-2: The orchestrator-tick reviewer fan-out (Step 2.5 Phase B) applies the same default selection and honors the same override env var.
- [ ] AC-3: Developer dispatch explicitly pins sonnet (consistent with the frontmatter default); security-review dispatches the Claude-native `security-reviewer` at opus by default. Both have a documented per-invocation override.
- [ ] AC-4: Docs under `docs/operations/` (or the relevant command README) describe the default harness and model per role, how to override each, and the cost rationale (Codex plan = zero Claude tokens for code/test review; opus on security = one high-value role).
- [ ] AC-5: A hermetic test asserts that, with no override env vars set, the reviewer selection logic resolves code-reviewer to `code-reviewer-codex`, test-reviewer to `test-reviewer-codex`, security-reviewer to the Claude-native agent, and developer to sonnet.
<!-- AC:END -->

## References

- spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
- ai-sdlc-plugin/commands/execute.md
- ai-sdlc-plugin/agents/code-reviewer-codex.md
- ai-sdlc-plugin/agents/test-reviewer-codex.md
- ai-sdlc-plugin/agents/security-reviewer.md
- ai-sdlc-plugin/agents/developer.md
