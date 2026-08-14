---
id: AISDLC-554
title: >-
  fix(attestation): make the DSSE signer reachable outside the ai-sdlc monorepo
  so adopter repos can produce attestations
status: Done
assignee: []
labels:
  - attestation
  - adoption
  - plugin
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - ai-sdlc-plugin/plugin.json
  - orchestrator/package.json
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reported from a real adopter repo (`local-trades`, plugin 0.9.0) on 2026-08-14:
the review half of the pipeline runs, verdicts are written, the PR opens — and
no attestation is ever produced. Nothing errors, so the pipeline looks like it
completed.

Root cause: `sign-attestation.mjs` resolved the attestation runtime as
`<repoRoot>/orchestrator/dist/runtime/attestations.js` at two sites — a path
that exists ONLY inside the ai-sdlc monorepo. In any adopter repo it failed
with `Run pnpm --filter @ai-sdlc/orchestrator build first`, advice that cannot
succeed in a repo with no `@ai-sdlc` packages to build. This reproduced on the
cheapest possible invocation (`--print-content-hash`, which needs no signing
key), so it blocked before reaching any signing logic.

Verified against the published `@ai-sdlc/orchestrator@0.14.0` tarball rather
than a local build. Three independent blockers, only the first of which was in
the original report:

1. The hardcoded monorepo path above.
2. `@ai-sdlc/orchestrator/runtime` is absent from the package's `exports` map,
   so even correct module resolution returns `ERR_PACKAGE_PATH_NOT_EXPORTED`.
   The files ship in the tarball; only the door is locked.
3. The main barrel (`orchestrator/src/index.ts`) exports **zero** attestation
   symbols, so there is no alternate route.

Why the signer must not work around this by re-implementing canonicalization:
signing and verification deliberately share one codepath, so an envelope built
from a re-implementation would fail the real verifier **in a way that looks
like tampering**. Missing-runtime must fail loudly, never fall back.

Why this matters beyond convenience: the attestation is what makes "3 reviewers
approved this" checkable by someone who was not there. Without it an adopter
gets the review half and none of the provenance half — silently, which is the
worst property for a trust mechanism. A missing attestation is indistinguishable
from a repo that never ran reviews.

Review surfaced that the same monorepo-only assumption existed on a **second**
module, and that the zero-config claim had two further holes. All are fixed
here; none is deferred, because each independently reduces the fix to "works
only in the monorepo".

- **v6 is the DEFAULT schema** (AISDLC-409) and had its own hardcoded
  `<repoRoot>/pipeline-cli/dist/attestation/sign-v6.js`. Fixing only the v5 /
  `--print-content-hash` path would have left every adopter on the default path
  still broken, and pushed them toward `AI_SDLC_V5_LEGACY=1` — i.e. onto the
  weaker binding rather than the Merkle-transcript model.
- **`install-runtime-deps.sh` did not know about the new dependency.** Its
  idempotence early-exit and post-install verification were hardcoded to
  pipeline-cli + mcp-server, so an existing install would early-exit and never
  fetch orchestrator, then stamp its completion sentinel anyway.
- **The `@ai-sdlc/pipeline-cli` pin was `^0.10.0`,** which on a `0.x` caret can
  only ever resolve to `0.10.x` — and `0.10.0` does not ship
  `dist/attestation/sign-v6.js` at all. Verified by unpacking both tarballs.

### Scope

- Replace all three hardcoded call sites with one `runtimeModuleCandidates()`
  policy, ordered: monorepo build dir → repo `node_modules` walk-up →
  `$CLAUDE_PLUGIN_DIR`/`$CLAUDE_PLUGIN_ROOT` → `node_modules` walk-up from the
  script itself (git hooks do not inherit the plugin env vars).
- Declare `@ai-sdlc/orchestrator` in `plugin.json` `runtimeDependencies` and
  bump `@ai-sdlc/pipeline-cli` to `^0.14.0`; teach `install-runtime-deps.sh` to
  probe and verify the orchestrator runtime. This reuses the pattern
  `resolve-pipeline-cli.sh` already established for the classifier CLI.
- Add the `./runtime` subpath to the orchestrator `exports` map.
- Replace the misleading errors with ones naming every searched path and both
  remedies.
- Gate installed copies on a minimum version, so a stale ancestor
  `node_modules` cannot win by position and sign with drifted canonicalization.
- Echo the resolved module path to stderr — provenance-critical resolution
  should be auditable, not silent.

Resolution order is load-bearing: the monorepo build ranks first so a
contributor with a stale build still gets the build-me error rather than
silently signing with a different installed copy; a repo-pinned dependency
ranks above the plugin's copy so the repo being signed controls the version.

Deep file paths are used throughout, which bypasses the `exports` map — an
adopter with `@ai-sdlc/orchestrator` already installed can sign immediately,
without waiting for the release that ships item 3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [x] #1 A repo with `@ai-sdlc/orchestrator` in `node_modules` and no
      `orchestrator/` source tree signs successfully
