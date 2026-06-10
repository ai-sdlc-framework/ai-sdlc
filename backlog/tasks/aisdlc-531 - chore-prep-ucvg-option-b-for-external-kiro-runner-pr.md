---
id: AISDLC-531
title: >-
  chore: prep UCVG Option B for the external Kiro-runner PR (allow-list runner
  path + enable AI_SDLC_UNTRUSTED_PR_GATE)
status: To Do
assignee: []
labels:
  - chore
  - security
  - ci:no-issue-required
dependencies: []
priority: medium
dispatchable: false
dispatchableReason: >-
  Operator-led security prep: the allow-list scope + flipping the untrusted-PR-gate
  feature flag are operator decisions tied to the arrival of the external Kiro PR
  (GitHub #870 / contributor Fridayana). Do not auto-dispatch.
references:
  - .ai-sdlc/untrusted-pr-gate.yaml
  - .github/workflows/untrusted-pr-gate.yml
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification-gate.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prep so the RFC-0043 untrusted-contributor PR gate (UCVG) actually VERIFIES the external
Kiro-runner contribution rather than hard-blocking it at Stage 1 — the "Option B" the
operator chose (run real external executable code through the sandbox + hardened reviewers
+ clean-room attestation, instead of rejecting it at the AST gate).

Context: external contributor Fridayana (GitHub #870) will submit a `KiroRunner` PR against
the runner seam landed in AISDLC-529 (`--runner` / `AI_SDLC_RUNNER_PLUGIN`). A runner is
executable code the orchestrator invokes, so UCVG's Stage-1 AST gate (allowed-globs) will
reject it as a protected/disallowed path unless we explicitly admit the runner contribution
path for sandbox review.

This task is the deliberate, operator-overseen config change to enable that — DO NOT enable
the gate broadly or before the Kiro PR is imminent.

Steps (operator-gated):
1. Decide + add the runner-contribution path(s) to `allowed-globs` in
   `.ai-sdlc/untrusted-pr-gate.yaml` — scoped NARROWLY to where a contributed runner lives
   (e.g. a dedicated `contrib/runners/**` dir, or the specific runner file path), NOT a broad
   source allow. The goal: the Kiro PR passes Stage 1 into Stage 2-4 sandbox verification.
2. Confirm the Stage-2 differential-test harness can actually exercise a runner contribution
   (today it is wired around the `ucvg-demo` fixture) so the hardened reviewers get real
   signal on the runner's own tests. Extend the harness if needed, or document the limitation.
3. Enable the gate for the test: `gh variable set AI_SDLC_UNTRUSTED_PR_GATE --body 1`
   (currently default-off per RFC-0043 §Migration Path). Decide scope: repo-wide vs only for
   the window of the Kiro PR.
4. Eyes-open note (record in the PR/decision): the sandbox prevents exfiltration DURING
   review (network=none + credential-withholding proxy), but a merged runner executes with
   REAL credentials on normal runs — so the hardened-reviewer verdict + clean-room attestation
   are the load-bearing gate for executable contributions. This is the intended UCVG test.
5. After the Kiro PR is resolved, decide whether to leave the gate enabled (promotion) or
   revert to default-off + remove the runner path from allowed-globs.

Cross-refs: AISDLC-529 (runner seam, merged), RFC-0043 (UCVG), the UCVG live-demo work
(fork harness, AQ2). The flag check + allowed-globs live in untrusted-pr-gate.yml /
untrusted-pr-gate.yaml.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The runner-contribution path is added to `allowed-globs` in `.ai-sdlc/untrusted-pr-gate.yaml`, scoped narrowly to where a contributed runner lives (not a broad source allow), so the Kiro PR passes Stage 1 into sandbox verification
- [ ] #2 The Stage-2 differential-test harness can exercise a runner contribution's own tests (or the limitation is documented), so Stage-3 hardened reviewers get real signal
- [ ] #3 `AI_SDLC_UNTRUSTED_PR_GATE` is enabled for the test window (`gh variable set AI_SDLC_UNTRUSTED_PR_GATE --body 1`), with the scope (repo-wide vs PR-window) decided + recorded
- [ ] #4 The executable-contribution risk note (sandbox protects during review; merged runner runs with real creds → reviewer verdict + attestation are the gate) is recorded in the PR/decision
- [ ] #5 A post-test plan is recorded: leave the gate enabled (promote) OR revert to default-off + remove the runner allow-list path after the Kiro PR resolves
<!-- AC:END -->
