#!/usr/bin/env node
/**
 * check-rfc-lifecycle-transitions.mjs — enforce the RFC lifecycle ladder.
 *
 * Detects forbidden lifecycle transitions in the PR diff and fails CI with a
 * clear diagnostic message. Allowed path:
 *
 *   Draft → Ready for Review → Signed Off → Implemented
 *
 * Forbidden transitions (skipping a step):
 *   - Draft → Signed Off
 *   - Draft → Implemented
 *   - Ready for Review → Implemented
 *
 * The script compares the `lifecycle:` frontmatter field in two RFC file
 * snapshots: the *before* (previous git commit / base) and the *after*
 * (current working file). It is primarily designed for CI use where the
 * caller provides diff data, but it can also be used locally.
 *
 * Operator override (audit-trail preserving, BOTH locations required):
 *   Add the following HTML comment in BOTH the PR body AND in the RFC
 *   file body (after the closing frontmatter fence). Single-source
 *   override is NOT accepted (defense-in-depth — AISDLC-350).
 *
 *     <!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> -->
 *
 *   The <operator> value MUST appear in `.ai-sdlc/lifecycle-approvers.yaml`.
 *   Any name not in the allowlist causes the override to be ignored and the
 *   lifecycle ladder is enforced normally.
 *
 *   Alternative: operator submits an approving GitHub review comment
 *   containing the marker; CI validates via `gh api review.user.login`
 *   against the allowlist (see rfc-lifecycle-check.yml).
 *
 * Audit log:
 *   Every approved override writes a structured entry to
 *   `.ai-sdlc/_audit/lifecycle-overrides.jsonl` (append-only).
 *   Fields: { ts, rfc, fromLifecycle, toLifecycle, operator, reason,
 *             prNumber, commitSha }
 *
 * Usage:
 *   node scripts/check-rfc-lifecycle-transitions.mjs \
 *     --before <before-content> --after <after-content> \
 *     [--pr-body <pr-body-text>] [--rfc-id <RFC-NNNN>] \
 *     [--repo-root <path>] [--pr-number <n>] [--commit-sha <sha>]
 *
 *   Or as a library (primary usage — caller supplies transition data):
 *     import { checkLifecycleTransition, LIFECYCLE_STATES, FORBIDDEN_TRANSITIONS }
 *       from './check-rfc-lifecycle-transitions.mjs';
 *
 * CI wiring (AISDLC-350):
 *   This script is invoked per-RFC by `.github/workflows/rfc-lifecycle-check.yml`
 *   which detects changed spec/rfcs/*.md files in the PR diff, extracts the
 *   before content via `git show $BASE_SHA:$file`, and runs this script once
 *   per changed RFC. The workflow posts an `ai-sdlc/rfc-lifecycle` commit status.
 *
 *   To add this check to required-checks on main after one week of soak:
 *     gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
 *       -F 'contexts[]=ai-sdlc/rfc-lifecycle' --jq '.contexts'
 */

import { createRequire } from 'node:module';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy-load js-yaml so the library can still be imported in environments where
// js-yaml is not installed (the fallback parser handles basic cases).
let _jsYaml = null;
function getJsYaml() {
  if (_jsYaml) return _jsYaml;
  try {
    const req = createRequire(import.meta.url);
    _jsYaml = req('js-yaml');
  } catch {
    _jsYaml = null;
  }
  return _jsYaml;
}

/**
 * The ordered lifecycle ladder. Each state's index reflects its position
 * in the promotion sequence; non-linear promotions are forbidden.
 */
export const LIFECYCLE_STATES = ['Draft', 'Ready for Review', 'Signed Off', 'Implemented'];

/**
 * Terminal lifecycle states that are valid but outside the promotion ladder.
 * Transitions INTO these from any state are allowed (e.g. any → Superseded).
 */
export const TERMINAL_STATES = new Set(['Superseded']);

/**
 * Set of forbidden transitions as `"from->to"` strings. Derived from the
 * ladder: any transition that skips one or more steps.
 */
export const FORBIDDEN_TRANSITIONS = new Set(
  LIFECYCLE_STATES.flatMap((from, i) =>
    LIFECYCLE_STATES.slice(i + 2).map((to) => `${from}->${to}`),
  ),
);

