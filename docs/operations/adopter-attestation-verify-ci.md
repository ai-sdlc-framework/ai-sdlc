# Adopter CI recipe — verifying a v6 attestation in a consumer repo (AISDLC-566)

AISDLC-554 made the DSSE attestation **signer** (`sign-attestation.mjs`)
reachable from a consumer/adopter repo — one that has the AI-SDLC plugin
installed but does not have this monorepo checked out. AISDLC-566 closes the
matching gap on the **verifier** side: `ai-sdlc-plugin/scripts/verify-attestation.mjs`
independently re-verifies a signed envelope in the adopter's own CI, without
depending on this monorepo's `scripts/` + sibling `orchestrator/dist/`.

## Prerequisites

1. The plugin is installed (`.claude/plugins/ai-sdlc/` or wherever your
   Claude Code plugin cache lives), which declares `@ai-sdlc/orchestrator`
   as a `runtimeDependency` — `install-runtime-deps.sh` puts a copy in the
   plugin's own `node_modules/`, so **you do not need to install anything
   yourself** for the zero-config path. If you'd rather pin the version your
   repo controls, `pnpm add -D @ai-sdlc/orchestrator` works too — a
   repo-pinned copy always wins over the plugin's own copy (see the
   resolution order below).
2. A committed `.ai-sdlc/trusted-reviewers.yaml` with the operator's public
   key(s) — the same file `/ai-sdlc execute` writes locally.
3. A committed DSSE envelope at `.ai-sdlc/attestations/<patch-id>.v6.dsse.json`
   (or the legacy v5/v4/v3 filename shapes) — produced by
   `sign-attestation.mjs` per the AISDLC-554 recipe.

## GitHub Actions recipe

```yaml
name: verify-attestation

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  verify-attestation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # full history — the verifier walks ancestor SHAs

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Whichever route your repo uses to install the AI-SDLC plugin's
      # runtime dependency. If you pinned it yourself:
      - run: pnpm add -D @ai-sdlc/orchestrator
      # ...or, if the plugin's own runtimeDependencies install step already
      # ran earlier in this job (zero-config path), skip this line — the
      # verifier will find the plugin copy via $CLAUDE_PLUGIN_ROOT / a
      # node_modules walk-up from the script itself.

      - name: Verify v6 attestation
        id: verify
        run: |
          node ai-sdlc-plugin/scripts/verify-attestation.mjs \
            --head "${{ github.event.pull_request.head.sha }}" \
            --base "${{ github.event.pull_request.base.sha }}"
        # Exit code: 0 on status=valid, 1 on status=invalid, 2 on usage error.
        # `status=` and `reason=` are also printed to stdout for a status
        # check / PR comment step to parse if desired.
```

## What the script does

`ai-sdlc-plugin/scripts/verify-attestation.mjs`:

1. Resolves the `@ai-sdlc/orchestrator` runtime **the same way**
   `sign-attestation.mjs` resolves it (AISDLC-554): monorepo dev path (not
   applicable outside this repo) → `node_modules` walk-up from the repo root
   → `$CLAUDE_PLUGIN_DIR` / `$CLAUDE_PLUGIN_ROOT` node_modules → `node_modules`
   walk-up from the script's own location. Each candidate is version-gated
   against a minimum (`0.14.0`) so a stale ancestor copy can never silently
   win by directory position. The resolved path is echoed to stderr for
   auditability.
2. Runs the SAME verification core (`ai-sdlc-plugin/scripts/verify-attestation-core.mjs`)
   this monorepo's own `.github/workflows/verify-attestation.yml` uses — the
   Merkle-transcript proof + trusted-key signature check for v6 envelopes,
   with fallback support for legacy v5/v4/v3 envelopes.
3. Prints `status=valid|invalid` and `reason=<detail>` to stdout, and exits
   `0` on valid / `1` on invalid / `2` on a usage or environment error (e.g.
   the runtime could not be resolved at all).

## Local dry run

```bash
node ai-sdlc-plugin/scripts/verify-attestation.mjs \
  --head "$(git rev-parse HEAD)" \
  --base "$(git merge-base origin/main HEAD)"
```

With no `--head`/`--base` (and no `PR_HEAD_SHA`/`PR_BASE_SHA` env vars —
the workflow's env-var contract also works, matching the in-repo CI
verifier), the script defaults to `git rev-parse HEAD` and
`git merge-base origin/main HEAD` in the current working directory.
