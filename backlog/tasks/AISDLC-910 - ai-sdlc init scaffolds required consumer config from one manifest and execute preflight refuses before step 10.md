---
id: AISDLC-910
title: 'feat: ai-sdlc init scaffolds the required consumer configuration from one manifest; execute preflight and doctor report the same missing entries before any dev budget is spent'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [feature, adopters, pipeline-cli, plugin]
dependencies: []
references: [ai-sdlc-plugin/commands/doctor.md, docs/operations/doctor.md, ai-sdlc-plugin/commands/init-signing-key.md, ai-sdlc-plugin/hooks/check-plugin-version.js, pipeline-cli/src/steps/01-validate.ts, pipeline-cli/src/steps/reviewer-set.ts, pipeline-cli/src/dor/trusted-reviewers-check.ts]
priority: high
dispatchable: true
---

## Description

In a consumer repository (ai-sdlc-io, plugin 0.28.0, 2026-10-14/15) the attestation configuration was discovered by failure, one file per task run. Two tasks finished dev and both reviews, then Step 10.6 self-verification failed with `v6: no trusted reviewers configured — cannot verify rootSignature` because `.ai-sdlc/trusted-reviewers.yaml` did not exist; executors may not edit `.ai-sdlc/`, so both escalated to the operator, who added the keyring by hand on main. On resume one failed again: verifier ENOENT on `.ai-sdlc/review-policy.md`, and the verifier listed `code-reviewer/test-reviewer/security-reviewer` as required while the classifier had selected `correctness-reviewer + security-reviewer`. A second escalation, a second hand edit. `/ai-sdlc doctor` audits, but `docs/operations/doctor.md:19` and `ai-sdlc-plugin/commands/doctor.md:81` both say "after `ai-sdlc init`", and no `init` command exists in the plugin (only `init-signing-key` and `rfc-init`). Nothing walks an adopter through the configuration the current release requires, and nothing tells them when a new release adds a required file.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that each pipeline step validates the config it needs at the moment it needs it. That rule is why the keyring is first missed at Step 10.6, after dev and review budget is spent; the requirement is that a consumer repo is known-complete before Step 1. 2. Deleted: the per-step discovery of missing config (Step 10.6 keyring ENOENT, review-policy ENOENT) as the FIRST place an adopter learns about it; the per-step checks stay as defence in depth but are no longer the user-facing path. Also deleted: the two doc sentences that reference a command that does not exist, replaced by the real one. 3. Simplified: ONE required-config manifest in pipeline-cli (entry: path, schema or template, `since` plugin version, `needsOperatorInput`), covering at least `agent-role.yaml`, `pipeline.yaml`, `trusted-reviewers.yaml`, `review-policy.md`, the classifier reviewer set, and the operator signing key. `init`, `doctor` and the execute preflight all read that manifest, so they can never disagree on what is required or on the wording. 4. Accelerated: a missing entry is reported at Step 1 (`01-validate.ts`) with the doctor wording and the exact init command, so no task reaches Step 10.6 to find it; the adopter fixes config once, not once per task. 5. Automated, last: `/ai-sdlc init` scaffolds missing entries, prompts only for `needsOperatorInput` values (reviewer keys, reviewer set), never overwrites without `--force`, and records `configVersion` in `.ai-sdlc/pipeline.yaml`; a re-run after an upgrade prompts only for entries whose `since` is newer than `configVersion`. The existing SessionStart plugin-staleness check (`check-plugin-version.js`) prints one extra line when the manifest has entries newer than `configVersion`. `doctor --fix` scaffolds the non-interactive entries. `init-signing-key` becomes one step of `init` (kept as an alias). The reviewer-set mismatch (verifier requiring the three-reviewer set while the classifier selects two) is fixed by making the verifier read the same `reviewer-set.ts` selection the classifier used, or by `init` writing the chosen set where the verifier reads it; the task decides which after reading both call sites, and documents it.

## Acceptance Criteria

- [ ] `pipeline-cli` exports one required-config manifest; a test asserts every path the pipeline reads under `.ai-sdlc/` for attestation and review (keyring, review policy, reviewer set, agent-role, pipeline.yaml) is listed with a `since` version.
- [ ] `/ai-sdlc init` on an empty repo creates every manifest entry (operator-input ones prompted, with `--non-interactive` taking defaults or failing with the missing names); re-run is a no-op without `--force`; `configVersion` is written and a re-run after bumping an entry's `since` prompts only for that entry.
- [ ] `/ai-sdlc execute` Step 1 refuses, before any worktree or dev dispatch, when a manifest entry the run will read is missing, with the doctor wording and the init command; a test covers a missing keyring and a missing review policy.
- [ ] `doctor` lists the same entries with the same wording as the preflight; `doctor --fix` scaffolds non-interactive entries.
- [ ] The verifier and the classifier agree on the required reviewer set for a run (test: classifier picks the two-reviewer set, verifier accepts an envelope with exactly those two).
- [ ] SessionStart prints one line when `configVersion` is older than the newest manifest `since`.
- [ ] `docs/operations/doctor.md` and `ai-sdlc-plugin/commands/doctor.md` reference the real command; `init-signing-key` docs say it is a step of `init`.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Adopter-facing; design for adopters first. If the whole shape exceeds one PR, land the manifest + Step 1 preflight + doctor alignment first (that alone stops the Step 10.6 discoveries), then `init` and the SessionStart line; say so in the PR body rather than splitting the task by hand. Reproduction material: the consumer repo's decision catalog entries DEC-0012, DEC-0014 and DEC-0016 and its keyring PR #17.
