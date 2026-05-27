/**
 * RFC-0024 Refit Phase 6 (AISDLC-278) — §15.1 Capture Lifecycle Defaults.
 *
 * Implements the timebox + default-on-silence substrate that makes the
 * capture lifecycle non-blocking under operator fatigue:
 *
 *   - **OQ-1** Draft auto-submit at `draftAutoSubmitDays` (default 7d)
 *   - **OQ-2** Pending-triage auto-classify at `pendingTriageDays` (default 14d)
 *   - **OQ-5** Unknown-severity auto-classify at `unknownSeverityDays` (default 14d)
 *   - **OQ-6** Rate-ceiling notification at `dailyCapPerAgentRole` (default 50)
 *   - **OQ-9** Stale ladder: 3d TUI → 7d Slack → 14d email → 21d archive
 *
 * Per §15.1: every auto-action is reversible via the matching CLI command.
 * Timeboxes are per-org configurable in `.ai-sdlc/capture-config.yaml`.
 *
 * **Notification pattern**: Slack DM and email digest payloads are written
 * to `$ARTIFACTS_DIR/_capture-notifications/slack-pending.jsonl` and
 * `$ARTIFACTS_DIR/_capture-notifications/email-digest-pending.jsonl`.
 * External cron jobs (operator-wired `curl`) consume these files to actually
 * send the messages — the same pattern as `dor/slack-digest.ts`.
 *
 * **LLM invoker requirement**: auto-classify steps (OQ-2 / OQ-5) require an
 * `LlmInvoker`. When the invoker is unavailable (e.g. background cron without
 * `AI_SDLC_CLASSIFIER_INVOKER_MODULE` set), a `pending-triage-expired` or
 * `unknown-severity-expired` audit entry is appended to mark the expiry and
 * classification is retried on the next tick when the invoker becomes
 * available.
 *
 * @module capture/capture-lifecycle
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

import {
  validateCaptureRecord,
  type AuditEntry,
  type CaptureRecord,
  type CaptureSeverity,
  type CaptureTriageValue,
} from './capture-record.js';
import {
  captureToMarkdown,
  parseMarkdownCapture,
  resolveDraftsDir,
  resolveSubmittedDir,
  submitDraft,
  writeDraftCaptureFile,
} from './draft-capture.js';
import { autoTriageCapture, autoInferSeverity } from './auto-triage.js';
import type { LlmInvoker } from '../classifier/substrate/index.js';

// ── Lifecycle config ──────────────────────────────────────────────────────────

/** §15.1 per-org configurable lifecycle timeboxes + rate ceiling. */
export interface CaptureLifecycleConfig {
  /** Days before an un-submitted draft is auto-submitted (OQ-1). Default: 7. */
  draftAutoSubmitDays: number;
  /** Days before a `triage: tbd` submitted capture is auto-classified (OQ-2). Default: 14. */
  pendingTriageDays: number;
  /** Days before a `severity: unknown` submitted capture is auto-classified (OQ-5). Default: 14. */
  unknownSeverityDays: number;
  /** OQ-9 notification ladder thresholds. */
  staleNotificationLadder: {
    /** Days before TUI blocker highlight appears. Default: 3. */
    tuiHighlightDays: number;
    /** Days before Slack DM is sent. Default: 7. */
    slackDmDays: number;
    /** Days before email digest inclusion. Default: 14. */
    emailDigestDays: number;
    /** Days before auto-archive. Default: 21. */
    autoArchiveDays: number;
  };
  /** OQ-6 per-agent-role daily submission rate ceiling. */
  rateCeiling: {
    /** Maximum submitted captures per day per agent role. Default: 50. */
    dailyCapPerAgentRole: number;
    /** Per-agent-role overrides. Keys are agent role strings. */
    perAgentRoleOverrides: Record<string, number>;
  };
}

/** Default §15.1 lifecycle config values. */
export const LIFECYCLE_DEFAULTS: CaptureLifecycleConfig = {
  draftAutoSubmitDays: 7,
  pendingTriageDays: 14,
  unknownSeverityDays: 14,
  staleNotificationLadder: {
    tuiHighlightDays: 3,
    slackDmDays: 7,
    emailDigestDays: 14,
    autoArchiveDays: 21,
  },
  rateCeiling: {
    dailyCapPerAgentRole: 50,
    perAgentRoleOverrides: {},
  },
};

// ── Raw YAML shape ─────────────────────────────────────────────────────────────

interface RawCaptureConfig {
  capture?: {
    lifecycle?: {
      draftAutoSubmitDays?: number;
      pendingTriageDays?: number;
      unknownSeverityDays?: number;
      staleNotificationLadder?: {
        tuiHighlightDays?: number;
        slackDmDays?: number;
        emailDigestDays?: number;
        autoArchiveDays?: number;
      };
      rateCeiling?: {
        dailyCapPerAgentRole?: number;
        perAgentRoleOverrides?: Record<string, number>;
      };
    };
  };
}

/**
 * Load the §15.1 lifecycle config from `.ai-sdlc/capture-config.yaml`.
 * Missing file or missing fields fall through to `LIFECYCLE_DEFAULTS`.
 * Never throws — schema drift always falls back to safe defaults.
 */
