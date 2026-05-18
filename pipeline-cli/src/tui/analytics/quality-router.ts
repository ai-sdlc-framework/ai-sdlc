/**
 * RFC-0025 §6 auto-routing — `framework-misbehaved` capture records are
 * appended to the quality corpus and optionally converted into backlog
 * tasks with `triage: framework-bug` labels.
 * SUBSTRATE (AISDLC-302 Phase 1 / salvaged from PR #481).
 *
 * The router composes with RFC-0024's emergent-capture flow:
 *   1. Every `framework-misbehaved` classification appends to
 *      `$ARTIFACTS_DIR/_quality/captures.jsonl`.
 *   2. When the feature flag is set, the task file is written to
 *      `backlog/tasks/` with `triage: framework-bug` + `priority:`
 *      derived from the composite severity.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PHASE 1 SUBSTRATE NOTES (AISDLC-302)
 * ─────────────────────────────────────────────────────────────────────
 * `appendFrameworkCapture()` and `isQualityMonitoringEnabled()` are
 * fully aligned with operator-affirmed resolutions and are kept intact.
 *
 * ⚠️  TODO(AISDLC-305 / Phase 4 / OQ-4): `routeFrameworkBug()` currently
 * auto-attributes via CODEOWNERS by default. The operator-affirmed OQ-4
 * resolution requires attribution to be "suggest-only" by default: the
 * task is written WITHOUT an assignee, and the operator reviews the
 * CODEOWNERS suggestion in a separate UX flow before committing the
 * attribution. Phase 4 will replace the CODEOWNERS write-on-create logic
 * with the suggest-only model (per-org configurable, controlled by
 * `.ai-sdlc/quality-monitoring.yaml`).
 * ─────────────────────────────────────────────────────────────────────
 *
 * Feature-flag gate: the auto-routing path (step 2) fires only when
 * `AI_SDLC_FRAMEWORK_QUALITY_MONITORING=experimental` is set.
 * The capture step (step 1) always fires when the classifier returns a
 * `framework-misbehaved` result — so the audit trail is preserved even
 * when auto-routing is off.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FrameworkBugCaptureRecord } from './quality-classifier.js';
import { FRAMEWORK_QUALITY_DIRNAME, FRAMEWORK_QUALITY_CAPTURES_FILE } from './quality-reader.js';
import { resolveArtifactsDir } from '../sources/types.js';
import type { CompositeSeverity } from './quality-classifier.js';

// ── Feature flag ──────────────────────────────────────────────────────

const FLAG = 'AI_SDLC_FRAMEWORK_QUALITY_MONITORING';

export function isQualityMonitoringEnabled(): boolean {
  const val = process.env[FLAG] ?? '';
  return /^(experimental|1|true|yes|on)$/i.test(val.trim());
}

// ── Severity → priority mapping ───────────────────────────────────────

const SEVERITY_TO_PRIORITY: Record<CompositeSeverity, string> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
};

// ── Captures writer ────────────────────────────────────────────────────

export interface AppendCaptureOpts {
  artifactsDir?: string;
  /** Logger — best-effort; errors are swallowed to protect the caller. */
  logger?: { warn: (msg: string) => void };
}

/**
 * Append a `framework-misbehaved` capture record to the captures corpus
 * (`$ARTIFACTS_DIR/_quality/captures.jsonl`).
 *
 * Always runs regardless of the feature flag — the capture is the audit
 * trail. Flag only gates the backlog-task auto-routing in
 * `routeFrameworkBug()`.
 *
 * Best-effort: write failures are swallowed so a transient disk issue
 * never crashes the orchestrator hot loop.
 */
