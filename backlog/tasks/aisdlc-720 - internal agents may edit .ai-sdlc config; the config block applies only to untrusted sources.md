---
id: AISDLC-720
title: >-
  Internal agents may edit .ai-sdlc config; the config block applies only to untrusted sources
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - adopter
  - bug
dependencies: []
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - spec/schemas/agent-role.schema.json
  - .ai-sdlc/agent-role.yaml
  - docs/api-reference/governance.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator statement, 2026-10-04 (Dominique Legault, to the planner session): "Why does the framework explicitly disallow agents to modify the .ai-sdlc config ... I never asked for this, the only thing I asked for was that untrusted PRs from external sources like github PRs couldn't make modifications to the config of ai-sdlc, not internal trusted agents operating on my behalf. If I have to manually make changes to the config and commit and push and merge those changes then that dramatically affects developer velocity."

What the code does today (origin/main, 2026-10-04):
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` refuses the Write and Edit tools on any path under `.ai-sdlc/` for every session, as a hardcoded floor that ignores `agent-role.yaml` ("is under .ai-sdlc/, which is never editable — pipeline configuration is out of scope for agent edits regardless of project config"). It checks no role, source kind or fork status. The floor was added by AISDLC-567 (#982) and kept absolute by AISDLC-599 ("the safer governance posture").
- `spec/schemas/agent-role.schema.json` documents the floor as always-on; this repository's `.ai-sdlc/agent-role.yaml` also lists `.ai-sdlc/**` and `.github/workflows/**` under `constraints.blockedPaths`.
- Nine agent and command bodies tell agents "Never edit `.ai-sdlc/**`" (`ai-sdlc-plugin/agents/developer.md`, `ci-conflict-resolver.md`, `rebase-resolver.md`, `refinement-reviewer.md`; `ai-sdlc-plugin/commands/execute.md`, `orchestrator-tick.md`, `dispatch-worker.md`, `rebase.md`, `resolve-conflicts.md`).
- No CI check stops a pull request from an outside contributor from changing `.ai-sdlc/**`; the only protection against the actual threat is CODEOWNERS and the fork handling in `untrusted-pr-gate.yml` and `ai-sdlc-review.yml`.
- Shell commands are not matched for paths, so the floor blocks the reviewed tools and leaves scripts free; it is not a boundary.

So the rule stops the trusted sessions and does not stop the untrusted source it was meant for. Every one-line config change lands on the operator (examples: the force-push default, `releaseAuthors`, `allowReleaseMerge`).

## Conventions
- Trust-chain change: the security review runs on opus, and the PR stays a draft until CodeQL is clean.
- The security reviewer confirms that the untrusted signal cannot be cleared from inside an untrusted run and that the CI check cannot be skipped by a fork.

## Acceptance Criteria
- [ ] The hardcoded `.ai-sdlc/**` floor for Write and Edit is removed for internal sessions. An internal session is any session that is not marked untrusted; a session is marked untrusted only by an explicit signal set by the workflows that run agents on outside input (fork pull requests, pull requests whose author association is not OWNER, MEMBER or COLLABORATOR, and the `gh-issue` source kind). Name the signal (for example an environment variable set by those workflows) and document it; the default with no signal is internal.
- [ ] For untrusted runs the block on `.ai-sdlc/**` (and on `.github/workflows/**`) stays, covers Write, Edit, MultiEdit and shell writes as far as a pattern matcher can, and the refusal says the run is untrusted and why.
- [ ] The real boundary for outside contributions is in CI, derived from GitHub facts: a required check fails any pull request from a fork or from an author without OWNER, MEMBER or COLLABORATOR association that changes governance config (`.ai-sdlc/agent-role.yaml` and the other config files under `.ai-sdlc/`, listed explicitly) or `.github/workflows/**`, and its message says a maintainer must make that change. Same-repository pull requests from the operator's identity or agents are not affected. Tests cover fork, outside author, and internal cases.
- [ ] Project-level `constraints.blockedPaths` keeps working as an explicit opt-in for repositories that want stricter rules; this repository's `.ai-sdlc/agent-role.yaml` drops `.ai-sdlc/**` and `.github/workflows/**` from it, applied after the release that ships the hook change and made with the Edit tool (the workflow-edit rule is external-only per AISDLC-567's own text).
- [ ] The nine agent and command bodies listed above replace "Never edit `.ai-sdlc/**`" with: edit governance config only when the task names the file and the change; never as a side effect; runtime artifacts (attestations, reviews, transcript leaves, the decision log, the dispatch board) are written through their CLIs as today.
- [ ] Reviewer prompts (code and security) treat a diff that touches governance config as requiring a matching task or decision record on main, and a change that loosens a control without one as a major finding. The decision digest lists every merged change to governance config with its pull request. This is review and visibility, not a block: no step waits for the operator.
- [ ] `spec/schemas/agent-role.schema.json` descriptions and `docs/api-reference/governance.md` describe the new model in plain words: who may edit config, what marks a run untrusted, where the CI boundary is.
- [ ] Bootstrap: sessions run the installed plugin's hook, not the one on main, so the hook keeps refusing Write and Edit under `.ai-sdlc/` until a plugin release ships this change and sessions pick it up. Config edits that depend on this change wait for that release and are then made with the Edit tool. No executor routes a config edit through a shell command to get around the hook; the operator's authorization covers the content of a change, not a bypass. This task's own change to this repository's `.ai-sdlc/agent-role.yaml` (dropping the two blockedPaths entries) is therefore delivered as a follow-up step after the release, and the task's notes say so.
- [ ] A happy-path test: an internal session, default configuration, a task that names a config key and value, edits `.ai-sdlc/agent-role.yaml` with the Edit tool and is not refused.
- [ ] Reviewer agents can write their own review transcript and ledger files under `.ai-sdlc/` through the Write tool or the sanctioned CLI without a refusal (44 of 46 `.ai-sdlc` refusals in a five-day sample were reviewers blocked from writing their own transcript); a test covers it.
- [ ] PR body carries a "Velocity impact" section (DEC-0048): the harm the old rule prevented, that it fired on a normal operator workflow with a human-only exit, and the new boundary.

## Out of scope
- Changing what the config keys mean; merge rights; the release path.

## Remaining scope (2026-10-05)

The hook and resolver half shipped in PR #1211 and plugin 0.23.0 (fail-closed: a run is untrusted when `AI_SDLC_UNTRUSTED_RUN` is truthy, or when `GITHUB_ACTIONS` is truthy and `AI_SDLC_INTERNAL_RUN` is not truthy). Do NOT redo it. Only the workflow half remains:

- (a) In `.github/workflows`, set `AI_SDLC_INTERNAL_RUN` only in step-level `env:` on steps of trusted jobs, never via `$GITHUB_ENV` or job-level or workflow-level `env:`, because a later step could inherit it (Opus security finding on #1211).
- (b) Set `AI_SDLC_UNTRUSTED_RUN` explicitly on every job that takes outside input (external PR review, issue-triggered runs).
- (c) Add a test or lint that fails if `AI_SDLC_INTERNAL_RUN` appears at job or workflow level or in a `$GITHUB_ENV` write.
- (d) The task file moves to completed only when this half merges (the task-move skip is pre-approved for that PR).

The workflow edit needs the planner-tracked blockedPaths change (task 721, which removes `.github/workflows/**` from `blockedPaths`) on main first.
<!-- SECTION:DESCRIPTION:END -->