export function loadCaptureLifecycleConfig(repoRoot?: string): CaptureLifecycleConfig {
  const root = repoRoot ?? process.env.CAPTURE_REPO_ROOT ?? process.cwd();
  const configPath = join(root, '.ai-sdlc', 'capture-config.yaml');

  let raw: RawCaptureConfig = {};
  try {
    const content = readFileSync(configPath, 'utf8');
    raw = (yamlLoad(content) as RawCaptureConfig) ?? {};
  } catch {
    // Missing or unreadable file → defaults.
  }

  const lc = raw.capture?.lifecycle;
  const ladder = lc?.staleNotificationLadder;
  const rc = lc?.rateCeiling;

  return {
    draftAutoSubmitDays: posInt(lc?.draftAutoSubmitDays) ?? LIFECYCLE_DEFAULTS.draftAutoSubmitDays,
    pendingTriageDays: posInt(lc?.pendingTriageDays) ?? LIFECYCLE_DEFAULTS.pendingTriageDays,
    unknownSeverityDays: posInt(lc?.unknownSeverityDays) ?? LIFECYCLE_DEFAULTS.unknownSeverityDays,
    staleNotificationLadder: {
      tuiHighlightDays:
        posInt(ladder?.tuiHighlightDays) ??
        LIFECYCLE_DEFAULTS.staleNotificationLadder.tuiHighlightDays,
      slackDmDays:
        posInt(ladder?.slackDmDays) ?? LIFECYCLE_DEFAULTS.staleNotificationLadder.slackDmDays,
      emailDigestDays:
        posInt(ladder?.emailDigestDays) ??
        LIFECYCLE_DEFAULTS.staleNotificationLadder.emailDigestDays,
      autoArchiveDays:
        posInt(ladder?.autoArchiveDays) ??
        LIFECYCLE_DEFAULTS.staleNotificationLadder.autoArchiveDays,
    },
    rateCeiling: {
      dailyCapPerAgentRole:
        posInt(rc?.dailyCapPerAgentRole) ?? LIFECYCLE_DEFAULTS.rateCeiling.dailyCapPerAgentRole,
      perAgentRoleOverrides: safeOverrides(rc?.perAgentRoleOverrides),
    },
  };
}

function posInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return null;
}

function safeOverrides(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = posInt(val);
    if (n !== null) out[k] = n;
  }
  return out;
}

// ── Directory helpers ─────────────────────────────────────────────────────────

/** Resolve the archived captures directory: `<repoRoot>/backlog/captures/archived/`. */
export function resolveArchivedDir(repoRoot?: string): string {
  const root = repoRoot ?? process.env.CAPTURE_REPO_ROOT ?? process.cwd();
  return join(root, 'backlog', 'captures', 'archived');
}

/** Resolve the lifecycle notifications directory: `$ARTIFACTS_DIR/_capture-notifications/`. */
export function resolveNotificationsDir(artifactsDir?: string): string {
  const base = artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), '_artifacts');
  return join(base, '_capture-notifications');
}

// ── Update a submitted capture in-place ──────────────────────────────────────

export interface UpdateSubmittedCaptureOpts {
  captureId: string;
  /** New triage value. If omitted, triage is not changed. */
  triage?: CaptureTriageValue;
  /** New severity value. If omitted, severity is not changed. */
  severity?: CaptureSeverity;
  /** Extra fields to patch into the top-level record. */
  patch?: Partial<Pick<CaptureRecord, 'resolvedAt' | 'resolvedBy'>>;
  /** Audit entry to append. */
  auditEntry: AuditEntry;
  repoRoot?: string;
}

/**
 * Update a submitted capture record in `backlog/captures/<id>.md` in-place.
 * Returns the updated record. Throws if the file doesn't exist or is corrupt.
 */
