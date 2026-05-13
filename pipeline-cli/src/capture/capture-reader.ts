/**
 * RFC-0024 capture reader — lists + loads capture records from
 * `$ARTIFACTS_DIR/_captures/`.
 *
 * Each capture is stored as a single JSON line in `<id>.jsonl`. The reader
 * walks the directory and returns all valid records, skipping corrupt files
 * with a warning rather than aborting.
 *
 * @module capture/capture-reader
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * AISDLC-269 PR #483 review fix: validate captureId before path construction.
 * Mirrors capture-writer.ts assertSafeCaptureId — kept as a separate const
 * here to avoid a cross-module circular dependency.
 */
const CAPTURE_ID_PATTERN = /^cap_[\d-]+T[\d-]+_[a-f0-9]{6}$/;
function assertSafeCaptureId(captureId: string): void {
  if (basename(captureId) !== captureId || !CAPTURE_ID_PATTERN.test(captureId)) {
    throw new Error(
      `[cli-capture] invalid captureId: ${captureId} — expected cap_YYYY-MM-DDTHH-MM-SS_<6-hex>`,
    );
  }
}
import {
  validateCaptureRecord,
  type CaptureRecord,
  type CaptureTriageValue,
} from './capture-record.js';
import { resolveCapturesDir } from './capture-writer.js';

export interface LoadCapturesOpts {
  /** Override artifacts directory. */
  artifactsDir?: string;
  /** Filter by triage value. */
  triage?: CaptureTriageValue;
  /** Filter by source type. */
  sourceType?: 'operator' | 'ai-agent';
  /** If true, only return unresolved (triage='tbd') captures. */
  pendingOnly?: boolean;
}

export interface LoadCapturesResult {
  records: CaptureRecord[];
  /** Number of files that failed to parse (logged, not thrown). */
  skippedFiles: number;
}

/**
 * Load all capture records from the captures directory.
 * Records are sorted by timestamp ascending (oldest first).
 */
export function loadCaptures(opts: LoadCapturesOpts = {}): LoadCapturesResult {
  const dir = resolveCapturesDir(opts.artifactsDir);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory doesn't exist yet — no captures.
    return { records: [], skippedFiles: 0 };
  }

  const records: CaptureRecord[] = [];
  let skippedFiles = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = join(dir, entry);

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      skippedFiles += 1;
      continue;
    }

    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      skippedFiles += 1;
      continue;
    }

    let parsed: unknown;
    try {
      // Each file contains exactly one JSON line.
      parsed = JSON.parse(trimmed);
    } catch {
      skippedFiles += 1;
      continue;
    }

    const err = validateCaptureRecord(parsed);
    if (err) {
      skippedFiles += 1;
      continue;
    }

    records.push(parsed as CaptureRecord);
  }

  // Sort by timestamp ascending.
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Apply filters.
  let filtered = records;
  if (opts.triage !== undefined) {
    filtered = filtered.filter((r) => r.triage === opts.triage);
  }
  if (opts.sourceType !== undefined) {
    filtered = filtered.filter((r) => r.source.type === opts.sourceType);
  }
  if (opts.pendingOnly) {
    filtered = filtered.filter((r) => r.triage === 'tbd');
  }

  return { records: filtered, skippedFiles };
}

/**
 * Load a single capture by ID. Returns null if not found or invalid.
 */
export function loadCaptureById(captureId: string, artifactsDir?: string): CaptureRecord | null {
  // loadCaptureById returns null on not-found but throws on invalid IDs:
  // a malformed ID is a programming error, not a "file not present" condition.
  assertSafeCaptureId(captureId);
  const dir = resolveCapturesDir(artifactsDir);
  const filePath = join(dir, `${captureId}.jsonl`);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }

  const err = validateCaptureRecord(parsed);
  if (err) return null;

  return parsed as CaptureRecord;
}

/**
 * Count captures by triage status. Returns a map of triage → count.
 */
export function countCapturesByTriage(artifactsDir?: string): Record<CaptureTriageValue, number> {
  const { records } = loadCaptures({ artifactsDir });
  const counts: Record<string, number> = {};
  for (const r of records) {
    counts[r.triage] = (counts[r.triage] ?? 0) + 1;
  }
  return counts as Record<CaptureTriageValue, number>;
}

/**
 * Returns true when any capture with triage='tbd' references the given issue ID
 * in its `relatedIssueId` or `blocksIssueId` fields.
 *
 * Used by the `CapturesPending` pre-dispatch filter (RFC-0024 §9.3).
 */
export function hasPendingCapturesForIssue(issueId: string, artifactsDir?: string): boolean {
  const { records } = loadCaptures({ artifactsDir, pendingOnly: true });
  const id = issueId.toLowerCase();
  return records.some(
    (r) => r.relatedIssueId?.toLowerCase() === id || r.blocksIssueId?.toLowerCase() === id,
  );
}
