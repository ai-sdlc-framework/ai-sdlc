export const EVIDENCE_LEDGER_SCHEMA_VERSION: 1;
export const DECISION_EVIDENCE_DIR: string;
export const EVIDENCE_CHECK_COMMAND: string;
export const QUOTE_LINE_TOLERANCE: number;

export interface EvidenceFailure {
  /** Entry id, or `ledger` for a ledger-level failure. */
  entry: string;
  reason: string;
}

export interface EvidenceCheckResult {
  ok: boolean;
  failures: EvidenceFailure[];
}

export interface EvidenceCheckOptions {
  /** Root the file quotes, paths, RFCs and tasks resolve against (the main checkout). */
  repoRoot: string;
  /** The draft text the ledger must match; omit to skip the hash comparison. */
  draftText?: string;
  /** Override for DEC existence; default looks for a decision-opened event under `repoRoot`. */
  decisionExists?: (id: string) => boolean;
}

export function normalizeDraftText(text: string): string;
export function draftSha256(text: string): string;
export function decisionOpenedOnDisk(root: string, id: string): boolean;
export function checkEvidenceLedger(
  ledger: unknown,
  opts: EvidenceCheckOptions,
): EvidenceCheckResult;
export function formatEvidenceFailures(failures: EvidenceFailure[]): string;
export function formatEvidenceRefusal(ledgerPath: string, failures: EvidenceFailure[]): string;
export function parseEvidenceLedger(
  text: string,
): { ledger: unknown; failures?: undefined } | { ledger: null; failures: EvidenceFailure[] };
