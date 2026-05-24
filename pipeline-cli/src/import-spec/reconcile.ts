/**
 * `cli-import-spec --reconcile` drift handling (RFC-0036 Phase 6 / AISDLC-331).
 *
 * ## What this is
 *
 * After Phase 4 (AISDLC-329) imported a spec-kit `tasks.md` row into a
 * backlog task with `specRef:` back-references, the upstream artifact can
 * churn at spec-kit's own pace. When the operator runs `--reconcile`, this
 * module:
 *
 *   1. Scans `backlog/{tasks,completed}/*.md` for tasks carrying a
 *      `specRef.source: spec-kit` block.
 *   2. Re-parses the upstream `specRef.artifactPath` with the same parser
 *      Phase 4 used.
 *   3. For each imported task, compares its in-tree body + ACs to the
 *      current upstream entry and classifies the drift per RFC-0035
 *      Stage A:
 *
 *      - `no-change` — upstream and task agree → silent no-op.
 *      - `typo` / `cosmetic` — low-severity (whitespace, punctuation,
 *        minor wording) → catalog auto-syncs the change into the task
 *        body and logs the Decision as auto-resolved.
 *      - `semantic` — meaningful body content change → catalog emits
 *        `Decision: spec-drift-detected` with a 24h override window per
 *        RFC-0024 §15.1; the operator gets a single batch-review entry.
 *      - `scope` — AC count change, AC text replacement, title change →
 *        same 24h-override Decision but explicitly tagged `scope`.
 *      - `removed-upstream` — the upstream entry vanished → marks the
 *        imported task `superseded` in a Decision; never auto-deletes.
 *
 * ## What this is NOT
 *
 *   - **Never halts an in-progress task.** Even when high-severity drift
 *     is detected against an `In Progress` task, the task continues
 *     against the version it was dispatched with. The drift Decision is
 *     surfaced for the operator's NEXT batch review.
 *   - **Never silently overwrites.** Low-severity auto-sync edits the
 *     task body in place + commits a Decision audit-trail entry so the
 *     operator can see what changed and override. Higher-severity drift
 *     is never written to the task body — only surfaced via Decision.
 *   - **Never deletes tasks.** Removed-upstream → `superseded` annotation
 *     on the imported task body's footer + Decision; the operator
 *     decides whether to close the task.
 *
 * ## Compositional contract (RFC-0035 G0)
 *
 * Every operator-impacting branch routes through the Decision Catalog
 * with auto-resolution OR timeboxed default-on-silence. Pipeline never
 * blocks on `--reconcile`; running it on a tree with N drifting tasks
 * produces N Decisions and zero pipeline interrupts.
 *
 * @module import-spec/reconcile
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  appendDecisionEvent,
  isDecisionCatalogEnabled,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  nextDecisionId,
  withEventLogLock,
} from '../decisions/index.js';

import {
  loadAdopterAuthoringConfig,
  type AdopterAuthoringConfig,
  type DriftSeverityAction,
} from './config.js';
import { parseTasksMd, type SpecKitTaskEntry } from './parser.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * RFC-0035 Stage A severity tiers used by the drift classifier. The five
 * non-`no-change` values map (per `driftHandling.severityThresholds`) to
 * the auto-sync vs defer-24h-window action.
 */
export type DriftSeverity =
  | 'no-change'
  | 'typo'
  | 'cosmetic'
  | 'semantic'
  | 'scope'
  | 'removed-upstream';

