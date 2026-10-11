/**
 * Review-scope classification (AISDLC-723, DEC-0055).
 *
 * Path-based classification of a diff into `test-only`, `docs-adjacent` or
 * `full`, plus the reviewer roles an attestation must carry for each class.
 *
 * ONE implementation, two consumers, so they cannot drift:
 *   - the signer side (`pipeline-cli/src/steps/reviewer-set.ts`,
 *     `pipeline-cli/src/attestation/sign-v6.ts`), which uses it to pick the
 *     reviewer set and to RECORD the classification in the envelope, and
 *   - the CI verifier (`verify-core.mjs`), which RE-DERIVES the classification
 *     from the diff and never reads it from a field the signer wrote.
 *
 * Dependency-free so the verifier can import it without a `dist/` build.
 *
 * ## One trust-chain list, three reviewer kinds (AISDLC-722)
 *
 * `TRUST_CHAIN_PATH_PREFIXES` is the ONE trust-chain path list. AISDLC-722
 * (two reviewers by default) builds on it instead of defining a second list:
 * `requiredReviewerKind()` maps a diff to `correctness-only` (test-only and
 * docs-adjacent diffs), `two` (correctness + security, any other diff that
 * touches no trust-chain path) or `three` (code + test + security, a diff that
 * touches a trust-chain path, an unreadable diff, or `reviewerSet: three`).
 * The signer selects with it and the CI verifier re-derives with it.
 *
 * ## Conservatism
 *
 * Anything not positively identified as test-only or docs-adjacent is `full`.
 * Mixed diffs are never downgraded. A comment-only change is not inferred.
 */

/** Paths whose change can alter what the trust chain accepts. Prefix match. */
export const TRUST_CHAIN_PATH_PREFIXES = Object.freeze([
  '.github/',
  '.husky/',
  '.ai-sdlc/',
  'ai-sdlc-plugin/',
  'pipeline-cli/attestation-core/',
  'pipeline-cli/src/attestation/',
  'orchestrator/src/runtime/attestations',
  'scripts/verify-attestation',
  'scripts/check-attestation',
  'scripts/sign-attestation',
  'scripts/is-docs-only-changeset.mjs',
  'scripts/pre-push-fixups.sh',
  'scripts/check-task-moved.sh',
  'scripts/check-dark-code-on-push.sh',
  'pipeline-cli/src/cli/attestation.ts',
  'pipeline-cli/bin/cli-attestation.mjs',
  'reference/src/core/generated-schemas.ts',
  // Governance resolver and schema, hierarchy lease policy, decision fallback.
  'pipeline-cli/src/governance/',
  'spec/schemas/agent-role.schema.json',
  'pipeline-cli/src/hierarchy/lease-policy.ts',
  'pipeline-cli/src/hierarchy/operational.ts',
  'pipeline-cli/src/decisions/governance-fallback.ts',
  // Reviewer selection and routing code.
  'pipeline-cli/src/steps/reviewer-set.ts',
  'pipeline-cli/src/runtime/untrusted-env.ts',
  'orchestrator/src/runtime/git-env.ts',
  '.mcp.json',
  'pipeline-cli/src/steps/reviewer-set-comparison.ts',
  'pipeline-cli/src/steps/07-build-review-prompts.ts',
  'pipeline-cli/src/orchestrator/reconcile.ts',
  // Merge and release path code.
  'pipeline-cli/src/cli/merge-if-eligible.ts',
  'pipeline-cli/bin/cli-merge-if-eligible.mjs',
  'release-please-config.json',
  '.release-please-manifest.json',
  // Agent-instruction directories: Markdown here steers agents (AISDLC-723).
  '.claude/',
  '.codex/',
  '.cursor/',
  '.opencode/',
]);

/** Files that act as agent instructions wherever they sit in the tree. */
const AGENT_INSTRUCTION_BASENAMES = Object.freeze(['claude.md', 'agents.md', 'skill.md']);

