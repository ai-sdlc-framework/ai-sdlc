---
id: AISDLC-748
title: >-
  init detects branch-protection availability and installs attestation-approval enforcement or the client-side merge gate
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - governance
  - orchestrator
dependencies:
  - AISDLC-747
references:
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Resolves DEC-0014 (operator, 2026-10-06). Background: an adopter repo initialized governance and merged 200+ PRs with two reviewer transcripts because init scaffolds attestation artifacts without enforcement; the earlier work shipped doctor and a disclosure only.

Decision: init enforces by default, chosen by runtime capability, never by guessing the plan.

1. If the branch-protection API is available (public repo, or paid plan): apply protection requiring the `ai-sdlc/pr-ready` check plus 1 approving review, and install the verify-attestation workflow that posts that approval (from the dependency listed), so merges block without a human wait.
2. If the protection call returns 403 (GitHub Free private repo): fall back to client-side enforcement. The framework's merge command refuses unless attestation verifies and checks are green, the hook keeps blocking direct agent merges, and doctor reports "enforcement: client-side only; the server cannot block a manual merge" as an error-level finding.

Both paths print exactly what was installed and the opt-out flag (`--no-branch-protection`); `--yes` follows the same detection. The attestation approval still posts on path 2.

Sequencing: lands after the attestation-approval workflow listed under dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] Tests cover both paths with a mocked API (200 and 403).
- [ ] Doctor output is tested for each path.
- [ ] Init output names the chosen path and the `--no-branch-protection` opt-out.
- [ ] `docs/operations/quality-gate.md` states the detect-and-fallback rule.
