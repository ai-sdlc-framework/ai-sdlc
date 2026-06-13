/**
 * RFC-0024 Refit Phase 1 (AISDLC-320) — Draft → Shared state machine.
 *
 * Implements the OQ-1/OQ-7 revised design:
 *   - Drafts land in `.ai-sdlc/captures-drafts/<id>.md` (operator-local, gitignored)
 *   - `cli-capture submit <id>` promotes a draft to `backlog/captures/<id>.md` (team-shared)
 *   - `cli-capture discard <id>` hard-deletes a draft (no audit obligation — never shared)
 *   - `cli-capture migrate-legacy` moves legacy `$ARTIFACTS_DIR/_captures/<id>.jsonl` → submitted
 *
 * File format: Markdown with a single-line JSON block embedded in an HTML comment.
 * The comment block is machine-parseable; the Markdown body is human-readable.
 *
 * ```
 * <!-- capture:json
 * {"id":"cap_...","schemaVersion":"v1",...}
 * -->
 *
 * # cap_...
 * **Finding:** ...
 * ```
 *
 * The `CAPTURE_REPO_ROOT` environment variable overrides `process.cwd()` as the
 * base for resolving `.ai-sdlc/captures-drafts/` and `backlog/captures/`. Used by
 * tests to redirect I/O to a temporary directory.
 *
 * @module capture/draft-capture
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

import {
  validateCaptureRecord,
  type AuditEntry,
  type CaptureRecord,
  type CaptureTriageValue,
} from './capture-record.js';
import { resolveCapturesDir } from './capture-writer.js';
import type { LoadCapturesResult } from './capture-reader.js';

// ── Capture ID validation ─────────────────────────────────────────────────────

const CAPTURE_ID_PATTERN = /^cap_[\d-]+T[\d-]+_[a-f0-9]{6}$/;

function assertSafeCaptureId(captureId: string): void {
  if (basename(captureId) !== captureId || !CAPTURE_ID_PATTERN.test(captureId)) {
    throw new Error(
      `[cli-capture] invalid captureId: ${captureId} — expected cap_YYYY-MM-DDTHH-MM-SS_<6-hex>`,
    );
  }
}

// ── Directory helpers ─────────────────────────────────────────────────────────

/** Resolve the effective repo root: $CAPTURE_REPO_ROOT → process.cwd(). */
export function resolveRepoRoot(): string {
  return process.env.CAPTURE_REPO_ROOT ?? process.cwd();
}

/**
 * Resolve the draft captures directory: `<repoRoot>/.ai-sdlc/captures-drafts/`.
 * Operator-local; gitignored.
 */
export function resolveDraftsDir(repoRoot?: string): string {
  return join(repoRoot ?? resolveRepoRoot(), '.ai-sdlc', 'captures-drafts');
}

/**
 * Resolve the submitted captures directory: `<repoRoot>/backlog/captures/`.
 * Team-shared; tracked in git.
 */
export function resolveSubmittedDir(repoRoot?: string): string {
  return join(repoRoot ?? resolveRepoRoot(), 'backlog', 'captures');
}

// ── Markdown format ───────────────────────────────────────────────────────────

const JSON_MARKER_START = '<!-- capture:json';
const JSON_MARKER_END = '-->';

/**
 * Serialize a `CaptureRecord` to the `.md` file format used by both draft
 * and submitted captures. The JSON is embedded in an HTML comment for machine
 * parsing; the Markdown body is for human readability.
 */
export function captureToMarkdown(record: CaptureRecord): string {
  const by = record.source.operator ?? record.source.agentRole ?? 'unknown';
  const prLine = record.evidence.prNumber ? `**PR:** #${record.evidence.prNumber}  \n` : '';
  const filePart = record.evidence.filePath
    ? `${record.evidence.filePath}${record.evidence.line != null ? `:${record.evidence.line}` : ''}`
    : null;
  const fileLine = filePart ? `**File:** ${filePart}  \n` : '';
  const contextLine = record.source.context ? `**Context:** ${record.source.context}  \n` : '';

  return (
    `${JSON_MARKER_START}\n${JSON.stringify(record)}\n${JSON_MARKER_END}\n\n` +
    `# ${record.id}\n\n` +
    `**Finding:** ${record.finding}\n\n` +
    `**Severity:** ${record.severity}  \n` +
    `**Triage:** ${record.triage}  \n` +
    `**Filed by:** ${by}  \n` +
    `**At:** ${record.timestamp}  \n` +
    prLine +
    fileLine +
    contextLine
  );
}

