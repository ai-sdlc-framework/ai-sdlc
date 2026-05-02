/**
 * Embedded template strings scaffolded by `ai-sdlc init` (AISDLC-143).
 *
 * Why these live in code instead of being read from disk at runtime:
 *  - The orchestrator ships as an npm package; users `npm i -g
 *    @ai-sdlc/orchestrator` and run `ai-sdlc init` in a brand new repo.
 *    The `dist/` payload would not include arbitrary `*.yml` source
 *    fixtures unless we listed each one in `package.json#files` AND
 *    plumbed a `__dirname`-based loader through esm import-meta.url.
 *  - Embedded strings work identically when invoked via `node ./dist/...`
 *    from a checkout, via `npx @ai-sdlc/orchestrator init`, or via a
 *    pre-bundled binary, with no runtime filesystem dependency.
 *
 * Drift policy: when the canonical workflow at
 * `.github/workflows/ai-sdlc-gate.yml` (or the audit-only
 * `verify-attestation.yml`) is updated for adopters, mirror the change
 * here. The init-workspace test suite includes a smoke check that the
 * embedded copy at least parses as a YAML mapping; AISDLC-140 sub-3's
 * cutover memo will add a hard byte-equality assertion against the live
 * file once the framework's own copy stabilizes.
 *
 * Q-decisions baked into the templates:
 *  - Q1 (prescriptive default): the gate workflow is scaffolded
 *    unconditionally — every adopter gets `ai-sdlc/pr-ready` on day one.
 *  - Q3 (attestation = audit-only): verify-attestation template is the
 *    audit-only variant; signing infrastructure is opt-in via
 *    `--with-attestation`.
 *  - Q4(b) (interactive default with --yes escape hatch): see
 *    `init-features.ts` for the wizard wiring; this module just supplies
 *    the byte content.
 */

/** `.github/workflows/ai-sdlc-gate.yml` — single rollup PR-ready check. */
export const AI_SDLC_GATE_WORKFLOW = `name: AI-SDLC PR Ready Gate

# Single rollup status check \`ai-sdlc/pr-ready\` that aggregates every PR
# signal AI-SDLC adopters need into ONE branch-protection entry. Replaces
# the historical pattern of enumerating N required checks by name + app_id,
# which is brittle against path filters, [skip ci] tokens, matrix changes,
# and multi-app posters. See \`docs/operations/quality-gate.md\` for the
# full rationale.
#
# Industry pattern: \`re-actors/alls-green\` ("alls-green") is the de facto
# community fix; named adopters include aiohttp, attrs, conda, setuptools,
# pytest, pip-tools, Open edX, PyCA, PyPA, Mergify.

on:
  pull_request:
    types: [opened, synchronize, reopened]
  merge_group:
    types: [checks_requested]

concurrency:
  group: ai-sdlc-gate-\${{ github.event.pull_request.number || github.event.merge_group.head_sha || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: read
  checks: write

jobs:
  detect:
    name: Detect Changes
    runs-on: ubuntu-latest
    outputs:
      docs_only: \${{ steps.filter.outputs.docs_only }}
    steps:
      - uses: actions/checkout@v4
      - id: filter
        uses: dorny/paths-filter@v3
        with:
          predicate-quantifier: 'every'
          filters: |
            docs_only:
              - 'docs/**'
              - '*.md'

  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check

  build-test:
    name: Build & Test (Node \${{ matrix.node-version }})
    needs: detect
    if: needs.detect.outputs.docs_only != 'true'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test

  coverage:
    name: Coverage
    needs: detect
    if: needs.detect.outputs.docs_only != 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test:coverage

  pr-ready:
    name: ai-sdlc/pr-ready
    needs: [detect, lint, build-test, coverage]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Aggregate required signals
        uses: re-actors/alls-green@release/v1
        with:
          jobs: \${{ toJSON(needs) }}
`;

/**
 * `.github/workflows/verify-attestation.yml` — AUDIT-ONLY verifier.
 *
 * Per Q3 in /tmp/quality-gate-redesign-final.md, attestation infrastructure
 * is opt-in and audit-only. This workflow logs verification results to the
 * action run log but does NOT post a required-status check or block merges.
 * Operators who want to promote attestation to a hard gate can edit the
 * \`Log audit result\` step to write to commit statuses.
 */
