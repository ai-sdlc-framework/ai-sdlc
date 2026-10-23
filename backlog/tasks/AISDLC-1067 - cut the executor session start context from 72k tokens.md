---
id: AISDLC-1067
title: 'executor session start context is cut from about 72k tokens to under 30k by moving reference prose out of the command, CLAUDE.md and the governance preamble'
status: To Do
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
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - docs/operations/cli-hierarchy.md
---

## Description

Live check during the weekly token audit (2026-10-23 19:05Z): every executor session is at about 72k tokens of context on its second model call, before any task work. Since cache-read tokens are 98 percent of the week's 7,980M tokens and every later call replays this baseline, the start context is the largest per-call constant in the fleet: an executor round of 300 calls carries about 21M tokens of preamble alone. The inputs are the executor command body (`ai-sdlc-plugin/commands/executor.md`, 10.9k characters), the project `CLAUDE.md` (15k characters, at its budget), the governance skill preamble injected at SessionStart (5.9k characters, and the SessionStart hook prints the governance block twice in this repository, see the duplicated "AI-SDLC Governance Active" text), the skill and agent listings, and the MCP tool schemas of every connected server.

Fix, measured first: (1) add a script `scripts/measure-start-context.mjs` that starts a session with the executor command non-interactively (or reads the first assistant `usage` of a fresh executor transcript) and prints the token count per contributor where it can be told apart (command body, CLAUDE.md, governance block, remainder); commit its output in the PR body as the before figure. (2) Remove the duplicate governance block: the SessionStart hook must print it once (find why it prints twice; a second hook registration or two settings layers). (3) Move every reference paragraph out of the executor command body into `docs/operations/cli-hierarchy.md` and leave the command with the steps and the prompt-rules lines only; the same pass for the governance skill (keep the rules that change behaviour, link the rest). (4) In the roster launcher, start executors with the plugin's MCP servers only (not the operator's personal connectors: the tool schemas of unrelated servers are loaded into every executor); document the setting. Do not touch `CLAUDE.md` size rules beyond what the budget test already enforces. Target: under 30k tokens on the second call, reported in the PR body with the after figure.

**Five-step review (requirements first).** Requirement questioned: does an executor need the full reference text at start? No: it needs the steps, the rules and a path to the rest. Deletion: the duplicated governance block and the reference prose in the command body. Simplified: command = steps plus rules. Accelerated: every executor call carries about 40k fewer tokens. Automated last: the measure script runs in CI as a budget test with a ceiling, failing when the start context grows past it.

## Acceptance Criteria

- [ ] `scripts/measure-start-context.mjs` exists, documents its method, and the PR body shows before and after figures from it; the after figure is under 30k tokens on an executor's second call.
- [ ] The SessionStart governance block appears exactly once in a fresh session (test on the hook output).
- [ ] A budget test fails when the measured executor start context exceeds the committed ceiling; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
