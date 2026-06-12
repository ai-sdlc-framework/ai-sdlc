---
id: AISDLC-534
title: >-
  fix(ci): classify human-authored .github/dependabot.yml (non-workflow config)
  as docs-only / skip-attestation so it doesn't require a full code-PR attestation
status: To Do
assignee: []
labels:
  - bug
  - ci
  - dx
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - scripts/is-docs-only-changeset.mjs
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/dependabot.yml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A **human-authored** PR that only changes `.github/dependabot.yml` (or other non-workflow
`.github/**` config) is currently classified as a **code PR** by the change-detection logic,
because `.github/dependabot.yml` is not in the docs-only paths-ignore set
(`spec/rfcs/**`, `docs/**`, `backlog/**`, root `*.md`). The `Attestation gate (code PRs)`
job then polls for `ai-sdlc/attestation: success` and FAILS the `ai-sdlc/pr-ready` rollup
because a config-only PR has no DSSE envelope.

Dependabot-AUTHORED PRs for the same file sail through via the
`Auto-approve automation PR (Dependabot)` bypass — but that bypass is keyed on the PR
author being dependabot, NOT on the file being config. So when a maintainer hand-authors a
superseding/remade config PR, the bypass is lost and the maintainer must run the entire
attestation reconcile (3 reviewers → emit-leaf → sign v6 → verify status=valid → push)
plus a fresh-worktree `pnpm install` + build of pipeline-cli AND orchestrator — heavyweight
overhead for a few lines of YAML.

**Motivating incident (2026-06-12 window):** PR #893 (react patch-version dependabot
`ignore:` block, a 19-line YAML addition that superseded the closed dependabot PR #876)
was blocked by `Attestation gate (code PRs)` for exactly this reason and required a full
manual v6 attestation to land.

**Fix direction (implementer confirms against the workflows):**
- Treat `.github/dependabot.yml` (and ideally other non-workflow `.github/**` config such as
  `.github/CODEOWNERS`, `.github/*.md`) as **docs-only / attestation-exempt** for the
  `verify-attestation.yml` + `ai-sdlc-review.yml` gates, so a config-only changeset
  short-circuits the same way `spec/rfcs/**` / `docs/**` / `backlog/**` do.
- The shared classifier is `scripts/is-docs-only-changeset.mjs` (used on `merge_group`)
  plus the `paths-ignore` lists on the `pull_request` triggers — update BOTH in lockstep so
  the PR-event path and the merge_group path agree (asymmetry between them is its own bug class).
- **Do NOT** exempt `.github/workflows/**` — actual workflow YAML is security-sensitive and
  MUST keep its gate. Scope the exemption tightly to non-executable config files.
- Add hermetic coverage to `scripts/is-docs-only-changeset.test.mjs` (or equivalent): a
  changeset touching only `.github/dependabot.yml` is docs-only; a changeset touching
  `.github/workflows/*.yml` is NOT docs-only; a mixed changeset (config + source) is NOT
  docs-only.

**Related:** AISDLC-484 (fix dead docs-only CI fast-path — same classification surface;
coordinate so the two don't conflict). The maintainer-config-needs-attestation gotcha is
captured in operator memory `feedback_human_authored_config_pr_needs_attestation`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A PR that changes ONLY `.github/dependabot.yml` is classified as docs-only / attestation-exempt and merges without requiring a DSSE attestation envelope (the `Attestation gate (code PRs)` job does not block it)
- [ ] #2 The exemption is applied consistently on BOTH the `pull_request` paths-ignore path and the `merge_group` inline `is-docs-only-changeset.mjs` path (no asymmetry)
- [ ] #3 `.github/workflows/**` remains a code-PR / attestation-required surface — workflow YAML is explicitly NOT exempted
- [ ] #4 A mixed changeset (config + any source/test file) is still treated as a code PR requiring attestation
- [ ] #5 Hermetic tests cover the dependabot-only (exempt), workflow-yml (not exempt), and mixed (not exempt) cases; lint + format clean
- [ ] #6 Coordinated with AISDLC-484 so the two docs-only-classification changes do not conflict
<!-- AC:END -->
