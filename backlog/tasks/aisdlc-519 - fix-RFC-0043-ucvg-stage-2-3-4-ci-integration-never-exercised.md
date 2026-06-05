---
id: AISDLC-519
title: 'fix(ci): harden RFC-0043 UCVG Stage 2/3→4 CI integration end-to-end (never exercised; 5 bugs found in live e2e)'
status: To Do
assignee: []
created_date: '2026-06-04'
labels:
  - rfc-0043
  - phase-7
  - ci
  - bug
  - security
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - .github/workflows/untrusted-pr-gate.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The AISDLC-514 e2e milestone run (on a real fork: `ai-sdlc-enterprise/ai-sdlc-ucvg-test`)
proved the UCVG gate has **never worked end-to-end**. Stages 2/3/4 were never exercised
on a real PR until this run, so the entire CI integration path — plus the AISDLC-514
OpenShell→Docker swap — is full of never-run bugs. The gate currently fail-closes on
**every** untrusted PR regardless of content (safe direction, but zero real security
signal), and cannot produce a valid attestation. AISDLC-514 AC#3 (benign passes + valid
attestation) and AC#4 (real adversarial blocking at the correct stage) are therefore
UNMET. "Send a live demo on any repo" is NOT yet a true statement.

Five distinct bugs were found. Three are already fixed + validated on the test fork's
`main` (the gate now reaches Stage 0/1 correctly there); two remain open.

### Validated fixes (already applied on the fork; port to ai-sdlc main + add tests)

- **Bug A — empty diff → Stage 1 fail-closes on everything.** The `pr-content` checkout
  (`.github/workflows/untrusted-pr-gate.yml`, BOTH occurrences) uses `ref: <head.sha>`
  with the default depth-1, so neither the base SHA nor `HEAD~1` exists; `git diff`
  returns empty; the gate fail-closes `abort-protected-path` with empty `offendingPaths`.
  Fix: add `fetch-depth: 0` to both `pr-content` checkouts.
- **Bug B — Stage 1 parse always fails.** The `ast-gate` CLI emits PRETTY-PRINTED
  multi-line JSON (`emit()` uses `JSON.stringify(result, null, 2)`), but the workflow
  parses `echo "$AST_OUTPUT" | tail -n1 | python3 json.load` — `tail -n1` grabs only the
  closing `}` → parse always fails → fallback `abort-protected-path`. Fix: parse the full
  stdout blob (drop `tail -n1`) in BOTH the GATE_OUTCOME and OFFENDING lines. (Alternative:
  make `emit()` write compact single-line JSON — but that affects other subcommands.)
- **Bug C — Stage 4 cannot start.** `actions/download-artifact` is pinned to
  `95815c38cf2ff2164869cbab79da8cef8384b0fb`, which is NOT a real commit (GitHub 422).
  Fix: use a real v4 SHA (e.g. `d3f86a106a0bac45b974a628896c90dbdf5c8093`).

### Open bugs (root-cause + fix here)

- **Bug D — Stage 2 Docker `sandbox-run` produces no unsigned report.** With A+B+C applied,
  the pipeline reaches Stage 2; `check-sandbox` reports Docker available (no degradation),
  the `Stage 2 — Run Docker sandbox` step reports success, but
  `.ai-sdlc/ucvg/reports/<pr>.unsigned.json` is never written → `report_artifact=''` →
  the upload step is skipped → Stage 4 fails with "Artifact not found:
  ucvg-unsigned-report-<pr>". Root cause not yet pinned — likely the real
  DockerSandboxDriver run (container lifecycle / differential test / inference.local proxy
  / reviewer call) fails inside `sandbox-run` under `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`.
- **Bug E — Stage 2 step masks the sandbox exit code.** The step runs
  `node … sandbox-run … 2>&1 | tee /tmp/sandbox-run.log`; the pipe's exit status is
  `tee`'s (0), so a real `sandbox-run` failure reports as step **success** (this hid Bug D
  and is a dangerous false-green at the per-stage level). Fix: capture the real exit code
  (`set -o pipefail`, or `PIPESTATUS[0]`, or write-then-tee) and fail the step on non-zero.

### Standing validation harness

`ai-sdlc-enterprise/ai-sdlc-ucvg-test` is a public fork of ai-sdlc configured for live e2e:
empty `allowlist.authors` (everyone untrusted), a throwaway `AISDLC_SIGNING_KEY_CONTENT`
secret + matching pubkey in `trusted-reviewers.yaml`, `AI_SDLC_UNTRUSTED_PR_GATE=1`,
`ANTHROPIC_API_KEY` set, all workflows disabled except the UCVG gate. Its `main` already
carries fixes A/B/C. Open PRs #1–#4 are vector fixtures. Use it to reproduce + validate D/E
without touching real ai-sdlc PR flow. (Rotate the test API key per operator instruction.)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Bugs A, B, C ported to `.github/workflows/untrusted-pr-gate.yml` on ai-sdlc main with the fixes described above.
- [ ] #2 Bug E fixed: the Stage 2 sandbox step propagates `sandbox-run`'s real exit code (no `| tee` masking) and fails closed on non-zero.
- [ ] #3 Bug D root-caused and fixed: a benign untrusted PR runs the real Docker sandbox + differential test + 3 reviewers and writes `.ai-sdlc/ucvg/reports/<pr>.unsigned.json`, which uploads + transfers to Stage 4.
- [ ] #4 A benign untrusted fork PR flows through all 4 stages and produces a v6 attestation that verifies `status=valid` + posts `ai-sdlc/untrusted-pr-gate: success` (AISDLC-514 AC#3, validated on the fork harness).
- [ ] #5 Adversarial fixtures block at the CORRECT stage with NON-EMPTY offending/finding evidence (not the empty-diff fallback): protected-path, lifecycle-script, action-injection at Stage 1; prompt-injection / credential-exfil / resource-exhaustion / report-forgery at Stage 2/3/4 (AISDLC-514 AC#4).
- [ ] #6 Add CI-integration coverage so these never-exercised paths can't silently regress: a workflow-level test asserting the diff computation, the JSON-parse, the artifact name/handoff contract, and the exit-code propagation.
- [ ] #7 Update `docs/operations/e2e-real-repo-runbook.md` + the AISDLC-513 conformance doc with the corrected (real, non-fallback) vector→stage→outcome evidence once green.
<!-- AC:END -->

## Notes

Discovered during the AISDLC-514 live e2e on 2026-06-04. The mocked hermetic tests +
AISDLC-513 fixtures could not catch these because they never ran the real workflow / real
Docker. This is the milestone earning its keep. The earlier "3/3 Stage-1 vectors proven"
claim from the live run was a false positive (all blocked via Bug A) and is retracted.
