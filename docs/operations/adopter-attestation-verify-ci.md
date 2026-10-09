# Adopter CI recipe — verifying a v6 attestation in a consumer repo (AISDLC-566 / AISDLC-575)

AISDLC-554 made the DSSE attestation **signer** (`sign-attestation.mjs`)
reachable from a consumer/adopter repo — one that has the AI-SDLC plugin
installed but does not have this monorepo checked out. AISDLC-566 closed the
matching gap on the **verifier** side for plugin-installed adopters. AISDLC-575
closes the LAST gap: a **plugin-less** verify entrypoint — `cli-attestation
verify`, published inside `@ai-sdlc/pipeline-cli` — for a consumer's CI that has
no Claude Code plugin installed at all, only Node and npm.

**Use the plugin-less recipe below unless you already have the plugin
installed in CI for other reasons** (in which case
`ai-sdlc-plugin/scripts/verify-attestation.mjs` also works and calls the exact
same verification code — see "Alternative: plugin-installed recipe" below).

## Recommended: one-line reusable workflow (AISDLC-757)

Add this to your repo and you are done. The workflow verifies the PR's
envelope against the **base branch's** trust roots, so a PR cannot edit the gate
it is judged by:

```yaml
name: verify-attestation
on:
  pull_request_target: # REQUIRED: the gate definition must come from the base branch
    branches: [main]
permissions:
  contents: read
jobs:
  verify-attestation:
    uses: ai-sdlc-framework/ai-sdlc/.github/workflows/consumer-verify-attestation.yml@<pinned-commit-sha>
    with:
      ai-sdlc-ref: <pinned-commit-sha> # the SAME 40-hex SHA as above
```

Pin the SHA in **both** places: the `uses:` ref pins the workflow, and
`ai-sdlc-ref` pins the tooling (action, materialize script, policy-floor check,
docs-only classifier) checked out beside it. `ai-sdlc-ref` is required, has no
default, and the job fails closed unless it is a full 40-hex commit SHA. The job
also fails first unless the caller is triggered by `pull_request_target`.