export function appendFrameworkCapture(
  record: FrameworkBugCaptureRecord,
  opts: AppendCaptureOpts = {},
): void {
  try {
    const artifactsDir = resolveArtifactsDir({ artifactsDir: opts.artifactsDir });
    const dir = join(artifactsDir, FRAMEWORK_QUALITY_DIRNAME);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, FRAMEWORK_QUALITY_CAPTURES_FILE);
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    opts.logger?.warn(
      `[quality-router] capture append failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ── CODEOWNERS heuristic (OQ-4 placeholder) ───────────────────────────

/**
 * Resolve the CODEOWNERS-based assignee suggestion for a given source
 * hint. Returns an array of owner handles (e.g. `['@dominique']`) or an
 * empty array when no CODEOWNERS file exists or no pattern matches.
 *
 * ⚠️  TODO(AISDLC-305 / Phase 4 / OQ-4): This is a SUGGESTION helper only.
 * Phase 4 will wire this into a suggest-only UX: the returned handles are
 * surfaced to the operator for review, not written directly to the task
 * frontmatter on creation.
 */
export function resolveCodeownersAssignee(workDir: string, sourceHint?: string): string[] {
  const candidates = [join(workDir, '.github', 'CODEOWNERS'), join(workDir, 'CODEOWNERS')];
  let raw: string | null = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        raw = readFileSync(p, 'utf8');
        break;
      } catch {
        // skip unreadable
      }
    }
  }
  if (!raw || !sourceHint) return [];

  // Walk CODEOWNERS lines in reverse (last match wins per GitHub semantics)
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  let bestOwners: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const pattern = parts[0] ?? '';
    const owners = parts.slice(1);
    if (!pattern || owners.length === 0) continue;
    // Simple glob match: single-pass alternation handles `**` and `*`
    // without re-replacing previous conversions.
    const regexStr = '^' + pattern.replace(/\*\*/g, '.*').replace(/(?<!\*)\*(?!\*)/g, '[^/]*');
    try {
      if (new RegExp(regexStr).test(sourceHint)) {
        bestOwners = owners;
      }
    } catch {
      // skip bad patterns
    }
  }
  return bestOwners;
}

// ── Backlog task auto-writer (§6) ──────────────────────────────────────

export interface RouteOpts {
  /** Project root for CODEOWNERS lookup + backlog tasks dir. */
  workDir?: string;
  artifactsDir?: string;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

export interface RouteResult {
  /** Whether the auto-routing produced a backlog task file. */
  taskFileWritten: boolean;
  /** Path to the task file, if written. */
  taskFilePath?: string;
  /** Suggested assignees from CODEOWNERS heuristic (not auto-applied — see Phase 4). */
  assignees: string[];
  /** Whether the feature flag was on. */
  featureFlagEnabled: boolean;
}

/**
 * Full auto-routing path for a `framework-misbehaved` capture:
 *
 * 1. Append the capture record to the corpus (always).
 * 2. When `AI_SDLC_FRAMEWORK_QUALITY_MONITORING=experimental` is set,
 *    write a backlog task with `triage: framework-bug` + `priority:` from
 *    the composite severity.
 *
 * ⚠️  TODO(AISDLC-305 / Phase 4 / OQ-4): Currently writes `assignee:`
 * directly from CODEOWNERS. Phase 4 switches to suggest-only: the task is
 * written WITHOUT an assignee, and the CODEOWNERS suggestion is surfaced
 * in a separate operator-review UX step.
 *
 * Task title: `chore: investigate framework bug — <subclass>`
 * Task ID: auto-generated from `framework-bug-<subclass>-<ts>` pattern.
 */
export function routeFrameworkBug(
  record: FrameworkBugCaptureRecord,
  opts: RouteOpts = {},
): RouteResult {
  const flagEnabled = isQualityMonitoringEnabled();

  // Step 1: always append capture
  appendFrameworkCapture(record, { artifactsDir: opts.artifactsDir, logger: opts.logger });

  if (!flagEnabled) {
    return { taskFileWritten: false, assignees: [], featureFlagEnabled: false };
  }

  // Step 2: resolve CODEOWNERS assignees (suggestion — Phase 4 flips to suggest-only)
  const workDir = opts.workDir ?? process.cwd();
  const assignees = resolveCodeownersAssignee(workDir, record.source);

  // Build a deterministic task ID from subclass + timestamp
  const tsSlug = record.ts.replace(/[^0-9T]/g, '').slice(0, 15); // e.g. 20260513T120000
  const subclassSlug = record.subclass.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const taskId = `framework-bug-${subclassSlug}-${tsSlug}`;
  const priority = SEVERITY_TO_PRIORITY[record.severity.composite] ?? 'medium';

  const frontmatter: string[] = [
    '---',
    `id: ${taskId}`,
    `title: 'chore: investigate framework bug - ${record.subclass}'`,
    `status: To Do`,
    `created_date: '${record.ts.slice(0, 10)}'`,
    `labels:`,
    `  - triage: framework-bug`,
    `  - rfc-0025`,
    `priority: ${priority}`,
    `dispatchable: false`,
    `dispatchableReason: 'Framework bug investigation — requires human judgment to determine root cause and fix'`,
  ];

  if (assignees.length > 0) {
    frontmatter.push(`assignee:`);
    for (const a of assignees) frontmatter.push(`  - ${a}`);
  } else {
    frontmatter.push(`assignee: []`);
  }

  frontmatter.push('---', '');

  const body = [
    `## Framework Bug Report — ${record.subclass}`,
    '',
    `Auto-filed by RFC-0025 failure-mode classifier at ${record.ts}.`,
    '',
    `**Composite severity:** ${record.severity.composite}`,
    `**Operator time cost:** ${record.severity.axes.operatorTimeCost}`,
    `**Blast radius:** ${record.severity.axes.blastRadius}`,
    `**Frequency:** ${record.severity.axes.frequency}`,
    '',
    `**Subclass:** \`${record.subclass}\``,
    '',
    `### Rationale`,
    '',
    record.auditTrail.classificationResult.rationale,
    '',
    `### Original failure`,
    '',
    '```',
    `Exit code: ${record.auditTrail.originalFailure.exitCode ?? 'n/a'}`,
    `Source: ${record.auditTrail.originalFailure.source ?? 'n/a'}`,
    record.auditTrail.originalFailure.stderr.slice(0, 500) || '(no stderr)',
    '```',
    '',
    `### Investigation checklist`,
    '',
    `- [ ] Reproduce the failure scenario`,
    `- [ ] Identify the root cause in framework code`,
    `- [ ] File a fix PR with test coverage`,
    `- [ ] Update the playbook handler to prevent recurrence`,
  ];

  if (record.taskId) body.push('', `Related task: ${record.taskId}`);

  const content = frontmatter.join('\n') + body.join('\n') + '\n';

  // Write to backlog/tasks/
  const tasksDir = join(workDir, 'backlog', 'tasks');
  const fileName = `${taskId}.md`;
  const filePath = join(tasksDir, fileName);

  try {
    if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
    writeFileSync(filePath, content, 'utf8');
    opts.logger?.info?.(`[quality-router] wrote framework-bug task: ${filePath}`);
    return { taskFileWritten: true, taskFilePath: filePath, assignees, featureFlagEnabled: true };
  } catch (err) {
    opts.logger?.warn(
      `[quality-router] failed to write framework-bug task (non-fatal): ${(err as Error).message}`,
    );
    return { taskFileWritten: false, assignees, featureFlagEnabled: true };
  }
}
