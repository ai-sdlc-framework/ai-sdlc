---
id: AISDLC-761
title: >-
  Pin a model on every plugin command and agent; haiku for relays and review probes
status: To Do
assignee: []
created_date: '2026-10-08'
labels:
  - token-cost
  - plugin
dependencies: []
references:
  - ai-sdlc-plugin/commands/
  - ai-sdlc-plugin/agents/
  - CLAUDE.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

22 of 23 commands and 5 agents (review-executor, code-reviewer-codex, test-reviewer-codex, refinement-reviewer, rebase-resolver, ci-conflict-resolver) carry `model: inherit`, so a relay run from a Fable or Opus session pays that rate (the 2026-05-30 incident class). Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. Pin haiku on relay commands (version, doctor, hierarchy, cleanup, pipeline-status, triage render, import-spec, rfc-init, init-signing-key) and on review-executor.
2. Pin sonnet on the resolvers, refinement-reviewer and the codex wrappers; keep developer on sonnet and security-reviewer on opus.
3. Add a test that fails when a command or agent file has no `model:` or has `inherit`.
4. Update the CLAUDE.md section 'Subagent model defaults'.

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: No command or agent file under ai-sdlc-plugin carries `model: inherit` or lacks `model:`.
- [ ] AC-2: The listed relay commands and review-executor pin haiku; resolvers, refinement-reviewer and codex wrappers pin sonnet.
- [ ] AC-3: The new test fails on a file with no model or with inherit.
- [ ] AC-4: CLAUDE.md subagent model defaults match the pins.
<!-- AC:END -->