/**
 * Parse a capture record from the `.md` file format.
 * Returns `null` if the file doesn't contain a valid JSON comment block.
 */
export function parseMarkdownCapture(content: string): CaptureRecord | null {
  const startIdx = content.indexOf(JSON_MARKER_START);
  if (startIdx === -1) return null;
  const afterStart = content.indexOf('\n', startIdx + JSON_MARKER_START.length);
  if (afterStart === -1) return null;
  const endIdx = content.indexOf(JSON_MARKER_END, afterStart);
  if (endIdx === -1) return null;
  const jsonStr = content.slice(afterStart + 1, endIdx).trim();
  try {
    return JSON.parse(jsonStr) as CaptureRecord;
  } catch {
    return null;
  }
}

// ── Capture config (OQ-2 threshold) ──────────────────────────────────────────

interface CaptureConfig {
  capture?: {
    confidence?: {
      autoSubmitThreshold?: number;
    };
  };
}

function loadCaptureConfig(repoRoot?: string): CaptureConfig {
  const root = repoRoot ?? resolveRepoRoot();
  const configPath = join(root, '.ai-sdlc', 'capture-config.yaml');
  try {
    const raw = readFileSync(configPath, 'utf8');
    return (yamlLoad(raw) as CaptureConfig) ?? {};
  } catch {
    return {};
  }
}

/**
 * Return the confidence threshold above which AI-agent captures auto-submit.
 * Default: 0.7 (per OQ-2 resolution). Operator-overridable via
 * `.ai-sdlc/capture-config.yaml`.
 */