/**
 * Regex that matches the operator override marker in a PR body or RFC body.
 * Captures `operator` and `reason` groups.
 *
 * Marker format (HTML comment, so it renders invisible in GitHub):
 *   <!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> -->
 *
 * Operator capture: [a-zA-Z0-9_-]{1,32} — restricts to safe identifier chars,
 * prevents ANSI escape injection and other special-char payloads (AISDLC-350).
 */
export const OVERRIDE_MARKER_REGEX =
  /<!--\s*ai-sdlc:lifecycle-jump-approved-by:([a-zA-Z0-9_-]{1,32})\s+reason:([\s\S]+?)-->/;

/**
 * Strip control characters from a string (used for reason sanitization
 * before writing to the audit log). Removes C0 and C1 control codes
 * and other non-printable chars that could corrupt JSONL or terminal output.
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeReason(s) {
  // Remove ASCII control chars (0x00-0x1F, 0x7F) and C1 controls (0x80-0x9F).
  // Keep printable ASCII and valid Unicode text.
  return s.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
}

/**
 * Extract the `lifecycle:` value from RFC frontmatter text using js-yaml
 * when available, with a robust inline fallback parser.
 *
 * The js-yaml path closes bypass vectors where the lifecycle field appears
 * inside a YAML block scalar, as a nested key, or after a YAML comment
 * (all of which the prior line-by-line scanner would misparse — AISDLC-350).
 *
 * Returns `null` when:
 *   - The source is empty / falsy (file did not exist).
 *   - No `lifecycle:` key is present in the frontmatter.
 *   - Frontmatter is malformed (no closing fence).
 *
 * @param {string} source - Full RFC file content (may be empty/null).
 * @returns {string|null}
 */
export function extractLifecycle(source) {
  if (!source) return null;
  const normalised = source.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) return null;
  const fenceEnd = normalised.indexOf('\n---\n', 4);
  if (fenceEnd === -1) return null;
  const block = normalised.slice(4, fenceEnd);

  // Preferred path: use js-yaml for a proper parse that handles block
  // scalars, nested keys, and YAML comments correctly.
  const yaml = getJsYaml();
  if (yaml) {
    try {
      const parsed = yaml.load(block);
      if (parsed && typeof parsed === 'object' && 'lifecycle' in parsed) {
        const val = parsed['lifecycle'];
        return typeof val === 'string' ? val : null;
      }
      return null;
    } catch {
      // Fall through to the inline parser on parse error.
    }
  }

  // Inline fallback parser: only reads top-level scalar keys at column 0.
  // This handles the common case and is immune to nested-key bypass because
  // it only matches lines starting at column 0 (no leading whitespace).
  for (const line of block.split('\n')) {
    // Skip blank lines and YAML comments.
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Only match top-level (col 0) lifecycle key — indented lines are
    // nested keys or block-scalar content, both of which we intentionally
    // skip to prevent bypass (AISDLC-350).
    const m = line.match(/^lifecycle\s*:\s*(.+)$/);
    if (m) {
      const raw = m[1].trim();
      // Strip surrounding quotes.
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        return raw.slice(1, -1);
      }
      return raw;
    }
  }
  return null;
}

/**
 * Parse the operator override marker from a text blob (PR body or RFC body).
 *
 * Returns `{ operator, reason }` if a valid marker is found, or `null`.
 * Returns `null` if the reason is whitespace-only after trim (AISDLC-350:
 * blank reasons undermine the audit-trail purpose).
 *
 * @param {string} text - Text to scan for the marker.
 * @returns {{ operator: string, reason: string }|null}
 */
export function parseOverrideMarker(text) {
  if (!text) return null;
  const m = OVERRIDE_MARKER_REGEX.exec(text);
  if (!m) return null;
  const operator = m[1].trim();
  const reason = m[2].trim();
  // Reject empty reasons (AISDLC-350: audit-trail purpose is undermined
  // by blank reasons — callers must supply a non-whitespace reason).
  if (!reason) return null;
  return { operator, reason };
}