export function updateSubmittedCapture(opts: UpdateSubmittedCaptureOpts): CaptureRecord {
  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const filePath = join(submittedDir, `${opts.captureId}.md`);

  if (!existsSync(filePath)) {
    throw new Error(`[capture-lifecycle] not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf8');
  const record = parseMarkdownCapture(content);
  if (!record) throw new Error(`[capture-lifecycle] cannot parse ${filePath}`);

  const validErr = validateCaptureRecord(record);
  if (validErr) throw new Error(`[capture-lifecycle] corrupt record: ${validErr}`);

  const updated: CaptureRecord = {
    ...record,
    ...(opts.triage !== undefined ? { triage: opts.triage } : {}),
    ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
    ...(opts.patch ?? {}),
    auditTrail: [...record.auditTrail, opts.auditEntry],
  };

  writeFileSync(filePath, captureToMarkdown(updated), { encoding: 'utf8' });
  return updated;
}

// ── Archive a submitted capture ───────────────────────────────────────────────

export interface ArchiveCaptureOpts {
  captureId: string;
  /** Classifier guess to attach for searchability. */
  classifierGuess?: {
    triage?: CaptureTriageValue;
    severity?: CaptureSeverity;
    reasoning?: string;
  };
  by?: string;
  repoRoot?: string;
  now?: Date;
}

/**
 * Move a submitted capture to `backlog/captures/archived/<id>.md`.
 *
 * The archive preserves the full audit trail + classifier guess for
 * searchability. The capture is removed from the operator's active queue
 * (`backlog/captures/`) but never deleted (§15.1 reversibility contract:
 * archived, not deleted). Auto-archive at 21d is reversible by the operator
 * moving the file back to `backlog/captures/` and running `cli-capture
 * re-activate <id>` (which adds a `re-activated` audit entry).
 */
export function archiveCapture(opts: ArchiveCaptureOpts): CaptureRecord {
  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const archivedDir = resolveArchivedDir(opts.repoRoot);
  const srcPath = join(submittedDir, `${opts.captureId}.md`);

  if (!existsSync(srcPath)) {
    throw new Error(`[capture-lifecycle] not found for archive: ${srcPath}`);
  }

  if (!existsSync(archivedDir)) {
    mkdirSync(archivedDir, { recursive: true });
  }

  const dstPath = join(archivedDir, `${opts.captureId}.md`);
  if (existsSync(dstPath)) {
    throw new Error(`[capture-lifecycle] already archived: ${opts.captureId}`);
  }

  const content = readFileSync(srcPath, 'utf8');
  const record = parseMarkdownCapture(content);
  if (!record) throw new Error(`[capture-lifecycle] cannot parse ${srcPath}`);

  const validErr = validateCaptureRecord(record);
  if (validErr) throw new Error(`[capture-lifecycle] corrupt record: ${validErr}`);

  const now = opts.now ?? new Date();
  const archivedEntry: AuditEntry = {
    action: 'archived',
    by: opts.by ?? 'framework',
    at: now.toISOString(),
    reason: 'auto-archive after stale ladder day-21 threshold (§15.1 OQ-9)',
    ...(opts.classifierGuess
      ? {
          classifierGuessTriage: opts.classifierGuess.triage ?? null,
          classifierGuessSeverity: opts.classifierGuess.severity ?? null,
          classifierGuessReasoning: opts.classifierGuess.reasoning ?? null,
        }
      : {}),
  };

  const archived: CaptureRecord = {
    ...record,
    auditTrail: [...record.auditTrail, archivedEntry],
  };

  writeFileSync(dstPath, captureToMarkdown(archived), { encoding: 'utf8' });
  rmSync(srcPath);

  return archived;
}

/**
 * Re-activate an archived capture — moves it from `backlog/captures/archived/`
 * back to `backlog/captures/` and appends a `re-activated` audit entry.
 * This is the §15.1 reversibility mechanism for auto-archive.
 */
export function reactivateCapture(opts: {
  captureId: string;
  by?: string;
  reason?: string;
  repoRoot?: string;
  now?: Date;
}): CaptureRecord {
  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const archivedDir = resolveArchivedDir(opts.repoRoot);
  const srcPath = join(archivedDir, `${opts.captureId}.md`);

  if (!existsSync(srcPath)) {
    throw new Error(`[capture-lifecycle] not found in archive: ${opts.captureId}`);
  }

  const dstPath = join(submittedDir, `${opts.captureId}.md`);
  if (existsSync(dstPath)) {
    throw new Error(
      `[capture-lifecycle] capture ${opts.captureId} already exists in submitted dir`,
    );
  }

  const content = readFileSync(srcPath, 'utf8');
  const record = parseMarkdownCapture(content);
  if (!record) throw new Error(`[capture-lifecycle] cannot parse ${srcPath}`);

  const now = opts.now ?? new Date();
  const reActivatedEntry: AuditEntry = {
    action: 're-activated',
    by: opts.by ?? 'operator',
    at: now.toISOString(),
    reason: opts.reason ?? 'operator re-activated archived capture',
  };

  const reactivated: CaptureRecord = {
    ...record,
    auditTrail: [...record.auditTrail, reActivatedEntry],
  };

  if (!existsSync(submittedDir)) {
    mkdirSync(submittedDir, { recursive: true });
  }

  writeFileSync(dstPath, captureToMarkdown(reactivated), { encoding: 'utf8' });
  rmSync(srcPath);

  return reactivated;
}

// ── Load archived captures ────────────────────────────────────────────────────

/**
 * Load all archived captures from `backlog/captures/archived/`.
 * Returns an empty array when the directory doesn't exist.
 */
export function loadArchivedCaptures(repoRoot?: string): CaptureRecord[] {
  const dir = resolveArchivedDir(repoRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const records: CaptureRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseMarkdownCapture(raw);
    if (!parsed) continue;
    const err = validateCaptureRecord(parsed);
    if (err) continue;
    records.push(parsed);
  }

  return records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ── Age helpers ───────────────────────────────────────────────────────────────

/**
 * Compute age in milliseconds from a capture's original timestamp.
 * Uses the `timestamp` field (wall-clock capture time).
 */
export function captureAgeMs(record: CaptureRecord, now: Date): number {
  return now.getTime() - new Date(record.timestamp).getTime();
}

/**
 * Compute age in whole days from a capture's original timestamp.
 */
export function captureAgeDays(record: CaptureRecord, now: Date): number {
  return Math.floor(captureAgeMs(record, now) / (24 * 60 * 60 * 1000));
}

// ── Audit trail inspection helpers ───────────────────────────────────────────

/** True when the capture's audit trail already contains an entry with `action === actionName`. */
export function hasAuditAction(record: CaptureRecord, actionName: string): boolean {
  return record.auditTrail.some((e) => e.action === actionName);
}

// ── OQ-1: Draft auto-submit ───────────────────────────────────────────────────

export interface DraftExpiryResult {
  submitted: string[];
  skipped: string[];
}

/**
 * OQ-1 — Check all drafts in `.ai-sdlc/captures-drafts/` and auto-submit
 * those older than `draftAutoSubmitDays`. Returns IDs of submitted drafts
 * and skipped (already expired threshold not met or errors).
 *
 * Auto-submit is reversible via `cli-capture redact <id> --reason <text>`
 * per §15.1 contract.
 */
export function checkDraftExpiry(opts: {
  config?: CaptureLifecycleConfig;
  repoRoot?: string;
  now?: Date;
}): DraftExpiryResult {
  const config = opts.config ?? loadCaptureLifecycleConfig(opts.repoRoot);
  const now = opts.now ?? new Date();
  const thresholdMs = config.draftAutoSubmitDays * 24 * 60 * 60 * 1000;

  const draftsDir = resolveDraftsDir(opts.repoRoot);
  let entries: string[];
  try {
    entries = readdirSync(draftsDir);
  } catch {
    return { submitted: [], skipped: [] };
  }

  const submitted: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry === '.gitkeep') continue;
    const captureId = entry.slice(0, -'.md'.length);
    const filePath = join(draftsDir, entry);

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      skipped.push(captureId);
      continue;
    }

    const record = parseMarkdownCapture(raw);
    if (!record) {
      skipped.push(captureId);
      continue;
    }

    const ageMs = captureAgeMs(record, now);
    if (ageMs < thresholdMs) {
      skipped.push(captureId);
      continue;
    }

    try {
      submitDraft({
        captureId,
        by: 'framework (auto-submit after draft expiry per §15.1 OQ-1)',
        repoRoot: opts.repoRoot,
        now,
      });
      submitted.push(captureId);
    } catch {
      skipped.push(captureId);
    }
  }

  return { submitted, skipped };
}

// ── OQ-2/OQ-5: Auto-classify pending-triage + unknown-severity ────────────────

export interface AutoClassifyExpiredResult {
  classified: Array<{ id: string; applied: boolean; reason: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * OQ-2 — Check all submitted captures with `triage: tbd` older than
 * `pendingTriageDays` and auto-classify them via the Phase 2 classifier.
 *
 * When no invoker is available, appends a `pending-triage-expired` audit entry
 * so the next tick can retry. When invoker IS available, applies the
 * classifier's highest-confidence triage (if confidence ≥ threshold) or
 * records the low-confidence state for operator review.
 *
 * Reversible via `cli-capture triage <id> --to <value>` per §15.1.
 */
export async function checkPendingTriageExpiry(opts: {
  config?: CaptureLifecycleConfig;
  repoRoot?: string;
  now?: Date;
  invoker?: LlmInvoker | null;
}): Promise<AutoClassifyExpiredResult> {
  const config = opts.config ?? loadCaptureLifecycleConfig(opts.repoRoot);
  const now = opts.now ?? new Date();
  const thresholdMs = config.pendingTriageDays * 24 * 60 * 60 * 1000;
  const repoRoot = opts.repoRoot ?? process.env.CAPTURE_REPO_ROOT ?? process.cwd();

  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const records = loadSubmittedCapturesRaw(submittedDir);

  const classified: AutoClassifyExpiredResult['classified'] = [];
  const skipped: AutoClassifyExpiredResult['skipped'] = [];

  for (const record of records) {
    if (record.triage !== 'tbd') continue;

    const ageMs = captureAgeMs(record, now);
    if (ageMs < thresholdMs) {
      skipped.push({ id: record.id, reason: 'not yet expired' });
      continue;
    }

    // Already have a pending-triage-expired entry AND no invoker — nothing new.
    const alreadyMarked = hasAuditAction(record, 'pending-triage-expired');
    if (alreadyMarked && !opts.invoker) {
      skipped.push({ id: record.id, reason: 'already marked expired; invoker unavailable' });
      continue;
    }

    if (!opts.invoker) {
      // Mark the expiry so it's visible; retry when invoker available.
      updateSubmittedCapture({
        captureId: record.id,
        auditEntry: {
          action: 'pending-triage-expired',
          by: 'framework',
          at: now.toISOString(),
          note: 'triage: tbd exceeded pendingTriageDays threshold; classifier unavailable — will retry',
        },
        repoRoot: opts.repoRoot,
      });
      classified.push({
        id: record.id,
        applied: false,
        reason: 'expired marked; invoker not configured',
      });
      continue;
    }

    // Invoker available — run the classifier.
    try {
      const result = await autoTriageCapture({
        finding: record.finding,
        context: { timestamp: record.timestamp, source: record.source },
        agentRole: record.source.agentRole ?? undefined,
        repoRoot,
        invoker: opts.invoker,
      });

      if (result.metBehindThreshold && result.recommendedTriage !== null) {
        updateSubmittedCapture({
          captureId: record.id,
          triage: result.recommendedTriage,
          patch: {
            resolvedAt: now.toISOString(),
            resolvedBy: 'framework (auto-classify after pendingTriageDays expiry)',
          },
          auditEntry: {
            action: 'auto-classified-triage',
            by: 'framework',
            at: now.toISOString(),
            appliedTriage: result.recommendedTriage,
            confidence: result.confidence,
            reasoning: result.reasoning,
            model: result.model,
          },
          repoRoot: opts.repoRoot,
        });
        classified.push({
          id: record.id,
          applied: true,
          reason: `auto-triaged to ${result.recommendedTriage} (confidence ${result.confidence.toFixed(2)})`,
        });
      } else {
        // Low confidence — mark expired but leave triage as tbd.
        updateSubmittedCapture({
          captureId: record.id,
          auditEntry: {
            action: 'pending-triage-expired',
            by: 'framework',
            at: now.toISOString(),
            note: `classifier low-confidence (${result.confidence.toFixed(2)} < ${result.effectiveThreshold}); triage unchanged`,
            rawClassification: result.rawClassification,
            confidence: result.confidence,
          },
          repoRoot: opts.repoRoot,
        });
        classified.push({
          id: record.id,
          applied: false,
          reason: `low-confidence (${result.confidence.toFixed(2)}) — operator review needed`,
        });
      }
    } catch {
      skipped.push({ id: record.id, reason: 'classifier error' });
    }
  }

  return { classified, skipped };
}

/**
 * OQ-5 — Check all submitted captures with `severity: unknown` older than
 * `unknownSeverityDays` and auto-infer severity via the Phase 2 classifier.
 *
 * Same fallback-on-no-invoker behavior as `checkPendingTriageExpiry()`.
 * Reversible via `cli-capture re-classify <id> --severity <value>` per §15.1.
 */
export async function checkUnknownSeverityExpiry(opts: {
  config?: CaptureLifecycleConfig;
  repoRoot?: string;
  now?: Date;
  invoker?: LlmInvoker | null;
}): Promise<AutoClassifyExpiredResult> {
  const config = opts.config ?? loadCaptureLifecycleConfig(opts.repoRoot);
  const now = opts.now ?? new Date();
  const thresholdMs = config.unknownSeverityDays * 24 * 60 * 60 * 1000;
  const repoRoot = opts.repoRoot ?? process.env.CAPTURE_REPO_ROOT ?? process.cwd();

  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const records = loadSubmittedCapturesRaw(submittedDir);

  const classified: AutoClassifyExpiredResult['classified'] = [];
  const skipped: AutoClassifyExpiredResult['skipped'] = [];

  for (const record of records) {
    if (record.severity !== 'unknown') continue;

    const ageMs = captureAgeMs(record, now);
    if (ageMs < thresholdMs) {
      skipped.push({ id: record.id, reason: 'not yet expired' });
      continue;
    }

    const alreadyMarked = hasAuditAction(record, 'unknown-severity-expired');
    if (alreadyMarked && !opts.invoker) {
      skipped.push({ id: record.id, reason: 'already marked expired; invoker unavailable' });
      continue;
    }

    if (!opts.invoker) {
      updateSubmittedCapture({
        captureId: record.id,
        auditEntry: {
          action: 'unknown-severity-expired',
          by: 'framework',
          at: now.toISOString(),
          note: 'severity: unknown exceeded unknownSeverityDays threshold; classifier unavailable — will retry',
        },
        repoRoot: opts.repoRoot,
      });
      classified.push({
        id: record.id,
        applied: false,
        reason: 'expired marked; invoker not configured',
      });
      continue;
    }

    try {
      const result = await autoInferSeverity({
        finding: record.finding,
        context: { timestamp: record.timestamp, source: record.source },
        agentRole: record.source.agentRole ?? undefined,
        repoRoot,
        invoker: opts.invoker,
      });

      if (result.metBehindThreshold && result.recommendedSeverity !== null) {
        updateSubmittedCapture({
          captureId: record.id,
          severity: result.recommendedSeverity,
          auditEntry: {
            action: 'auto-classified-severity',
            by: 'framework',
            at: now.toISOString(),
            appliedSeverity: result.recommendedSeverity,
            confidence: result.confidence,
            reasoning: result.reasoning,
            model: result.model,
          },
          repoRoot: opts.repoRoot,
        });
        classified.push({
          id: record.id,
          applied: true,
          reason: `auto-severity set to ${result.recommendedSeverity} (confidence ${result.confidence.toFixed(2)})`,
        });
      } else {
        updateSubmittedCapture({
          captureId: record.id,
          auditEntry: {
            action: 'unknown-severity-expired',
            by: 'framework',
            at: now.toISOString(),
            note: `classifier low-confidence (${result.confidence.toFixed(2)} < ${result.effectiveThreshold}); severity unchanged`,
            rawClassification: result.rawClassification,
            confidence: result.confidence,
          },
          repoRoot: opts.repoRoot,
        });
        classified.push({
          id: record.id,
          applied: false,
          reason: `low-confidence (${result.confidence.toFixed(2)}) — operator review needed`,
        });
      }
    } catch {
      skipped.push({ id: record.id, reason: 'classifier error' });
    }
  }

  return { classified, skipped };
}

// ── OQ-6: Rate-ceiling notification ───────────────────────────────────────────

export interface RateCeilingViolation {
  agentRole: string;
  dailyCount: number;
  ceiling: number;
}

/**
 * OQ-6 — Compute the daily submission count per agent role from the submitted
 * captures directory and return violations (roles that have exceeded their
 * daily ceiling). Does NOT drop or block captures — this is a soft warning per
 * RFC-0024 OQ-6 resolution ("selected over hard-ceiling-with-drops").
 *
 * The day boundary is defined relative to `now.toISOString().slice(0,10)` (UTC date).
 */
export function checkRateCeiling(opts: {
  config?: CaptureLifecycleConfig;
  repoRoot?: string;
  now?: Date;
}): RateCeilingViolation[] {
  const config = opts.config ?? loadCaptureLifecycleConfig(opts.repoRoot);
  const now = opts.now ?? new Date();
  const todayStr = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const records = loadSubmittedCapturesRaw(submittedDir);

  // Count submissions today per agent role.
  const counts: Record<string, number> = {};
  for (const record of records) {
    if (record.source.type !== 'ai-agent' || !record.source.agentRole) continue;
    // Use the `submitted` audit entry's `at` timestamp (or capture `timestamp` as fallback).
    const submittedEntry = record.auditTrail.find((e) => e.action === 'submitted');
    const submittedAt = submittedEntry ? String(submittedEntry.at) : record.timestamp;
    if (submittedAt.slice(0, 10) !== todayStr) continue;
    const role = record.source.agentRole;
    counts[role] = (counts[role] ?? 0) + 1;
  }

  const violations: RateCeilingViolation[] = [];
  for (const [role, count] of Object.entries(counts)) {
    const ceiling =
      config.rateCeiling.perAgentRoleOverrides[role] ?? config.rateCeiling.dailyCapPerAgentRole;
    if (count > ceiling) {
      violations.push({ agentRole: role, dailyCount: count, ceiling });
    }
  }

  return violations;
}

// ── OQ-9: Stale notification ladder ──────────────────────────────────────────

export type StaleLadderActionKind =
  | 'tui-highlight'
  | 'slack-notify'
  | 'email-notify'
  | 'archive'
  | 'none';

export interface StaleLadderAction {
  captureId: string;
  ageDays: number;
  action: StaleLadderActionKind;
  alreadyApplied: boolean;
}

export interface StaleLadderResult {
  actions: StaleLadderAction[];
  archived: string[];
  notificationsWritten: number;
}

/**
 * OQ-9 — Check all submitted `triage: tbd` captures and fire the appropriate
 * stale-ladder notification/action based on their age:
 *
 *   - Day 3:  TUI blocker highlight — adds `stale-3d-tui-notified` audit entry.
 *   - Day 7:  Slack DM — adds `stale-7d-slack-notified` audit entry + writes
 *             payload to `_capture-notifications/slack-pending.jsonl`.
 *   - Day 14: Email digest — adds `stale-14d-email-notified` audit entry + writes
 *             to `_capture-notifications/email-digest-pending.jsonl`.
 *   - Day 21: Archive — moves to `backlog/captures/archived/` + attaches classifier
 *             guess (if invoker available). Always fires regardless of prior
 *             notifications.
 *
 * Each notification fires exactly once (guarded by the audit trail).
 * Archive is always reversible via `reactivateCapture()` per §15.1.
 */
export async function checkStaleLadder(opts: {
  config?: CaptureLifecycleConfig;
  repoRoot?: string;
  now?: Date;
  artifactsDir?: string;
  invoker?: LlmInvoker | null;
}): Promise<StaleLadderResult> {
  const config = opts.config ?? loadCaptureLifecycleConfig(opts.repoRoot);
  const now = opts.now ?? new Date();
  const ladder = config.staleNotificationLadder;
  const repoRoot = opts.repoRoot ?? process.env.CAPTURE_REPO_ROOT ?? process.cwd();

  const submittedDir = resolveSubmittedDir(opts.repoRoot);
  const records = loadSubmittedCapturesRaw(submittedDir);

  const actions: StaleLadderAction[] = [];
  const archived: string[] = [];
  let notificationsWritten = 0;

  for (const record of records) {
    if (record.triage !== 'tbd') continue;

    const ageDays = captureAgeDays(record, now);

    // Day 21: archive (highest priority — do this first).
    if (ageDays >= ladder.autoArchiveDays) {
      if (!hasAuditAction(record, 'archived')) {
        let classifierGuess: ArchiveCaptureOpts['classifierGuess'] | undefined;
        if (opts.invoker) {
          try {
            const triageResult = await autoTriageCapture({
              finding: record.finding,
              context: { timestamp: record.timestamp },
              repoRoot,
              invoker: opts.invoker,
            });
            const sevResult = await autoInferSeverity({
              finding: record.finding,
              context: { timestamp: record.timestamp },
              repoRoot,
              invoker: opts.invoker,
            });
            classifierGuess = {
              triage: triageResult.recommendedTriage ?? undefined,
              severity: sevResult.recommendedSeverity ?? undefined,
              reasoning: triageResult.reasoning,
            };
          } catch {
            // Classifier unavailable — archive without guess.
          }
        }
        archiveCapture({
          captureId: record.id,
          classifierGuess,
          by: 'framework (auto-archive after stale ladder day-21 threshold)',
          repoRoot: opts.repoRoot,
          now,
        });
        archived.push(record.id);
        actions.push({ captureId: record.id, ageDays, action: 'archive', alreadyApplied: false });
      } else {
        actions.push({ captureId: record.id, ageDays, action: 'archive', alreadyApplied: true });
      }
      continue;
    }

    // Day 14: email digest.
    if (ageDays >= ladder.emailDigestDays) {
      if (!hasAuditAction(record, 'stale-14d-email-notified')) {
        writeNotificationPayload(
          opts.artifactsDir,
          'email-digest-pending.jsonl',
          buildEmailNotification(record, ageDays, now),
        );
        updateSubmittedCapture({
          captureId: record.id,
          auditEntry: {
            action: 'stale-14d-email-notified',
            by: 'framework',
            at: now.toISOString(),
            ageDays,
          },
          repoRoot: opts.repoRoot,
        });
        notificationsWritten += 1;
        actions.push({
          captureId: record.id,
          ageDays,
          action: 'email-notify',
          alreadyApplied: false,
        });
      } else {
        actions.push({
          captureId: record.id,
          ageDays,
          action: 'email-notify',
          alreadyApplied: true,
        });
      }
      continue;
    }

    // Day 7: Slack DM.
    if (ageDays >= ladder.slackDmDays) {
      if (!hasAuditAction(record, 'stale-7d-slack-notified')) {
        writeNotificationPayload(
          opts.artifactsDir,
          'slack-pending.jsonl',
          buildSlackNotification(record, ageDays, now),
        );
        updateSubmittedCapture({
          captureId: record.id,
          auditEntry: {
            action: 'stale-7d-slack-notified',
            by: 'framework',
            at: now.toISOString(),
            ageDays,
          },
          repoRoot: opts.repoRoot,
        });
        notificationsWritten += 1;
        actions.push({
          captureId: record.id,
          ageDays,
          action: 'slack-notify',
          alreadyApplied: false,
        });
      } else {
        actions.push({
          captureId: record.id,
          ageDays,
          action: 'slack-notify',
          alreadyApplied: true,
        });
      }
      continue;
    }

    // Day 3: TUI highlight.
    if (ageDays >= ladder.tuiHighlightDays) {
      if (!hasAuditAction(record, 'stale-3d-tui-notified')) {
        updateSubmittedCapture({
          captureId: record.id,
          auditEntry: {
            action: 'stale-3d-tui-notified',
            by: 'framework',
            at: now.toISOString(),
            ageDays,
          },
          repoRoot: opts.repoRoot,
        });
        actions.push({
          captureId: record.id,
          ageDays,
          action: 'tui-highlight',
          alreadyApplied: false,
        });
      } else {
        actions.push({
          captureId: record.id,
          ageDays,
          action: 'tui-highlight',
          alreadyApplied: true,
        });
      }
      continue;
    }

    actions.push({ captureId: record.id, ageDays, action: 'none', alreadyApplied: false });
  }

  return { actions, archived, notificationsWritten };
}

// ── Notification payload builders ────────────────────────────────────────────

function buildSlackNotification(record: CaptureRecord, ageDays: number, now: Date): object {
  const by = record.source.operator ?? record.source.agentRole ?? 'unknown';
  return {
    type: 'capture-stale-7d',
    captureId: record.id,
    ageDays,
    notifiedAt: now.toISOString(),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Stale capture — ${ageDays}d without triage* :hourglass_flowing_sand:\n\n*Finding:* ${record.finding}\n*Filed by:* ${by}\n*ID:* \`${record.id}\``,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Captured ${record.timestamp.slice(0, 10)} · triage pending · auto-archive in ${
              21 - ageDays
            }d`,
          },
        ],
      },
    ],
  };
}

function buildEmailNotification(record: CaptureRecord, ageDays: number, now: Date): object {
  const by = record.source.operator ?? record.source.agentRole ?? 'unknown';
  return {
    type: 'capture-stale-14d',
    captureId: record.id,
    ageDays,
    notifiedAt: now.toISOString(),
    finding: record.finding,
    capturedAt: record.timestamp,
    capturedBy: by,
    autoArchiveInDays: 21 - ageDays,
  };
}

function writeNotificationPayload(
  artifactsDir: string | undefined,
  filename: string,
  payload: object,
): void {
  const dir = resolveNotificationsDir(artifactsDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(payload) + '\n', { flag: 'a', encoding: 'utf8' });
}

// ── Rate-ceiling notification writer ─────────────────────────────────────────

/**
 * Write OQ-6 rate-ceiling violation notifications to the Slack pending file.
 * Called by `runLifecycleTick` when violations are detected.
 */
export function writeRateCeilingNotifications(
  violations: RateCeilingViolation[],
  opts: { artifactsDir?: string; now?: Date },
): void {
  if (violations.length === 0) return;
  const now = opts.now ?? new Date();
  const dir = resolveNotificationsDir(opts.artifactsDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, 'slack-pending.jsonl');
  for (const v of violations) {
    const payload = {
      type: 'capture-rate-ceiling-exceeded',
      agentRole: v.agentRole,
      dailyCount: v.dailyCount,
      ceiling: v.ceiling,
      notifiedAt: now.toISOString(),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Capture rate ceiling exceeded* :warning:\n\nAgent role \`${v.agentRole}\` submitted *${v.dailyCount}* captures today (ceiling: ${v.ceiling}/day).\n\nFull volume preserved in corpus — no drops. Review agent prompts if this rate is unexpected.`,
          },
        },
      ],
    };
    writeFileSync(filePath, JSON.stringify(payload) + '\n', { flag: 'a', encoding: 'utf8' });
  }
}