export function getAutoSubmitThreshold(repoRoot?: string): number {
  const config = loadCaptureConfig(repoRoot);
  return config.capture?.confidence?.autoSubmitThreshold ?? 0.7;
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/** Write a capture record to the drafts directory as a `.md` file. */
export function writeDraftCaptureFile(record: CaptureRecord, repoRoot?: string): void {
  const dir = resolveDraftsDir(repoRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${record.id}.md`);
  if (existsSync(filePath)) {
    throw new Error(`[cli-capture] collision: ${filePath} already exists`);
  }
  writeFileSync(filePath, captureToMarkdown(record), { encoding: 'utf8' });
}

/** Write a capture record to the submitted directory as a `.md` file. */
export function writeSubmittedCaptureFile(record: CaptureRecord, repoRoot?: string): void {
  const dir = resolveSubmittedDir(repoRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${record.id}.md`);
  if (existsSync(filePath)) {
    throw new Error(`[cli-capture] collision: ${filePath} already exists`);
  }
  writeFileSync(filePath, captureToMarkdown(record), { encoding: 'utf8' });
}

// ── Submit draft ──────────────────────────────────────────────────────────────

export interface SubmitDraftOpts {
  captureId: string;
  by?: string;
  repoRoot?: string;
  now?: Date;
}

/**
 * Move a draft capture to the submitted (team-shared) directory.
 *
 * 1. Read draft from `.ai-sdlc/captures-drafts/<id>.md`.
 * 2. Append an `{action:'submitted', by, at}` audit entry.
 * 3. Write to `backlog/captures/<id>.md`.
 * 4. Delete the draft file.
 *
 * Throws if the draft is not found or already submitted.
 */
export function submitDraft(opts: SubmitDraftOpts): CaptureRecord {
  assertSafeCaptureId(opts.captureId);
  const draftsDir = resolveDraftsDir(opts.repoRoot);
  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const draftPath = join(draftsDir, `${opts.captureId}.md`);

  if (!existsSync(draftPath)) {
    // Helpful error: check if already submitted.
    const submittedPath = join(submittedDir, `${opts.captureId}.md`);
    if (existsSync(submittedPath)) {
      throw new Error(`[cli-capture] capture ${opts.captureId} is already submitted`);
    }
    throw new Error(`[cli-capture] draft not found: ${opts.captureId}`);
  }

  let content: string;
  try {
    content = readFileSync(draftPath, 'utf8');
  } catch (err) {
    throw new Error(
      `[cli-capture] cannot read draft ${opts.captureId}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const record = parseMarkdownCapture(content);
  if (!record) throw new Error(`[cli-capture] cannot parse draft ${opts.captureId}`);

  const validErr = validateCaptureRecord(record);
  if (validErr) throw new Error(`[cli-capture] corrupt draft ${opts.captureId}: ${validErr}`);

  const now = opts.now ?? new Date();
  const by = opts.by ?? record.source.operator ?? record.source.agentRole ?? 'unknown';
  const submitEntry: AuditEntry = {
    action: 'submitted',
    by,
    at: now.toISOString(),
  };

  const submitted: CaptureRecord = {
    ...record,
    auditTrail: [...record.auditTrail, submitEntry],
  };

  if (!existsSync(submittedDir)) {
    mkdirSync(submittedDir, { recursive: true });
  }

  const submittedPath = join(submittedDir, `${opts.captureId}.md`);
  writeFileSync(submittedPath, captureToMarkdown(submitted), { encoding: 'utf8' });

  // Remove draft only after successful write.
  rmSync(draftPath);

  return submitted;
}

// ── Submit all drafts ─────────────────────────────────────────────────────────

export interface SubmitAllResult {
  submitted: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Bulk-submit all draft captures to the team-shared directory.
 * Idempotent: drafts that fail to submit are skipped (reported in `failed`).
 */
export function submitAllDrafts(
  opts: {
    by?: string;
    repoRoot?: string;
    now?: Date;
  } = {},
): SubmitAllResult {
  const draftsDir = resolveDraftsDir(opts.repoRoot);
  const submitted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  let entries: string[];
  try {
    entries = readdirSync(draftsDir);
  } catch {
    // No drafts directory — nothing to submit.
    return { submitted: [], failed: [] };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const captureId = entry.slice(0, -'.md'.length);
    try {
      assertSafeCaptureId(captureId);
      submitDraft({ captureId, by: opts.by, repoRoot: opts.repoRoot, now: opts.now });
      submitted.push(captureId);
    } catch (err) {
      failed.push({ id: captureId, error: (err as Error).message });
    }
  }

  return { submitted, failed };
}

// ── Discard draft ─────────────────────────────────────────────────────────────

export interface DiscardDraftOpts {
  captureId: string;
  reason: string;
  by?: string;
  repoRoot?: string;
}

/**
 * Hard-delete a draft capture (OQ-7 tiered deletion).
 *
 * Drafts are operator-local and were never team-shared, so there is no audit
 * obligation — the file is removed without appending an audit entry.
 *
 * Refuses to operate on submitted captures (they require `cli-capture redact`
 * to preserve the audit trail per §11 immutability contract).
 */
export function discardDraft(opts: DiscardDraftOpts): void {
  assertSafeCaptureId(opts.captureId);
  const draftsDir = resolveDraftsDir(opts.repoRoot);
  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const draftPath = join(draftsDir, `${opts.captureId}.md`);

  // Refuse if already submitted — give a helpful pointer.
  const submittedPath = join(submittedDir, `${opts.captureId}.md`);
  if (existsSync(submittedPath)) {
    throw new Error(
      `[cli-capture] capture ${opts.captureId} has been submitted to the team. ` +
        `It cannot be discarded; use 'cli-capture redact ${opts.captureId} --reason "${opts.reason}"' ` +
        `to scrub the finding text (preserves audit trail per RFC-0024 §11).`,
    );
  }

  if (!existsSync(draftPath)) {
    throw new Error(`[cli-capture] draft not found: ${opts.captureId}`);
  }

  rmSync(draftPath);
}

// ── Load captures from .md directories ───────────────────────────────────────

export interface LoadMarkdownCapturesOpts {
  repoRoot?: string;
  triage?: CaptureTriageValue;
  pendingOnly?: boolean;
  sourceType?: 'operator' | 'ai-agent';
}

/** Load draft captures from `.ai-sdlc/captures-drafts/`. */
export function loadDraftCaptures(opts: LoadMarkdownCapturesOpts = {}): LoadCapturesResult {
  return loadMarkdownCaptures(resolveDraftsDir(opts.repoRoot), opts);
}

/** Load submitted captures from `backlog/captures/`. */
export function loadSubmittedCaptures(opts: LoadMarkdownCapturesOpts = {}): LoadCapturesResult {
  return loadMarkdownCaptures(resolveSubmittedDir(opts.repoRoot), opts);
}

function loadMarkdownCaptures(dir: string, opts: LoadMarkdownCapturesOpts): LoadCapturesResult {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { records: [], skippedFiles: 0 };
  }

  const records: CaptureRecord[] = [];
  let skippedFiles = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    // Skip .gitkeep
    if (entry === '.gitkeep') continue;

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

    const parsed = parseMarkdownCapture(raw);
    if (!parsed) {
      skippedFiles += 1;
      continue;
    }

    const err = validateCaptureRecord(parsed);
    if (err) {
      skippedFiles += 1;
      continue;
    }

    records.push(parsed);
  }

  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

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

// ── Migrate legacy captures ───────────────────────────────────────────────────

export interface MigrateLegacyResult {
  migrated: number;
  failed: number;
  ids: string[];
}

/**
 * Migrate legacy JSONL captures from `$ARTIFACTS_DIR/_captures/` to the
 * team-shared `backlog/captures/` directory.
 *
 * For each `.jsonl` file:
 *   1. Parse the capture record.
 *   2. Append a `{action:'migrated-from-legacy'}` audit entry.
 *   3. Write the record as a `.md` file to `backlog/captures/`.
 *   4. Delete the legacy `.jsonl` file.
 *
 * Already-migrated captures (`.md` already exists) are skipped (idempotent).
 * Files that fail to parse are counted in `failed` and left in place.
 */
export function migrateLegacyCaptures(
  opts: {
    artifactsDir?: string;
    repoRoot?: string;
    now?: Date;
  } = {},
): MigrateLegacyResult {
  const legacyDir = resolveCapturesDir(opts.artifactsDir);
  const submittedDir = resolveSubmittedDir(opts.repoRoot);

  let entries: string[];
  try {
    entries = readdirSync(legacyDir);
  } catch {
    return { migrated: 0, failed: 0, ids: [] };
  }

  let migrated = 0;
  let failed = 0;
  const ids: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;

    const filePath = join(legacyDir, entry);
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
      failed += 1;
      continue;
    }

    let record: CaptureRecord;
    try {
      record = JSON.parse(raw.trim()) as CaptureRecord;
    } catch {
      failed += 1;
      continue;
    }

    const validErr = validateCaptureRecord(record);
    if (validErr) {
      failed += 1;
      continue;
    }

    const submittedPath = join(submittedDir, `${record.id}.md`);

    if (existsSync(submittedPath)) {
      // Already migrated — remove the stale legacy file.
      try {
        rmSync(filePath);
        migrated += 1;
        ids.push(record.id);
      } catch {
        failed += 1;
      }
      continue;
    }

    try {
      if (!existsSync(submittedDir)) {
        mkdirSync(submittedDir, { recursive: true });
      }

      const now = opts.now ?? new Date();
      const migrateEntry: AuditEntry = {
        action: 'migrated-from-legacy',
        by: 'cli-capture migrate-legacy',
        at: now.toISOString(),
      };

      const migratedRecord: CaptureRecord = {
        ...record,
        auditTrail: [...record.auditTrail, migrateEntry],
      };

      writeFileSync(submittedPath, captureToMarkdown(migratedRecord), { encoding: 'utf8' });
      rmSync(filePath);
      migrated += 1;
      ids.push(record.id);
    } catch {
      failed += 1;
    }
  }

  return { migrated, failed, ids };
}

// ── Redact a submitted capture ────────────────────────────────────────────────

export interface RedactSubmittedOpts {
  captureId: string;
  reason: string;
  redactedBy: string;
  repoRoot?: string;
  now?: Date;
}

/**
 * Redact a submitted capture in `backlog/captures/<id>.md`.
 *
 * Scrubs the `finding` field (and `source.context` / `evidence.additionalContext`)
 * but preserves the audit trail, per RFC-0024 §11 immutability contract.
 */
/**
 * Typed error thrown when a submitted capture file is missing.
 * AISDLC-320 review fix: use instanceof discriminator instead of message-string
 * matching so the cli-capture redact fallback to legacy JSONL doesn't silently
 * break if either error string is refactored.
 */
export class SubmittedCaptureNotFoundError extends Error {
  constructor(public readonly filePath: string) {
    super(`[cli-capture] not found: ${filePath}`);
    this.name = 'SubmittedCaptureNotFoundError';
  }
}

export function redactSubmittedCapture(opts: RedactSubmittedOpts): CaptureRecord {
  assertSafeCaptureId(opts.captureId);
  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const filePath = join(submittedDir, `${opts.captureId}.md`);

  if (!existsSync(filePath)) {
    throw new SubmittedCaptureNotFoundError(filePath);
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[cli-capture] cannot read ${filePath}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const record = parseMarkdownCapture(content);
  if (!record) throw new Error(`[cli-capture] cannot parse ${filePath}`);

  const validErr = validateCaptureRecord(record);
  if (validErr) throw new Error(`[cli-capture] corrupt record: ${validErr}`);

  const now = opts.now ?? new Date();
  const redactEntry: AuditEntry = {
    action: 'redacted',
    by: opts.redactedBy,
    at: now.toISOString(),
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

  writeFileSync(filePath, captureToMarkdown(redacted), { encoding: 'utf8' });

  return redacted;
}