/**
 * Classify a drift between an imported task's snapshot of an upstream
 * entry and the current upstream entry. Pure function — no I/O, no
 * Decision side effects. Exported for hermetic testing.
 *
 * The classifier is intentionally deterministic for v1: a parsed-content
 * comparison that captures the four interesting cases without LLM
 * involvement. LLM-backed reclassification (via the shared classifier
 * substrate) is a future enhancement tracked in the Decision Catalog
 * under `import-spec:drift-classifier-llm` — keep the v1 contract
 * simple, fast, and reproducible.
 *
 * Severity escalation order (caller picks the highest matching tier):
 *
 *   1. `removed-upstream` — the upstream entry is gone.
 *   2. `scope` — title differs, OR the AC count changed, OR any AC text
 *      differs by more than typo-tier normalisation.
 *   3. `semantic` — body content materially differs (lengths or
 *      normalised text don't match).
 *   4. `cosmetic` — only whitespace / punctuation differences in body or
 *      AC text after normalisation.
 *   5. `typo` — single-line, length-bounded edit; reserved for future
 *      Levenshtein-distance classification. v1 collapses into
 *      `cosmetic` for the auto-sync tier — the per-severity action is
 *      what matters, not the sub-tier label.
 *   6. `no-change`.
 */
export function classifyDrift(
  taskSnapshot: TaskSnapshot,
  upstream: SpecKitTaskEntry | null,
): DriftSeverity {
  if (upstream === null) return 'removed-upstream';

  const titleSame = taskSnapshot.title.trim() === upstream.title.trim();
  if (!titleSame) return 'scope';

  // AC count change is always scope-level — the task's testable surface
  // shifted, the operator must decide whether the in-flight implementation
  // still covers the contract.
  if (taskSnapshot.acceptanceCriteria.length !== upstream.acceptanceCriteria.length) {
    return 'scope';
  }

  // Per-AC compare. Different normalisation (text-equal-after-trim) on
  // either side bumps to `scope` because ACs are the binary-testable
  // contract surface — semantic changes to ACs are scope changes.
  const taskAcs = taskSnapshot.acceptanceCriteria;
  const upAcs = upstream.acceptanceCriteria;
  for (let i = 0; i < taskAcs.length; i += 1) {
    const a = normaliseLine(taskAcs[i]);
    const b = normaliseLine(upAcs[i]);
    if (a !== b) {
      // Same text after aggressive normalisation = cosmetic-only AC drift.
      if (aggressiveNormalise(taskAcs[i]) === aggressiveNormalise(upAcs[i])) {
        // continue — accumulate cosmetic AC drift, body compare may still
        // upgrade to semantic.
        continue;
      }
      return 'scope';
    }
  }

  // Body compare. Different content = semantic; same after aggressive
  // normalisation = cosmetic.
  const bodyTaskNormal = normaliseBody(taskSnapshot.body);
  const bodyUpNormal = normaliseBody(upstream.body);
  if (bodyTaskNormal !== bodyUpNormal) {
    if (aggressiveNormalise(taskSnapshot.body) === aggressiveNormalise(upstream.body)) {
      return 'cosmetic';
    }
    return 'semantic';
  }

  // Bodies match under normaliseBody; if any AC differed (cosmetic) we
  // surface as cosmetic; else no change.
  for (let i = 0; i < taskAcs.length; i += 1) {
    if (normaliseLine(taskAcs[i]) !== normaliseLine(upAcs[i])) return 'cosmetic';
  }
  return 'no-change';
}

/**
 * Body / AC snapshot extracted from an imported backlog task. Captures
 * what {@link writeBacklogTaskFromSpecKitEntry} emitted in Phase 4 so
 * the classifier can do its content compare.
 */
export interface TaskSnapshot {
  /** Task title (from frontmatter `title:`). */
  title: string;
  /** Task body (between the description begin/end markers). */
  body: string;
  /** Acceptance criteria (from the AC:BEGIN/END markers, `- [ ] #N ...` rows). */
  acceptanceCriteria: string[];
}

/**
 * A scanned imported task — points back to the upstream artifact via the
 * Phase 4 `specRef:` block.
 */
