/**
 * Review-policy banner for the SessionStart hook (AISDLC-561).
 *
 * The banner's wording is computed from INSPECTED enforcement state, never
 * from the mere existence of `.ai-sdlc/review-policy.md`. The inspection is
 * `ai-sdlc doctor --only attestation-governance` — the very check
 * `ai-sdlc doctor` uses for "is enforcement configured" (AISDLC-560), so
 * the hook and doctor cannot drift apart.
 *
 * Three states, each worded differently:
 *   - enforced:     doctor check passed
 *   - not-enforced: doctor check ran and reported warn/fail (names the gap)
 *   - unknown:      CLI missing, timed out, or output unparseable — the
 *                   banner says enforcement could not be confirmed and NEVER
 *                   claims the policy is active.
 */

const { spawnSync } = require('child_process');

const CHECK_ID = 'attestation-governance';
const POLICY_PATH = '.ai-sdlc/review-policy.md';

/**
 * Parse `ai-sdlc doctor --only attestation-governance --format json` stdout.
 * Pure. Returns { state, title?, remediation? }.
 */
function classifyDoctorOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const result = (parsed.results || []).find((r) => r && r.id === CHECK_ID);
    if (!result) return { state: 'unknown' };
    if (result.severity === 'pass') return { state: 'enforced', title: result.title };
    return { state: 'not-enforced', title: result.title, remediation: result.remediation };
  } catch {
    return { state: 'unknown' };
  }
}

/** Run the doctor check. Never throws. `bin` is overridable for tests. */
function detectEnforcement(projectDir, opts = {}) {
  const bin = opts.bin || 'ai-sdlc';
  const timeout = opts.timeoutMs || 6000;
  try {
    const r = spawnSync(bin, ['--format', 'json', 'doctor', '--only', CHECK_ID], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error || !r.stdout) return { state: 'unknown' };
    return classifyDoctorOutput(r.stdout);
  } catch {
    return { state: 'unknown' };
  }
}

const REVIEWER_SET_TEXT = [
  'Reviewer set (run by `/ai-sdlc execute`): by default `code-reviewer`, `test-reviewer` and `security-reviewer`.',
  'Code and test review use the `-codex` variants when the Codex CLI is installed; set `AI_SDLC_REVIEWER_HARNESS=claude` to force Claude-native reviewers.',
  'Opt-in: `reviewerSet: code-test-merged` (one `correctness-reviewer` + `security-reviewer`) via `.ai-sdlc/review-config.yaml` committed on main, or `AI_SDLC_REVIEWER_SET=code-test-merged`.',
  'A reviewer that is defined but never invoked produces no transcript; if only some reviewers have ever run in this repo, check how review is wired.',
].join('\n');

/** Pure renderer. `policyExists` gates the whole banner. */
function renderReviewPolicyBanner(policyExists, enforcement) {
  if (!policyExists) return '';
  let head;
  if (enforcement.state === 'enforced') {
    head = `Review policy is ENFORCED: ${POLICY_PATH} is backed by configured enforcement (${enforcement.title || 'attestation governance check passed'}). Consult it before reviewing code.`;
  } else if (enforcement.state === 'not-enforced') {
    head =
      `Review policy is AVAILABLE but NOT ENFORCED: ${POLICY_PATH} exists, but nothing blocks a merge on it. ` +
      `Missing: ${enforcement.title || 'enforcement is not configured'}.` +
      (enforcement.remediation ? ` Fix: \`${enforcement.remediation}\`.` : '') +
      ' Do not assume review is happening unless you run it yourself, and tell the operator review is not enforced.';
  } else {
    head =
      `Review policy is AVAILABLE at ${POLICY_PATH}, but enforcement could NOT be confirmed ` +
      '(`ai-sdlc doctor` was unavailable or timed out). Do not assume review is happening; run `ai-sdlc doctor` to check.';
  }
  return `\n${head}\n${REVIEWER_SET_TEXT}`;
}

module.exports = { classifyDoctorOutput, detectEnforcement, renderReviewPolicyBanner, CHECK_ID };
