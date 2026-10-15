---
id: AISDLC-917
title: 'fix: decisions-sync commits under the repository git identity so the trust gate accepts the sync branch'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [bug, decisions, governance, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/decisions/remote-persist.ts, pipeline-cli/src/decisions/remote-persist.test.ts, pipeline-cli/src/governance/merge-if-eligible.ts]
priority: high
dispatchable: true
---

## Description

Every decisions-sync PR (branch `ai-sdlc/decisions-sync`, the catalog event log) is refused by the eligibility gate when dispatch tries to arm it with the `decisions-sync` source kind: `the head commit author is not linked to a GitHub account — refusing (cannot be determined)` (`merge-if-eligible.ts:842`). The cause is in the producer: `remote-persist.ts:420-422` commits with `-c user.name=ai-sdlc-decisions -c user.email=decisions@ai-sdlc.invalid`, a synthetic identity that no GitHub account can ever be linked to. The trusted `decisions-sync` source kind landed with the 895 work, but it cannot land anything while the head author fails the linked-account check. Observed on PR #1594 (head 4f2c504) on 2026-10-15; the operator had to be asked to land it by hand. DEC-0234 chose `repo-identity`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that catalog commits need a distinct synthetic author to be recognisable. Rejected: the branch name and the path under `.ai-sdlc/_decisions/events/` already identify them, and the author field is what the trust gate checks. 2. Deleted: the two `-c user.name` / `-c user.email` arguments in `remote-persist.ts`; the commit uses the repository's configured git identity, as every other commit the tooling makes (precedent: AISDLC-865/866 land dependency bumps under the repo identity). 3. Simplified: no trust-gate exception; `merge-if-eligible.ts` is unchanged. 4. Accelerated: decisions-sync PRs arm and land through the reconciler without an operator. 5. Automated: `remote-persist.test.ts` asserts the git invocation carries no `user.name`/`user.email` override and that the resulting commit author equals `git config user.name`/`user.email` of the fixture repo.

## Acceptance Criteria

- [ ] `remote-persist.ts` no longer passes `user.name` or `user.email` overrides to git; the decisions-sync commit author is the repository's configured identity.
- [ ] `remote-persist.test.ts` covers the author of a produced commit and fails if a synthetic identity is reintroduced.
- [ ] A unit test on the gate's author resolution shows the new author shape passes the linked-account check for the `decisions-sync` source kind (no live GitHub call).
- [ ] The existing open PR #1594 is not touched by this task; the next decisions-sync run supersedes its head and lands on its own.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Decision record: DEC-0234 (`repo-identity`). The alternative, a decisions-sync-only exception in the trust gate, was rejected as a weakening.