/**
 * Load the lifecycle approvers allowlist from `.ai-sdlc/lifecycle-approvers.yaml`.
 *
 * Returns a Set of allowed operator identity strings (GitHub handles).
 * On any error (file missing, parse failure), returns an EMPTY Set — the gate
 * fails closed: without an allowlist, no override is accepted.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {Set<string>}
 */
export function loadLifecycleApprovers(repoRoot) {
  const approversPath = join(repoRoot, '.ai-sdlc', 'lifecycle-approvers.yaml');
  if (!existsSync(approversPath)) {
    return new Set();
  }
  try {
    const content = readFileSync(approversPath, 'utf-8');
    const yaml = getJsYaml();
    if (!yaml) {
      // Without js-yaml we use a minimal inline parser for the allowlist.
      // The allowlist YAML is simple enough (list of scalar mappings) that
      // a line-scan for `identity:` is sufficient and safe.
      const identities = new Set();
      for (const line of content.split('\n')) {
        const im = line.match(/^\s*-?\s*identity\s*:\s*['"]?([a-zA-Z0-9_-]{1,32})['"]?\s*$/);
        if (im) identities.add(im[1]);
      }
      return identities;
    }
    const parsed = yaml.load(content);
    if (!parsed || !Array.isArray(parsed.operators)) return new Set();
    return new Set(
      parsed.operators
        .filter((op) => op && typeof op.identity === 'string')
        .map((op) => op.identity),
    );
  } catch {
    // Fail closed on any parse error.
    return new Set();
  }
}

/**
 * Append a structured override entry to the audit log.
 *
 * Writes to `.ai-sdlc/_audit/lifecycle-overrides.jsonl` (append-only).
 * Silently no-ops on write errors (audit log failure must never block CI).
 *
 * @param {object} params
 * @param {string} params.repoRoot    - Absolute path to repo root.
 * @param {string} params.rfc         - RFC identifier (e.g. 'RFC-0011').
 * @param {string} params.fromLifecycle
 * @param {string} params.toLifecycle
 * @param {string} params.operator    - Approved operator identity.
 * @param {string} params.reason      - Override reason text.
 * @param {string} [params.prNumber]  - PR number (optional, from CI env).
 * @param {string} [params.commitSha] - Commit SHA (optional, from CI env).
 */
export function appendAuditEntry({
  repoRoot,
  rfc,
  fromLifecycle,
  toLifecycle,
  operator,
  reason,
  prNumber,
  commitSha,
}) {
  try {
    const auditDir = join(repoRoot, '.ai-sdlc', '_audit');
    mkdirSync(auditDir, { recursive: true });
    const auditPath = join(auditDir, 'lifecycle-overrides.jsonl');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      rfc,
      fromLifecycle,
      toLifecycle,
      operator,
      reason: sanitizeReason(reason),
      prNumber: prNumber ?? null,
      commitSha: commitSha ?? null,
    });
    appendFileSync(auditPath, entry + '\n');
  } catch {
    // Audit log failures are non-fatal — log to stderr but do not fail CI.
    process.stderr.write('[rfc-lifecycle] WARNING: failed to write audit log entry\n');
  }
}

// ---------------------------------------------------------------------------
// AISDLC-311 — requires-shipped check at Implemented promotion
// ---------------------------------------------------------------------------

/**
 * Extract a YAML-list-shaped field (e.g. `requires:`, `assumes:`) from an
 * RFC's frontmatter text. Supports inline (`[RFC-0001, RFC-0002]`) + block-
 * list forms. Returns deduplicated bare RFC IDs.
 *
 * Pure parser — no I/O. Used by `checkRequiresShipped` to read the upgrading
 * RFC's `requires:` declaration without depending on the check-rfc-docs
 * frontmatter parser (the two modules are intentionally independent).
 *
 * @param {string} source  - Full RFC content (frontmatter + body) OR raw frontmatter block.
 * @param {string} field   - One of 'requires' | 'assumes'.
 * @returns {string[]}
 */
