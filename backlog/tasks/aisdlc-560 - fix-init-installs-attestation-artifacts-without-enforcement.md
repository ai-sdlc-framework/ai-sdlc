---
id: AISDLC-560
title: >-
  fix(init): stop installing review-attestation artifacts without enforcement,
  and add a doctor command that reports the gap
status: To Do
assignee: []
labels:
  - adoption
  - attestation
  - onboarding
  - ci:no-issue-required
priority: critical
dependencies: []
references:
  - ai-sdlc-plugin/hooks/session-start.js
  - .ai-sdlc/trusted-reviewers.yaml
  - .ai-sdlc/review-policy.md
  - docs/operations/quality-gate.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adopter report, 2026-08-16, from `ReliableGenius/local-trades`. Governance was
initialized 2026-07-11. In the two months since: **200+ PRs merged, 222 backlog
tasks completed, 2 reviewer transcripts total.** On one day alone roughly twenty
PRs merged with no reviewer run, including one adding a public Cloudflare Worker
endpoint that accepts POSTs and writes to a database.

The adopter did nothing wrong. Init installed every *artifact* of review
attestation and **no enforcement**:

| Installed | Not installed, not mentioned |
|---|---|
| `.ai-sdlc/review-policy.md` (repo-specific, detailed) | Any CI workflow gating on review |
| `.ai-sdlc/trusted-reviewers.yaml` with a real ed25519 key, marked LOAD-BEARING | Any local hook concerning review |
| `.ai-sdlc/transcripts/` convention | Any documentation saying enforcement is the adopter's job |
| `.ai-sdlc/agent-role.yaml` | |

`grep -rl "pr-ready|attestation|review-policy|trusted-reviewers" .github/workflows/ scripts/`
returns nothing across nine workflows.

**The core defect: a partial installation is indistinguishable from a working
one.** From inside the repo, a keyring holding a real signing key with `addedAt`
and `addedBy` is strong evidence attestation is operating, and nothing
contradicts it. There is no step visible to skip and no state to inspect that
would reveal the gap. It took two months and 200 PRs to notice, and it was
noticed by a human asking a question — not by any check.

The reporter's framing is the design constraint worth adopting wholesale:
**a keyring with no verifier is a promise the framework does not keep**, and
**an attestation that merely exists is a file an agent will create.**

### Scope

- Init must not leave attestation half-configured. Either install the
  enforcement (a CI check and/or a hook) or do not install the keyring and
  transcript convention that imply it. Pick one and make it explicit; the
  current middle state is the defect.
- Add `ai-sdlc doctor` (or equivalent status command) that inspects real state
  and reports gaps, e.g. "attestation artifacts present, no enforcement
  configured". The reporter notes this would have taken seconds at any point in
  two months.
- If enforcement is deliberately the adopter's job, say so in the repo the
  init writes into — not only in framework docs the adopter never opens.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 A freshly initialized repo either has working enforcement, or does
      not receive a keyring/transcript convention that implies it
- [ ] #2 `ai-sdlc doctor` reports attestation state accurately on: a fully
      configured repo, an artifacts-only repo, and a repo with neither
- [ ] #3 On the artifacts-only repo, doctor's output names the gap explicitly
      and gives the command that closes it
- [ ] #4 Verified against a repo OUTSIDE this monorepo — a worktree of this
      repo inherits monorepo state and is not a valid test
- [ ] #5 If enforcement remains adopter-owned, the init output and the
      generated repo files both say so
- [ ] #6 Hermetic tests cover doctor's three states
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Related: AISDLC-555 (ship + install the pre-push hook / `/ai-sdlc init`),
AISDLC-556 (warn when verdicts are written with no reachable signer),
AISDLC-557 (pipeline-cli unresolvable in marketplace installs). This task is the
onboarding half: those three fix mechanisms that are unreachable, this one fixes
an install that never wires them up and reports success anyway.

The reporter is building the gate locally as LT-276 — attestation bound to a
commit or diff hash so any later push invalidates it, CI failing rather than
warning, risk-based reviewer requirements with security review mandatory for
Worker endpoints, auth, database writes and money paths, and a clean review
still producing an attestation so silence and absence stay distinguishable.
That last property is worth stealing directly.
<!-- SECTION:NOTES:END -->