export const VERIFY_ATTESTATION_WORKFLOW = `name: AI-SDLC Verify Review Attestation

# Reads the DSSE attestation at .ai-sdlc/attestations/<head-sha>.dsse.json
# and verifies the signature against any-of-N pubkeys in
# .ai-sdlc/trusted-reviewers.yaml.
#
# AUDIT-ONLY: this workflow logs verification results (success/failure with
# reason) for forensic purposes but does NOT post a required commit status.
# The single merge gate is \`ai-sdlc/pr-ready\` from ai-sdlc-gate.yml.

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'
  merge_group:
    types: [checks_requested]

concurrency:
  group: verify-attestation-\${{ github.event.pull_request.number || github.event.merge_group.head_sha }}
  cancel-in-progress: true

jobs:
  verify:
    name: Verify attestation
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Resolve subject SHA + base SHA from event payload
        id: resolve
        run: |
          if [ "\${{ github.event_name }}" = "merge_group" ]; then
            echo "head_sha=\${{ github.event.merge_group.head_sha }}" >> "$GITHUB_OUTPUT"
            echo "base_sha=\${{ github.event.merge_group.base_sha }}" >> "$GITHUB_OUTPUT"
          else
            echo "head_sha=\${{ github.event.pull_request.head.sha }}" >> "$GITHUB_OUTPUT"
            echo "base_sha=\${{ github.event.pull_request.base.sha }}" >> "$GITHUB_OUTPUT"
          fi

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ steps.resolve.outputs.head_sha }}

      - name: Log audit result
        env:
          HEAD_SHA: \${{ steps.resolve.outputs.head_sha }}
        run: |
          if [ -f ".ai-sdlc/attestations/\${HEAD_SHA}.dsse.json" ]; then
            echo "::notice::ai-sdlc attestation AUDIT — envelope present at \${HEAD_SHA}"
          else
            echo "::notice::ai-sdlc attestation AUDIT — no envelope on \${HEAD_SHA} (audit-only, not blocking)"
          fi
`;

/**
 * `.husky/pre-push` snippet that signs an attestation when one is missing
 * for the current HEAD. Installed when `--with-attestation` is opted in;
 * the actual `sign-attestation.mjs` script ships separately with the
 * orchestrator and is referenced by the canonical command stub here.
 *
 * Adopters typically already have a `.husky/pre-push` from their existing
 * tooling; the wizard appends our snippet behind a sentinel so we can
 * extend an existing hook without trampling user content.
 */
export const HUSKY_PREPUSH_SIGN_SNIPPET = `# ai-sdlc:attestation-sign-block
# Signs the DSSE attestation envelope for the current HEAD when verdict
# files exist. Skip with AI_SDLC_SKIP_ATTESTATION_SIGN=1.
if [ -z "\${AI_SDLC_SKIP_ATTESTATION_SIGN:-}" ] && [ -x "./scripts/check-attestation-sign.sh" ]; then
  ./scripts/check-attestation-sign.sh
fi
# end ai-sdlc:attestation-sign-block
`;

/**
 * `.ai-sdlc/trusted-reviewers.yaml` stub — empty allowlist with operator
 * instructions. The wizard scaffolds this so adopters have a single file
 * to receive contributor pubkey PRs into; bootstrap a contributor with
 * `/ai-sdlc init-signing-key` and append the printed YAML block.
 */
export const TRUSTED_REVIEWERS_STUB = `# Trusted contributor signing keys for review attestations.
#
# This file is a stub created by \`ai-sdlc init --with-attestation\`. Add
# entries by running \`/ai-sdlc init-signing-key\` on a contributor's
# machine and opening a PR that appends the printed YAML block below.
#
# Schema:
#   - identity:  free-form string (typically email or GitHub handle)
#   - machine:   free-form label (lets one identity register multiple keys)
#   - pubkey:    PEM-encoded ed25519 public key (multi-line block scalar)
#   - addedAt:   ISO 8601 date the entry was added
#   - addedBy:   GitHub handle of the maintainer who approved this entry's PR
#
# The verifier in CI uses a strict YAML format: every scalar value
# single-quoted; \`pubkey:\` is a \`|\` block scalar with each PEM line
# indented exactly 6 spaces; no tab characters anywhere.

reviewers: []
`;

/**
 * `.ai-sdlc/dor-config.yaml` stub — Definition-of-Ready rubric config.
 *
 * Mirrors the production DoR config used by the framework itself; ships
 * in warn-only mode so a fresh adopter does not get blocked by the rubric
 * while they tune it.
 */
export const DOR_CONFIG_STUB = `# Definition-of-Ready (DoR) gate configuration.
#
# The DoR rubric scores incoming issues + backlog tasks against seven
# criteria (binary-testable ACs, no wishlist markers, references resolve,
# bounded scope, surface named, done-state describable, no invisible
# dependencies). Failing the rubric posts a clarification comment on the
# issue / PR.
#
# Ships in warn-only mode by default — flip to 'enforce' after the soak
# window confirms the false-positive rate is low.

apiVersion: ai-sdlc.io/v1alpha1
kind: DorConfig
metadata:
  name: ai-sdlc-dor
spec:
  rubricVersion: v1
  evaluationMode: warn-only

  notifications:
    authorChannel: true
    # dedicatedChannel:
    #   slack: '#ai-sdlc-dor'

  staleness:
    warnAfterDays: 14
    closeAfterDays: 28
    closedLabel: 'closed-as-stale-dor'
`;