export interface ImportedTaskRecord {
  /** Absolute path to the backlog task file. */
  filePath: string;
  /** Backlog task id (e.g. `IMP-12`). */
  id: string;
  /** Backlog task status (`To Do`, `In Progress`, `Done`...). */
  status: string;
  /** Upstream spec-kit task id (e.g. `T-007`). */
  upstreamTaskId: string;
  /** spec-kit feature id from `specRef.featureId`. */
  featureId: string;
  /** Path to the upstream `tasks.md` (relative to repo root or absolute). */
  artifactPath: string;
  /** Snapshot extracted from the current task body. */
  snapshot: TaskSnapshot;
}

/** Per-task outcome of a reconcile pass. */
export interface ReconcilePerTaskResult {
  importedTaskId: string;
  upstreamTaskId: string;
  filePath: string;
  severity: DriftSeverity;
  /** Action the catalog decided on (auto-sync vs defer-24h vs no-op). */
  action: ReconcileAction;
  /** DEC-NNNN id for the audit trail; null when the catalog flag is off. */
  decisionId: string | null;
}

/** Top-level reconcile outcome — what the CLI renders + returns. */
export interface ReconcileResult {
  workDir: string;
  /** Per-imported-task outcomes, in scan order. */
  perTask: ReconcilePerTaskResult[];
  /** Imported tasks the operator filtered with `--task <id>` but that don't exist. */
  unknownFilterIds: string[];
}

/**
 * What the reconcile pass decided to do for one drifting task.
 *
 * `no-op` covers both `no-change` and a high-severity drift where the
 * in-progress task continues against its dispatched version (Decision
 * still emitted; the task body is unchanged).
 */
export type ReconcileAction =
  | 'no-op'
  | 'auto-sync-applied'
  | 'defer-24h-window-opened'
  | 'superseded-marker-added';

