/**
 * RFC-0024 §5.1 — capture writer.
 *
 * Writes a capture record to `$ARTIFACTS_DIR/_captures/<id>.jsonl` — one
 * file per capture. Records are never modified after write; the `auditTrail`
 * field is populated at write time and future triage actions produce new
 * audit entries via `writeCaptureTriageUpdate`.
 *
 * The `.jsonl` extension is used for compatibility with the corpus aggregator
 * (`cli-tui-corpus`), even though each file contains exactly one JSON line.
 *
 * @module capture/capture-writer
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * AISDLC-269 PR #483 review fix: validate captureId before using it in path
 * construction. captureId comes from CLI args / AI-agent output; raw `..`
 * segments would let a caller read/overwrite arbitrary .jsonl files outside
 * the captures dir. We accept ONLY the canonical pattern emitted by
 * makeCaptureId(): `cap_YYYY-MM-DDTHH-MM-SS_<6-hex>`. Anything else throws.
 */
const CAPTURE_ID_PATTERN = /^cap_[\d-]+T[\d-]+_[a-f0-9]{6}$/;
function assertSafeCaptureId(captureId: string): void {
  // Reject path traversal even when the canonical pattern would otherwise
  // happen to look valid — basename() strips dir components defensively.
  if (basename(captureId) !== captureId || !CAPTURE_ID_PATTERN.test(captureId)) {
    throw new Error(
      `[cli-capture] invalid captureId: ${captureId} — expected cap_YYYY-MM-DDTHH-MM-SS_<6-hex>`,
    );
  }
}
import {
  generateCaptureId,
  isTerminalTriage,
  validateCaptureRecord,
  type AuditEntry,
  type AgentRole,
  type CaptureEvidence,
  type CaptureRecord,
  type CaptureSeverity,
  type CaptureTriageValue,
} from './capture-record.js';

// ── Directory helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the captures directory: `$ARTIFACTS_DIR/_captures`.
 * Falls back to `./_artifacts/_captures` when `ARTIFACTS_DIR` is unset.
 */
export function resolveCapturesDir(artifactsDir?: string): string {
  const base = artifactsDir ?? process.env.ARTIFACTS_DIR ?? resolve(process.cwd(), '_artifacts');
  return join(base, '_captures');
}

/**
 * Ensure the captures directory exists (idempotent).
 */
function ensureCapturesDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Write options ─────────────────────────────────────────────────────────────

export interface WriteCapturOpts {
  /** One-line description of the emergent issue (required). */
  finding: string;
  /** Severity — defaults to 'unknown' when not supplied (OQ-5 resolution). */
  severity?: CaptureSeverity;
  /** Triage disposition — defaults to 'tbd'. */
  triage?: CaptureTriageValue;
  /** Source type. */
  sourceType: 'operator' | 'ai-agent';
  /** Agent role (only meaningful when sourceType='ai-agent'). */
  agentRole?: AgentRole | null;
  /** Operator email/login (only meaningful when sourceType='operator'). */
  operator?: string | null;
  /** Free-text source context. */
  context?: string;
  /** Evidence fields. */
  evidence?: CaptureEvidence;
  /** Adapter-native issue ID this capture is against. */
  relatedIssueId?: string | null;
  /** Extension target issue ID (for scope-extension). */
  extensionTargetIssueId?: string | null;
  /** Feature Issue path/URL (for new-feature-issue). */
  featureIssueCarveRef?: string | null;
  /** Issue ID gated by this finding. */
  blocksIssueId?: string | null;
  /** Override the artifacts directory. */
  artifactsDir?: string;
  /** Override clock (tests). */
  now?: Date;
}

/**
 * Write a capture record to disk. Returns the written record.
 *
 * The record is written as a single JSON line to
 * `<capturesDir>/<id>.jsonl`. The file is created exclusively — if the
 * same ID already exists (extremely unlikely due to the hex suffix), the
 * write fails with an error rather than silently overwriting.
 */
export function writeCapture(opts: WriteCapturOpts): CaptureRecord {
  const now = opts.now ?? new Date();
  const id = generateCaptureId(now);
  const timestamp = now.toISOString();

  const record: CaptureRecord = {
    id,
    schemaVersion: 'v1',
    timestamp,
    finding: opts.finding,
    severity: opts.severity ?? 'unknown',
    triage: opts.triage ?? 'tbd',
    source: {
      type: opts.sourceType,
      agentRole: opts.agentRole ?? null,
      operator: opts.operator ?? null,
      context: opts.context,
    },
    evidence: opts.evidence ?? {},
    relatedIssueId: opts.relatedIssueId ?? null,
    extensionTargetIssueId: opts.extensionTargetIssueId ?? null,
    featureIssueCarveRef: opts.featureIssueCarveRef ?? null,
    blocksIssueId: opts.blocksIssueId ?? null,
    createdIssueId: null,
    createdFeatureIssueId: null,
    resolvedAt: isTerminalTriage(opts.triage ?? 'tbd') ? timestamp : null,
    resolvedBy: isTerminalTriage(opts.triage ?? 'tbd')
      ? (opts.operator ?? opts.agentRole ?? 'unknown')
      : null,
    auditTrail: [
      {
        action: 'captured',
        by: opts.operator ?? opts.agentRole ?? 'unknown',
        at: timestamp,
      },
    ],
  };

  // Validate before writing (belt-and-suspenders against type coercion bugs).
  const err = validateCaptureRecord(record);
  if (err) throw new Error(`[cli-capture] invalid record: ${err}`);

  const dir = resolveCapturesDir(opts.artifactsDir);
  ensureCapturesDir(dir);

  const filePath = join(dir, `${id}.jsonl`);
  // O_EXCL equivalent — throw if file already exists.
  if (existsSync(filePath)) {
    throw new Error(`[cli-capture] collision: ${filePath} already exists`);
  }

  writeFileSync(filePath, JSON.stringify(record) + '\n', { encoding: 'utf8' });

  return record;
}