Optional inputs: `pipeline-cli-version` (an **exact pin**, `x.y.z`, of the
installed `@ai-sdlc/pipeline-cli` / `@ai-sdlc/orchestrator`, default `0.29.0`;
no caret or range is applied) and `required-independence-tier`
(`none|attested|isolated`, a floor on your base policy's `requiredTier`).

**Docs-only exemption set.** Consumers inherit ai-sdlc's docs-only exemption
(`scripts/is-docs-only-changeset.mjs` from the pinned tooling): a PR whose every
changed path is a root `*.md` (including `CLAUDE.md` and `AGENTS.md`), under
`docs/`, `spec/rfcs/`, `backlog/tasks/`, `backlog/completed/`,
`.ai-sdlc/_decisions/`, or an envelope file skips verification. The changed-path
list is the merge-base diff with rename detection off, so renaming a source or
workflow file into `docs/` still counts as touching the source path. Consumers
cannot supply narrower patterns today.

What it does, in order: checks out the **base** sha only (`persist-credentials:
false`, `contents: read`); fetches the head as git objects without checking it
out and fails closed if the fetched sha differs from the event head sha; copies
only the envelope and transcript leaves from head, as untrusted data, through
`materialize-head-data.mjs` (refuses symlinks and path escapes); keeps
`.ai-sdlc/trusted-reviewers.yaml` and the policy files from base; and runs the
docs-only classifier, `cli-attestation verify` and `cli-attestation
independence-policy` from trusted tooling, never from the PR. PR values reach
scripts only through `env:`.

**Independence enforcement.** `cli-attestation independence-policy` is the
consumer-CI entrypoint for independence enforcement: it runs the same verifier
as `verify`, then compares the envelope's tier with `requiredTier` in your
`.ai-sdlc/independence-policy.yaml`. Do not parse `verify` stdout and do not
write a bespoke tier-comparison script; the exit code is the gate.

If you cannot use `workflow_call` (for example you need extra steps in the same
job), use the composite action
`ai-sdlc-framework/ai-sdlc/.github/actions/verify-attestation-base@<sha>` after
your own base-sha checkout; it takes the same inputs plus `base-sha`,
`head-sha`, `head-repository` and `github-token`.

The rest of this page documents the hand-written job, which is the **fallback**
for cases neither the workflow nor the action fits. Note it runs under
`pull_request` and therefore lets the PR edit its own gate unless you replicate
the base-only hardening above.

## Trust boundary — read this before wiring the recipe

The verifier's job is to decide whether **untrusted PR content** should be
trusted. That means the runtime/verifier modules it imports to make that
decision must NOT themselves come from the untrusted content being checked —
otherwise a malicious PR could commit its own forged runtime (or an
`orchestrator/dist/`-shaped tree, or a fake `node_modules/@ai-sdlc/orchestrator`)
and have the verifier import and trust it, reporting the PR's own forged
attestation as `status=valid` (or worse — `import()` executes the module,
so a malicious runtime is arbitrary code execution in your CI).

**This is why the verifier's resolution order is deliberately narrower than
the signer's.** `sign-attestation.mjs` (AISDLC-554) resolves a monorepo dev
path and a repo-local `node_modules` copy *first*, because the signer only
ever runs against content the operator already trusts (their own checkout).
`cli-attestation verify` and `ai-sdlc-plugin/scripts/verify-attestation.mjs`
run against the PR HEAD being verified, so they **only** trust locations that
live outside the checkout:

1. `$CLAUDE_PLUGIN_DIR` / `$CLAUDE_PLUGIN_ROOT` node_modules — present when
   running inside a Claude Code plugin session; irrelevant for a plain CI job.
2. `node_modules` walking up from the resolver's OWN on-disk location — for
   `cli-attestation verify` this means `@ai-sdlc/orchestrator` installed as a
   normal sibling npm dependency alongside `@ai-sdlc/pipeline-cli`, never
   derived from the PR checkout under verification.

Every resolved candidate is additionally hard-rejected if it turns out to
live inside the checked-out repo (even via a symlink), and no candidate is
ever exempt from the minimum-version guard. If no trusted copy is found,
the verifier **fails closed** (`status` is never printed as `valid`; exit
code `2`) rather than falling back to anything repo-local or re-implementing
canonicalization.

**Do NOT** rely on the PR's own committed `package.json`/lockfile to pin the
runtime version, and don't expect a copy installed *inside* the checkout
being verified to be trusted — install the runtime as a normal dependency of
your CI job's OWN environment (e.g. a separate `npm install` step that isn't
part of the diff under review), matching the "install the pinned runtime,
don't rely on PR-committed runtime" rule from AISDLC-566/570.

## Prerequisites

1. Node ≥ 18 on the CI runner. No Claude Code plugin required.
2. `@ai-sdlc/orchestrator` and `@ai-sdlc/pipeline-cli` installed as pinned
   dependencies (`^0.19.0` or later) — see the recipe below. Both must be
   installed OUTSIDE the untrusted PR checkout's own tree (a separate
   `npm install` step, not something the PR's `package.json` controls).
3. A committed `.ai-sdlc/trusted-reviewers.yaml` with the operator's public
   key(s) — the same file `/ai-sdlc execute` writes locally. This is the
   ONLY source of truth for which signing key is trusted; nothing the
   runtime module itself claims can override it (see the hostile-runtime
   regression tests in `ai-sdlc-plugin/scripts/verify-attestation.test.mjs`
   for the exact threat this guards against).
4. A committed DSSE envelope at `.ai-sdlc/attestations/<patch-id>.v6.dsse.json`
   (or the legacy v5/v4/v3 filename shapes) — produced by
   `sign-attestation.mjs` per the AISDLC-554 recipe.

