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
 * ## Lockstep surface with AISDLC-722
 *
 * `TRUST_CHAIN_PATH_PREFIXES` is a minimal shared trust-chain path list. Task
 * AISDLC-722 (two reviewers by default) needs the same list; when it lands it
 * must import THIS list rather than define a second one.
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
]);

/**
 * Bookkeeping directories under `.ai-sdlc/` that carry data, not control. The
 * docs-only classifier already treats attestation envelopes and the decision
 * log as docs-equivalent, so they stay out of the trust-chain list.
 */
const TRUST_CHAIN_DATA_EXCEPTIONS = Object.freeze([
  /^\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$/,
  /^\.ai-sdlc\/_decisions\//,
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
 * import it). A test in `review-scope-core.test.mjs` asserts the two stay equal.
 */
export const DOCS_ONLY_PATTERN =
  /^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$|\.ai-sdlc\/_decisions\/|[^/]+\.md$)/;

/** Markdown anywhere in the tree. */
const MARKDOWN_PATTERN = /\.md$/i;

/**
 * A test or fixture whose path names security, attestation, signing,
 * verification, hook or governance code. Changing such a test can change a
 * security expectation, so it forces the full set.
 */
const SECURITY_TEST_PATH_PATTERN =
  /attest|sign(?:ing|ature|er|[-_.])|verif|trust|hook|merkle|security|governance|permission|sandbox|auth|secret|credential|policy|injection|redos/i;

/** @param {string} path */
function isTrustChainPath(path) {
  if (TRUST_CHAIN_DATA_EXCEPTIONS.some((re) => re.test(path))) return false;
  return TRUST_CHAIN_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
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
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
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
  const trust = normalised.find(isTrustChainPath);
  if (trust !== undefined) return { classification: 'full', reason: `trust-chain path: ${trust}` };
  const wf = normalised.find((p) => /(^|\/)\.github\/workflows\//.test(p));
  if (wf !== undefined) return { classification: 'full', reason: `workflow file: ${wf}` };

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
  return /^\s*securityReview:\s*['"]?always['"]?\s*(#.*)?$/m.test(yaml);
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