/**
 * Bookkeeping directories under `.ai-sdlc/` that carry data, not control. The
 * docs-only classifier already treats attestation envelopes and the decision
 * log as docs-equivalent, so they stay out of the trust-chain list.
 */
const TRUST_CHAIN_DATA_EXCEPTIONS = Object.freeze([
  /^\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$/,
  /^\.ai-sdlc\/_decisions\//,
  // Runtime artifacts every reviewed PR carries: transcript leaves, the findings
  // ledger and audit records are outputs of the review, not configuration.
  /^\.ai-sdlc\/transcript-leaves(\.jsonl|\/)/,
  /^\.ai-sdlc\/reviews\//,
  /^\.ai-sdlc\/_audit\//,
]);

/** Trust-chain paths that a prefix cannot express. */
const TRUST_CHAIN_PATH_PATTERNS = Object.freeze([
  /^scripts\/[^/]*attestation[^/]*$/,
  /(^|\/)\.github\/workflows\//,
]);

/** Test files, fixtures and snapshots. */
export const TEST_ONLY_PATTERNS = Object.freeze([
  /(^|\/)[^/]*\.test\.[^/]+$/,
  /(^|\/)[^/]*\.spec\.[^/]+$/,
  /(^|\/)__tests__\//,
  /(^|\/)fixtures\//,
  /(^|\/)__snapshots__\//,
]);

/**
 * Copy of `DOCS_ONLY_PATTERN` in `scripts/is-docs-only-changeset.mjs` (that
 * script is not shipped with the published package, so the verifier cannot
 * import it). A test in `pipeline-cli/src/attestation/review-scope.test.ts` asserts the two stay equal.
 */
export const DOCS_ONLY_PATTERN =
  /^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$|\.ai-sdlc\/_decisions\/|\.github\/dependabot\.yml$|\.github\/[^/]+\.md$|[^/]+\.md$)/;

/**
 * True when a failed `git show <ref>:<path>` means the file is definitely
 * absent at that ref (the only failure that may be read as "no config").
 *
 * @param {unknown} err
 */
export function isPathMissingGitError(err) {
  const stderr = String(/** @type {{stderr?: unknown}} */ (err)?.stderr ?? '');
  return /does not exist in|exists on disk, but not in/i.test(stderr);
}

/** Markdown anywhere in the tree. */
const MARKDOWN_PATTERN = /\.md$/i;

/**
 * A test or fixture whose path names security, attestation, signing,
 * verification, hook or governance code. Changing such a test can change a
 * security expectation, so it forces the full set.
 */
const SECURITY_TEST_PATH_PATTERN =
  /attest|sign(?:ing|ature|er|[-_.])|verif|trust|hook|merkle|security|governance|permission|sandbox|auth|secret|credential|policy|injection|redos|merge|eligib|reviewer|docs-only|gate|guard|role|dor|pre-push|allow|deny|bypass/i;

/** @param {string} path normalised */
function matchesTrustChain(path) {
  if (AGENT_INSTRUCTION_BASENAMES.includes(path.slice(path.lastIndexOf('/') + 1))) return true;
  if (TRUST_CHAIN_DATA_EXCEPTIONS.some((re) => re.test(path))) return false;
  return (
    TRUST_CHAIN_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    TRUST_CHAIN_PATH_PATTERNS.some((re) => re.test(path))
  );
}

/**
 * True when a path cannot be trusted as a plain repo path: git C-quotes
 * non-ASCII names (`"\\303\\251"`) unless read with `-z`, and a quoted, empty,
 * control-character or `..` path matches no list. Such a path fails closed.
 *
 * @param {unknown} path
 */
export function isSuspectPath(path) {
  if (typeof path !== 'string' || path === '') return true;
  // eslint-disable-next-line no-control-regex
  if (path.startsWith('"') || /[\u0000-\u001f\u007f]/.test(path)) return true;
  return path.replace(/\\/g, '/').split('/').includes('..');
}

/**
 * True when a diff path forces the three-reviewer set: a trust-chain path, a
 * workflow file, or a path that cannot be read as a plain repo path.
 *
 * @param {string} path
 */
