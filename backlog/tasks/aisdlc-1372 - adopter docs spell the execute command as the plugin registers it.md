---
id: AISDLC-1372
title: 'Adopter docs spell the execute command as the plugin registers it'
status: To Do
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - docs
dependencies: []
references:
  - README.md
  - docs/getting-started/onboarding.md
  - docs/getting-started/README.md
  - ai-sdlc-plugin/README.md
  - ai-sdlc-plugin/commands/execute.md
priority: low
---

## Description

**Gap.** The docs tell adopters to type `/ai-sdlc execute`, while the plugin named `ai-sdlc` registers the file `execute.md` as `/ai-sdlc:execute`. Source: https://github.com/ai-sdlc-framework/ai-sdlc/issues/2754 (item 7).

**Facts read in code** (main at 687e0d596).

- Adopter-facing spaced form today: `README.md:88`, `:113`, `:122`; `docs/getting-started/README.md:37`; `docs/getting-started/onboarding.md:247`, `:249`, `:317`, `:472`; `ai-sdlc-plugin/README.md:9`, `:19`, `:31`, `:65`, `:164`, `:219`. The spaced form appears in 47 files under `docs/`, `README.md` and the plugin README in all.
- Already fixed since the issue: item 8 (the removed signing step and `.dsse.json` check). `docs/getting-started/onboarding.md:223` is now "Step 4 - No signing key needed" and a grep for `init-signing-key` and `dsse` in `docs/getting-started`, `README.md` and the plugin README finds only `ai-sdlc-plugin/README.md:214`, which says the command was removed (commit a8dda8a3d, AISDLC-1313, and b9be05f97, AISDLC-1353).

**Not verified.** Whether Claude Code also accepts the spaced form `/ai-sdlc execute`. The issue did not check it and it was not checked here.

**Observed** (from the issue, not reproduced here). The trial session listed the command as `ai-sdlc:execute`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: adopters need the string that works; the 47 files include internal operator docs where the spaced form is a house style. Only the adopter-facing set is required. 2. Deleted: the spaced form in `README.md`, `docs/getting-started/` and `ai-sdlc-plugin/README.md`. 3. Simplified or optimised: one grep-based check instead of a list of files. 4. Accelerated: adopters copy a working command. 5. Automated: a test fails if the spaced form returns to those files.

- Replace `/ai-sdlc execute` with `/ai-sdlc:execute` in the adopter-facing files listed above, and the same for the other plugin commands written the same way in those files (`rebase`, `cleanup`, `planner`, and so on) after checking each is a registered command name.
- Add a test that scans those files for the spaced form of every command in `ai-sdlc-plugin/commands/*.md` and fails on a hit. Operator docs under `docs/operations/` are not changed here.

Out of scope: the other docs under `docs/` (a separate task if the operator wants them changed), and the command files' own text.

## Acceptance Criteria

- [ ] #1 `README.md`, `docs/getting-started/` and `ai-sdlc-plugin/README.md` contain no `/ai-sdlc <command>` spaced form for any registered command name.
- [ ] #2 A test lists `ai-sdlc-plugin/commands/*.md` names and fails when any of the three adopter-facing locations uses the spaced form, and it passes on the changed files.
- [ ] #3 Each replacement was checked against a registered command name; a name with no command file is left as written and listed in the pull request body.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
