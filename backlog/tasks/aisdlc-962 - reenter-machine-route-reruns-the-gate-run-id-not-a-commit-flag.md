---
id: AISDLC-962
title: 'The reenter machine route reruns the resolved gate run id; gh run rerun has no --commit flag'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - reconciler
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
priority: medium
dispatchable: true
---

## Description

`reenter.ts` builds the machine route as `gh run rerun --failed --commit <sha>`, but `gh run rerun` takes a run id and has no `--commit` flag, so every machine-route reenter fails and falls back to a full executor re-entry (a complete review round that changes nothing). The reconciler was fixed to resolve the gate run id for its own reruns; the reenter path still carries the old command.

**Five-step review (requirements first).**
1. Requirement questioned: should the reenter path have its own rerun command? No; the reconciler already resolves the run id for the same head.
2. Delete: the `--commit` command in `reenter.ts`.
3. Simplify: reenter calls the shared run-id resolver and reruns that id with `--failed`.
4. Accelerate: a rate-limited red now costs one rerun instead of an executor round.
5. Automate: a test asserts the machine route issues `gh run rerun <id> --failed` and never a `--commit` argument.

## Acceptance Criteria

- [ ] The machine route reruns the resolved gate run id.
- [ ] A test covers the command shape; the fallback to executor re-entry happens only when no run id resolves.