- [x] #2 A `node_modules` hoisted above the repo root resolves
- [x] #3 The plugin's own copy resolves via `CLAUDE_PLUGIN_ROOT` with nothing
      installed in the repo
- [x] #4 The monorepo build wins over an installed copy; a repo-pinned copy
      wins over the plugin copy
- [x] #5 With the runtime absent everywhere, the signer exits non-zero, prints
      both remedies plus every searched path, and writes nothing to stdout
- [x] #6 `plugin.json` declares `@ai-sdlc/orchestrator` as a runtimeDependency
- [x] #7 New tests are mutation-sensitive: reverting the resolver to the
      pre-fix single candidate fails 5 of them
- [x] #8 The DEFAULT v6 signing path resolves outside the monorepo — proven
      against the real published `@ai-sdlc/pipeline-cli@0.14.0`, reaching live
      v6 signing logic rather than a module-not-found error
- [x] #9 `install-runtime-deps.sh` probes AND verifies the orchestrator
      runtime, so a pre-existing install cannot early-exit past it
- [x] #10 The pipeline-cli pin resolves to a version that actually ships
      `sign-v6.js` (`^0.10.0` could not)
- [x] #11 An installed copy below the minimum version is skipped, logged, and
      loses to a current copy
- [x] #12 The resolved module path is echoed to stderr, and the positive tests
      assert WHICH candidate won rather than merely that a hash appeared
- [x] #13 Tests are insulated from ambient `CLAUDE_PLUGIN_DIR`/`ROOT`:
      verified by re-running under a populated `CLAUDE_PLUGIN_ROOT` (2 failures
      without the fix, 28/28 with it)
- [x] #14 BOTH plugin manifests declare the new dependency — the top-level
      `plugin.json` and the marketplace-canonical
      `.claude-plugin/plugin.json` — with a test asserting they cannot drift
- [x] #15 A prerelease does not satisfy an equal release minimum
      (`0.14.0-beta.1` < `0.14.0`), per semver precedence
- [x] #16 A copy accepted without a readable `package.json` says so on stderr,
      so fail-open acceptance is distinguishable from a passed version check
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Verified empirically against the published 0.14.0 tarball: `dist/runtime/`
ships, `@ai-sdlc/orchestrator/runtime` returns `ERR_PACKAGE_PATH_NOT_EXPORTED`,
deep-path import returns the same, and a direct file-path import succeeds with
**zero** dependencies installed — `attestations.ts` imports only `node:crypto`,
`node:child_process`, and a sibling `git-env.js`.

`createRequire().resolve` is unusable here: it matches the `require` condition,
which this package's exports map does not define (import-only). A bare
`import()` is also wrong — it resolves relative to the script under
`~/.claude/plugins/`, never the repo being signed.

Review round 1 blocked this PR and was right to. Both the code and test
reviewers found defects that would each have shipped a fix that only appeared
to work: the default v6 path was still monorepo-only, the installer would never
have fetched the new dependency, the version pin could not reach a build that
contains the v6 signer, and the test harness leaked `CLAUDE_PLUGIN_ROOT` from
the ambient shell — which meant the negative resolution tests could stop
testing anything inside a plugin session. Every one is fixed in this PR rather
than filed forward.

Round 2 blocked on a defect that would have voided the whole fix for the
production path it was filed to unblock: the `runtimeDependencies` bump had
been applied to `ai-sdlc-plugin/plugin.json` but not to the sibling
`.claude-plugin/plugin.json`, which this repo's history treats as the
marketplace-canonical manifest. Both are now synced and a test enforces it.
Reconciling the manifests properly — they also differ in `hooks` — is
AISDLC-558.

The version gate is deliberately lenient when a candidate has no readable
`package.json`: it fails open to a load rather than blocking signing on
metadata, and now announces that on stderr so the audit trail distinguishes it
from a verified pass. Skew is a correctness concern, not a security boundary —
forgery still requires the operator's trusted key.

One review observation remains unresolved rather than closed: a reviewer saw a
single unexplained failure of the repo-pinned-vs-plugin precedence test, then
11 clean repeats. A further 30-run stress pass produced 0 failures (41+ clean
runs total). The likeliest explanation is that reviewer's own concurrent
mutation of the resolver during the run, but that is a hypothesis, not a
diagnosis — if this test ever fails in CI it should be treated as a real
ordering regression, not written off as flake.

This task closes only the signer-reachability half of the report. Three
reported gaps are deliberately NOT in scope and are filed separately:
AISDLC-555 (the pre-push hook and `check-attestation-sign.sh` are never shipped
or installed into adopter repos) and AISDLC-556 (Step 10 writes verdicts
without checking a signer is reachable, and the docs describe the hook as if it
already exists).
<!-- SECTION:NOTES:END -->