export function isTrustChainPath(path) {
  return isSuspectPath(path) || matchesTrustChain(normalise(path));
}

/**
 * The subset of `paths` that force the three-reviewer set, in input order,
 * de-duplicated.
 *
 * @param {readonly string[]} paths
 * @returns {string[]}
 */
export function matchTrustChainPaths(paths) {
  const out = [];
  for (const p of paths) {
    if (isTrustChainPath(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** @param {string} path */
function isTestPath(path) {
  return TEST_ONLY_PATTERNS.some((re) => re.test(path));
}

/** @param {string} path */
function isDocsAdjacentPath(path) {
  return DOCS_ONLY_PATTERN.test(path) || MARKDOWN_PATTERN.test(path);
}

/** @param {string} path */
function normalise(path) {
  return path.normalize('NFC').toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Classify a diff by its changed paths.
 *
 * @param {readonly string[]} paths
 * @returns {{ classification: 'test-only' | 'docs-adjacent' | 'full', reason: string }}
 */
export function classifyReviewScope(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { classification: 'full', reason: 'no changed paths' };
  }
  const normalised = paths.map((p) => (typeof p === 'string' ? normalise(p) : ''));
  for (const p of normalised) {
    if (p === '' || p.includes('\0') || p.split('/').includes('..')) {
      return { classification: 'full', reason: 'unparseable path' };
    }
  }
  const trust = normalised.find(matchesTrustChain);
  if (trust !== undefined) return { classification: 'full', reason: `trust-chain path: ${trust}` };

  if (normalised.every(isTestPath)) {
    const sec = normalised.find((p) => SECURITY_TEST_PATH_PATTERN.test(p));
    if (sec !== undefined) {
      return { classification: 'full', reason: `security-sensitive test path: ${sec}` };
    }
    return { classification: 'test-only', reason: 'every path is a test, fixture or snapshot' };
  }
  if (normalised.every(isDocsAdjacentPath)) {
    return { classification: 'docs-adjacent', reason: 'every path is Markdown or docs-only' };
  }
  return { classification: 'full', reason: 'diff touches non-test, non-docs paths' };
}

/**
 * Parse `securityReview: always` from `.ai-sdlc/review-config.yaml` text.
 * The caller MUST read that text from the base branch, never the PR worktree.
 *
 * @param {string | null | undefined} yaml
 * @returns {boolean} true when the repository keeps security review on everything
 */
export function parseSecurityReviewAlways(yaml) {
  if (typeof yaml !== 'string') return false;
  return /^\s*securityReview:\s*['"]?always['"]?\s*(#.*)?$/im.test(yaml);
}

/** Reviewer roles that satisfy "the correctness review" requirement. */
const CORRECTNESS_NAMES = ['correctness-reviewer'];
const CODE_NAMES = ['code-reviewer', 'code-reviewer-codex'];
const TEST_NAMES = ['test-reviewer', 'test-reviewer-codex'];

/**
 * The reviewer set the signer selects for a classification.
 *
 * @param {'test-only' | 'docs-adjacent' | 'full'} classification
 * @param {{ securityAlways?: boolean }} [opts]
 * @returns {'correctness-only' | 'full'}
 */
export function reviewerSetKindFor(classification, opts = {}) {
  if (opts.securityAlways === true) return 'full';
  return classification === 'test-only' || classification === 'docs-adjacent'
    ? 'correctness-only'
    : 'full';
}

/**
 * Check the reviewer names carried by an attestation against what the
 * re-derived classification requires.
 *
 *   - correctness-only: a correctness review (or the code + test pair).
 *   - full: a security review AND a correctness review (or the code + test pair).
 *
 * @param {readonly string[]} reviewerNames
 * @param {'test-only' | 'docs-adjacent' | 'full'} classification
 * @param {{ securityAlways?: boolean }} [opts]
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkReviewerCoverage(reviewerNames, classification, opts = {}) {
  const names = new Set(reviewerNames);
  const has = (list) => list.some((n) => names.has(n));
  const missing = [];
  if (!(has(CORRECTNESS_NAMES) || (has(CODE_NAMES) && has(TEST_NAMES)))) {
    missing.push('correctness-reviewer (or code-reviewer + test-reviewer)');
  }
  if (reviewerSetKindFor(classification, opts) === 'full' && !names.has('security-reviewer')) {
    missing.push('security-reviewer');
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Parse the `reviewerSet:` scalar from a review-config YAML string. Returns
 * `null` when absent or unrecognised. `three` is the repository opt-out
 * (always the three-reviewer set); `code-test-merged` and `auto` mean the
 * default (diff-derived), because the classifier already picks two whenever
 * that is safe. The caller MUST read the text from the base branch.
 *
 * @param {string | null | undefined} yaml
 * @returns {'three' | 'code-test-merged' | 'auto' | null}
 */
export function parseReviewerSetConfig(yaml) {
  const m = String(yaml ?? '').match(
    /^\s*reviewerSet:\s*['"]?(three|code-test-merged|auto)['"]?\s*(#.*)?$/im,
  );
  return m ? /** @type {'three' | 'code-test-merged' | 'auto'} */ (m[1].toLowerCase()) : null;
}

/**
 * The reviewer kind a diff requires (AISDLC-722 on top of AISDLC-723).
 *
 *   - `three`: code + test + security. A trust-chain path, an unreadable or
 *     empty diff, or `requireThree` (`reviewerSet: three`).
 *   - `correctness-only`: a test-only or docs-adjacent diff with no trust-chain
 *     path (and `securityAlways` unset).
 *   - `two`: correctness + security, every other diff.
 *
 * @param {readonly string[] | null | undefined} paths all changed paths; `null` means the diff could not be read
 * @param {{ securityAlways?: boolean, requireThree?: boolean }} [opts]
 * @returns {{ kind: 'correctness-only' | 'two' | 'three', classification: 'test-only' | 'docs-adjacent' | 'full', reason: string, triggeringPaths: string[] }}
 */
export function requiredReviewerKind(paths, opts = {}) {
  const three = (reason, triggeringPaths = []) => ({
    kind: /** @type {const} */ ('three'),
    classification: /** @type {const} */ ('full'),
    reason,
    triggeringPaths,
  });
  if (opts.requireThree === true) return three('config:require-three');
  if (!Array.isArray(paths)) return three('diff-unavailable');
  if (paths.length === 0) return three('no-changed-files');
  const triggering = matchTrustChainPaths(paths);
  if (triggering.length > 0) return three('trust-chain-path', triggering);
  const { classification, reason } = classifyReviewScope(paths);
  return {
    kind:
      reviewerSetKindFor(classification, opts) === 'correctness-only' ? 'correctness-only' : 'two',
    classification,
    reason,
    triggeringPaths: [],
  };
}

/**
 * Check the reviewer names carried by an attestation against a required kind.
 * The three set needs a code reviewer, a test reviewer and security; the two
 * set needs security and a correctness review (or the code + test pair); the
 * correctness-only set needs just the correctness review. A larger set always
 * covers a smaller requirement. `-codex` variants count as their role.
 *
 * @param {readonly string[]} reviewerNames
 * @param {'correctness-only' | 'two' | 'three'} kind
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkReviewerKindCoverage(reviewerNames, kind) {
  const names = new Set(reviewerNames);
  const has = (list) => list.some((n) => names.has(n));
  const missing = [];
  if (kind === 'three') {
    if (!has(CODE_NAMES)) missing.push('code-reviewer');
    if (!has(TEST_NAMES)) missing.push('test-reviewer');
  } else if (!(has(CORRECTNESS_NAMES) || (has(CODE_NAMES) && has(TEST_NAMES)))) {
    missing.push('correctness-reviewer (or code-reviewer + test-reviewer)');
  }
  if (kind !== 'correctness-only' && !names.has('security-reviewer')) {
    missing.push('security-reviewer');
  }
  return { ok: missing.length === 0, missing };
}
