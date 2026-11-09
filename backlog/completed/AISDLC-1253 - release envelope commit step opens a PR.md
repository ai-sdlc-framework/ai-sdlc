---
id: AISDLC-1253
title: 'The release workflow commits the signed MCP tarball envelope with an allowed commitlint scope and lands it through a PR, not a push to protected main'
status: Done
assignee: []
created_date: '2026-11-09'
labels:
  - ci
  - release
  - bug
dependencies: []
references:
  - .github/workflows/release.yml
  - commitlint.config.mjs
  - docs/operations/mcp-server-signing.md
  - .ai-sdlc/attestations/mcp-server-0.41.0.dsse.json
priority: high
dispatchable: true
dispatchableReason: 'Operator order 2026-11-09 01:3xZ ("file it"). Release run 42543610586 (v0.42.0) failed at its final step after every package had published; without the fix every release run ends red and no MCP tarball envelope reaches main.'
---

## Description

**Gap.** The `Commit signed MCP server tarball envelope` step of `.github/workflows/release.yml` (publish-npm job) went live with AISDLC-1245 (#2595, 2026-11-08), which made the sign step's soft-fail guard real so that the envelope output is now set. On its first live run (release 0.42.0, run 42543610586, 2026-11-09T01:14Z) the step failed twice over:

1. Its commit message is `chore(release): sign @ai-sdlc/plugin-mcp-server@<v> tarball DSSE envelope (AISDLC-439)`. `release` is not in the `scope-enum` of `commitlint.config.mjs`, and husky's `commit-msg` hook runs in the runner because `pnpm install` installs the hooks. The commit is rejected: `scope must be one of [reference, conformance, ..., plugin] [scope-enum]`.
2. Had the commit succeeded, the next line `git push origin HEAD:main` would be refused: `main` requires a pull request and enforces that for admins (branch protection, verified 2026-11-09). The 0.41.0 envelope reached main only because the operator signed it locally and opened PR #2577 by hand.

**Effect.** The publish job reports failure although every npm package published (pipeline-cli, orchestrator, plugin-mcp-server, reference, mcp-advisor 0.42.0 on the registry by 01:16Z). The signed envelope for 0.42.0 was written on the runner and discarded; `.ai-sdlc/attestations/mcp-server-0.42.0.dsse.json` is not on main. Every future release ends red the same way, which hides a real publish failure behind a known one.

**Shape.** The step commits with an allowed scope (`ci`), on a branch `ai-sdlc/mcp-envelope-<version>` pushed with the workflow token, and opens a PR against `main` with `gh pr create` whose title is the commit subject and whose body names the release tag and the run URL. The PR is armed with the sanctioned path `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm` run from the workflow (the release PR lane already trusts `release`). When a branch or PR with that name already exists the step is idempotent: it reuses the branch and skips the create. The step never pushes to `main`.

## Fix

**Five-step review (requirements first).**
1. Requirement questioned: AISDLC-439 set "a signed DSSE envelope for every published MCP server tarball lands in `.ai-sdlc/attestations/` on main". It stands; it never required a direct push to main, which branch protection forbids for everyone.
2. Deleted: the `git push origin HEAD:main` line and the assumption that the release bot may bypass protection. Nothing else to delete; the sign step is unchanged.
3. Simplified: one commit on one branch, one PR, armed by the same `cli-merge-if-eligible --source-kind release` path the release PR uses; no new merge mechanism.
4. Accelerated: the envelope lands minutes after publish without an operator signing it locally and opening a PR by hand, as for 0.41.0 (#2577).
5. Automated: a workflow test asserts the step's commit scope is in `commitlint.config.mjs`'s `scope-enum` and that `release.yml` contains no `push origin HEAD:main`.

## Acceptance Criteria

- [x] AC-1: the envelope step's commit subject uses a scope present in `commitlint.config.mjs` `scope-enum` (`ci`) and keeps `(AISDLC-439)` in the subject; a test in `.github/workflows/__tests__/` parses `release.yml` and `commitlint.config.mjs` and fails when any commit subject in `release.yml` uses a scope outside the enum.
- [x] AC-2: the step pushes the commit to `ai-sdlc/mcp-envelope-<version>` and opens a PR against `main` with `gh pr create` (title = commit subject; body names the release tag, package version and `${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`); the workflow has no `git push origin HEAD:main` anywhere; test on the workflow text.
- [x] AC-3: the step is idempotent: when the branch already exists on origin it force-with-lease pushes the rebuilt commit and when a PR for that branch is already open it skips `gh pr create`; when the envelope path already exists on `origin/main` the sign step's existing skip applies and this step does not run.
- [x] AC-4: the opened PR is armed from the workflow with `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm` with `AI_SDLC_CALLER_ROLE` set as the release lane expects; a refusal is logged as a `::warning::` and does not fail the job (the envelope PR waits for an operator).
- [x] AC-5: `permissions` of the publish-npm job include `pull-requests: write` and `contents: write` only as far as this step needs; nothing else widened.
- [x] AC-6: `docs/operations/mcp-server-signing.md` describes the branch + PR landing and names the manual recovery for a release whose envelope was lost (sign locally, open the same-named PR), replacing any text that says the bot pushes main.
- [x] AC-7: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Out of scope

Recovering the 0.42.0 envelope itself needs the signing key and is operator-only (class (c)); the operator signs locally and opens `ai-sdlc/mcp-envelope-0.42.0` as for 0.41.0 (#2577). This task makes 0.43.0 onward land unattended.

## Final Summary

## Summary
Fixed the round-1 finding. The envelope step now sets `HUSKY: '0'` and uses `--no-verify` on both the commit and the push, so husky hooks installed by `pnpm install` can't fail the step after the npm packages are published. I added a test assertion for all three.

## Changes
- .github/workflows/release.yml
- .github/workflows/__tests__/release-mcp-envelope-pr.test.mjs

## Design decisions
Resumed round, so I committed only and did not push. Build, lint and format:check passed. For `pnpm test` I saw only the truncated tail of the output, so "passed" rests on the overall command exiting 0. The envelope test file passes 5/5 when run on its own.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