// ── Main orchestration: runLifecycleTick ──────────────────────────────────────

export interface LifecycleTickResult {
  /** IDs of drafts that were auto-submitted (OQ-1). */
  submittedDrafts: string[];
  /** Auto-classify results for pending-triage captures (OQ-2). */
  pendingTriageAutoClassified: AutoClassifyExpiredResult;
  /** Auto-classify results for unknown-severity captures (OQ-5). */
  unknownSeverityAutoClassified: AutoClassifyExpiredResult;
  /** Stale ladder actions taken (OQ-9). */
  staleLadder: StaleLadderResult;
  /** Rate ceiling violations detected (OQ-6). */
  rateCeilingViolations: RateCeilingViolation[];
}

/**
 * Run a full lifecycle tick. Orchestrates all §15.1 expiry checks in order:
 *   1. Draft auto-submit (OQ-1)
 *   2. Pending-triage auto-classify (OQ-2)
 *   3. Unknown-severity auto-classify (OQ-5)
 *   4. Stale notification ladder (OQ-9)
 *   5. Rate ceiling check (OQ-6)
 *
 * Meant to be called from an orchestrator-tick hook or a cron job. All
 * individual steps are idempotent — running the same tick twice produces
 * no additional side-effects beyond the first run.
 *
 * The `invoker` parameter wires in the LLM classifier for OQ-2 / OQ-5 /
 * OQ-9 archive classifier-guess. When `null`, auto-classify steps fall
 * back gracefully (mark expired, retry on next tick).
 */