/** `.github/workflows/dor-ingress.yml` — minimal DoR ingress shim. */
export const DOR_INGRESS_WORKFLOW = `name: AI-SDLC DoR Ingress

# Wires the DoR rubric into the GitHub issue + PR lifecycle:
#   - issues:opened / issues:edited  → score the issue body, post the
#     idempotent clarification comment when needs-clarification.
#   - pull_request touching backlog/tasks/*.md → score the changed
#     task bodies (the in-repo equivalent of an issue).
#
# Ships in warn-only mode (see .ai-sdlc/dor-config.yaml). Flip the
# config's \`evaluationMode\` to \`enforce\` after the soak window.

on:
  issues:
    types: [opened, edited]
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'backlog/tasks/*.md'

concurrency:
  group: dor-ingress-\${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  evaluate:
    name: Evaluate against DoR rubric
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Evaluate DoR (placeholder — wire to your DoR runner)
        run: |
          echo "::notice::DoR ingress shim invoked. Wire pnpm --filter @ai-sdlc/pipeline-cli evaluate-dor here."
`;

/**
 * `.ai-sdlc/review-classifier.yaml` stub — cost-optimized review tiers.
 *
 * The actual classifier code ships via AISDLC-141 (a follow-up). For now
 * the wizard scaffolds the config stub + a pointer to the classifier
 * docs so adopters who opt in via `--with-classifier` are ready to flip
 * on the workflow once AISDLC-141 lands.
 */
export const REVIEW_CLASSIFIER_STUB = `# Review classifier configuration (AISDLC-141, follow-up).
#
# The review classifier inspects a PR diff and decides which review tier
# to invoke (cheap-pattern-match → mid-tier-LLM → full reviewer fan-out)
# to keep review costs bounded as PR volume grows.
#
# This file is a stub scaffolded by \`ai-sdlc init --with-classifier\`.
# The classifier runtime ships in AISDLC-141; until then this config is
# advisory only. See docs/operations/init.md for the migration path.

apiVersion: ai-sdlc.io/v1alpha1
kind: ReviewClassifier
metadata:
  name: default-classifier
spec:
  tiers:
    - name: cheap
      maxFilesChanged: 5
      maxLinesChanged: 50
      strategy: pattern-match
    - name: mid
      maxFilesChanged: 20
      maxLinesChanged: 500
      strategy: single-llm-pass
    - name: full
      strategy: full-reviewer-fanout
  routing:
    docsOnly: cheap
    testOnly: cheap
    default: mid
`;

/**
 * The set of feature templates exported as a single map so the wizard
 * dispatcher can iterate without each feature growing its own switch
 * statement.
 *
 * Each entry maps a relative path inside the target repo to the literal
 * bytes to write. Paths are POSIX-style; the writer joins them onto the
 * project dir using `node:path/join` which is platform-correct.
 */
export interface FeatureTemplateSet {
  /** Files under the project root keyed by relative POSIX path. */
  files: Record<string, string>;
}

export const DOR_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/dor-config.yaml': DOR_CONFIG_STUB,
    '.github/workflows/dor-ingress.yml': DOR_INGRESS_WORKFLOW,
  },
};

export const ATTESTATION_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/trusted-reviewers.yaml': TRUSTED_REVIEWERS_STUB,
    '.github/workflows/verify-attestation.yml': VERIFY_ATTESTATION_WORKFLOW,
    // The .gitkeep ensures the attestations dir is tracked in git so the
    // first PR's envelope lands cleanly without "directory does not exist"
    // errors from the signing script.
    '.ai-sdlc/attestations/.gitkeep': '',
  },
};

export const CLASSIFIER_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/review-classifier.yaml': REVIEW_CLASSIFIER_STUB,
  },
};

/**
 * Always-on baseline workflow templates (regardless of wizard answers).
 * Matches AC #4 in AISDLC-143: pipeline.yaml + agent-role.yaml +
 * quality-gate.yaml + autonomy-policy.yaml are scaffolded by `initProject`
 * (existing logic) and the gate workflow is scaffolded by this map.
 */
export const BASELINE_WORKFLOW_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.github/workflows/ai-sdlc-gate.yml': AI_SDLC_GATE_WORKFLOW,
  },
};
