---
id: aisdlc-565
title: >-
  Attestation pre-push hook uses `set -o pipefail`, silently no-ops under dash
  /bin/sh (husky)
status: Done
priority: high
labels:
  - bug
  - attestation
  - aisdlc-555-followup
drift_log:
  - date: '2026-09-04'
    type: ref-deleted
    detail: 'Referenced file no longer exists: AISDLC-555'
    resolution: flagged
drift_checked: '2026-09-04'
---

## Description

The attestation-sign pre-push hook installer (`orchestrator/src/cli/commands/init-features.ts`,
fresh-hook branch, ~line 1714) writes the hook file with:

```
#!/usr/bin/env bash
set -euo pipefail

# ai-sdlc:attestation-sign-block
...
```

Husky v9 does **not** honour the hook's shebang — its generated `_/pre-push`
wrapper delegates via `sh -e "$s"`. On any adopter whose `/bin/sh` is **dash**
(the Debian/Ubuntu default), `set -o pipefail` is not a valid option, so the
hook aborts on line 2 (`set: Illegal option -o pipefail`) **before reaching the
sign block**. Result: the push proceeds and the attestation is silently never
signed — the exact failure the hook exists to prevent.

The regression e2e test `prepush-sign-snippet.test.ts` ("installs to
.husky/pre-push … and the hook RUNS on push") already reproduces husky v9
faithfully and catches this deterministically on dash-based CI runners.

The `HUSKY_PREPUSH_SIGN_SNIPPET` body itself is already pure POSIX sh (it uses
`[ … ]` tests, a `for` glob loop, and explicitly invokes `bash "$signer"` only
for the signer script). Only the generated **preamble** is non-portable.

## Scope

1. In `init-features.ts`, change the fresh-hook write (the `!adapters.exists(hookPath)`
   branch) preamble from `#!/usr/bin/env bash\nset -euo pipefail\n\n` to
   `#!/usr/bin/env sh\nset -eu\n\n`. `pipefail` is not used by the snippet, so
   dropping it loses nothing; `sh` + `set -eu` runs correctly under both dash
   and bash, and matches how husky actually invokes the hook.
2. Update any test helpers / fixtures that hard-code the old
   `#!/usr/bin/env bash\nset -euo pipefail` base-hook string so tests exercise
   the shipped shape (at minimum the `runSnippet` helper base string; grep the
   test file for `pipefail`).
3. Do NOT touch the snippet body or the append-path logic. Do not widen scope
   beyond the preamble portability fix.

## Acceptance Criteria

- [x] Fresh-install hook preamble is `#!/usr/bin/env sh` + `set -eu` (no `pipefail`).
- [x] `prepush-sign-snippet.test.ts` husky-real-push test passes when the hook is
      run under dash (`sh -e`), asserting the sign block is reached ("NO
      attestation signer" diagnostic appears).
- [x] Full `orchestrator` vitest suite passes.
- [x] No change to `HUSKY_PREPUSH_SIGN_SNIPPET` body or the existing-hook append path.