// ── Triage update ─────────────────────────────────────────────────────────────

export interface TriageUpdateOpts {
  /** Capture ID to update. */
  captureId: string;
  /** New triage disposition (must be a terminal value — cannot set back to 'tbd'). */
  triage: CaptureTriageValue;
  /** Who performed the triage. */
  resolvedBy: string;
  /** Additional fields to merge into the record (e.g. createdIssueId). */
  patch?: Partial<
    Pick<
      CaptureRecord,
      'createdIssueId' | 'createdFeatureIssueId' | 'extensionTargetIssueId' | 'featureIssueCarveRef'
    >
  >;
  /** Override artifacts directory. */
  artifactsDir?: string;
  /** Override clock (tests). */
  now?: Date;
}

/**
 * Apply a triage update to an existing capture record.
 *
 * Reads the existing record, applies the triage update, appends an audit
 * entry, and overwrites the file. Returns the updated record.
 *
 * NOTE: This is the ONLY mutation the framework performs on capture records —
 * and it's guarded so it can only flip `triage: tbd → <terminal>`. Flipping
 * a terminal value to another terminal value is not supported in v1
 * (requires a spec change per §11 rationale).
 */
export function applyTriageUpdate(opts: TriageUpdateOpts): CaptureRecord {
  const now = opts.now ?? new Date();
  assertSafeCaptureId(opts.captureId);
  const dir = resolveCapturesDir(opts.artifactsDir);
  const filePath = join(dir, `${opts.captureId}.jsonl`);

  if (!existsSync(filePath)) {
    throw new Error(`[cli-capture] not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[cli-capture] cannot read ${filePath}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  let record: CaptureRecord;
  try {
    record = JSON.parse(raw.trim()) as CaptureRecord;
  } catch {
    throw new Error(`[cli-capture] cannot parse ${filePath}`);
  }

  const validErr = validateCaptureRecord(record);
  if (validErr) throw new Error(`[cli-capture] corrupt record: ${validErr}`);

  if (record.triage !== 'tbd') {
    throw new Error(
      `[cli-capture] capture ${opts.captureId} already has terminal triage '${record.triage}' — cannot re-triage`,
    );
  }

  const timestamp = now.toISOString();
  const newAuditEntry: AuditEntry = {
    action: 'triaged',
    by: opts.resolvedBy,
    at: timestamp,
    to: opts.triage,
  };

  const updated: CaptureRecord = {
    ...record,
    triage: opts.triage,
    resolvedAt: timestamp,
    resolvedBy: opts.resolvedBy,
    auditTrail: [...record.auditTrail, newAuditEntry],
    ...(opts.patch ?? {}),
  };

  writeFileSync(filePath, JSON.stringify(updated) + '\n', { encoding: 'utf8' });

  return updated;
}

// ── Redact ───────────────────────────────────────────────────────────────────

export interface RedactCaptureOpts {
  /** Capture ID to redact. */
  captureId: string;
  /** Reason for redaction (required — preserves audit trail even though finding is scrubbed). */
  reason: string;
  /** Who performed the redaction. */
  redactedBy: string;
  /** Override artifacts directory. */
  artifactsDir?: string;
  /** Override clock (tests). */
  now?: Date;
}

/**
 * RFC-0024 §OQ-7 resolution — `cli-capture redact <id> --reason <text>`.
 *
 * Scrubs the `finding` field but preserves the audit trail. This is the
 * only operator-accessible redaction path; hard delete is filesystem-only.
 */
export function redactCapture(opts: RedactCaptureOpts): CaptureRecord {
  const now = opts.now ?? new Date();
  assertSafeCaptureId(opts.captureId);
  const dir = resolveCapturesDir(opts.artifactsDir);
  const filePath = join(dir, `${opts.captureId}.jsonl`);

  if (!existsSync(filePath)) {
    throw new Error(`[cli-capture] not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[cli-capture] cannot read ${filePath}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  let record: CaptureRecord;
  try {
    record = JSON.parse(raw.trim()) as CaptureRecord;
  } catch {
    throw new Error(`[cli-capture] cannot parse ${filePath}`);
  }

  const timestamp = now.toISOString();
  const redactEntry: AuditEntry = {
    action: 'redacted',
    by: opts.redactedBy,
    at: timestamp,
    reason: opts.reason,
  };

  const redacted: CaptureRecord = {
    ...record,
    finding: '[REDACTED]',
    evidence: {
      ...record.evidence,
      additionalContext: '[REDACTED]',
    },
    source: {
      ...record.source,
      context: record.source.context ? '[REDACTED]' : record.source.context,
    },
    auditTrail: [...record.auditTrail, redactEntry],
  };

  writeFileSync(filePath, JSON.stringify(redacted) + '\n', { encoding: 'utf8' });

  return redacted;
}
