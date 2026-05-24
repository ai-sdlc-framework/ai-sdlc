/**
 * RFC-0025 §6 auto-routing — `framework-misbehaved` capture records are
 * appended to the quality corpus and optionally converted into backlog
 * tasks with `triage: framework-bug` labels.
 *
 * Phase 1 substrate (AISDLC-302): capture-append + feature-flag gate +
 * legacy CODEOWNERS attribution.
 *
 * Phase 4 (AISDLC-305 / OQ-4): the OQ-4 suggest-only attribution path.
 *  - Default behaviour is now suggest-only: the task is written WITHOUT
 *    an assignee; the resolved CODEOWNERS candidates (top
 *    `suggestionCount`) are returned to the caller for surfacing in the
 *    TUI / Slack DM, where the operator confirms before any assignment
 *    happens.
 *  - Per-org opt-in via `quality.framework-bug.autoAttribute: true` in
 *    `.ai-sdlc/quality-monitoring.yaml` flips the default to
 *    force-assign — the top candidates are written directly into the
 *    task's `assignee:` frontmatter.
 *  - The attribution backends are pluggable through
 *    `attributionSources: ['codeowners', ...]` — Phase 4 ships only the
 *    `codeowners` backend; `git-blame` and `recent-pr` are v2 extensions
 *    documented in RFC-0025 §13.1 but NOT implemented in this phase.
 *  - LinkedIn-postmortem-style owner-blame is explicitly avoided per the
 *    OQ-4 resolution rationale (2026-05-15): wrong-assignment is more
 *    disruptive in small teams than no-assignment.
 *
 * The router composes with RFC-0024's emergent-capture flow:
 *   1. Every `framework-misbehaved` classification appends to
 *      `$ARTIFACTS_DIR/_quality/captures.jsonl`.
 *   2. When the feature flag is set, the task file is written to
 *      `backlog/tasks/` with `triage: framework-bug` + `priority:`
 *      derived from the composite severity + `assignee:` honouring the
 *      OQ-4 suggest-only-vs-auto-attribute knob.
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
import {
  loadQualityMonitoringConfig,
  type FrameworkBugAttributionConfig,
  type QualityMonitoringConfig,
} from './quality-monitoring-config.js';

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

// ── Attribution backends (OQ-4) ───────────────────────────────────────

/**
 * Resolve the CODEOWNERS-based assignee suggestion for a given source
 * hint. Returns an array of owner handles (e.g. `['@dominique']`) or an
 * empty array when no CODEOWNERS file exists or no pattern matches.
 *
 * Phase 4 (AISDLC-305 / OQ-4): this is the `codeowners` attribution
 * backend; the router calls it via `resolveAttributionCandidates()` for
 * every source listed in `frameworkBug.attributionSources`. The legacy
 * direct callers (e.g. tests) continue to work because the contract is
 * unchanged.
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

/**
 * OQ-4 attribution dispatch — resolves candidates across every backend in
 * `attributionSources`, in order, dedupes (preserving first-occurrence
 * order), and caps at `suggestionCount`.
 *
 * Phase 4 ships only `'codeowners'`; unknown backends are silently
 * skipped (matches the §13.1 forward-compat extensibility contract for
 * `git-blame` / `recent-pr`). The router never throws on an unknown
 * backend — operators get the candidates from the backends that ARE
 * implemented.
 *
 * Returns at most `suggestionCount` candidates. When zero backends
 * resolve anything (no CODEOWNERS file, no matching pattern, no source
 * hint), returns an empty array; the caller surfaces the empty list as
 * "no candidates suggested — operator picks a reviewer manually".
 */
export function resolveAttributionCandidates(
  workDir: string,
  sourceHint: string | undefined,
  attribution: FrameworkBugAttributionConfig,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const source of attribution.attributionSources) {
    if (source === 'codeowners') {
      for (const candidate of resolveCodeownersAssignee(workDir, sourceHint)) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        candidates.push(candidate);
        if (candidates.length >= attribution.suggestionCount) return candidates;
      }
    }
    // 'git-blame' and 'recent-pr' are §13.1-documented v2 extensions —
    // silently skip until they ship rather than throwing or warning,
    // because operators may have copy-pasted the §13.1 example into
    // their config in anticipation of them being available.
  }
  return candidates;
}

// ── Backlog task auto-writer (§6) ──────────────────────────────────────

export interface RouteOpts {
  /** Project root for CODEOWNERS lookup + backlog tasks dir. */
  workDir?: string;
  artifactsDir?: string;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  /**
   * Pre-resolved `QualityMonitoringConfig` override (test convenience).
   * When supplied, bypasses `loadQualityMonitoringConfig({ workDir })` —
   * useful in unit tests that want to drive the OQ-4 branches without
   * writing a `.ai-sdlc/quality-monitoring.yaml` to disk for each case.
   */
  qualityMonitoringConfig?: QualityMonitoringConfig;
}

