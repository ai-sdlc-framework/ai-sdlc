---
id: AISDLC-88
title: >-
  CI marker hygiene: prevent [skip ci]-type tokens from leaking into commit
  messages and silently disabling workflows
status: Done
assignee: []
created_date: '2026-04-30 16:34'
updated_date: '2026-05-01 01:29'
labels:
  - bug
  - ci
  - developer-experience
  - follow-up
  - footgun
dependencies: []
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/agents/execute-orchestrator.md
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-87 -
      CI-side-attestor-GH-Action-signs-attestation-after-duplicate-review-approves-unblocks-remote-agents-external-contributor-PRs.md
      was modified after task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-04-30 during AISDLC-87 (CI-side attestor) merge. PR #99 had its workflows silently disabled because three of its commit messages contained the literal substring `[skip ci]` — not as instructions, but as discussion of the bug they were fixing.

GitHub Actions parses the COMMIT MESSAGE BODY for `[skip ci]` (and variants — `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`) as a substring match. Context doesn't matter. If the substring appears anywhere in any commit being pushed, ALL workflows for that push are skipped silently. No warning. No "Workflow skipped" notice. Just zero runs.

## How the token leaked into PR #99's commits (3 layers)

1. **Workflow YAML legitimately uses `[skip ci]`**: AISDLC-87 added a chore commit (CI-side attestor signs envelope + pushes back to PR branch). That commit needs `[skip ci]` to prevent infinite re-trigger of `ai-sdlc-review.yml`. Correct intended use of the marker.
2. **Dev commit body discussed the design**: developer subagent's commit body explained the workflow's `[skip ci]` mechanic using the literal token. Round-1 reviewer flagged the major bug ("`[skip ci]` also skips verify-attestation.yml"); round-2's fix commit body explained the fix, also referencing the literal token.
3. **`/ai-sdlc execute` Step 10 chore commit body** auto-generates iteration history ("Round 1 flagged a major `[skip ci]` issue; round 2 fixed it...") — pulled reviewer findings into the commit message verbatim.

Result: PR #99 had ZERO workflow runs after open. Diagnostic took ~30 min to identify (initially suspected workflow-file-modification approval gate, fork PR rules, vsajan-author misattribution).

## Fix layers (3 prevention points)

### A. `/ai-sdlc execute` Step 10 chore commit sanitization (MUST)
Before `git commit`-ing the chore commit, sed-replace any literal `[skip ci]`-family tokens in the body with safe alternatives. Same applies to the developer's commit message body if it's piped through.

Sanitization regex (case-insensitive):
- `\[skip ci\]` → `\`[skip ci]\`` (backtick-wrap; gh-actions parser ignores backtick-wrapped versions)
- `\[ci skip\]` → `\`[ci skip]\``
- `\[no ci\]` → `\`[no ci]\``
- `\[skip actions\]` → `\`[skip actions]\``
- `\[actions skip\]` → `\`[actions skip]\``

(Verify GH Actions actually ignores backtick-wrapped versions. If not, replace with `(skip-ci-marker)` style.)

### B. Developer + execute-orchestrator subagent rules (MUST)
Add explicit instruction to:
- `ai-sdlc-plugin/agents/developer.md`
- `ai-sdlc-plugin/agents/execute-orchestrator.md`

Wording: "NEVER write the literal `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, or `[actions skip]` substring in any commit message — even when discussing the marker. GitHub silently skips all workflows for the entire push when it sees these patterns. Use backtick-wrapped (`` `[skip ci]` ``) or paren-quoted (`(skip ci marker)`) when you need to reference the token."

