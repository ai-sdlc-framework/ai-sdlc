/**
 * The adopter workflow templates `ai-sdlc init` scaffolded before the verdict
 * gate (RFC-0061, DEC-0284; AISDLC-1353), kept ONLY so init and `doctor` can
 * recognise a byte-identical old copy and replace it. Never written to a new
 * repository.
 */

export const LEGACY_AI_SDLC_GATE_WORKFLOW = `name: AI-SDLC PR Ready Gate

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
  # AISDLC-261 PR #480 review fix: include 'ready_for_review' so the gate
  # fires when adopters using the draft-PR flow (AISDLC-218) flip a PR
  # from draft to ready. Without it, ai-sdlc/pr-ready stays unposted on
  # the ready transition and branch protection fails.
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
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

export const LEGACY_VERIFY_ATTESTATION_WORKFLOW = `name: AI-SDLC Verify Review Attestation

# Reads the DSSE attestation at .ai-sdlc/attestations/<head-sha>.dsse.json
# and verifies the signature against any-of-N pubkeys in
# .ai-sdlc/trusted-reviewers.yaml.
#
# AUDIT-ONLY verify job: it logs verification results (success/failure with
# reason) for forensic purposes but does NOT post a required commit status.
# The single merge gate is \`ai-sdlc/pr-ready\` from ai-sdlc-gate.yml.
#
# The \`approve\` job (AISDLC-748.1) posts an APPROVE pull-request review ONLY
# after the verify job reported a fully valid envelope, so the 1 approving
# review that \`ai-sdlc init\` requires in branch protection is satisfied by a
# verified attestation and never by an unverified one. Trust boundary:
#   - Triggered by pull_request_target so the workflow definition, the trust
#     root (.ai-sdlc/trusted-reviewers.yaml) and the verifier all come from the
#     BASE branch. The PR head is never checked out: only its attestation
#     envelope and transcript leaves are copied in as untrusted data.
#   - The verifier is installed from npm into a directory outside the checkout.
#   - \`pull-requests: write\` is held only by the \`approve\` job, which runs no
#     repository code, only for same-repo (non-fork) non-draft PRs.
# Requires the repo setting "Allow GitHub Actions to create and approve pull
# requests" (Settings > Actions > General > Workflow permissions).

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'
  merge_group:
    types: [checks_requested]