export function extractRfcListField(source, field) {
  if (!source) return [];
  const normalised = source.replace(/\r\n/g, '\n');
  let block = normalised;
  if (normalised.startsWith('---\n')) {
    const fenceEnd = normalised.indexOf('\n---\n', 4);
    if (fenceEnd !== -1) block = normalised.slice(4, fenceEnd);
  }
  const ids = new Set();
  // Inline form.
  const inlineRe = new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]`, 'm');
  const inline = block.match(inlineRe);
  if (inline) {
    for (const raw of (inline[1] ?? '').split(',')) {
      const item = raw.trim().replace(/^['"]|['"]$/g, '');
      if (/^RFC-\d{4}$/.test(item)) ids.add(item);
    }
    return [...ids];
  }
  // Block-list form.
  const blockRe = new RegExp(`^${field}:\\n((?:\\s+-\\s+.+\\n?)*)`, 'm');
  const blockMatch = block.match(blockRe);
  if (!blockMatch) return [];
  for (const line of (blockMatch[1] ?? '').split('\n')) {
    const item = line
      .replace(/^\s+-\s+/, '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (/^RFC-\d{4}$/.test(item)) ids.add(item);
  }
  return [...ids];
}

/**
 * Check that all `requires:` entries of an RFC are themselves at the
 * `Implemented` lifecycle when promoting the RFC to `Implemented`.
 *
 * Per AISDLC-311:
 *   - `requires:` = runtime-code dependency. Target RFC MUST be `Implemented`.
 *   - `assumes:` = design-contract dependency. Target RFC only needs to exist;
 *                  it is NOT checked here.
 *
 * Returns `{ ok, violations[] }`. The CLI runner treats violations as
 * warnings rather than hard failures during the initial soak window — this
 * prevents the gate from retroactively breaking historical RFCs whose
 * `requires:` field may not yet be split between requires/assumes. After
 * the AISDLC-311 audit pass completes the caller can promote to a hard
 * fail by inspecting `violations.length > 0`.
 *
 * @param {object} params
 * @param {string|null} params.toContent     - RFC content after the change.
 * @param {string|null} params.toLifecycle   - Resolved target lifecycle.
 * @param {string}      params.rfcId         - For diagnostic messages.
 * @param {(rfcId: string) => string|null} [params.readUpstreamRfcContent]
 *        - Loader for upstream RFC content; tests stub this. Falls back to no
 *          check when not provided.
 * @returns {{ ok: boolean, violations: Array<{ rfcId: string, depId: string, depLifecycle: string }>, diagnostic?: string }}
 */
export function checkRequiresShipped({ toContent, toLifecycle, rfcId, readUpstreamRfcContent }) {
  // Only enforce when the RFC is being promoted to `Implemented`.
  if (toLifecycle !== 'Implemented') return { ok: true, violations: [] };
  if (!toContent || typeof readUpstreamRfcContent !== 'function') {
    return { ok: true, violations: [] };
  }
  const requires = extractRfcListField(toContent, 'requires');
  if (requires.length === 0) return { ok: true, violations: [] };

  const violations = [];
  for (const depId of requires) {
    const depContent = readUpstreamRfcContent(depId);
    if (depContent === null) {
      // Missing dep file — surface as a violation; the check-rfc-docs
      // dependency-existence check will also flag this.
      violations.push({ rfcId, depId, depLifecycle: 'missing' });
      continue;
    }
    const depLifecycle = extractLifecycle(depContent);
    if (depLifecycle !== 'Implemented') {
      violations.push({ rfcId, depId, depLifecycle: depLifecycle ?? 'unknown' });
    }
  }

  if (violations.length === 0) return { ok: true, violations: [] };
  const diagnostic =
    `[rfc-lifecycle] WARN ${rfcId}: promoting to 'Implemented' with unshipped ` +
    `'requires:' deps: ${violations
      .map((v) => `${v.depId} (lifecycle='${v.depLifecycle}')`)
      .join(', ')}. ` +
    `Per AISDLC-311, runtime-code dependencies (requires:) must ship before the consumer can ship. ` +
    `If this RFC's implementation does NOT import any of these RFCs' code, move them to 'assumes:' instead.`;
  return { ok: false, violations, diagnostic };
}

/**
 * Check a single RFC lifecycle transition.
 *
 * @param {object} params
 * @param {string|null} params.fromLifecycle  - Previous lifecycle value (null = new file).
 * @param {string|null} params.toLifecycle    - New lifecycle value (null = file deleted).
 * @param {string}      params.rfcId          - RFC identifier for error messages.
 * @param {string}      [params.prBody]       - PR body text (scanned for override marker).
 * @param {string}      [params.rfcBody]      - RFC body text (scanned for override marker).
 * @param {Set<string>} [params.approvers]    - Set of allowed operator identities.
 * @param {string}      [params.repoRoot]     - Repo root (for audit log writes).
 * @param {string}      [params.prNumber]     - PR number (for audit log).
 * @param {string}      [params.commitSha]    - Commit SHA (for audit log).
 *
 * @returns {{ ok: boolean, violation?: string, override?: { operator: string, reason: string }, diagnostic?: string }}
 */
export function checkLifecycleTransition({
  fromLifecycle,
  toLifecycle,
  rfcId,
  prBody,
  rfcBody,
  approvers,
  repoRoot,
  prNumber,
  commitSha,
}) {
  // New file: no "from" state — any lifecycle is valid.
  if (fromLifecycle === null) {
    return { ok: true };
  }

  // AISDLC-350 fail-closed fix: when toContent's lifecycle is null but
  // fromContent's was set, treat as "lifecycle removed mid-PR" and fail.
  if (toLifecycle === null) {
    const diagnostic =
      `[rfc-lifecycle] FAIL ${rfcId}: lifecycle field was '${fromLifecycle}' but was REMOVED ` +
      `in this PR. RFC lifecycle fields must not be deleted — set an explicit lifecycle value instead.`;
    return { ok: false, violation: `${fromLifecycle}->null`, diagnostic };
  }

  // Same state: no-op.
  if (fromLifecycle === toLifecycle) {
    return { ok: true };
  }

  // Transitions INTO a terminal state are always valid.
  if (TERMINAL_STATES.has(toLifecycle)) {
    return { ok: true };
  }

  // Validate that the "to" state is a known lifecycle state.
  const toIdx = LIFECYCLE_STATES.indexOf(toLifecycle);
  const fromIdx = LIFECYCLE_STATES.indexOf(fromLifecycle);

  if (toIdx === -1) {
    // Unknown target lifecycle — not a ladder-skip violation but still warn;
    // return ok so tooling doesn't block on an extended lifecycle value we
    // haven't catalogued. Caller may add additional validation.
    return { ok: true };
  }

  if (fromIdx === -1) {
    // Unknown source lifecycle with a known, non-terminal target — fail closed.
    // We cannot validate whether the transition skips steps; treating unknown
    // sources as allowed is a bypass vector (AISDLC-417).
    const diagnostic =
      `[rfc-lifecycle] FAIL ${rfcId}: lifecycle field '${fromLifecycle}' is not a recognised ` +
      `ladder state. Cannot validate whether the transition to '${toLifecycle}' is permitted. ` +
      `Valid lifecycle states: ${LIFECYCLE_STATES.join(', ')}, Superseded. ` +
      `Correct the 'lifecycle:' frontmatter field to a recognised value.`;
    return { ok: false, violation: `${fromLifecycle}->${toLifecycle}`, diagnostic };
  }

  // Regressions (e.g. Implemented → Draft) are not forbidden by this gate.
  // They may be intentional reverts; a separate gate can enforce that.
  if (toIdx <= fromIdx) {
    return { ok: true };
  }

  const key = `${fromLifecycle}->${toLifecycle}`;
  if (!FORBIDDEN_TRANSITIONS.has(key)) {
    return { ok: true };
  }

  // Forbidden transition detected — check for override marker.
  // AISDLC-350: override requires the marker in BOTH PR body AND RFC body
  // (defense-in-depth — single-source override is a trust-all bypass).
  const prOverride = parseOverrideMarker(prBody);
  const rfcOverride = parseOverrideMarker(rfcBody);

  if (prOverride && rfcOverride) {
    // Use PR-body operator for the primary record; both must be present.
    const operator = prOverride.operator;
    const reason = sanitizeReason(prOverride.reason);

    // AISDLC-350: validate operator against allowlist.
    if (approvers && approvers.size > 0 && !approvers.has(operator)) {
      const diagnostic =
        `[rfc-lifecycle] FAIL ${rfcId}: override marker found (operator='${operator}') but ` +
        `this identity is NOT in .ai-sdlc/lifecycle-approvers.yaml. ` +
        `Only listed operators may approve lifecycle jumps. ` +
        `Add '${operator}' to the allowlist via a separate PR first.`;
      return { ok: false, violation: key, diagnostic };
    }

    // Write audit entry.
    if (repoRoot) {
      appendAuditEntry({
        repoRoot,
        rfc: rfcId,
        fromLifecycle,
        toLifecycle,
        operator,
        reason,
        prNumber,
        commitSha,
      });
    }

    return { ok: true, override: { operator, reason } };
  }

  // Compute the correct next step(s) for the diagnostic message.
  const nextStep = LIFECYCLE_STATES[fromIdx + 1];

  let overrideMissing = '';
  if (prOverride && !rfcOverride) {
    overrideMissing =
      ' Override marker found in PR body only — it must ALSO appear in the RFC body.';
  } else if (!prOverride && rfcOverride) {
    overrideMissing =
      ' Override marker found in RFC body only — it must ALSO appear in the PR body.';
  }

  const diagnostic =
    `[rfc-lifecycle] FAIL ${rfcId}: forbidden lifecycle transition ` +
    `'${fromLifecycle}' → '${toLifecycle}'. ` +
    `The required next step is '${nextStep}'. ` +
    `Correct path: ${LIFECYCLE_STATES.join(' → ')}. ` +
    `To bypass (audit-trail preserving), add to BOTH the PR body AND the RFC body: ` +
    `<!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> --> ` +
    `where <operator> is listed in .ai-sdlc/lifecycle-approvers.yaml. ` +
    `Alternatively, add the marker in an approving GitHub review comment. ` +
    `Gate enforced by .github/workflows/rfc-lifecycle-check.yml (AISDLC-350).` +
    overrideMissing;

  return { ok: false, violation: key, diagnostic };
}

/**
 * Check a list of RFC transition descriptors and return an aggregated report.
 *
 * @param {Array<{
 *   rfcId: string,
 *   fromContent: string|null,
 *   toContent: string|null,
 *   prBody?: string,
 *   approvers?: Set<string>,
 *   repoRoot?: string,
 *   prNumber?: string,
 *   commitSha?: string,
 * }>} transitions
 *
 * @returns {{
 *   failures: Array<{ rfcId: string, violation: string, diagnostic: string }>,
 *   overrides: Array<{ rfcId: string, override: { operator: string, reason: string }, transition: string }>,
 *   clean: number,
 * }}
 */
export function checkAllTransitions(transitions) {
  const failures = [];
  const overrides = [];
  const warnings = [];
  let clean = 0;

  for (const t of transitions) {
    const fromLifecycle = extractLifecycle(t.fromContent);
    const toLifecycle = extractLifecycle(t.toContent);
    const rfcBody = t.toContent ?? '';

    const result = checkLifecycleTransition({
      fromLifecycle,
      toLifecycle,
      rfcId: t.rfcId,
      prBody: t.prBody ?? '',
      rfcBody,
      approvers: t.approvers,
      repoRoot: t.repoRoot,
      prNumber: t.prNumber,
      commitSha: t.commitSha,
    });

    if (result.ok) {
      if (result.override) {
        overrides.push({
          rfcId: t.rfcId,
          override: result.override,
          transition: `${fromLifecycle}->${toLifecycle}`,
        });
      } else {
        clean++;
      }
    } else {
      failures.push({
        rfcId: t.rfcId,
        violation: result.violation,
        diagnostic: result.diagnostic,
      });
    }

    // AISDLC-311 — requires-shipped check, runs alongside the ladder check.
    // Warning-only during the initial soak window; do NOT escalate to a hard
    // failure until the AISDLC-311 audit pass has reclassified historical
    // `requires:` entries that are actually design-contract (`assumes:`).
    if (typeof t.readUpstreamRfcContent === 'function') {
      const reqResult = checkRequiresShipped({
        toContent: t.toContent,
        toLifecycle,
        rfcId: t.rfcId,
        readUpstreamRfcContent: t.readUpstreamRfcContent,
      });
      if (!reqResult.ok) {
        warnings.push({
          rfcId: t.rfcId,
          kind: 'requires-not-shipped',
          violations: reqResult.violations,
          diagnostic: reqResult.diagnostic,
        });
      }
    }
  }

  return { failures, overrides, warnings, clean };
}

/**
 * Format and print a checkAllTransitions report to stdout/stderr.
 * Returns exit code (0 = OK, 1 = violations).
 *
 * @param {{ failures: Array, overrides: Array, clean: number }} report
 * @returns {number}
 */
export function reportTransitionsAndExit({ failures, overrides, warnings = [], clean }) {
  for (const ov of overrides) {
    console.log(
      `[rfc-lifecycle] OVERRIDE ${ov.rfcId}: '${ov.transition}' approved by ${ov.override.operator} — ${ov.override.reason}`,
    );
  }
  for (const w of warnings) {
    console.log(w.diagnostic);
  }
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(f.diagnostic);
    }
    console.error(
      `[rfc-lifecycle] ${failures.length} forbidden transition(s) detected. ` +
        `Each RFC must progress through: ${LIFECYCLE_STATES.join(' → ')}. ` +
        `Gate enforced by .github/workflows/rfc-lifecycle-check.yml (AISDLC-350).`,
    );
    return 1;
  }
  console.log(
    `[rfc-lifecycle] OK: ${clean} clean transition(s), ${overrides.length} approved override(s)` +
      (warnings.length > 0 ? `, ${warnings.length} warning(s)` : '') +
      `.`,
  );
  return 0;
}

/**
 * Check whether a PR simultaneously modifies the lifecycle approvers allowlist
 * AND uses an override marker. A PR that does both can self-approve a bypass —
 * the allowlist change takes effect in the same diff as the override it enables.
 *
 * This is a workflow-level guard (AISDLC-417): the caller supplies the git diff
 * output for `.ai-sdlc/lifecycle-approvers.yaml` and the PR body text.
 *
 * @param {object} params
 * @param {string} params.allowlistDiff - Output of `git diff BASE HEAD -- .ai-sdlc/lifecycle-approvers.yaml` (empty = no change).
 * @param {string} params.prBody        - PR body text to check for override markers.
 * @returns {{ ok: boolean, diagnostic?: string }}
 */
export function checkAllowlistMutationGuard({ allowlistDiff, prBody }) {
  const allowlistChanged = allowlistDiff && allowlistDiff.trim().length > 0;
  if (!allowlistChanged) {
    return { ok: true };
  }
  const hasOverrideMarker = OVERRIDE_MARKER_REGEX.test(prBody ?? '');
  if (!hasOverrideMarker) {
    return { ok: true };
  }
  const diagnostic =
    '[rfc-lifecycle] FAIL: This PR modifies .ai-sdlc/lifecycle-approvers.yaml AND contains ' +
    'an override marker (<!-- ai-sdlc:lifecycle-jump-approved-by:... -->). ' +
    'Allowing a PR to both expand the approvers allowlist and use that allowlist to bypass the ' +
    'lifecycle ladder in the same diff is a privilege-escalation vector. ' +
    'Split into two PRs: one that adds the approver, and a separate PR (after the first merges) ' +
    'that uses the override marker. (AISDLC-417)';
  return { ok: false, diagnostic };
}

/**
 * Check that the audit log `.ai-sdlc/_audit/lifecycle-overrides.jsonl` is
 * append-only — the diff must not contain any removed lines (lines starting
 * with `-` that are not file-header lines starting with `---`).
 *
 * The caller supplies the raw output of:
 *   `git diff BASE HEAD -- .ai-sdlc/_audit/lifecycle-overrides.jsonl`
 *
 * Returns ok:true when the diff is empty (no change) or only additions.
 * Returns ok:false with diagnostic when any existing lines are removed.
 *
 * @param {object} params
 * @param {string} params.auditLogDiff - git diff output for the audit log file (may be empty).
 * @returns {{ ok: boolean, removedLines?: string[], diagnostic?: string }}
 */
export function checkAuditLogIntegrity({ auditLogDiff }) {
  if (!auditLogDiff || auditLogDiff.trim().length === 0) {
    return { ok: true };
  }

  // Find lines starting with `-` that are actual content removals (not diff headers).
  // Diff headers: `--- a/...`, `--- /dev/null`.  Content removal: `^-` followed by non-`-`.
  const removedLines = auditLogDiff
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'));

  if (removedLines.length === 0) {
    return { ok: true };
  }

  const diagnostic =
    `[rfc-lifecycle] FAIL: The audit log .ai-sdlc/_audit/lifecycle-overrides.jsonl ` +
    `is append-only — existing entries must never be removed. ` +
    `This PR removes ${removedLines.length} line(s). ` +
    `Audit log tampering undermines the governance trail. ` +
    `Restore the removed entries and re-push. (AISDLC-417)`;

  return { ok: false, removedLines, diagnostic };
}

/**
 * Minimal CLI for local / pipeline use. Accepts two required flags:
 *   --before <file-path>   Path to the "before" version of the RFC file
 *   --after  <file-path>   Path to the "after" version of the RFC file
 *   --rfc-id <RFC-NNNN>    RFC id for error messages (optional; inferred from filename)
 *   --pr-body <text>       PR body text to scan for override marker (optional)
 *   --pr-body-file <path>  Path to a file containing the PR body (avoids shell injection)
 *   --repo-root <path>     Repository root for allowlist + audit log (optional)
 *   --pr-number <n>        PR number for audit log (optional)
 *   --commit-sha <sha>     Commit SHA for audit log (optional)
 *   --help                 Print usage
 *
 * In CI, prefer --pr-body-file over --pr-body to avoid command-substitution
 * injection when the PR body contains shell metacharacters. Write the body to
 * a temp file with `printf '%s' "$PR_BODY" > /tmp/pr-body.txt` and pass
 * `--pr-body-file /tmp/pr-body.txt` (AISDLC-417).
 *
 * In CI, prefer the library interface (import + call checkAllTransitions)
 * since you can pass in-memory content rather than temp files.
 * CI enforcement is via .github/workflows/rfc-lifecycle-check.yml (AISDLC-350).
 */

function parseArgs(argv) {
  const args = {
    before: null,
    after: null,
    rfcId: null,
    prBody: '',
    prBodyFile: null,
    repoRoot: null,
    prNumber: null,
    commitSha: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--before') args.before = argv[++i];
    else if (a === '--after') args.after = argv[++i];
    else if (a === '--rfc-id') args.rfcId = argv[++i];
    else if (a === '--pr-body') args.prBody = argv[++i];
    else if (a === '--pr-body-file') args.prBodyFile = argv[++i];
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--pr-number') args.prNumber = argv[++i];
    else if (a === '--commit-sha') args.commitSha = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/check-rfc-lifecycle-transitions.mjs --before <path> --after <path> ' +
          '[--rfc-id <id>] [--pr-body <text>] [--pr-body-file <path>] [--repo-root <path>] ' +
          '[--pr-number <n>] [--commit-sha <sha>]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));

  const repoRoot = args.repoRoot ?? resolve(__dirname, '..');
  const approvers = loadLifecycleApprovers(repoRoot);

  const beforeContent = args.before ? readFileSync(args.before, 'utf-8') : null;
  const afterContent = args.after ? readFileSync(args.after, 'utf-8') : null;
  const rfcId = args.rfcId ?? 'RFC-unknown';

  // --pr-body-file takes precedence over --pr-body (avoids shell injection).
  const prBody = args.prBodyFile ? readFileSync(args.prBodyFile, 'utf-8') : args.prBody;

  const report = checkAllTransitions([
    {
      rfcId,
      fromContent: beforeContent,
      toContent: afterContent,
      prBody,
      approvers,
      repoRoot,
      prNumber: args.prNumber,
      commitSha: args.commitSha,
    },
  ]);

  process.exit(reportTransitionsAndExit(report));
}
