---
id: AISDLC-789
title: >-
  cli-merge-if-eligible merges trusted pull requests on governance paths; the sensitive paths go to the audit record
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - governance
  - merge
  - dec-0072
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.test.ts
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement DEC-0072 (answered `internal-only`, 2026-10-10). `cli-merge-if-eligible` currently refuses merge and arm for any PR that changes a governance-sensitive path (`isGovernanceSensitivePath`: `.ai-sdlc/`, `.github/`, `.husky/`, plugin hooks, agents, commands, scripts, the gate itself, the policy schema). The trust evaluation (`evaluatePrTrust`) runs before that check, so the refusal only ever stops trusted, allow-listed, same-repo PRs, the same pattern DEC-0054 removed for config edits. `auto-enable-auto-merge.yml` arms every same-repo PR with no path filter, so the refusal protects nothing the workflow does not already waive (AISDLC-663.5's own follow-up notes said so and named CODEOWNERS plus required review as the real, operator-only control).

Change: for a PR that passed the trust evaluation, a governance-sensitive change no longer refuses. The list of sensitive paths is recorded in the merge audit entry and printed in the eligibility reason, so `cli-decisions operator-digest` and the audit log show which merges touched governance paths. The fail-closed refusal when the changed-file list cannot be fetched or hits GitHub's 300-file cap stays. The 'no changed files' refusal stays. Untrusted PRs are unchanged (still refused by the trust check before this point). Update the governance docs (`docs/operations/decision-authority.md`, the merge section of `CLAUDE.md` if it mentions the human-merge rule) and the CLI help text.

Reversal: restore the refusal branch; DEC-0072 records this.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A trusted same-repo PR whose diff touches a governance-sensitive path is eligible to merge and to arm when green, CLEAN and attested (test for merge mode and arm mode).
- [ ] The eligibility reason and the audit record list the governance-sensitive paths the PR changes (test asserts the paths appear).
- [ ] An untrusted PR (fork head or author outside `mergeAuthors`) touching the same paths is still refused by the trust evaluation (existing test kept or extended).
- [ ] The refusal when the changed-file list cannot be fetched or reaches the 300-file cap is unchanged (existing test kept).
- [ ] `isGovernanceSensitivePath` and `governanceSensitiveChanges` remain exported and tested; no path is removed from the list.
- [ ] Docs: `docs/operations/decision-authority.md` and any CLAUDE.md sentence describing the human-merge refusal are updated to say governance paths are audited, not refused, for trusted PRs; DEC-0072 is cited.
