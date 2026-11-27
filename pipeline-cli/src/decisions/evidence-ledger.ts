/**
 * Decision evidence ledger (AISDLC-1451, DEC-0442).
 *
 * The rules live once, in the dependency-free
 * `pipeline-cli/attestation-core/evidence-ledger-core.mjs`, so the governance
 * gate's RFC resolution check can run them with no build (AISDLC-1452). This
 * module re-exports them and supplies the projected Decision Catalog as the
 * default DEC lookup, plus the ledger loading every CLI gate shares.
 *
 * @module decisions/evidence-ledger
 */

import { readFileSync } from 'node:fs';

import {
  checkEvidenceLedger as checkCore,
  parseEvidenceLedger,
  type EvidenceCheckOptions,
  type EvidenceCheckResult,
} from '../../attestation-core/evidence-ledger-core.mjs';
import { listDecisions } from './projection.js';

export {
  DECISION_EVIDENCE_DIR,
  EVIDENCE_CHECK_COMMAND,
  EVIDENCE_LEDGER_SCHEMA_VERSION,
  QUOTE_LINE_TOLERANCE,
  draftSha256,
  formatEvidenceFailures,
  formatEvidenceRefusal,
  normalizeDraftText,
  type EvidenceCheckOptions,
  type EvidenceCheckResult,
  type EvidenceFailure,
} from '../../attestation-core/evidence-ledger-core.mjs';

/** Check one ledger. Never throws; every problem is one failure naming its entry. */
export function checkEvidenceLedger(
  ledger: unknown,
  opts: EvidenceCheckOptions,
): EvidenceCheckResult {
  let decIds: Set<string> | null = null;
  const decisionExists =
    opts.decisionExists ??
    ((id: string): boolean => {
      decIds ??= new Set(
        listDecisions({ workDir: opts.repoRoot }).decisions.map((d) => d.metadata.id),
      );
      return decIds.has(id);
    });
  return checkCore(ledger, { ...opts, decisionExists });
}

export interface LoadedLedger extends EvidenceCheckResult {
  /** The ledger file's text, when it could be read (copied verbatim when filed). */
  text: string | null;
}

/** Read and check the ledger at `path`; a missing or unparsable file is one failure. */
export function loadAndCheckLedger(path: string, opts: EvidenceCheckOptions): LoadedLedger {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return {
      ok: false,
      text: null,
      failures: [{ entry: 'ledger', reason: `cannot read: ${(e as Error).message}` }],
    };
  }
  const parsed = parseEvidenceLedger(text);
  if (parsed.failures) return { ok: false, text, failures: parsed.failures };
  return { ...checkEvidenceLedger(parsed.ledger, opts), text };
}
