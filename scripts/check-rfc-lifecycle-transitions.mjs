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
 * Operator override (audit-trail preserving):
 *   Add the following HTML comment anywhere in the PR body or in the RFC
 *   file body (after the closing frontmatter fence):
 *
 *     <!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> -->
 *
 *   The script logs the override and continues without failing.
 *
 * Usage:
 *   node scripts/check-rfc-lifecycle-transitions.mjs \
 *     --before <before-content> --after <after-content> \
 *     [--pr-body <pr-body-text>] [--rfc-id <RFC-NNNN>]
 *
 *   Or as a library (primary usage — caller supplies transition data):
 *     import { checkLifecycleTransition, LIFECYCLE_STATES, FORBIDDEN_TRANSITIONS }
 *       from './check-rfc-lifecycle-transitions.mjs';
 */

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
 */
export const OVERRIDE_MARKER_REGEX =
  /<!--\s*ai-sdlc:lifecycle-jump-approved-by:([^\s>]+)\s+reason:([\s\S]+?)-->/;

/**
 * Extract the `lifecycle:` value from RFC frontmatter text.
 *
 * Returns `null` when:
 *   - The source is empty / falsy (file did not exist).
 *   - No `lifecycle:` key is present in the frontmatter.
 *
 * The parser is intentionally minimal — it only needs to read one scalar
 * field from the leading `--- ... ---` block.
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
  for (const line of block.split('\n')) {
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
 *
 * @param {string} text - Text to scan for the marker.
 * @returns {{ operator: string, reason: string }|null}
 */
export function parseOverrideMarker(text) {
  if (!text) return null;
  const m = OVERRIDE_MARKER_REGEX.exec(text);
  if (!m) return null;
  return { operator: m[1].trim(), reason: m[2].trim() };
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
 *
 * @returns {{ ok: boolean, violation?: string, override?: { operator: string, reason: string }, diagnostic?: string }}
 */
export function checkLifecycleTransition({ fromLifecycle, toLifecycle, rfcId, prBody, rfcBody }) {
  // New file: no "from" state — any lifecycle is valid.
  if (fromLifecycle === null) {
    return { ok: true };
  }

  // Deleted file or lifecycle removed: no enforcement.
  if (toLifecycle === null) {
    return { ok: true };
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

  // Regressions (e.g. Implemented → Draft) are not forbidden by this gate.
  // They may be intentional reverts; a separate gate can enforce that.
  if (fromIdx === -1 || toIdx <= fromIdx) {
    return { ok: true };
  }

  const key = `${fromLifecycle}->${toLifecycle}`;
  if (!FORBIDDEN_TRANSITIONS.has(key)) {
    return { ok: true };
  }

  // Forbidden transition detected — check for override marker.
  const override = parseOverrideMarker(prBody) ?? parseOverrideMarker(rfcBody) ?? null;
  if (override) {
    return { ok: true, override };
  }

  // Compute the correct next step(s) for the diagnostic message.
  const nextStep = LIFECYCLE_STATES[fromIdx + 1];
  const diagnostic =
    `[rfc-lifecycle] FAIL ${rfcId}: forbidden lifecycle transition ` +
    `'${fromLifecycle}' → '${toLifecycle}'. ` +
    `The required next step is '${nextStep}'. ` +
    `Correct path: ${LIFECYCLE_STATES.join(' → ')}. ` +
    `To bypass (audit-trail preserving), add to the PR body: ` +
    `<!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> -->`;

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
  }

  return { failures, overrides, clean };
}

/**
 * Format and print a checkAllTransitions report to stdout/stderr.
 * Returns exit code (0 = OK, 1 = violations).
 *
 * @param {{ failures: Array, overrides: Array, clean: number }} report
 * @returns {number}
 */
export function reportTransitionsAndExit({ failures, overrides, clean }) {
  for (const ov of overrides) {
    console.log(
      `[rfc-lifecycle] OVERRIDE ${ov.rfcId}: '${ov.transition}' approved by ${ov.override.operator} — ${ov.override.reason}`,
    );
  }
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(f.diagnostic);
    }
    console.error(
      `[rfc-lifecycle] ${failures.length} forbidden transition(s) detected. ` +
        `Each RFC must progress through: ${LIFECYCLE_STATES.join(' → ')}.`,
    );
    return 1;
  }
  console.log(
    `[rfc-lifecycle] OK: ${clean} clean transition(s), ${overrides.length} approved override(s).`,
  );
  return 0;
}

/**
 * Minimal CLI for local / pipeline use. Accepts two required flags:
 *   --before <file-path>   Path to the "before" version of the RFC file
 *   --after  <file-path>   Path to the "after" version of the RFC file
 *   --rfc-id <RFC-NNNN>    RFC id for error messages (optional; inferred from filename)
 *   --pr-body <text>       PR body text to scan for override marker (optional)
 *   --help                 Print usage
 *
 * In CI, prefer the library interface (import + call checkAllTransitions)
 * since you can pass in-memory content rather than temp files.
 */
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = { before: null, after: null, rfcId: null, prBody: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--before') args.before = argv[++i];
    else if (a === '--after') args.after = argv[++i];
    else if (a === '--rfc-id') args.rfcId = argv[++i];
    else if (a === '--pr-body') args.prBody = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/check-rfc-lifecycle-transitions.mjs --before <path> --after <path> [--rfc-id <id>] [--pr-body <text>]',
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

  const beforeContent = args.before ? readFileSync(args.before, 'utf-8') : null;
  const afterContent = args.after ? readFileSync(args.after, 'utf-8') : null;
  const rfcId = args.rfcId ?? 'RFC-unknown';

  const report = checkAllTransitions([
    {
      rfcId,
      fromContent: beforeContent,
      toContent: afterContent,
      prBody: args.prBody,
    },
  ]);

  process.exit(reportTransitionsAndExit(report));
}
