---
id: AISDLC-752
title: >-
  Every hierarchy session starts in bypassPermissions by default, planner included
status: To Do
assignee: []
created_date: '2026-10-07'
labels:
  - rfc-0051
  - dispatch
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - pipeline-cli/src/hierarchy/docs-parity.test.ts
  - pipeline-cli/src/hierarchy/index.ts
  - docs/operations/cli-hierarchy.md
  - docs/operations/parallel-dispatch.md
  - ai-sdlc-plugin/commands/hierarchy.md
  - ai-sdlc-plugin/commands/planner.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-07 the operator decided that every session in the session hierarchy, the planner included, runs in `bypassPermissions` (the mode `claude --dangerously-skip-permissions` selects). The planner is unattended for most of the day like the other tiers; permission prompts stall it, and hooks, not prompts, are the control surface for all three roles.

Today `cli-hierarchy up` starts dispatch and executors in `bypassPermissions` unconditionally but resolves the planner mode from `--planner-permission-mode`, then the operator's `defaultMode` setting, then `FALLBACK_PLANNER_MODE = 'default'`, and refuses to start a planner that resolves to `bypassPermissions` unless `--allow-planner-bypass` is given (`pipeline-cli/src/hierarchy/up.ts`, around the `plannerMode` resolution and the refusal that mentions `--allow-planner-bypass`). That is why the running roster was started with `--no-planner` and a hand-launched planner, which the roster does not know about.

Change the default so the planner behaves like the other tiers:

- The planner's permission mode defaults to `bypassPermissions`. An explicit `--planner-permission-mode <m>` still overrides it, so an operator who wants a prompting planner can have one. The operator's `defaultMode` setting no longer feeds the planner mode: the hierarchy is an unattended fleet and its mode is a hierarchy decision, not a per-user editor preference.
- Remove the refusal and the `--allow-planner-bypass` flag from `up`. Keep accepting the flag as a no-op for one release so existing scripts and the plugin recipe do not break, and print a one-line deprecation notice when it is passed.
- Dispatch and executor sessions keep `bypassPermissions` with no override; add an assertion in `hierarchy.test.ts` that the `claude` command line `buildClaudeCommand` produces for each of the three roles carries `--permission-mode bypassPermissions` when no planner mode is given, and that only the planner line changes under `--planner-permission-mode`.
- The `crossSessionInbound` preflight already triggers whenever any bypass session starts; with the planner now also bypass it triggers on every `up`. Keep it, and make sure its fix text still reads correctly when the planner is among the sessions.
- Update `docs/operations/cli-hierarchy.md` (option table, the preflight bullets, the "planner starts in the permission mode from the operator's settings" sentence, and the exit-code text), `docs/operations/parallel-dispatch.md`, `ai-sdlc-plugin/commands/hierarchy.md` recipes (the one-slot recipe becomes `up --executors 1`, no `--no-planner`), and the help text in `pipeline-cli/src/cli/hierarchy.ts`. `docs-parity.test.ts` enforces that the help text and the reference page agree, so change both together. `--no-planner` stays, for the case where a planner already runs elsewhere.
- Mention in the CHANGELOG entry that an operator who relied on a prompting planner must now pass `--planner-permission-mode default`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `cli-hierarchy up --executors 1` with no other flags starts planner, dispatch and executor-alpha, and `cli-hierarchy status` shows `bypassPermissions` for all three; `hierarchy.json` records the same.
- [ ] `--allow-planner-bypass` is accepted with a deprecation line and changes nothing; `--planner-permission-mode default` still yields a prompting planner.
- [ ] The operator's `defaultMode` setting no longer influences the planner mode (test with a settings view whose `defaultMode` is `plan` or `default`).
- [ ] `hierarchy.test.ts` asserts the `--permission-mode bypassPermissions` argument for every role by default and the planner-only override; the former refusal test is removed or inverted.
- [ ] Help text, `docs/operations/cli-hierarchy.md`, `parallel-dispatch.md` and the plugin `hierarchy.md` recipes agree, and `docs-parity.test.ts` passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass apart from the pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), disclosed in the PR body.
