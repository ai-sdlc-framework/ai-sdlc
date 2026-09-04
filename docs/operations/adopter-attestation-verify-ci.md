# Adopter CI recipe — verifying a v6 attestation in a consumer repo (AISDLC-566)

AISDLC-554 made the DSSE attestation **signer** (`sign-attestation.mjs`)
reachable from a consumer/adopter repo — one that has the AI-SDLC plugin
installed but does not have this monorepo checked out. AISDLC-566 closes the
matching gap on the **verifier** side: `ai-sdlc-plugin/scripts/verify-attestation.mjs`
independently re-verifies a signed envelope in the adopter's own CI, without
depending on this monorepo's `scripts/` + sibling `orchestrator/dist/`.

## Trust boundary — read this before wiring the recipe

The verifier's job is to decide whether **untrusted PR content** should be
trusted. That means the runtime module the verifier imports to make that
decision must NOT itself come from the untrusted content being checked —
otherwise a malicious PR could commit its own forged runtime (or an
`orchestrator/dist/`-shaped tree, or a fake `node_modules/@ai-sdlc/orchestrator`)
and have the verifier import and trust it, reporting the PR's own forged
attestation as `status=valid` (or worse — `import()` executes the module,
so a malicious runtime is arbitrary code execution in your CI).

**This is why the verifier's resolution order is deliberately narrower than
the signer's.** `sign-attestation.mjs` (AISDLC-554) resolves a monorepo dev
path and a repo-local `node_modules` copy *first*, because the signer only
ever runs against content the operator already trusts (their own checkout).
`ai-sdlc-plugin/scripts/verify-attestation.mjs` runs against the PR HEAD
being verified, so it **only** trusts locations that live outside the
checkout:

1. `$CLAUDE_PLUGIN_DIR` / `$CLAUDE_PLUGIN_ROOT` node_modules — the plugin
   install on the CI runner, populated fresh by `install-runtime-deps.sh`
   from the plugin's pinned `runtimeDependencies`. Never derived from PR
   file content.
2. `node_modules` walking up from the verifier script's OWN on-disk
   location — the same plugin install, reached without the env vars (some
   CI/hook contexts don't inherit them).

Every resolved candidate is additionally hard-rejected if it turns out to
live inside the checked-out repo (even via a symlink), and no candidate is
ever exempt from the minimum-version guard. If no trusted copy is found,
the verifier **fails closed** (`status` is never printed as `valid`; exit
code `2`) rather than falling back to anything repo-local.

**Do NOT** `pnpm add -D @ai-sdlc/orchestrator` inside the repo being
verified and expect the verifier to use it — that copy lives inside
`repoRoot` and is deliberately never trusted, by design. If you want a
repo-pinned version, install it into a directory OUTSIDE the checkout (for
example, a separate `actions/checkout` step into a sibling directory, or a
global/user-level npm install on the runner) and point `$CLAUDE_PLUGIN_ROOT`
at it, or simply rely on the plugin's own zero-config install (below).

## Prerequisites

1. The plugin is installed (`.claude/plugins/ai-sdlc/` or wherever your
   Claude Code plugin cache lives), which declares `@ai-sdlc/orchestrator`
   as a `runtimeDependency` — `install-runtime-deps.sh` puts a copy in the
   plugin's own `node_modules/`, OUTSIDE the checked-out repo. This is the
   zero-config path and the one the recipe below relies on.
2. A committed `.ai-sdlc/trusted-reviewers.yaml` with the operator's public
   key(s) — the same file `/ai-sdlc execute` writes locally. This is the
   ONLY source of truth for which signing key is trusted; nothing the
   runtime module itself claims can override it (see the hostile-runtime
   regression tests in `ai-sdlc-plugin/scripts/verify-attestation.test.mjs`
   for the exact threat this guards against).
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

      # Install the AI-SDLC plugin's runtime dependency OUTSIDE the checkout
      # (e.g. via install-runtime-deps.sh into $CLAUDE_PLUGIN_ROOT, or your
      # own equivalent trusted-install step on the runner). Do NOT install it
      # into the checked-out repo's own node_modules — the verifier will not
      # trust a copy that lives inside the PR being verified (see "Trust
      # boundary" above).

      - name: Verify v6 attestation
        id: verify
        run: |
          node ai-sdlc-plugin/scripts/verify-attestation.mjs \
            --head "${{ github.event.pull_request.head.sha }}" \
            --base "${{ github.event.pull_request.base.sha }}"
        # Exit code: 0 on status=valid, 1 on status=invalid, 2 when no
        # trusted runtime could be resolved (fail closed) or on usage error.
        # `status=` and `reason=` are also printed to stdout for a status
        # check / PR comment step to parse if desired.
```

## What the script does

`ai-sdlc-plugin/scripts/verify-attestation.mjs`:

1. Resolves the `@ai-sdlc/orchestrator` runtime from a TRUSTED location
   only — see "Trust boundary" above for the full resolution order and
   rationale. Each candidate is version-gated against a minimum (`0.14.0`)
   so a stale copy can never silently win by directory position, and any
   candidate that resolves inside the checked-out repo is hard-rejected
   even if it otherwise looks legitimate. The resolved path is echoed to
   stderr for auditability.
2. Runs the SAME verification core (`ai-sdlc-plugin/scripts/verify-attestation-core.mjs`)
   this monorepo's own `.github/workflows/verify-attestation.yml` uses — the
   Merkle-transcript proof + trusted-key signature check for v6 envelopes,
   with fallback support for legacy v5/v4/v3 envelopes.
3. Prints `status=valid|invalid` and `reason=<detail>` to stdout, and exits
   `0` on valid / `1` on invalid / `2` when no trusted runtime could be
   resolved or on a usage error.

## Local dry run

```bash
node ai-sdlc-plugin/scripts/verify-attestation.mjs \
  --head "$(git rev-parse HEAD)" \
  --base "$(git merge-base origin/main HEAD)"
```

With no `--head`/`--base` (and no `PR_HEAD_SHA`/`PR_BASE_SHA` env vars —
the workflow's env-var contract also works, matching the in-repo CI
verifier), the script defaults to `git rev-parse HEAD` and
`git merge-base origin/main HEAD` in the current working directory. Local
dry runs from inside this monorepo will resolve the runtime via the
`ai-sdlc-plugin` package's own `node_modules` (if installed) or `$CLAUDE_PLUGIN_ROOT`
— NOT via `orchestrator/dist/` in the same checkout, since that path is
deliberately excluded from this driver's candidate list.