concurrency:
  group: verify-attestation-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.event.merge_group.head_sha }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  verify:
    name: Verify attestation
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      status: \${{ steps.verify.outputs.status }}
      reason: \${{ steps.verify.outputs.reason }}
    env:
      # Exact version of the verifier installed from npm. Must be a PUBLISHED
      # version of both packages; bump it as part of the release procedure.
      AI_SDLC_CLI_VERSION: '0.31.0'
    steps:
      - name: Resolve subject SHA + base SHA from event payload
        id: resolve
        env:
          EVENT_NAME: \${{ github.event_name }}
          MG_HEAD: \${{ github.event.merge_group.head_sha }}
          MG_BASE: \${{ github.event.merge_group.base_sha }}
          PR_HEAD: \${{ github.event.pull_request.head.sha }}
          PR_BASE: \${{ github.event.pull_request.base.sha }}
          PR_HEAD_REPO: \${{ github.event.pull_request.head.repo.full_name }}
          REPO: \${{ github.repository }}
        run: |
          if [ "$EVENT_NAME" = "merge_group" ]; then
            echo "head_sha=$MG_HEAD" >> "$GITHUB_OUTPUT"
            echo "base_sha=$MG_BASE" >> "$GITHUB_OUTPUT"
            echo "head_repo=$REPO" >> "$GITHUB_OUTPUT"
          else
            echo "head_sha=$PR_HEAD" >> "$GITHUB_OUTPUT"
            echo "base_sha=$PR_BASE" >> "$GITHUB_OUTPUT"
            echo "head_repo=$PR_HEAD_REPO" >> "$GITHUB_OUTPUT"
          fi

      # BASE checkout only: the trust root and workflow definition are the
      # base branch's, never the PR's.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          ref: \${{ steps.resolve.outputs.base_sha }}
          persist-credentials: false

      - name: Fetch head objects and copy attestation data (untrusted data only)
        env:
          HEAD_SHA: \${{ steps.resolve.outputs.head_sha }}
          HEAD_REPO: \${{ steps.resolve.outputs.head_repo }}
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          # Authenticate the fetch (private repos) without persisting the token
          # in the repo config: it is passed per-invocation via an extraheader.
          auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\\n')"
          echo "::add-mask::$auth"
          git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \\
            fetch --no-tags --no-recurse-submodules "https://github.com/$HEAD_REPO.git" "$HEAD_SHA"
          [ "$(git rev-parse FETCH_HEAD)" = "$HEAD_SHA" ]
          for p in .ai-sdlc/attestations .ai-sdlc/transcript-leaves .ai-sdlc/transcript-leaves.jsonl; do
            if git cat-file -e "$HEAD_SHA:$p" 2>/dev/null; then
              git checkout "$HEAD_SHA" -- "$p"
            fi
          done

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22

      - name: Install trusted verifier (outside the checkout)
        id: runtime
        run: |
          set -euo pipefail
          home="$RUNNER_TEMP/ai-sdlc-verifier"
          mkdir -p "$home"
          cd "$home"
          npm init -y >/dev/null
          npm install --no-save --save-exact --ignore-scripts "@ai-sdlc/orchestrator@$AI_SDLC_CLI_VERSION" "@ai-sdlc/pipeline-cli@$AI_SDLC_CLI_VERSION"
          echo "home=$home" >> "$GITHUB_OUTPUT"

      - name: Verify attestation
        id: verify
        env:
          HEAD_SHA: \${{ steps.resolve.outputs.head_sha }}
          BASE_SHA: \${{ steps.resolve.outputs.base_sha }}
          VERIFIER_HOME: \${{ steps.runtime.outputs.home }}
        run: |
          set +e
          out=$(node "$VERIFIER_HOME/node_modules/@ai-sdlc/pipeline-cli/bin/cli-attestation.mjs" verify --head "$HEAD_SHA" --base "$BASE_SHA")
          set -e
          status=$(printf '%s\\n' "$out" | sed -n 's/^status=//p' | head -n 1)
          reason=$(printf '%s\\n' "$out" | sed -n 's/^reason=//p' | head -n 1 | tr -d '\\r' | cut -c1-300)
          echo "status=$status" >> "$GITHUB_OUTPUT"
          echo "reason=$reason" >> "$GITHUB_OUTPUT"
          echo "::notice::ai-sdlc attestation AUDIT — status='\${status:-none}' on $HEAD_SHA: $reason (audit-only, not blocking)"

  # Posts the approving review. Separate job: the review write scope is held
  # ONLY here. Runs only when the verifier reported \`valid\`, only on
  # pull_request_target, only for same-repo non-draft PRs, and executes no
  # repository code (no checkout).
  approve:
    name: Approve verified attestation
    needs: verify
    runs-on: ubuntu-latest
    if: >-
      needs.verify.result == 'success' &&
      needs.verify.outputs.status == 'valid' &&
      github.event_name == 'pull_request_target' &&
      github.event.pull_request.draft == false &&
      github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Post approving review
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          STATUS: \${{ needs.verify.outputs.status }}
          REASON: \${{ needs.verify.outputs.reason }}
        run: |
          set -euo pipefail
          marker='<!-- ai-sdlc-attestation-review -->'
          setting='Allow GitHub Actions to create and approve pull requests'
          [ "$STATUS" = "valid" ] || { echo "::notice::verification status is not valid; not approving"; exit 0; }
          # A soft-fail or spot-check "valid" skipped the Merkle proof: not a full verification.
          if printf '%s' "$REASON" | grep -qiE 'soft-fail|spot-check'; then
            echo "::notice::qualified verification (soft-fail or spot-check); not approving"
            exit 0
          fi
          printf '%s' "$HEAD_SHA" | grep -qE '^[0-9a-f]{40}$' || { echo "::error::invalid head sha"; exit 1; }

          reviews() {
            gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/reviews?per_page=100" \\
              --jq '.[] | select(.user.login == "github-actions[bot]" and (.body // "" | contains("'"$marker"'"))) | [.id, .state, .commit_id] | @tsv'
          }

          # Dismiss this workflow's own stale approvals (head moved).
          reviews | while IFS="$(printf '\\t')" read -r id state commit; do
            if [ "$state" = "APPROVED" ] && [ "$commit" != "$HEAD_SHA" ]; then
              gh api -X PUT "repos/$REPO/pulls/$PR_NUMBER/reviews/$id/dismissals" \\
                -f message="Superseded: head moved from \${commit:0:12} to \${HEAD_SHA:0:12}" >/dev/null \\
                || echo "review $id already dismissed or not dismissable"
            fi
          done

          # Idempotent per head SHA: re-list right before posting.
          if reviews | awk -F'\\t' -v sha="$HEAD_SHA" '$2 == "APPROVED" && $3 == sha { found = 1 } END { exit !found }'; then
            echo "::notice::already approved at $HEAD_SHA"
            exit 0
          fi

          summary=$(printf '%s' "\${REASON:-valid envelope at HEAD}" | tr -s '[:space:]' ' ')
          body="$marker
          AI-SDLC attestation verified for \\\`\${HEAD_SHA:0:12}\\\`.

          Verdict summary: $summary

          Posted by the Verify attestation workflow after the envelope verified against .ai-sdlc/trusted-reviewers.yaml on the base branch."
          if ! err=$(gh api -X POST "repos/$REPO/pulls/$PR_NUMBER/reviews" \\
            -f commit_id="$HEAD_SHA" -f event=APPROVE -f body="$body" 2>&1 >/dev/null); then
            if printf '%s' "$err" | grep -q '403'; then
              echo "::error::GitHub returned 403 when posting the approving review. Enable the repository setting \\"$setting\\" (Settings > Actions > General > Workflow permissions) and re-run."
            else
              echo "::error::$err"
            fi
            exit 1
          fi
          echo "Posted approving review at $HEAD_SHA"
`;