## Fallback: hand-written GitHub Actions job (plugin-less, AISDLC-575)

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

      # Install the TRUSTED runtime + verify-core into a directory OUTSIDE
      # the checked-out repo — e.g. a sibling directory, not `${{ github.workspace }}`.
      # This is what makes both packages resolve from a TRUSTED location per
      # the "Trust boundary" section above; do NOT `npm install` them into
      # the checkout being verified.
      - name: Install trusted verifier runtime
        working-directory: /tmp
        run: |
          mkdir -p ai-sdlc-verifier && cd ai-sdlc-verifier
          npm init -y >/dev/null
          npm install --no-save '@ai-sdlc/orchestrator@^0.19.0' '@ai-sdlc/pipeline-cli@^0.19.0'
          echo "AI_SDLC_VERIFIER_HOME=/tmp/ai-sdlc-verifier" >> "$GITHUB_ENV"

      - name: Verify v6 attestation
        id: verify
        run: |
          node "$AI_SDLC_VERIFIER_HOME/node_modules/@ai-sdlc/pipeline-cli/bin/cli-attestation.mjs" verify \
            --head "${{ github.event.pull_request.head.sha }}" \
            --base "${{ github.event.pull_request.base.sha }}"
        # Exit code: 0 on status=valid, 1 on status=invalid, 2 when no
        # trusted runtime could be resolved (fail closed) or on usage error.
        # `status=` and `reason=` are also printed to stdout for a status
        # check / PR comment step to parse if desired.
```

The `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DIR` candidate is irrelevant here
(unset) — resolution falls through to the `node_modules` walk-up from the
bin's own on-disk location, which is inside `/tmp/ai-sdlc-verifier/node_modules/`,
never the checked-out PR.

## What `cli-attestation verify` does

1. Resolves the `@ai-sdlc/orchestrator` runtime from a TRUSTED location
   only — see "Trust boundary" above for the full resolution order and
   rationale. Each candidate is version-gated against a minimum (`0.19.0`)
   so a stale copy can never silently win by directory position, and any
   candidate that resolves inside the checked-out repo is hard-rejected
   even if it otherwise looks legitimate. The resolved path is echoed to
   stderr for auditability.
2. Runs the SAME verification core — `verify-core.mjs`, shipped inside
   `@ai-sdlc/pipeline-cli` at `attestation-core/verify-core.mjs` — that this
   monorepo's own `.github/workflows/verify-attestation.yml` and the
   plugin-installed driver both use. One implementation, three callers: the
   Merkle-transcript proof + trusted-key signature check for v6 envelopes,
   with fallback support for legacy v5/v4/v3 envelopes.
3. Prints `status=valid|invalid` and `reason=<detail>` to stdout, and exits
   `0` on valid / `1` on invalid / `2` when no trusted runtime could be
   resolved or on a usage error.

## Local dry run

```bash
node pipeline-cli/bin/cli-attestation.mjs verify \
  --head "$(git rev-parse HEAD)" \
  --base "$(git merge-base origin/main HEAD)"
```

(From inside a checkout with `@ai-sdlc/orchestrator` reachable via
`node_modules` walk-up from the bin's own location — this monorepo's own
workspace `node_modules` symlinks satisfy that automatically after `pnpm
install`.)

## Alternative: plugin-installed recipe (AISDLC-566)

If your CI already has the AI-SDLC Claude Code plugin installed (for the
review/dispatch pipeline itself), `ai-sdlc-plugin/scripts/verify-attestation.mjs`
is a zero-extra-install alternative — it resolves BOTH the orchestrator
runtime and the (now pipeline-cli-hosted) verify-core module from the
plugin's own `node_modules`, populated by `install-runtime-deps.sh` from the
plugin's pinned `runtimeDependencies`:

```yaml
      - name: Verify v6 attestation
        id: verify
        run: |
          node ai-sdlc-plugin/scripts/verify-attestation.mjs \
            --head "${{ github.event.pull_request.head.sha }}" \
            --base "${{ github.event.pull_request.base.sha }}"
```

Both drivers call the identical `verify-core.mjs` — there is only one
verification implementation, single-sourced inside `@ai-sdlc/pipeline-cli`
(AISDLC-575); pick whichever entrypoint matches what's already installed in
your CI environment.
