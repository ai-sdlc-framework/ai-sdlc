/**
 * Question evidence gate (AISDLC-1452, DEC-0442): the AskUserQuestion half of
 * the evidence gates. Every question carries an `Evidence: <ledger path>` line,
 * the ledger passes the AISDLC-1451 checker, and its `draftSha256` matches the
 * question text (the checker hashes it, leaving out the Evidence line, so an
 * edit after the research invalidates the ledger). The rules are not copied
 * here: `check` runs `cli-decisions evidence check --draft`, the one checker.
 *
 * The one exception is a question whose header is exactly `Preference`
 * (naming, formatting, ordering, as the decision-rubric skill defines it). It
 * passes, and its full text is logged so a decision dressed up as a
 * preference is visible in the gate log.
 *
 * The gate refuses; it does not warn. A checker that cannot run is a refusal
 * too, never a pass.
 */

'use strict';

const { createHash } = require('crypto');

/** The header that exempts a question from the ledger. Exact match, case included. */
const PREFERENCE_HEADER = 'Preference';

/** `Evidence: <path>` on its own line of the question text. */
const EVIDENCE_LINE = /^\s*Evidence:\s*(\S+)\s*$/m;

/** The command a refusal names to re-check a ledger (AC 4). */
const RECHECK = 'node pipeline-cli/bin/cli-decisions.mjs evidence check';

const str = (v) => (typeof v === 'string' ? v : '');

/** The ledger path a question cites, or null. */
function evidencePath(questionText) {
  const m = EVIDENCE_LINE.exec(str(questionText));
  return m ? m[1] : null;
}

/**
 * Run the gate over every question of an AskUserQuestion input.
 *
 * @param {object} args
 * @param {object} args.toolInput the AskUserQuestion input.
 * @param {(ledgerPath: string, draftText: string) => ({ ok: boolean, failures: Array<{entry: string, reason: string}> } | null)} args.check
 *   the checker; null when it could not run.
 * @param {string} [args.sessionId]
 * @param {() => Date} [args.now]
 * @returns {{ decision: 'allow' | 'deny', reason?: string, records: object[] }}
 */
function runEvidenceGate({ toolInput, check, sessionId = '', now = () => new Date() }) {
  const qs =
    toolInput && Array.isArray(toolInput.questions)
      ? toolInput.questions.filter((q) => q && typeof q === 'object')
      : [];
  const records = [];
  const problems = [];
  qs.forEach((q, i) => {
    const text = str(q.question);
    const label = `question ${i + 1}${str(q.header) ? ` ("${str(q.header)}")` : ''}`;
    const rec = (outcome, basis, extra = {}) =>
      records.push({
        ts: now().toISOString(),
        sessionId,
        check: 'evidence',
        outcome,
        basis,
        questionHash: createHash('sha256').update(text).digest('hex'),
        ...extra,
      });
    if (str(q.header) === PREFERENCE_HEADER) {
      rec('preference', PREFERENCE_HEADER, { questionText: text });
      return;
    }
    const ledger = evidencePath(text);
    if (!ledger) {
      rec('deny', 'no-evidence-line');
      problems.push(
        `${label} has no \`Evidence: <ledger path>\` line. Run the decision-rubric research step, pass \`${RECHECK} <ledger> --draft <draft>\`, then put the Evidence line on the question.`,
      );
      return;
    }
    let result = null;
    try {
      result = check(ledger, text);
    } catch {
      result = null;
    }
    if (!result) {
      rec('deny', 'checker-unavailable', { ledger });
      problems.push(
        `${label}: the evidence checker could not run on ${ledger}; run \`${RECHECK} ${ledger}\` yourself to see why.`,
      );
      return;
    }
    if (!result.ok) {
      const failures = Array.isArray(result.failures) ? result.failures : [];
      rec('deny', 'ledger-fails', { ledger, failures });
      problems.push(
        `${label}: evidence ledger ${ledger} fails:\n` +
          failures.map((f) => `  ${str(f.entry)}: ${str(f.reason)}`).join('\n') +
          `\nFix the entries, then re-check: ${RECHECK} ${ledger}`,
      );
      return;
    }
    rec('allow', 'ledger-passes', { ledger });
  });
  if (problems.length === 0) return { decision: 'allow', records };
  return {
    decision: 'deny',
    reason: `no question goes out on an unchecked fact (DEC-0442).\n${problems.join('\n')}`,
    records,
  };
}

module.exports = { PREFERENCE_HEADER, RECHECK, evidencePath, runEvidenceGate };
