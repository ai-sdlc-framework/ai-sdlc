---
id: AISDLC-1342
title: 'The release content check accepts the two SDK version constants and the Go SDK stays below 1.0'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - pipeline-cli
  - release
dependencies: []
references:
  - pipeline-cli/src/governance/release-merge.ts
  - pipeline-cli/src/governance/release-merge.test.ts
  - pipeline-cli/src/cli/release-content-check.ts
  - pipeline-cli/src/cli/release-content-check.test.ts
  - release-please-config.json
  - sdk-go/aisdlc.go
  - sdk-python/src/ai_sdlc/__init__.py
  - docs/operations/release-flow.md
priority: high
dispatchable: true
dispatchableReason: 'Bounded to one allowlist, one content rule, one release setting and their tests.'
---

## Description

**Gap.** The rolling release pull request (#2630) cannot land. Its `Release content allowlist` check fails, so the `ai-sdlc/pr-ready` rollup fails, and no release has gone out since 0.42.0. Fixes that adopters wait for (AISDLC-1255 tick timeout, AISDLC-1257 task-file commit before rebase) are on `main` and unreleased.

What was seen on 2026-11-19 (run 44450494994, head `4d230509`):

```
release content check failed: not release artifacts: sdk-go/aisdlc.go, sdk-python/src/ai_sdlc/__init__.py
```

**Cause (read from the source).**

- AISDLC-1303 (#2783, merged 2026-11-18) added `extra-files` to `release-please-config.json` for the two SDKs: `aisdlc.go` under `sdk-go` and `src/ai_sdlc/__init__.py` under `sdk-python`. Since then the release pull request rewrites one line in each file, the line that carries the `x-release-please-version` marker.
- `RELEASE_FILE_ALLOWLIST` in `pipeline-cli/src/governance/release-merge.ts:120-129` was not extended, so `nonReleaseFiles` reports both paths.
- `validateReleaseContent` (`release-merge.ts:493-520`) knows two content rules only: `tomlContentRefusal` for `.toml` and `jsonContentRefusal` for everything else. A `.go` or `.py` file has no rule, so adding the paths to the list alone would send them to the JSON rule and fail closed.

**Second finding, same pull request.** The release pull request proposes `sdk-go` 1.0.0 (from 0.9.0) because AISDLC-1306 and AISDLC-1307 are breaking changes and the `sdk-go` package has no pre-1.0 setting. DEC-0413 chose `reference-only`: "Reference names only in one 0.x release". A 1.0.0 tag contradicts that record.

**Shape.** The release pull request may change the two version constant files, and in each only the single marked version line. Any other change to those files is refused as today. The Go SDK takes a minor bump for a breaking change while it is below 1.0.

**Control.** The allowlist is a control on what a release pull request may contain. This change widens it by exactly two paths that `release-please-config.json` already declares as release files, and adds a content rule stricter than the path check: one marked line, a version value, nothing else. It follows AISDLC-1303, which is on `main`. Planner reading, class (a): it restores the release path that AISDLC-1303 broke and admits no file content that is not a version value.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the version constants must follow the release (AISDLC-1303), and the release pull request must stay limited to release artifacts; both stand. 2. Deleted: no new allowlist mechanism and no reading of `extra-files` at run time; two literal paths join the existing list. 3. Simplified or optimised: one content rule shared by both files, keyed on the `x-release-please-version` marker. 4. Accelerated: the release pull request goes green without a hand edit. 5. Automated: a test fails when `release-please-config.json` names an `extra-files` path that the allowlist lacks, so the next added file cannot block a release unseen.

- **Allowlist.** Add `sdk-go/aisdlc.go` and `sdk-python/src/ai_sdlc/__init__.py` to `RELEASE_FILE_ALLOWLIST`.
- **Content rule.** Add a marked-line rule next to `tomlContentRefusal`: base and head each hold exactly one line with the `x-release-please-version` marker, the head value on that line is a version value, and base and head are equal once that value is blanked. `validateReleaseContent` uses it for these two paths. Refusal texts name the file, in the style of the two existing rules.
- **Config agreement test.** A test reads `release-please-config.json` and asserts that every `extra-files` entry, joined to its package directory, is on the allowlist.
- **Go pre-1.0 setting.** Set `bump-minor-pre-major` to true for the `sdk-go` package in `release-please-config.json`, so the breaking changes of AISDLC-1306 and AISDLC-1307 release as 0.10.0.
- **Docs.** `docs/operations/release-flow.md` names the two version constant files among the files a release pull request changes, and says that a new `extra-files` entry needs an allowlist entry in the same change.

Out of scope: landing the release pull request (operator instruction, `--source-kind release`), any change to who may merge a release, and the Python SDK version policy.

## Acceptance Criteria

- [ ] #1 A test shows `nonReleaseFiles` returns nothing for a change set holding `sdk-go/aisdlc.go` and `sdk-python/src/ai_sdlc/__init__.py`.
- [ ] #2 A test shows the content rule accepts each file when only the marked version line changes to a version value.
- [ ] #3 Tests show the content rule refuses each file when another line changes, when the marked line is missing in base or head, when two marked lines exist, and when the new value is not a version value.
- [ ] #4 A test reads `release-please-config.json` and fails when an `extra-files` path is not on the allowlist.
- [ ] #5 `release-please-config.json` sets `bump-minor-pre-major` to true for `sdk-go`, and a test asserts it.
- [ ] #6 `docs/operations/release-flow.md` names the two files and the rule for a new `extra-files` entry.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