export interface RouteResult {
  /** Whether the auto-routing produced a backlog task file. */
  taskFileWritten: boolean;
  /** Path to the task file, if written. */
  taskFilePath?: string;
  /**
   * Suggested assignees from the OQ-4 attribution backends, capped at
   * `suggestionCount`. ALWAYS populated when backends resolved
   * candidates, regardless of `autoAttribute` — the suggest-only UX
   * surfaces them via the TUI / Slack DM; auto-attribute also writes
   * them to the task frontmatter.
   *
   * The semantic of `assignees` is "who the framework thinks could
   * investigate" — see `assigneesAutoApplied` for "who was force-written
   * to the task file".
   */
  assignees: string[];
  /**
   * Whether the suggested assignees were force-written to the task's
   * `assignee:` frontmatter (OQ-4 `autoAttribute: true`) or left as a
   * suggestion (`autoAttribute: false`, the default).
   *
   * The TUI / Slack DM surfaces the suggestion to the operator when
   * `false`; the operator confirms (or rejects) assignment via the
   * existing RFC-0024 triage UX before the framework touches `assignee:`.
   */
  assigneesAutoApplied: boolean;
  /** Whether the feature flag was on. */
  featureFlagEnabled: boolean;
}

/**
 * Full auto-routing path for a `framework-misbehaved` capture:
 *
 * 1. Append the capture record to the corpus (always).
 * 2. When `AI_SDLC_FRAMEWORK_QUALITY_MONITORING=experimental` is set,
 *    write a backlog task with `triage: framework-bug` + `priority:` from
 *    the composite severity + `assignee:` honouring the OQ-4
 *    suggest-only-vs-auto-attribute knob.
 *
 * OQ-4 attribution (AISDLC-305 / Phase 4):
 *   - Default (`autoAttribute: false`, the §13.1 small-team default): the
 *     task is written with `assignee: []`. The resolved candidates are
 *     returned in `RouteResult.assignees` for the TUI / Slack DM to
 *     surface as a suggestion the operator confirms before any
 *     assignment.
 *   - Opt-in (`autoAttribute: true`, per-org override): the top
 *     `suggestionCount` candidates are written directly to the task's
 *     `assignee:` frontmatter.
 *   - In both branches, the body's "Suggested investigators" section
 *     lists the candidates so the operator has a complete audit trail
 *     of who the attribution backends nominated.
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
    return {
      taskFileWritten: false,
      assignees: [],
      assigneesAutoApplied: false,
      featureFlagEnabled: false,
    };
  }

  // Step 2: resolve OQ-4 attribution config (per-org overridable via
  // `.ai-sdlc/quality-monitoring.yaml`; tests inject via `opts.qualityMonitoringConfig`).
  // Load failures (e.g. OQ-10 vendor-namespace violation in the config) MUST
  // NOT block routing — the audit trail (Step 1) already landed and the
  // task-write path is the operator's actionable surface. Swallow the
  // exception, log it as info, and proceed with attribution-disabled.
  const workDir = opts.workDir ?? process.cwd();
  let attribution: FrameworkBugAttributionConfig;
  if (opts.qualityMonitoringConfig) {
    attribution = opts.qualityMonitoringConfig.frameworkBug;
  } else {
    try {
      attribution = loadQualityMonitoringConfig({ workDir }).frameworkBug;
    } catch (err) {
      opts.logger?.info?.(
        `[quality-router] quality-monitoring.yaml load failed (proceeding with suggest-only default): ${(err as Error).message}`,
      );
      attribution = {
        autoAttribute: false,
        attributionSources: ['codeowners'],
        suggestionCount: 3,
      };
    }
  }
  const assignees = resolveAttributionCandidates(workDir, record.source, attribution);
  const assigneesAutoApplied = attribution.autoAttribute && assignees.length > 0;

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

  // OQ-4: only force-write `assignee:` when the per-org `autoAttribute: true`
  // toggle is set. Default suggest-only writes `assignee: []` and surfaces
  // candidates via RouteResult.assignees instead.
  if (assigneesAutoApplied) {
    frontmatter.push(`assignee:`);
    for (const a of assignees) frontmatter.push(`  - ${a}`);
  } else {
    frontmatter.push(`assignee: []`);
  }

  frontmatter.push('---', '');

  // OQ-4 audit trail: always render the suggested investigators block
  // (regardless of autoAttribute) so the operator can see who the
  // backends nominated. When suggest-only, this is the operator's
  // primary attribution UX inside the task; when auto-attribute, it's
  // a record of the decision the framework made on their behalf.
  const suggestedSection: string[] =
    assignees.length > 0
      ? [
          `### Suggested investigators (OQ-4 attribution)`,
          '',
          ...assignees.map((a) => `- ${a}`),
          '',
          assigneesAutoApplied
            ? `_Per \`quality.framework-bug.autoAttribute: true\`, the candidates above were force-written to \`assignee:\` on creation._`
            : `_Suggest-only mode (default per RFC-0025 §13.1 / OQ-4). Confirm assignment via the TUI / Slack DM before the framework writes \`assignee:\`._`,
          '',
        ]
      : [
          `### Suggested investigators (OQ-4 attribution)`,
          '',
          `_No candidates resolved. Configure \`.github/CODEOWNERS\` or extend \`quality.framework-bug.attributionSources\` to enable suggest-only attribution._`,
          '',
        ];

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
    ...suggestedSection,
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
    return {
      taskFileWritten: true,
      taskFilePath: filePath,
      assignees,
      assigneesAutoApplied,
      featureFlagEnabled: true,
    };
  } catch (err) {
    opts.logger?.warn(
      `[quality-router] failed to write framework-bug task (non-fatal): ${(err as Error).message}`,
    );
    return {
      taskFileWritten: false,
      assignees,
      assigneesAutoApplied,
      featureFlagEnabled: true,
    };
  }
}
