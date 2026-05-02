---
id: AISDLC-143
title: Interactive ai-sdlc init wizard + scaffold ai-sdlc-gate.yml for adopters
status: Done
assignee: []
created_date: '2026-05-02 22:13'
labels:
  - adopter-facing
  - init
  - framework
  - follow-up
dependencies: []
references:
  - orchestrator/src/cli/commands/init.ts
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/quality-gate.md
  - 'memory: feedback_design_for_adopters_first.md'
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sub-5 of the AISDLC-140 quality-gate redesign. Per Q4(b) operator decision: `init` runs as an interactive wizard by default; `--yes` accepts prescriptive defaults non-interactively (CI/scripts).

## Wizard prompts
1. "Will this repo use Definition-of-Ready gates? [Y/n]" → if yes, scaffold dor-config.yaml + dor.yml workflows
2. "Do you want attestation infrastructure (audit-only)? [Y/n]" → if yes, scaffold trusted-reviewers.yaml stub + verify-attestation.yml + .ai-sdlc/attestations/ + husky pre-push sign hook
3. "Add review classifier for cost-optimized reviews? [Y/n]" → if yes, scaffold classifier configs + workflow wiring
4. "Recommended branch protection rule for main: required check 'ai-sdlc/pr-ready' + 'codecov/patch'. Apply now? [Y/n]" → if yes, gh api PUT to set the rule

## Always scaffolded (Q4 b — base set)
- pipeline.yaml, agent-role.yaml, quality-gate.yaml, autonomy-policy.yaml (existing 4)
- `.github/workflows/ai-sdlc-gate.yml` (NEW; the prescriptive aggregator)
- `docs/operations/quality-gate.md` recommendation pointer

## Acceptance criteria
1. `ai-sdlc init` (no flags) runs interactive wizard with prompts above
2. `ai-sdlc init --yes` accepts all defaults (Y to all) without prompting; suitable for CI
3. `--with-X` flags still work for explicit feature opt-in (`--with-dor`, `--with-attestation`, `--with-classifier`)
4. After wizard completes, prints a "next steps" summary including the operator action items (set GH secrets if attestation chosen, etc.)
5. Branch-protection-rule application uses gh api with explicit dry-run mode (`--dry-run` shows the JSON without applying)
6. Hermetic tests for each wizard branch (mock prompt input → assert correct files scaffolded)
7. Re-runnable: `ai-sdlc init --add dor` adds DoR feature to an already-initialized repo without duplicating existing files
8. Documentation updated: `docs/operations/init.md` (new) — adopter-facing guide

## Out of scope (separate follow-ups)
- Per-language workflow templates (Python/Go/Rust) — start with Node baseline + flag for adopters to customize
- Cross-CI provider support (CircleCI/GitLab) — GHA-only for now</description>
<acceptanceCriteria>["init runs interactive wizard by default", "init --yes accepts defaults non-interactively", "--with-X flags work for explicit opt-in", "Next-steps summary prints operator action items", "Branch-protection apply uses gh api with --dry-run mode", "Hermetic tests per wizard branch", "Re-runnable: ai-sdlc init --add dor extends existing init", "docs/operations/init.md adopter guide", ">=80% patch coverage"]</acceptanceCriteria>
</invoke>
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Interactive `ai-sdlc init` wizard with 4 prompts (DoR / attestation / classifier / branch-protection), `--yes` for non-interactive, `--with-X` flags for explicit opt-in, `--add <feature>` for idempotent extension. Embeds `ai-sdlc-gate.yml` template + 4 base yamls. Per Q4(b) + adopter-first stance.

## Verification
- 29 wizard tests + 6 e2e tests + 2 round-2 regression tests
- 95% coverage init-features.ts; 92% init.ts (>80% threshold)
- 3 reviews APPROVED (round 2 fixed 1 MAJOR + 2 SHOULD; deferred 3 minor follow-ups)

## Round 2 fixes
- MAJOR: runCommand execSync→execFileSync (word-splitting bug on macOS paths with spaces)
- process.exitCode=1 on requested-but-failed --with-branch-protection
- Removed dead-code addNormalized

## Follow-ups (deferred — code reviewer round 1 suggestions)
- #2: tmpfile leak (branch-protection-body.json under projectDir/.ai-sdlc/)
- #4: templates "exact copy" vs "derived" docblock
- #6: DoR ingress concurrency-group key collision across event types
<!-- SECTION:FINAL_SUMMARY:END -->