export const VERIFIER_WORKFLOW_PATH = '.github/workflows/verify-attestation.yml';
export const GATE_WORKFLOW_PATH = '.github/workflows/ai-sdlc-gate.yml';

export type LegacyWorkflowKind = 'retired-verifier' | 'gate-without-verdict-check';

export interface LegacyWorkflowFinding {
  kind: LegacyWorkflowKind;
  /** Project-relative path. */
  path: string;
  /** True when the file is byte-identical to the old template, so it is safe to replace. */
  pristine: boolean;
  /** What is wrong, with the lines to change when the file was edited. */
  detail: string;
}

/** Line numbers (1-based) matching `pattern`, as `N: text` entries. */
function matchingLines(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (pattern.test(line)) out.push(`line ${i + 1}: ${line.trim()}`);
  });
  return out;
}

const RETIRED_VERIFY_CALL = /cli-attestation\.mjs["']?\s+verify(\s|$)/;
const VERDICT_CHECK_JOB = /^ {2}verdict-check:\s*$/m;

/** Inspect the two workflow files; returns one finding per problem found. */
export function diagnoseLegacyWorkflows(
  read: (relPath: string) => string | null,
): LegacyWorkflowFinding[] {
  const findings: LegacyWorkflowFinding[] = [];

  const verifier = read(VERIFIER_WORKFLOW_PATH);
  if (verifier != null) {
    const pristine = verifier === LEGACY_VERIFY_ATTESTATION_WORKFLOW;
    const calls = matchingLines(verifier, RETIRED_VERIFY_CALL);
    if (pristine || calls.length > 0) {
      findings.push({
        kind: 'retired-verifier',
        path: VERIFIER_WORKFLOW_PATH,
        pristine,
        detail: pristine
          ? `${VERIFIER_WORKFLOW_PATH} runs the retired envelope verifier (\`cli-attestation verify\` always reports status=invalid, so its approve job never runs); it is byte-identical to the old template and safe to delete`
          : `${VERIFIER_WORKFLOW_PATH} calls the retired \`cli-attestation verify\` (${calls.join('; ')}). Delete the file: the merge gate reads the review verdict through the verdict-check job in ${GATE_WORKFLOW_PATH}`,
      });
    }
  }

  const gate = read(GATE_WORKFLOW_PATH);
  if (gate != null && !VERDICT_CHECK_JOB.test(gate)) {
    const pristine = gate === LEGACY_AI_SDLC_GATE_WORKFLOW;
    const needs = matchingLines(gate, /^\s+needs:\s*\[.*\]\s*$/);
    findings.push({
      kind: 'gate-without-verdict-check',
      path: GATE_WORKFLOW_PATH,
      pristine,
      detail: pristine
        ? `${GATE_WORKFLOW_PATH} has no verdict-check job, so the review verdict record is never read; it is byte-identical to the old template and safe to rewrite`
        : `${GATE_WORKFLOW_PATH} has no verdict-check job, so the review verdict record is never read. Add a \`verdict-check\` job that runs \`cli-attestation.mjs verdict-check --post-status\` (copy it from the scaffold: \`ai-sdlc init --add workflows --force\` in a scratch copy) and add \`verdict-check\` to the pr-ready \`needs:\` list${needs.length > 0 ? ` (${needs.join('; ')})` : ''}`,
    });
  }
  return findings;
}

export interface LegacyWorkflowIo {
  read: (relPath: string) => string | null;
  write: (relPath: string, contents: string) => void;
  remove?: (relPath: string) => void;
}

export interface LegacyWorkflowAction {
  finding: LegacyWorkflowFinding;
  /** `deleted` / `rewritten`: file replaced. `reported`: edited copy left unchanged. */
  outcome: 'deleted' | 'rewritten' | 'reported';
}

/**
 * Replace byte-identical old workflows (delete the verifier, rewrite the gate);
 * leave edited copies unchanged and report them. `newGate` is the current gate template.
 */
export function migrateLegacyWorkflows(
  io: LegacyWorkflowIo,
  newGate: string,
): LegacyWorkflowAction[] {
  return diagnoseLegacyWorkflows(io.read).map((finding) => {
    if (!finding.pristine) return { finding, outcome: 'reported' as const };
    if (finding.kind === 'retired-verifier') {
      if (!io.remove) return { finding, outcome: 'reported' as const };
      io.remove(finding.path);
      return { finding, outcome: 'deleted' as const };
    }
    io.write(finding.path, newGate);
    return { finding, outcome: 'rewritten' as const };
  });
}
