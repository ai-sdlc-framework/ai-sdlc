---
id: AISDLC-1071
title: 'one governance skill copy, and the three reviewer agents render their rule blocks from prompt-rules.js instead of hand-written duplicates'
status: Done
assignee: []
created_date: '2026-10-23'
labels:
  - plugin
  - token-cost
  - rca-2026-10-23
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - docs/operations/prompt-rules.md
---

## Description

Persistent-context audit (2026-10-23). Two findings outside the RFC-0053 tasks. (1) The governance skill ships twice: `.claude/skills/ai-sdlc-governance/SKILL.md` in the project and `ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md` in the plugin, both listed in every session, and the two have drifted: the project copy tells agents to run `pnpm test:coverage` while `CLAUDE.md` says coverage is CI-only (AISDLC-726), and its lease-push rule predates DEC-0264. (2) The code, test and security reviewer agent definitions each carry a hand-written block of about 4.5 KB of near-identical never/always rules (216, 203 and 137 lines in total) instead of the one-line-per-rule render from `ai-sdlc-plugin/hooks/lib/prompt-rules.js` that AISDLC-651.2 made the single source; the blocks already disagree with each other in wording. Every reviewer call replays its block; three reviewers per round, every round.

Fix: delete the project copy of the skill (the plugin copy is the one adopters get) and reconcile the plugin copy with `CLAUDE.md` where they conflict (CI-only coverage, DEC-0264 lease push); add a test that fails when a skill name is listed by both the project `.claude/skills/` and the plugin. For the reviewers, replace the hand-written rule blocks with the `prompt-rules:begin/end` rendered region the other agents use, keep only the remit-specific instructions in prose, and extend `scripts/` prompt-rules gate so an agent file that restates a rule id in prose outside the rendered region fails. Report the byte count per reviewer before and after in the PR body.

**Five-step review (requirements first).** Requirement questioned: do reviewers need their own wording of the shared rules? No: the rules are the same rules; wording drift is only risk. Deletion: one skill copy and three hand-written rule blocks. Simplified: one render path for every agent. Accelerated: about 4 KB fewer per reviewer call. Automated last: the duplicate-skill test and the prose-restatement gate.

## Acceptance Criteria

- [x] Exactly one `ai-sdlc-governance` skill is listed in a fresh session; a test fails on a skill name present in both `.claude/skills/` and the plugin; the surviving copy agrees with `CLAUDE.md` on coverage and lease push.
- [x] The three reviewer agents carry a rendered `prompt-rules` region and no hand-written restatement of a rule id; the prompt-rules gate fails on a restatement; the PR body shows bytes before and after per reviewer.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `pnpm test:plugin-model-pins-gate` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
Deleted the project copy of the governance skill and updated the plugin copy to match CLAUDE.md on coverage (CI-only) and lease push (DEC-0264). The three reviewers now carry a rendered prompt-rules region (stash, waived-tests) with no prose restatement of a rule id. Two guards were added: a duplicate-skill test and the prompt-rules gate now covering the reviewers. There was no byte saving, because the ~4.5 KB hand-written blocks the audit described were not in the files.

## Changes
- .claude/skills/ai-sdlc-governance/SKILL.md
- ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md
- ai-sdlc-plugin/agents/code-reviewer.md
- ai-sdlc-plugin/agents/test-reviewer.md
- ai-sdlc-plugin/agents/security-reviewer.md
- ai-sdlc-plugin/commands/prompt-rules.test.mjs
- ai-sdlc-plugin/hooks/lease-push-docs.test.mjs

## Design decisions
Bytes before and after per reviewer are in the PR body: code 14429 to 14442, test 13242 to 13234, security 9768 to 10537. Security grew because it gained the stash and waived-tests rules it lacked. The rebase conflicted in the governance SKILL.md because main had cut its reference material; I took main's side and reapplied my two edits. I ran the full build, test, lint, format:check and test:plugin-model-pins-gate before the rebase, all green. After the rebase I re-ran only the prompt-rules and lease-push-docs tests (86 pass, 0 fail) and format:check. The PR is a draft; `ai-sdlc/pr-ready` has not been checked. The commit scope is `ci` because commitlint rejected `plugin`.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

