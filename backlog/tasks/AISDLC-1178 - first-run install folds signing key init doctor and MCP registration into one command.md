---
id: AISDLC-1178
title: 'First-run install: one command after adding the plugin does signing key, init, doctor and MCP advisor registration'
status: In Progress
assignee: []
created_date: '2026-11-04'
labels:
  - install
  - onboarding
  - ai-sdlc-plugin
dependencies: []
references:
  - ai-sdlc-plugin/commands/doctor.md
  - docs/operations/init.md
  - docs/getting-started/onboarding.md
  - orchestrator/src/cli/commands/mcp-setup.ts
priority: medium
dispatchable: true
---

## Description

**Source.** Install friction report from the ai-sdlc-io planner session, 2026-11-04, relayed as operator-approved. Context: ai-sdlc-io IO-54 (PR 183) adds a tabbed install block to the homepage. Operator confirmed this task for dispatch in the ai-sdlc planner session on 2026-11-04.

**Five-step review (requirements first).**
1. Question the requirement: the user needs a working, attested setup after the fewest steps. Today it takes six serial commands: `/plugin marketplace add ai-sdlc-framework/ai-sdlc`, `/plugin install ai-sdlc@ai-sdlc`, `/reload-plugins`, `/ai-sdlc init-signing-key`, `/ai-sdlc init`, `/ai-sdlc doctor`. The onboarding doc adds `npm install -g @ai-sdlc/orchestrator`.
2. Delete: drop every separate step that can run unattended after the plugin is installed.
3. Simplify: one command, run once after the plugin install, generates the signing key if none exists, runs init, registers the MCP advisor and runs doctor. It ends with one report of what it did, what it skipped and why.
4. Accelerate: re-running it is idempotent and touches only what is missing.
5. Automate: a first-run smoke test exercises the single command on a fresh repo.

**Target:** one command to add the plugin, then one command for everything else. A step that cannot be folded in, such as one that needs an operator decision on the machine, is explained in that command's output, not listed as a separate docs step.

**Assumptions to confirm at walkthrough:**
- The global `@ai-sdlc/orchestrator` install is either not required for the first run, or the command installs or resolves it itself.
- Whether `/reload-plugins` can be avoided depends on Claude Code. If it cannot, the output says so.

## Acceptance Criteria

- [ ] AC-1: After the plugin is installed and loaded, one command leaves a repo with a signing key, the `.ai-sdlc/` configuration from init, and the MCP advisor registered for the detected clients. Doctor reports no errors.
- [ ] AC-2: The command prints a report listing each step as done, skipped (already present) or not possible, with the reason and the exact next action for anything not done.
- [ ] AC-3: A second run on the same repo changes nothing and says so.
- [ ] AC-4: `docs/getting-started/onboarding.md` shows the two-step path first.
- [ ] AC-5: A first-run smoke test covers the single command on a fresh repository.
