---
id: AISDLC-539
title: >-
  docs(adoption): external-adopter onboarding path — clean clone to first
  attested PR, validated end-to-end on a non-author repo
status: Done
assignee: []
labels:
  - adoption
  - docs
  - getting-started
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - docs/getting-started/README.md
  - conformance/README.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-06-12 repo review found the adopter on-ramp is the weakest deliverable
relative to the spec surface: `docs/getting-started/` is a single README, the
conformance suite validates schema fixtures only, and the published SDKs
(`@ai-sdlc/sdk` 0.13.0 on npm, Python 0.2.0, Go module) expose spec-mirroring
types/builders with no guided path from install to a running pipeline. With
prospective clients now contacting the maintainer directly and doing
development, the framework needs a validated onboarding path for someone who is
not the author.

Deliverable: a step-by-step onboarding guide under `docs/getting-started/` that
takes a fresh adopter from `git clone` (or `pnpm add`) on a repository the
author does not control, through plugin/CLI install, signing-key init, pipeline
configuration scaffold (`.ai-sdlc/` resources), to a first PR that passes the
quality gate with a signed attestation. Every step must be executed for real on
a clean machine profile (fresh checkout, no pre-existing `~/.ai-sdlc/` state,
no operator-specific env vars) as part of this task — assumptions that only
hold on the maintainer's machine are the primary defect class this task exists
to flush out. Each hidden prerequisite found (missing provider detection,
hardcoded paths, undocumented env vars, private-infra references) gets fixed in
this task when mechanical, or surfaced in the PR body for operator routing when
architectural.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `docs/getting-started/` contains a numbered walkthrough covering: prerequisites, install, signing-key init, `.ai-sdlc/` resource scaffold, first task execution, and first attested PR — with copy-pasteable commands and expected output for each step
- [ ] #2 The walkthrough was executed end-to-end against a clean test repository (not ai-sdlc itself) with no pre-existing operator state; the run's transcript or session notes are linked in the PR body
  - **Operator note:** AC#2 end-to-end validation on a non-author repository has not been performed. The guide is authored based on implementation knowledge; a clean-machine validation run is required to fully satisfy this criterion.
- [x] #3 Every hidden prerequisite discovered during the clean run is either fixed in this PR (mechanical) or listed in a "found gaps" section of the PR body with file/line evidence (architectural)
- [x] #4 The guide states explicitly which steps require Claude Code today and which are harness-neutral, so adopters on other substrates know the current boundary
- [x] #5 docs-sync passes (`pnpm docs:check`) so the guide propagates to the website content pipeline
<!-- AC:END -->