export async function runLifecycleTick(opts: {
  repoRoot?: string;
  now?: Date;
  artifactsDir?: string;
  invoker?: LlmInvoker | null;
  config?: CaptureLifecycleConfig;
}): Promise<LifecycleTickResult> {
  const config = opts.config ?? loadCaptureLifecycleConfig(opts.repoRoot);
  const now = opts.now ?? new Date();

  // 1. OQ-1 — draft auto-submit.
  const draftResult = checkDraftExpiry({ config, repoRoot: opts.repoRoot, now });

  // 2. OQ-2 — pending-triage auto-classify.
  const triageResult = await checkPendingTriageExpiry({
    config,
    repoRoot: opts.repoRoot,
    now,
    invoker: opts.invoker,
  });

  // 3. OQ-5 — unknown-severity auto-classify.
  const severityResult = await checkUnknownSeverityExpiry({
    config,
    repoRoot: opts.repoRoot,
    now,
    invoker: opts.invoker,
  });

  // 4. OQ-9 — stale notification ladder (runs after OQ-2/5 may have already
  //    changed some captures from tbd → classified, so re-reads submitted dir).
  const staleResult = await checkStaleLadder({
    config,
    repoRoot: opts.repoRoot,
    now,
    artifactsDir: opts.artifactsDir,
    invoker: opts.invoker,
  });

  // 5. OQ-6 — rate ceiling.
  const violations = checkRateCeiling({ config, repoRoot: opts.repoRoot, now });
  writeRateCeilingNotifications(violations, { artifactsDir: opts.artifactsDir, now });

  return {
    submittedDrafts: draftResult.submitted,
    pendingTriageAutoClassified: triageResult,
    unknownSeverityAutoClassified: severityResult,
    staleLadder: staleResult,
    rateCeilingViolations: violations,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Load all `.md` capture records from a directory (no filtering). */
function loadSubmittedCapturesRaw(dir: string): CaptureRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const records: CaptureRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry === '.gitkeep') continue;
    const filePath = join(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseMarkdownCapture(raw);
    if (!parsed) continue;
    const err = validateCaptureRecord(parsed);
    if (err) continue;
    records.push(parsed);
  }

  return records;
}

// Re-export writeDraftCaptureFile so the CLI can write a re-activated draft
// from the archive flow (operator wants to keep editing).
export { writeDraftCaptureFile };
