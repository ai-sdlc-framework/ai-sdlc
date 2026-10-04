---
id: AISDLC-710
title: >-
  Lease push on the agent's own branch is allowed by default
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.js
  - spec/schemas/agent-role.schema.json
  - docs/api-reference/governance.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adopters and this repo's own operator are repeatedly asked to authorize `git push --force-with-lease` to an agent's own task branch. The governance setting `allowForcePush` (under `spec.governance` in `.ai-sdlc/agent-role.yaml`; schema `spec/schemas/agent-role.schema.json`, resolver `ai-sdlc-plugin/hooks/lib/governance-resolver.js`, functions `resolveForcePushMode` and `STRICT_DEFAULTS.allowForcePush`) defaults to `never` when a repo sets nothing, so every adopter hits the prompt after any rebase. Rebasing a task branch onto main and lease-pushing it is the framework's own required workflow (rebase, never merge main in), so the default blocks the documented happy path. Operator decision 2026-10-04 (DEC-0047): the default is `leaseOnOwnBranch`.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared `/tmp` path.
- Facts established while filing (verify against current main before changing code): allowed values are `never`, `leaseOnOwnBranch`, boolean `true` (read as `leaseOnOwnBranch`) and boolean `false` (read as `never`); anything malformed fails closed to `never`. The hook entry is `loadLeasePolicy` and `enforceBash` in `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`, with the push parser `evaluateLeasePush` / `parseAllowedShape` in `ai-sdlc-plugin/hooks/lib/lease-push-guard.js`. Today the guard accepts one spelling only, `git push <remote> --force-with-lease[=<own>[:<sha>]] HEAD:refs/heads/<own-branch>`; the no-colon form is refused on purpose (git can map it to main through `push.default` or `remote.<name>.push`), so widening the matcher must keep that refusal or replace it with a check that resolves the real destination.
- Facts that could not be established while filing: whether `/ai-sdlc doctor` reads `allowForcePush` today (a grep of `ai-sdlc-plugin/commands/doctor.md` found no mention); the init scaffold in `orchestrator/src/cli/commands/init.ts` and `init-templates.ts` writes no `governance:` block, so new adopters get the resolver default.

## Acceptance Criteria
- [ ] When a repo sets nothing, the effective value of `allowForcePush` is `leaseOnOwnBranch`: `--force-with-lease` to the session's own task branch is allowed without an operator prompt. The change is in the resolver's default and the schema default, not only in templates.
- [ ] Unchanged and still refused under the default: plain `--force` / `-f` / `+refspec`; any force push to main, master or another protected/default branch; a lease push to a branch that is not the agent's own (define "own" exactly as the current `leaseOnOwnBranch` value does: the branch checked out in a dispatched worktree under `<repo>/.worktrees/`, where the worktree's `.active-task` id, the worktree directory name and the `ai-sdlc/<task-id>-*` branch prefix all agree, the branch is not protected, and no other local ref answers to its short name).
- [ ] A repo can still opt into the stricter value `never` (boolean `false` reads the same way) explicitly; an explicit setting always wins over the default.
- [ ] The init scaffold and templates write (or document) the new default; this repo's own config is updated or left unset so it inherits it. `/ai-sdlc doctor` reports the effective value and where it came from.
- [ ] The hook accepts the lease push however the command is reasonably written when the branch is the agent's own (from inside the task worktree, with or without an explicit refspec, with `--force-with-lease=<ref>:<sha>`), so agents do not fall back to asking. If the current matcher only accepts one exact form (see `ai-sdlc-plugin/hooks/lib/lease-push-guard.js`), widen it and test each accepted form and each refused form.
- [ ] The refusal message, when a push IS refused, names the config key and the value that would allow it, so an adopter can fix it without reading source.
- [ ] Skill and agent bodies that tell agents to ask the operator before a lease push (developer agent, rebase-resolver, ci-conflict-resolver, execute, executor: grep for it) are updated to push under the default instead of asking.
- [ ] Tests: default resolution with no config; explicit strict value still refuses; own-branch lease allowed; foreign-branch lease refused; main refused; plain force refused. Docs page `docs/api-reference/governance.md` and the CHANGELOG entry (via the release tooling, not hand-edited on a feature branch) describe the changed default as a behaviour change adopters get on upgrade.

## Out of scope
- Removing the governance hook; allowing plain force pushes; merge rights.

## Notes for the implementer
- Adopter-facing default change; ship in the next release.
- Security review on opus: confirm the "own branch" test cannot be satisfied for a branch another session or a human owns.
<!-- SECTION:DESCRIPTION:END -->
