---
id: AISDLC-79
title: >-
  agent-role.yaml tools list: decide intent vs Claude Code SDK defaults (Task,
  WebFetch, WebSearch, Skill, NotebookEdit)
status: Done
assignee: []
created_date: '2026-04-29 01:53'
updated_date: '2026-04-29 06:37'
labels:
  - question
  - design
  - agent-role
  - user-feedback
  - alex
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

User feedback (Alex / neuralcartographer): the default `agent-role.yaml` `tools` list shipped by `init` is:

```
Edit, Write, Read, Glob, Grep, Bash
```

The Claude Code SDK ships these PLUS:

```
Task, WebFetch, WebSearch, Skill, NotebookEdit
```

User asks: **intentional minimization or oversight?**

## The decision

This is a security/governance question, not a bug. Three possible answers:

### Option A — Keep the current minimal list (intentional minimization)

Reasoning: tighter tool surface = smaller blast radius. Coding agents shouldn't need WebFetch/WebSearch (closed-loop on the codebase), shouldn't spawn sub-Tasks (recursion risk), shouldn't edit notebooks (rare). Skill is interesting — leaving it off blocks the agent from invoking other plugins' skills.

Document in agent-role.yaml WHY each is omitted. Add an opt-in pattern (`tools+:`) for users who want the broader set.

### Option B — Match Claude Code SDK defaults

Reasoning: principle of least surprise. Users coming from Claude Code expect their agents to have what Claude Code agents have. Removing tools without explaining feels arbitrary.

If we go this route, document each addition's risk profile in the agent-role.yaml comments.

### Option C — Tier-based defaults

Different agent roles get different defaults:
- `coding-agent` (the default): Edit/Write/Read/Glob/Grep/Bash + NotebookEdit (no Task, no Web*, no Skill)
- `research-agent`: + WebFetch/WebSearch
- `meta-agent`: + Task + Skill

`init` chooses based on a flag or a question.

## Recommendation

**Option C** — most flexible, surfaces the security implication of each addition. Default is the current minimal set (matches today's behavior, no migration). New roles available via `--role` flag.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Decision doc under `backlog/decisions/AISDLC-79-agent-role-tools-defaults.md` (or similar) recording the rationale for the chosen option
2. `agent-role.yaml` template updated per the chosen option with inline comments explaining each tool's inclusion/exclusion
3. If Option C: `init --role <coding|research|meta>` flag + corresponding template variants
4. Migration note for users on the current default — explicit statement that nothing changes for them OR what they need to do
5. CHANGELOG entry
6. Regression tests for the chosen default(s) and any new flags
7. All new code: 80%+ patch coverage, build/test/lint/format clean

## Out of scope

- Reworking the broader agent-role schema
- Adding new tool types beyond what Claude Code SDK exposes
- Per-skill tool overrides (separate concern)

## References

- User report (Alex Kline / neuralcartographer, 2026-04-28)
- `templates/.ai-sdlc/agent-role.yaml`
- Claude Code SDK tool list (canonical reference)
- `.ai-sdlc/agent-role.yaml` in this repo (the dogfood baseline)
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Decision documented under `backlog/decisions/` recording chosen option (A/B/C) with rationale and tradeoffs
- [x] #2 `agent-role.yaml` template updated with inline comments explaining each tool's inclusion or exclusion based on the decision
- [x] #3 If Option C selected: `init --role <coding|research|meta>` flag implemented with corresponding template variants and tests
- [x] #4 Migration note: explicit statement of what current users need to do (or that nothing changes for them)
- [x] #5 CHANGELOG entry
- [x] #6 Regression tests cover the chosen defaults and any new flags
- [x] #7 All new code: 80%+ patch coverage; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Implemented Option C (tier-based agent-role tool defaults) via a new `init --role <coding|research|meta>` flag. Default tier `coding` preserves today's tool surface plus NotebookEdit; `research` adds WebFetch+WebSearch; `meta` adds Task+Skill on top. Decision doc records why Option A (mirror SDK defaults wholesale) and Option B (single template) were rejected. Existing `agent-role.yaml` files are untouched (init's skip-if-exists behavior preserved) — no migration required.

## Changes
- `orchestrator/src/cli/commands/init.ts`: 3 tier templates + `--role` flag + `AGENT_ROLE_TIERS` allowlist + `getAgentRoleYaml(tier)` exported helper. Validation rejects invalid tier with exit code 1.
- `orchestrator/src/cli/commands/commands.test.ts`: 6 new regression tests (default tier, each --role value, invalid --role rejection, exported helper sanity). Anchored regex assertions catch tier-list drift.
- `backlog/decisions/AISDLC-79-agent-role-tools-defaults.md` (new): chosen option + rationale + tradeoffs + threat model (prompt-injection surface from Web*/Skill, cost-amplification from Task).
- `orchestrator/CHANGELOG.md`: entry with explicit no-migration guarantee.

## Design decisions
- **Default = `coding` tier**: existing users get current behavior + NotebookEdit. No silent escalation possible — tier escalation requires explicit `--role` flag.
- **Three nearly-identical YAML templates rather than programmatic generation**: each tier's tools listed explicitly with inline rationale comments. CLAUDE.md's "three similar lines beat a premature abstraction" applies.
- **`blockedPaths` preserved across all tiers**: even `meta` tier cannot edit `.github/workflows/**` or `.ai-sdlc/**` — the tier system controls tool surface, not path policy.

## Verification
- `pnpm build` — clean
- `pnpm test` — 2752/2752 orchestrator + sibling packages green
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 1 minor + 3 suggestion; test: 1 suggestion; security: 0)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- Reviewer suggestions (deferrable): drop redundant `?? 'coding'` fallback; consider Commander's `.choices()` for built-in validation; refactor 3 templates to programmatic generation if a 4th tier is ever added; lock tool count per tier with explicit length assertion.
<!-- SECTION:FINAL_SUMMARY:END -->