export interface ReconcileOpts {
  /** Project root (`backlog/` lives here). Defaults to cwd. */
  workDir?: string;
  /**
   * Filter to a single imported task by id (e.g. `IMP-12`). Mirrors the
   * `cli-import-spec --reconcile --task <id>` CLI flag.
   */
  taskFilter?: string;
  /**
   * Override the upstream tasks.md reader (tests). Default reads from
   * disk relative to `workDir`.
   */
  readUpstream?: (artifactPath: string) => string | null;
  /** Inject the imported-task scanner (tests). */
  scanImported?: (workDir: string) => ImportedTaskRecord[];
  /**
   * Inject the config (tests). Defaults to the result of
   * {@link loadAdopterAuthoringConfig} against `workDir`.
   */
  config?: AdopterAuthoringConfig;
  /** Inject the current ISO timestamp (tests). */
  now?: () => string;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Run the reconcile pass. Stable orchestration shape that mirrors
 * `importSpec()` — delegates scanning, parsing, classification, and
 * Decision emission to small helpers so each piece is independently
 * testable + the CLI stays mostly a renderer.
 */
export function reconcileSpec(opts: ReconcileOpts = {}): ReconcileResult {
  const workDir = opts.workDir ?? process.cwd();
  const config = opts.config ?? loadAdopterAuthoringConfig({ workDir });
  const scan = opts.scanImported ?? scanImportedTasks;
  const readUpstream = opts.readUpstream ?? defaultReadUpstream(workDir);
  const now = opts.now ?? (() => new Date().toISOString());

  let records = scan(workDir);

  // `--task <id>` filter — narrow to that imported task before any I/O.
  const unknownFilterIds: string[] = [];
  if (opts.taskFilter) {
    const wanted = opts.taskFilter.toUpperCase();
    const found = records.filter((r) => r.id.toUpperCase() === wanted);
    if (found.length === 0) unknownFilterIds.push(opts.taskFilter);
    records = found;
  }

  // Group records by artifactPath so we parse each tasks.md once.
  const artifactCache = new Map<string, Map<string, SpecKitTaskEntry> | null>();
  const perTask: ReconcilePerTaskResult[] = [];

  for (const record of records) {
    let upstreamMap = artifactCache.get(record.artifactPath);
    if (upstreamMap === undefined) {
      const source = readUpstream(record.artifactPath);
      if (source === null) {
        upstreamMap = null;
      } else {
        const parsed = parseTasksMd(source);
        upstreamMap = parsed.schemaVersion === 'unknown' ? null : indexByTaskId(parsed.entries);
      }
      artifactCache.set(record.artifactPath, upstreamMap);
    }

    const upstreamEntry =
      upstreamMap === null ? null : (upstreamMap.get(record.upstreamTaskId) ?? null);
    const severity = classifyDrift(record.snapshot, upstreamEntry);

    const decided = applyDriftDecision({
      workDir,
      record,
      severity,
      upstreamEntry,
      config,
      now,
    });
    perTask.push({
      importedTaskId: record.id,
      upstreamTaskId: record.upstreamTaskId,
      filePath: record.filePath,
      severity,
      action: decided.action,
      decisionId: decided.decisionId,
    });
  }

  return { workDir, perTask, unknownFilterIds };
}

// ── Imported-task scanner ────────────────────────────────────────────────────

const SPECREF_SOURCE_RE = /^\s*source:\s*spec-kit\s*$/m;
const TITLE_RE = /^title:\s*(.+?)\s*$/m;
const STATUS_RE = /^status:\s*['"]?([^'"\n]+?)['"]?\s*$/m;
const TASK_ID_RE = /^id:\s*(.+?)\s*$/m;
const FEATURE_ID_RE = /^\s*featureId:\s*(.+?)\s*$/m;
const SPEC_TASK_ID_RE = /^\s*taskId:\s*(.+?)\s*$/m;
const ARTIFACT_PATH_RE = /^\s*artifactPath:\s*(.+?)\s*$/m;
const DESC_RE = /<!-- SECTION:DESCRIPTION:BEGIN -->([\s\S]*?)<!-- SECTION:DESCRIPTION:END -->/;
const AC_BLOCK_RE = /<!-- AC:BEGIN -->([\s\S]*?)<!-- AC:END -->/;
const AC_LINE_RE = /^\s*-\s*\[[ x]\]\s*(?:#\d+\s+)?(.+?)\s*$/i;

/**
 * Walk `<workDir>/backlog/{tasks,completed}/*.md` and extract one
 * {@link ImportedTaskRecord} per file whose frontmatter contains
 * `source: spec-kit` inside its `specRef:` block. Pure side-effect-free
 * read.
 */
export function scanImportedTasks(workDir: string): ImportedTaskRecord[] {
  const out: ImportedTaskRecord[] = [];
  for (const bucket of ['tasks', 'completed']) {
    const dir = join(workDir, 'backlog', bucket);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const filePath = join(dir, entry);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const fm = extractFrontmatter(content);
      if (!fm) continue;
      if (!SPECREF_SOURCE_RE.test(fm)) continue;

      const id = TASK_ID_RE.exec(fm)?.[1] ?? '';
      const titleRaw = TITLE_RE.exec(fm)?.[1] ?? '';
      const status = STATUS_RE.exec(fm)?.[1] ?? 'To Do';
      const featureId = FEATURE_ID_RE.exec(fm)?.[1]?.trim() ?? '';
      const upstreamTaskId = SPEC_TASK_ID_RE.exec(fm)?.[1]?.trim() ?? '';
      const artifactPath = ARTIFACT_PATH_RE.exec(fm)?.[1]?.trim() ?? '';
      if (!id || !upstreamTaskId || !artifactPath) continue;

      const snapshot = extractTaskSnapshot(content, unquoteYaml(titleRaw));
      out.push({
        filePath,
        id,
        status,
        featureId: unquoteYaml(featureId),
        upstreamTaskId: unquoteYaml(upstreamTaskId),
        artifactPath: unquoteYaml(artifactPath),
        snapshot,
      });
    }
  }
  return out;
}

function extractFrontmatter(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  return content.slice(3, end);
}

function extractTaskSnapshot(content: string, title: string): TaskSnapshot {
  const descMatch = DESC_RE.exec(content);
  const body = descMatch ? descMatch[1].trim() : '';
  const acBlock = AC_BLOCK_RE.exec(content);
  const acs: string[] = [];
  if (acBlock) {
    for (const line of acBlock[1].split('\n')) {
      const m = AC_LINE_RE.exec(line);
      if (!m) continue;
      const text = m[1].trim();
      if (text.startsWith('(no acceptance criteria')) continue;
      acs.push(text);
    }
  }
  return { title, body, acceptanceCriteria: acs };
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

// ── Upstream reader ──────────────────────────────────────────────────────────

function defaultReadUpstream(workDir: string): (artifactPath: string) => string | null {
  return (artifactPath: string): string | null => {
    const abs = artifactPath.startsWith('/') ? artifactPath : join(workDir, artifactPath);
    if (!existsSync(abs)) return null;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
}

function indexByTaskId(entries: SpecKitTaskEntry[]): Map<string, SpecKitTaskEntry> {
  const map = new Map<string, SpecKitTaskEntry>();
  for (const e of entries) map.set(e.taskId, e);
  return map;
}

// ── Normalisers used by classifyDrift ────────────────────────────────────────

/**
 * Light normalisation — trim + collapse internal whitespace. Used as the
 * baseline equality check for ACs and body lines. Bodies still differ if
 * the underlying words/order change.
 */
function normaliseLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Heavy normalisation — lowercase + strip punctuation + collapse
 * whitespace. Used to decide whether a `normaliseLine`-different pair
 * is merely cosmetic (case / punctuation / whitespace only).
 */
function aggressiveNormalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseBody(value: string): string {
  return value
    .split('\n')
    .map((line) => normaliseLine(line))
    .filter((line) => line.length > 0)
    .join('\n');
}

// ── Decision routing ─────────────────────────────────────────────────────────

interface ApplyDriftDecisionArgs {
  workDir: string;
  record: ImportedTaskRecord;
  severity: DriftSeverity;
  upstreamEntry: SpecKitTaskEntry | null;
  config: AdopterAuthoringConfig;
  now: () => string;
}

interface ApplyDriftDecisionResult {
  action: ReconcileAction;
  decisionId: string | null;
}

function applyDriftDecision(args: ApplyDriftDecisionArgs): ApplyDriftDecisionResult {
  if (args.severity === 'no-change') {
    return { action: 'no-op', decisionId: null };
  }

  if (args.severity === 'removed-upstream') {
    const decisionId = emitRemovedUpstreamDecision(args);
    appendSupersededFooter(args.record.filePath, args.now());
    return { action: 'superseded-marker-added', decisionId };
  }

  // typo / cosmetic / semantic / scope
  const sevAction = severityAction(args.severity, args.config);

  if (sevAction === 'auto-sync' && args.upstreamEntry !== null) {
    rewriteTaskBodyAndAcs(args.record.filePath, args.upstreamEntry);
    const decisionId = emitAutoSyncDecision(args);
    return { action: 'auto-sync-applied', decisionId };
  }

  // defer-24h-window for semantic + scope.
  const decisionId = emitDeferDecision(args);
  return { action: 'defer-24h-window-opened', decisionId };
}

function severityAction(
  severity: Exclude<DriftSeverity, 'no-change' | 'removed-upstream'>,
  config: AdopterAuthoringConfig,
): DriftSeverityAction {
  // RFC §14.1 splits the four tiers into two policy buckets:
  //   typo / cosmetic → `typoCosmetic` action
  //   semantic / scope → `semanticScope` action
  return severity === 'typo' || severity === 'cosmetic'
    ? config.driftHandling.typoCosmetic
    : config.driftHandling.semanticScope;
}

// ── Side effects on the imported task file ───────────────────────────────────

function rewriteTaskBodyAndAcs(filePath: string, upstream: SpecKitTaskEntry): void {
  let original: string;
  try {
    original = readFileSync(filePath, 'utf8');
  } catch {
    // Same defensive policy as `appendSupersededFooter` — best-effort.
    return;
  }

  const newBody =
    upstream.body.trim().length > 0
      ? upstream.body.trim()
      : `Imported from spec-kit (upstream \`${upstream.taskId}\`).`;
  let next = original.replace(
    DESC_RE,
    `<!-- SECTION:DESCRIPTION:BEGIN -->\n${newBody}\n<!-- SECTION:DESCRIPTION:END -->`,
  );

  const acLines =
    upstream.acceptanceCriteria.length === 0
      ? '- [ ] (no acceptance criteria extracted from upstream — review needed)'
      : upstream.acceptanceCriteria.map((ac, idx) => `- [ ] #${idx + 1} ${ac}`).join('\n');
  next = next.replace(AC_BLOCK_RE, `<!-- AC:BEGIN -->\n${acLines}\n<!-- AC:END -->`);

  writeFileSync(filePath, next, 'utf8');
}

function appendSupersededFooter(filePath: string, isoNow: string): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    // File missing — caller injected a synthetic record, or the operator
    // deleted the file between scan and reconcile. Either way, the
    // Decision (already emitted) carries the audit trail; the footer is
    // best-effort.
    return;
  }
  const marker = '<!-- IMPORT-SPEC-RECONCILE:SUPERSEDED -->';
  if (content.includes(marker)) return;
  const footer = [
    '',
    marker,
    '',
    '## Spec-kit reconcile note',
    '',
    `The upstream spec-kit entry for this task was no longer present at \`${isoNow}\`.`,
    'Per RFC-0036 §6.4 the imported task is marked **superseded** but NOT auto-deleted.',
    "Decide whether to close, archive, or rehome the task at the operator's next batch review.",
    '',
  ].join('\n');
  writeFileSync(filePath, content.replace(/\s*$/, '') + '\n' + footer, 'utf8');
}

// ── Decision emitters ────────────────────────────────────────────────────────

function emitAutoSyncDecision(args: ApplyDriftDecisionArgs): string | null {
  if (!isDecisionCatalogEnabled()) return null;
  let id: string | null = null;
  withEventLogLock({ workDir: args.workDir }, () => {
    const decisionId = nextDecisionId({ workDir: args.workDir });
    const summary = `Spec-kit drift auto-synced: ${args.record.id} ← upstream ${args.record.upstreamTaskId} (${args.severity})`;
    const body = [
      `\`cli-import-spec --reconcile\` detected low-severity drift between`,
      `imported task \`${args.record.id}\` and its upstream entry`,
      `\`${args.record.upstreamTaskId}\` in \`${args.record.artifactPath}\`.`,
      '',
      `Severity tier: **${args.severity}** (auto-sync per`,
      `\`drift-handling.severityThresholds.typoCosmetic\` = auto-sync).`,
      '',
      `The task body + acceptance criteria were re-written from the current`,
      `upstream version. The Decision is auto-answered with \`accept-auto-sync\``,
      `so the operator triage surface shows only NEW gaps.`,
    ].join('\n');
    const opened = makeDecisionOpenedEvent({
      decisionId,
      source: 'subagent-escalation',
      scope: `import-spec:reconcile:${args.record.id}`,
      summary,
      body,
      options: [
        {
          id: 'accept-auto-sync',
          description: 'Accept the auto-synced upstream content',
        },
        {
          id: 'revert-auto-sync',
          description: 'Revert and surface the drift for manual review',
        },
      ],
    });
    appendDecisionEvent(opened, { workDir: args.workDir });
    const answered = makeOperatorAnsweredEvent({
      decisionId,
      chosenOptionId: 'accept-auto-sync',
      rationale: `Auto-synced per RFC-0036 OQ-2 — severity tier '${args.severity}' maps to auto-sync.`,
      by: 'rfc-0036-reconcile-auto-sync',
    });
    appendDecisionEvent(answered, { workDir: args.workDir });
    id = decisionId;
  });
  return id;
}

function emitDeferDecision(args: ApplyDriftDecisionArgs): string | null {
  if (!isDecisionCatalogEnabled()) return null;
  let id: string | null = null;
  withEventLogLock({ workDir: args.workDir }, () => {
    const decisionId = nextDecisionId({ workDir: args.workDir });
    const summary = `Spec-kit drift detected: ${args.record.id} ← upstream ${args.record.upstreamTaskId} (${args.severity})`;
    const body = [
      `\`cli-import-spec --reconcile\` detected high-severity drift between`,
      `imported task \`${args.record.id}\` (status: ${args.record.status}) and its`,
      `upstream entry \`${args.record.upstreamTaskId}\` in`,
      `\`${args.record.artifactPath}\`.`,
      '',
      `Severity tier: **${args.severity}** (24h-override window per`,
      `\`drift-handling.severityThresholds.semanticScope\` = defer-24h-window).`,
      '',
      `**The in-progress task is NOT halted.** It continues against the`,
      `version it was dispatched with. Per RFC-0024 §15.1 default-on-silence,`,
      `if the operator does not override within 24h the drift is accepted as`,
      `no-fork (task continues against dispatched version).`,
      '',
      `Operator-surfaced in the next batch review.`,
    ].join('\n');
    const opened = makeDecisionOpenedEvent({
      decisionId,
      source: 'subagent-escalation',
      scope: `import-spec:reconcile:${args.record.id}`,
      summary,
      body,
      options: [
        {
          id: 'no-fork-accept-drift',
          description:
            'Accept drift — continue task against dispatched version (default-on-silence at 24h)',
        },
        {
          id: 'fork-and-re-import',
          description: 'Re-import the upstream entry into a new backlog task',
        },
        {
          id: 'patch-in-flight-task',
          description: 'Patch the in-flight task body + ACs to the new upstream version',
        },
      ],
    });
    appendDecisionEvent(opened, { workDir: args.workDir });
    id = decisionId;
  });
  return id;
}

function emitRemovedUpstreamDecision(args: ApplyDriftDecisionArgs): string | null {
  if (!isDecisionCatalogEnabled()) return null;
  let id: string | null = null;
  withEventLogLock({ workDir: args.workDir }, () => {
    const decisionId = nextDecisionId({ workDir: args.workDir });
    const summary = `Spec-kit upstream removed: ${args.record.id} ← ${args.record.upstreamTaskId}`;
    const body = [
      `\`cli-import-spec --reconcile\` could not find upstream entry`,
      `\`${args.record.upstreamTaskId}\` in \`${args.record.artifactPath}\`.`,
      '',
      `Per RFC-0036 §6.4 the imported backlog task \`${args.record.id}\` (status:`,
      `${args.record.status}) is marked **superseded** in its body footer but NOT`,
      `auto-deleted — the operator decides whether to close, archive, or rehome.`,
    ].join('\n');
    const opened = makeDecisionOpenedEvent({
      decisionId,
      source: 'subagent-escalation',
      scope: `import-spec:reconcile:${args.record.id}`,
      summary,
      body,
      options: [
        {
          id: 'close-task',
          description: 'Close the imported task (upstream entry intentionally removed)',
        },
        {
          id: 'keep-task',
          description: 'Keep the task — implementation is still valuable independent of spec-kit',
        },
        {
          id: 'rehome-task',
          description: 'Re-home the task under a different upstream entry',
        },
      ],
    });
    appendDecisionEvent(opened, { workDir: args.workDir });
    id = decisionId;
  });
  return id;
}