### C. Pre-push hook check (NICE-TO-HAVE)
Add to `.husky/pre-push` (or new `scripts/check-skip-ci-marker.sh`):
- Scan commits being pushed via `git log $remote_ref..$local_ref`
- Pattern-match against the 5 magic tokens
- If found: WARN with the offending commit + line + suggest the escape pattern
- If found AND not in the legitimate workflow-managed chore-commit (e.g., the CI-side attestor's own commit): BLOCK with override flag `AI_SDLC_ALLOW_SKIP_CI_MARKER=1`

The legitimate workflow-managed chore commits (CI-side attestor) are the ONLY place `[skip ci]` should appear — they're authored by the bot identity, not human commits.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `ai-sdlc-plugin/commands/execute.md` Step 10 sanitizes commit message body before `git commit`. Sed-replace the 5 magic tokens with backtick-wrapped versions.
2. Developer subagent (`ai-sdlc-plugin/agents/developer.md`) prompt explicitly forbids the literal tokens in commit messages with the escape guidance.
3. Execute-orchestrator subagent (`ai-sdlc-plugin/agents/execute-orchestrator.md`) prompt has the same rule.
4. New script `scripts/check-skip-ci-marker.sh` (or extend `.husky/pre-push`): scans commits being pushed for the 5 magic tokens. Blocks with helpful error + override flag. Exempts the bot-authored CI-attestor chore commits.
5. Verify backtick-wrapping actually defeats the GH Actions parser (test in a throwaway PR or check GH docs). If backticks don't work, switch to `(skip-ci-marker)` style.
6. Regression test: a fixture commit message containing `[skip ci]` is rewritten cleanly by the sanitization step.
7. Regression test: pre-push hook blocks a push containing `[skip ci]` in non-bot commits.
8. Regression test: pre-push hook ALLOWS the bot-authored chore commit with `[skip ci]` (the legitimate use).
9. CHANGELOG entry under `ai-sdlc-plugin/CHANGELOG.md`.
10. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean. New code: 80%+ patch coverage.
11. Documentation in CLAUDE.md: short note explaining the footgun + the escape pattern, in the Git Flow section.

## Out of scope

- Removing the legitimate `[skip ci]` use in the CI-side attestor workflow (it's correct — needed to prevent infinite loop)
- Renaming the marker (it's GitHub Actions canonical syntax)
- Changing GitHub Actions' parser behavior (out of our control)

## References

- AISDLC-87 (the task that hit this footgun)
- PR #99 (the empirical case — 0 workflow runs until commit messages were rewritten via git filter-branch)
- GitHub Actions docs on `[skip ci]`: https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 ai-sdlc-plugin/commands/execute.md Step 10 sanitizes commit message body before git commit. Sed-replace the 5 magic tokens ([skip ci], [ci skip], [no ci], [skip actions], [actions skip]) with backtick-wrapped versions
- [x] #2 Developer subagent (ai-sdlc-plugin/agents/developer.md) prompt explicitly forbids the literal tokens in commit messages with the escape guidance
- [x] #3 Execute-orchestrator subagent (ai-sdlc-plugin/agents/execute-orchestrator.md) prompt has the same rule
- [x] #4 New script scripts/check-skip-ci-marker.sh (or extend .husky/pre-push): scans commits being pushed for the 5 magic tokens. Blocks with helpful error + override flag. Exempts the bot-authored CI-attestor chore commits
- [x] #5 Verify backtick-wrapping actually defeats the GH Actions parser (test in a throwaway PR or check GH docs). If backticks don't work, switch to (skip-ci-marker) style
- [x] #6 Regression test: a fixture commit message containing [skip ci] is rewritten cleanly by the sanitization step
- [x] #7 Regression test: pre-push hook blocks a push containing [skip ci] in non-bot commits
- [x] #8 Regression test: pre-push hook ALLOWS the bot-authored chore commit with [skip ci] (the legitimate use)
- [x] #9 CHANGELOG entry under ai-sdlc-plugin/CHANGELOG.md
- [x] #10 pnpm build && pnpm test && pnpm lint && pnpm format:check clean. New code: 80%+ patch coverage
- [x] #11 Documentation in CLAUDE.md: short note explaining the footgun + the escape pattern, in the Git Flow section
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Three-layer prevention against `[skip ci]`-family magic tokens silently disabling GitHub Actions workflows (the PR #99 footgun). Layer A: `/ai-sdlc execute` Step 10 sed-sanitizes the chore commit body, replacing all 5 magic tokens with paren-quoted equivalents (`[skip ci]` → `(skip ci marker)`). Layer B: developer + execute-orchestrator subagent prompts forbid the literal tokens and document the escape. Layer C: `scripts/check-skip-ci-marker.sh` pre-push gate rejects any commit body containing the tokens, exempting the bot-authored CI-attestor chore commits (production identity `ai-sdlc-ci-attestor[bot]` per `.github/workflows/ai-sdlc-review.yml`).

Empirical confirmation: backtick-wrapping does NOT defeat the GH Actions parser; paren-quoted form was chosen instead.

## Changes

- `scripts/check-skip-ci-marker.sh` (new): pre-push gate, exempts bot-author + chore-commit-subject combo
- `scripts/check-skip-ci-marker.test.mjs` (new): 18 unit tests including production-identity fixture
- `ai-sdlc-plugin/agents/developer.md`: Hard Rule 7 added (NEVER literal tokens; bot-author exemption named at production identity)
- `ai-sdlc-plugin/agents/execute-orchestrator.md`: Step 10 sed-sanitization + Hard Rule 8 mirror
- `ai-sdlc-plugin/agents/agents.test.mjs`: assertions for the new Hard Rules (round 3 broadened bot-identity regex)
- `ai-sdlc-plugin/CHANGELOG.md`: AISDLC-88 entry naming production `ai-sdlc-ci-attestor[bot]` identity
- `CLAUDE.md`: new `### CI marker hygiene (AISDLC-88)` subsection under `## Git Flow` documenting all 5 tokens + paren-quoted escape + backtick-wrapping caveat + script ref

## AC status

- ✓ All 11 ACs met across 3 iterations

## Verification

- `pnpm build` — clean
- `node --test scripts/check-skip-ci-marker.test.mjs` — 18/18
- `node --test ai-sdlc-plugin/agents/agents.test.mjs` — 32/32 (round 3 fixed regex regression)
- `pnpm test` (full workspace) — orchestrator 2884/2884, dashboard 126/126, dogfood 292/292, conformance 23/23, mcp-advisor 131/131
- `pnpm lint` clean, `pnpm format:check` clean
- 3 iterations of dev + 3 review rounds:
  - Round 1: code-reviewer flagged 1 MAJOR (wrong bot identity in allowlist) + 2 minor + 1 suggestion
  - Round 2: addressed identity + Hard Rule wording + CLAUDE.md note + production-identity test fixture; introduced 1 test regression (agents.test.mjs assertion still pinned legacy identity)
  - Round 3: broadened the agents.test.mjs assertion + updated CHANGELOG identity → all 3 reviewers APPROVED with 0 findings each
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Design decisions

- **Paren-quoted, not backtick**: backtick-wrapping does NOT defeat the GH parser (empirically confirmed); chose `(skip ci marker)` style instead
- **Bot identity = production not legacy**: allowlist matches BOTH `ai-sdlc-ci-attestor[bot]` (production, per ai-sdlc-review.yml) AND `github-actions[bot]` (kept as harmless fallback)
- **3 layers, not 1**: belt-and-suspenders defense — each layer catches different leak vectors (chore commit auto-generation, dev commit body, force-push)

## Follow-up

- Codex availability for true cross-harness independence (separate task track)
- The pre-existing `init-workspace.test.ts` env-pollution flake (CWD inheritance under parallel vitest workers) — unrelated to AISDLC-88, surfaced in adjacent runs
<!-- SECTION:FINAL_SUMMARY:END -->
