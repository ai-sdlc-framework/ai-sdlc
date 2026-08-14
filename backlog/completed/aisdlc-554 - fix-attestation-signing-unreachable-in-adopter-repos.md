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

### Scope

- Replace both hardcoded call sites with one `loadAttestationRuntime(repoRoot)`
  resolver, ordered: monorepo build dir → repo `node_modules` walk-up →
  `$CLAUDE_PLUGIN_DIR`/`$CLAUDE_PLUGIN_ROOT` → `node_modules` walk-up from the
  script itself (git hooks do not inherit the plugin env vars).
- Declare `@ai-sdlc/orchestrator` in `plugin.json` `runtimeDependencies`, so
  `install-runtime-deps.sh` installs it into the plugin cache and adopters need
  to install nothing. This reuses the pattern `resolve-pipeline-cli.sh` already
  established for the classifier CLI.
- Add the `./runtime` subpath to the orchestrator `exports` map.
- Replace the misleading error with one that names every searched path and both
  remedies.

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

This task closes only the signer-reachability half of the report. Three
reported gaps are deliberately NOT in scope and are filed separately:
AISDLC-555 (the pre-push hook and `check-attestation-sign.sh` are never shipped
or installed into adopter repos) and AISDLC-556 (Step 10 writes verdicts
without checking a signer is reachable, and the docs describe the hook as if it
already exists).
<!-- SECTION:NOTES:END -->
