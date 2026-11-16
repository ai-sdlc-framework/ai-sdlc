---
id: AISDLC-1293
title: 'Untrusted PR gate sandbox runs the Python and Go suites when a pull request changes sdk-python or sdk-go'
status: In Progress
assignee: []
created_date: '2026-11-16'
labels:
  - pipeline-cli
  - untrusted-pr-gate
  - enhancement
dependencies:
  - AISDLC-1291
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - pipeline-cli/src/cli/ucvg.ts
  - pipeline-cli/src/cli/ucvg.test.ts
  - .ai-sdlc/untrusted-pr-gate.yaml
  - .github/workflows/ai-sdlc-gate.yml
  - docs/concepts/untrusted-contributor-verification.md
priority: medium
dispatchable: true
dispatchableReason: 'Fork PR #2683 (2026-11-15) changed a Python file and stopped at stage 1 because `.py` is not an allowed file type. The operator decided on 2026-11-16 (decision rubric) that the allowed list stays as it is until the sandbox runs the Python and Go suites, and chose the fetch container design the same day. AISDLC-1291 builds that design for Node; this task extends it.'
---

## Description

**Gap.** The sandbox runs one command for every PR: the Node suite of the repository root. A change under `sdk-python/` or `sdk-go/` would be reported with test evidence that never exercised it.

- `buildDifferentialTestScript` in `pipeline-cli/src/pipeline/sandbox-runner.ts` has no branch per language or per path and no configuration key for a test command.
- The sandbox image has no Python and no Go toolchain.
- Trusted CI runs these suites in `.github/workflows/ai-sdlc-gate.yml`: job `test-python` (`pip install -e '.[dev]'`, then `pytest`, in `sdk-python`) and job `test-go` (`go test ./... -v -count=1` in `sdk-go` and in `sdk-go/operator`).
- `allowedMutationGlobs` in `.ai-sdlc/untrusted-pr-gate.yaml` holds only ts, tsx, js, jsx and md, so today such a PR stops at stage 1. `pyproject.toml`, `go.mod` and `go.sum` match no allowed entry, so an outsider PR cannot change Python or Go dependencies.

**Decision (operator, decision rubric, 2026-11-16).** Dependencies reach the sandbox through a fetch container with network that sees only the base tree, followed by the hardened run container without network (full record in AISDLC-1291). For other languages this means one stock image pinned by digest per language and no custom image.

**Shape.** The gate configuration lists extra suites. Each names the paths that trigger it, its image, its fetch command and its test command. The gate runs only what the PR needs (operator, 2026-11-16): a suite starts, fetch container included, only when the PR changes a file under its paths; the root Node suite starts only when the PR changes a file that belongs to no extra suite. The report passes only when every suite that ran passed on base and on head.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must outsider Python and Go changes be tested in the sandbox? Yes, the operator decided the allowed list widens only after they are. Must it be configurable? Yes: the directory names are this repository's, and adopters have others. 2. Deleted: nothing. 3. Simplified or optimised: reuse the two-container path of AISDLC-1291 unchanged; a suite is data, not code. 4. Accelerated: a suite whose paths are untouched does not start. 5. Automated: tests on selection, on the docker arguments and on the combined result.

- **Configuration.** `.ai-sdlc/untrusted-pr-gate.yaml` gains the key `sandboxSuites`: a list of entries with `name`, `paths` (globs), `image` (must be pinned by digest; a floating tag is refused at load), `workdir`, `fetch` and `test`. With the key absent, behaviour is exactly that of AISDLC-1291.
- **Entries added in this repository.** `python`: paths `sdk-python/**`, a `python:3.12` image by digest, fetch installs `.[dev]` into a virtual environment inside the fetch output, test runs `pytest`. `go`: paths `sdk-go/**`, a `golang:1.26` image by digest, fetch downloads the modules of `sdk-go` and `sdk-go/operator` into a module cache inside the fetch output, test runs `go test ./... -count=1` in both directories with the proxy off.
- **Runner.** For each selected suite: fetch container (network, base tree only, no diff, no secret), then run container with the same hardening arguments as the Node suite. Base suite, apply diff, head suite, as for Node.
- **Result.** `upstreamSuitePassed` is true only when every suite that ran passed on base; `newTestsPassed` likewise on head. The outputs name the suite that failed. No field is added to the report schema.
- **Docs.** `docs/concepts/untrusted-contributor-verification.md` documents `sandboxSuites` with the two entries as the example.

Out of scope: any change to `allowedMutationGlobs` or `protectedPaths` (a separate task, after this one is on `main`); coverage for Python and Go; ruff and mypy.

## Acceptance Criteria

- [ ] #1 With no `sandboxSuites` key, the docker arguments and the in-container script equal those produced before this change; a test covers it.
- [ ] #2 A diff that touches only `sdk-python/**` selects the `python` suite alone: no fetch container and no run container starts for Node or for `go`. A diff that touches only `orchestrator/**` starts Node alone. A diff that touches `orchestrator/**` and `sdk-go/**` starts Node and `go`. Tests cover the three cases.
- [ ] #3 A `sandboxSuites` entry whose `image` has no digest is refused when the configuration is loaded, with a message naming the entry; a test covers it.
- [ ] #4 Every run container of an extra suite carries `--network=none`, `--cap-drop=ALL`, `--read-only`, the seccomp option, `no-new-privileges` and `--user 65534:65534`; every fetch container receives no diff variable and no secret; tests assert both.
- [ ] #5 When one of two selected suites fails on head, `newTestsPassed` is false and the output names that suite; a test covers it.
- [ ] #6 `.ai-sdlc/untrusted-pr-gate.yaml` contains the `python` and `go` entries with images pinned by digest, and its `allowedMutationGlobs` and `protectedPaths` are unchanged.
- [ ] #7 `docs/concepts/untrusted-contributor-verification.md` documents `sandboxSuites`.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
