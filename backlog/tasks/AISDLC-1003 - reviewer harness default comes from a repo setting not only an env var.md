---
id: AISDLC-1003
title: 'reviewer harness default comes from a repo setting, not only an env var'
status: In Progress
assignee: []
created_date: '2026-10-21'
labels:
  - pipeline-cli
  - review
dependencies: []
references:
  - pipeline-cli/src/dispatch/reviewer-harness.ts
  - pipeline-cli/src/next-step/review-prepare.ts
  - .ai-sdlc/model-routing.yaml
priority: high
dispatchable: true
---

## Description

The Codex plan quota is exhausted until 2026-11-19. With no override, `reviewer-harness.ts` routes code and test review to the `-codex` agents, which return a fake CRITICAL verdict on quota exhaustion; the task comes back `iterate-needed`, dispatch reenters it as a review-stage resume with a note to run Claude-native, and a second executor pass does the real review. That is one wasted review round, one extra verdict and one extra reenter per task while the quota is out. The only switch today is `AI_SDLC_REVIEWER_HARNESS=claude` in the executor process env, which executor sessions launched by `cli-hierarchy up` or `restart` do not carry.

Fix: the harness default is read from a repo setting first, the env var second. Add a `harness:` key to `.ai-sdlc/model-routing.yaml` (values `codex` or `claude`, default `codex` so no behaviour changes for adopters) read through the same resolver `reviewer-harness.ts` uses; `review-prepare.ts` reports which source set it. Set this repository's value to `claude` in the same PR. The existing env var keeps precedence as a per-run override. Document the key in `docs/operations/agent-governance-reference.md` next to the model table.

Out of scope: detecting quota exhaustion at runtime; changing the Codex agents themselves.

**Five-step review (requirements first).**
1. Requirement questioned: must the default live in a process env var? No: a repo setting is what every executor session reads without relaunch.
2. Deleted: the per-task reenter note that tells the executor to export the env var.
3. Simplified: one resolver reads yaml then env; no new file.
4. Accelerated: saves one review round and one reenter per task while Codex is out.
5. Automated: the setting applies on the next claim, no session relaunch.

## Acceptance Criteria

- [ ] `.ai-sdlc/model-routing.yaml` accepts `harness: codex | claude`; missing key means `codex`.
- [ ] `resolveReviewer()` uses the yaml value when `AI_SDLC_REVIEWER_HARNESS` is unset; the env var still wins when set.
- [ ] `review-prepare` logs the harness and its source (yaml or env).
- [ ] This repository's yaml sets `harness: claude`.
- [ ] Unit tests cover: no key + no env, key only, env overriding key.
- [ ] `docs/operations/agent-governance-reference.md` documents the key.
