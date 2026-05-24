/**
 * DoR Gate at import time (RFC-0036 Phase 5 / AISDLC-330).
 *
 * Wires the RFC-0011 DoR rubric into the spec-kit import path. For each
 * generated backlog task the bridge:
 *
 *   1. Renders the task content from the parsed `SpecKitTaskEntry`.
 *   2. Writes it to a temp file (under `<workDir>/.ai-sdlc/import-spec-tmp/`).
 *   3. Runs {@link refineBacklogTask} against that temp file.
 *   4. Auto-resolves any clarification question via `.specify/analyze.json`
 *      metadata when present (OQ-7) — only NEW gaps reach the operator.
 *   5. Decides per OQ-3 (`strict` default; `--rubric warn` opt-out):
 *      - `strict` + `needs-clarification` (after auto-resolve) → refuse
 *        import per OQ-10: emit a clarification task back to spec-kit
 *        with structured hints (which gates failed + why).
 *      - `warn` + `needs-clarification` → write the task anyway; record
 *        the warning in the import result for surfacing.
 *      - `admit` → write the task to `backlog/tasks/`.
 *
 * Compositional with RFC-0035 Stage A/B/C (AC#7): every failed-DoR event
 * routes through the Decision Catalog as `Decision: import-blocked-on-dor`
 * (or its analyze-auto-resolved counterpart) so operator triage stays
 * inside the catalog substrate.
 *
 * @module import-spec/dor-at-import
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  appendDecisionEvent,
  isDecisionCatalogEnabled,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  nextDecisionId,
  withEventLogLock,
} from '../decisions/index.js';
import { refineBacklogTask, type RefineBacklogTaskResult } from '../dor/ingress-claude.js';
import type { GateEvaluation, GateId, RefinementVerdict } from '../dor/types.js';

import type { DorStrictness } from './config.js';
import { nextTaskNumber, slugify } from './task-writer.js';
import type { SpecKitTaskEntry } from './parser.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Spec-kit `analyze.json` metadata shape consumed by OQ-7 auto-resolution.
 *
 * Intentionally permissive — adopters write this file from
 * `/speckit.analyze` output (or hand-author it). Two surfaces drive
 * auto-resolution:
 *
 * - `coveredGates`: gate IDs that analyze already verified upstream. Any
 *   clarification finding tagged with one of these gate IDs is
 *   auto-resolved with `analyze-covered-gate`.
 * - `coveredQuestionHashes`: sha-256 hashes of normalised clarification
 *   questions analyze already addressed. Lets adopters target individual
 *   questions when whole-gate auto-resolve is too coarse.
 *
 * Future expansion: `coveredQuestions: string[]` (verbatim text) is
 * trivial to add — keeping the v1 surface tight per OQ-6 / RFC §14.1.
 */
export interface AnalyzeMetadata {
  /** DoR gate IDs that the upstream `/speckit.analyze` already verified. */
  coveredGates?: GateId[];
  /**
   * sha-256 hashes of normalised clarification question text. Use
   * {@link hashClarificationQuestion} to derive.
   */
  coveredQuestionHashes?: string[];
  /** Optional free-form rationale, surfaced in the operator audit trail. */
  rationale?: string;
}

export type DorAtImportPerTaskOutcome =
  | {
      /** DoR admitted the task (after any analyze auto-resolution). */
      kind: 'admitted';
      verdict: RefinementVerdict;
      /** Decisions emitted + auto-resolved by analyze metadata. */
      autoResolvedDecisionIds: string[];
    }
  | {
      /** Strict mode + failed DoR: import refused, upstream clarification emitted. */
      kind: 'refused-strict';
      verdict: RefinementVerdict;
      decisionId: string | null;
      clarificationTaskFile: string | null;
      failedGates: GateId[];
      autoResolvedDecisionIds: string[];
    }
  | {
      /** Warn mode + failed DoR: task admitted with warnings surfaced. */
      kind: 'admitted-with-warnings';
      verdict: RefinementVerdict;
      failedGates: GateId[];
      autoResolvedDecisionIds: string[];
    };

export interface DorAtImportPerTaskResult {
  /** Upstream spec-kit task identifier (e.g. `T-007`). */
  upstreamTaskId: string;
  /** Title used during DoR evaluation. */
  title: string;
  outcome: DorAtImportPerTaskOutcome;
}

export interface RunDorAtImportOpts {
  /** Project root for backlog writes + decision events. */
  workDir: string;
  /** Strict (default) or warn (opt-out via `--rubric warn`). */
  strictness: DorStrictness;
  /** Spec-kit feature id (slug of the spec-kit feature dir). */
  featureId: string;
  /** `tasks.md` path used in the synthetic `specRef.artifactPath`. */
  artifactPath: string;
  /** Override the importedAt stamp (tests). */
  importedAt?: string;
  /**
   * Override the analyze metadata reader. Defaults to reading
   * `<workDir>/<analyzeMetadataPath>` (set in adopter-authoring.yaml
   * under `speckit-bridge.analyzeMetadataPath`; default
   * `.specify/analyze.json`).
   */
  analyzeMetadataPath?: string;
  /**
   * Override the analyze metadata reader entirely (tests). Takes
   * precedence over `analyzeMetadataPath` when supplied.
   */
  readAnalyzeMetadata?: () => AnalyzeMetadata | null;
  /**
   * Pre-flight ID prefix for the *generated* backlog tasks. Defaults to
   * `IMP` (matches the existing task-writer convention).
   */
  prefix?: string;
  /**
   * Override for the DoR result generator. Tests inject a stub; production
   * defers to {@link refineBacklogTask}.
   */
  evaluateDor?: (taskFilePath: string) => Promise<RefineBacklogTaskResult>;
}

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * Normalise a clarification question to a stable form before hashing.
 * Adopters who hand-author `analyze.json` use {@link hashClarificationQuestion}
 * (or this function + their own sha-256) to populate
 * `coveredQuestionHashes`.
 */
export function normaliseClarificationQuestion(q: string): string {
  return q.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Hash a clarification question for the analyze auto-resolve lookup
 * table. Lower-case, whitespace-collapsed, sha-256 hex. Exported so
 * adopter scripts that produce `analyze.json` can pre-compute the
 * hashes without re-implementing the normalisation rules.
 */
export function hashClarificationQuestion(q: string): string {
  return createHash('sha256').update(normaliseClarificationQuestion(q), 'utf8').digest('hex');
}

/**
 * Default analyze-metadata reader. Returns null when the file is absent
 * (the bridge falls back to the full DoR rubric per AC#4) or when
 * parsing fails (malformed metadata is loud so the operator can fix it).
 */
export function readAnalyzeMetadataFromDisk(absPath: string): AnalyzeMetadata | null {
  if (!existsSync(absPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[import-spec] failed to parse analyze metadata at ${absPath}: ${msg}`);
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const out: AnalyzeMetadata = {};
  if (Array.isArray(obj.coveredGates)) {
    const arr = obj.coveredGates.filter(
      (g): g is GateId => typeof g === 'number' && g >= 1 && g <= 7,
    );
    out.coveredGates = arr;
  }
  if (Array.isArray(obj.coveredQuestionHashes)) {
    out.coveredQuestionHashes = obj.coveredQuestionHashes.filter(
      (h): h is string => typeof h === 'string',
    );
  }
  if (typeof obj.rationale === 'string') out.rationale = obj.rationale;
  return out;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const DEFAULT_PREFIX = 'IMP';
const DEFAULT_ANALYZE_PATH = '.specify/analyze.json';
const TMP_DIRNAME = '.ai-sdlc/import-spec-tmp';

interface RenderedTaskFile {
  id: string;
  tmpFilePath: string;
  fileName: string;
  cleanup: () => void;
}

/**
 * Render the spec-kit task to a temporary file under
 * `<workDir>/.ai-sdlc/import-spec-tmp/` so {@link refineBacklogTask}
 * can locate it via `taskFilePathOverride`. Caller invokes `cleanup()`
 * after the DoR evaluation completes (regardless of admit/refuse).
 *
 * Uses the same task-ID allocator + filename slug rules as the eventual
 * landing path so failure metadata is consistent with what would have
 * shipped.
 */
function renderTaskToTempFile(
  entry: SpecKitTaskEntry,
  opts: { workDir: string; prefix: string; renderTaskMarkdown: (id: string) => string },
): RenderedTaskFile {
  const num = nextTaskNumber(opts.workDir, opts.prefix);
  const id = `${opts.prefix}-${num}`;
  const slug = slugify(entry.title);
  const fileName = `${id.toLowerCase()} - ${slug}.md`;
  const tmpDir = join(opts.workDir, TMP_DIRNAME);
  mkdirSync(tmpDir, { recursive: true });
  const tmpFilePath = join(tmpDir, fileName);
  // Defense: ensure the tmp file lands under the project's .ai-sdlc/ root.
  if (!tmpFilePath.startsWith(tmpDir)) {
    throw new Error(`[import-spec] refusing to write temp file outside ${tmpDir}: ${tmpFilePath}`);
  }
  writeFileSync(tmpFilePath, opts.renderTaskMarkdown(id), 'utf8');
  return {
    id,
    tmpFilePath,
    fileName,
    cleanup: () => {
      try {
        rmSync(tmpFilePath, { force: true });
      } catch {
        // best-effort
      }
      // Remove the tmp dir when empty so we don't accumulate cruft.
      try {
        rmSync(tmpDir, { recursive: false, force: false });
      } catch {
        // dir not empty (parallel imports) — leave it.
      }
    },
  };
}

/**
 * Walk the verdict and decide, per OQ-7, which findings the
 * analyze metadata already covered.
 */
export function classifyAnalyzeCoverage(
  verdict: RefinementVerdict,
  analyze: AnalyzeMetadata | null,
): {
  coveredFindings: GateEvaluation[];
  uncoveredFindings: GateEvaluation[];
} {
  const failing = verdict.gates.filter((g) => g.verdict === 'fail' && g.severity === 'block');
  if (!analyze) return { coveredFindings: [], uncoveredFindings: failing };

  const gateSet = new Set(analyze.coveredGates ?? []);
  const questionHashSet = new Set(analyze.coveredQuestionHashes ?? []);

  const covered: GateEvaluation[] = [];
  const uncovered: GateEvaluation[] = [];
  for (const g of failing) {
    if (gateSet.has(g.gateId)) {
      covered.push(g);
      continue;
    }
    const q = g.clarificationQuestion;
    if (q && questionHashSet.has(hashClarificationQuestion(q))) {
      covered.push(g);
      continue;
    }
    uncovered.push(g);
  }
  return { coveredFindings: covered, uncoveredFindings: uncovered };
}

interface EmitAutoResolvedDecisionArgs {
  workDir: string;
  upstreamTaskId: string;
  taskTitle: string;
  finding: GateEvaluation;
  analyzeRationale?: string;
}

/**
 * For each analyze-covered finding, emit `decision-opened` followed by
 * `operator-answered` (`provide-answer`) so the audit trail shows the
 * analyze acknowledgement and the operator never sees the question.
 * Returns the allocated DEC-NNNN id (or null when the feature flag is off).
 */
function emitAutoResolvedDecision(args: EmitAutoResolvedDecisionArgs): string | null {
  if (!isDecisionCatalogEnabled()) return null;
  let id: string | null = null;
  withEventLogLock({ workDir: args.workDir }, () => {
    const decisionId = nextDecisionId({ workDir: args.workDir });
    const summary = `Spec-kit import (auto-resolved by analyze): ${args.upstreamTaskId} gate ${args.finding.gateId}`;
    const body = [
      `\`cli-import-spec\` raised a DoR Gate-${args.finding.gateId} clarification on imported`,
      `task \`${args.upstreamTaskId}\` (\`${args.taskTitle}\`):`,
      '',
      `> ${args.finding.finding ?? args.finding.clarificationQuestion ?? '(no detail)'}`,
      '',
      `Per RFC-0036 OQ-7, the upstream \`.specify/analyze.json\` metadata already covered`,
      `this concern (${args.analyzeRationale ?? 'gate or question hash listed in coverage set'}).`,
      `The Decision is auto-answered with \`provide-answer\` so the operator triage`,
      `surface shows only NEW gaps.`,
    ].join('\n');
    const opened = makeDecisionOpenedEvent({
      decisionId,
      source: 'subagent-escalation',
      scope: `import-spec:dor:${args.upstreamTaskId}`,
      summary,
      body,
      options: [
        {
          id: 'provide-answer',
          description: 'Analyze covered this concern — accept auto-resolution.',
        },
        {
          id: 'reject-issue',
          description: 'Override: surface this concern despite analyze coverage.',
        },
      ],
    });
    appendDecisionEvent(opened, { workDir: args.workDir });
    const answered = makeOperatorAnsweredEvent({
      decisionId,
      chosenOptionId: 'provide-answer',
      rationale: `Auto-resolved by RFC-0036 OQ-7: ${args.analyzeRationale ?? 'analyze metadata covered this gate/question'}`,
      by: 'rfc-0036-analyze-auto-resolve',
    });
    appendDecisionEvent(answered, { workDir: args.workDir });
    id = decisionId;
  });
  return id;
}

interface EmitImportBlockedArgs {
  workDir: string;
  upstreamTaskId: string;
  taskTitle: string;
  artifactPath: string;
  failedFindings: GateEvaluation[];
}

interface EmitImportBlockedResult {
  decisionId: string | null;
  clarificationTaskFile: string | null;
}

/**
 * OQ-10 rejection routing: write a clarification task back to the
 * backlog and emit `Decision: import-blocked-on-dor` so the spec-kit
 * project's owner gets actionable, structured hints (which gates failed,
 * why, and which upstream `tasks.md` row triggered the rejection).
 *
 * The task lands in `backlog/tasks/` so the operator's normal triage
 * picks it up; the Decision lands in the catalog so cross-task patterns
 * are visible.
 */
function emitImportBlocked(args: EmitImportBlockedArgs): EmitImportBlockedResult {
  const gateList = args.failedFindings.map((g) => `Gate ${g.gateId}`).join(', ');
  const summary = `Spec-kit import blocked on DoR: ${args.upstreamTaskId} (${gateList})`;
  const findingLines: string[] = [];
  for (const g of args.failedFindings) {
    findingLines.push(`- **Gate ${g.gateId}**:`);
    if (g.finding) findingLines.push(`    - Finding: ${g.finding}`);
    if (g.clarificationQuestion) findingLines.push(`    - Question: ${g.clarificationQuestion}`);
  }

  const body = [
    `\`cli-import-spec\` ran the RFC-0011 DoR Gate on the generated backlog task`,
    `for upstream \`${args.upstreamTaskId}\` (\`${args.taskTitle}\`) and refused the`,
    `import per RFC-0036 OQ-3 (strict default) + OQ-10 (refuse + emit clarification).`,
    '',
    '## Failing gates',
    '',
    ...findingLines,
    '',
    '## Recommended upstream action',
    '',
    `Update \`${args.artifactPath}\` (and any \`spec.md\` / \`plan.md\` it references)`,
    `to address the gates above, then re-run \`cli-import-spec\`.`,
  ].join('\n');

  let decisionId: string | null = null;
  if (isDecisionCatalogEnabled()) {
    withEventLogLock({ workDir: args.workDir }, () => {
      const id = nextDecisionId({ workDir: args.workDir });
      const event = makeDecisionOpenedEvent({
        decisionId: id,
        source: 'subagent-escalation',
        scope: `import-spec:dor:${args.upstreamTaskId}`,
        summary,
        body,
        options: [
          {
            id: 'opt-fix-upstream',
            description: 'Fix the upstream spec-kit artifact and re-import',
          },
          {
            id: 'opt-rerun-with-warn',
            description: 'Re-run import with --rubric warn (caveats logged)',
          },
          {
            id: 'opt-abandon-import',
            description: 'Abandon import of this entry (e.g. duplicate)',
          },
        ],
      });
      appendDecisionEvent(event, { workDir: args.workDir });
      decisionId = id;
    });
  }

  const clarificationTaskFile = writeClarificationTaskFile({
    workDir: args.workDir,
    title: `Spec-kit DoR-blocked: ${args.upstreamTaskId} (${gateList})`,
    body: [
      `# Upstream clarification needed: DoR refused at import`,
      '',
      `\`cli-import-spec\` refused to import \`${args.upstreamTaskId}\` from`,
      `\`${args.artifactPath}\` because the generated backlog task did not pass`,
      `the RFC-0011 Definition-of-Ready Gate.`,
      '',
      `Per RFC-0036 OQ-10 the import is REFUSED — no placeholder task is`,
      `created in the backlog. Address the gates below upstream and re-run`,
      `the import.`,
      '',
      ...findingLines,
      '',
      `Filed by RFC-0036 Phase 5 (AISDLC-330).`,
    ].join('\n'),
    labels: ['spec-kit-bridge', 'upstream-clarification', 'dor-blocked'],
  });

  return { decisionId, clarificationTaskFile };
}

function writeClarificationTaskFile(args: {
  workDir: string;
  title: string;
  body: string;
  labels: string[];
}): string {
  const prefix = 'IMPCLARIFY';
  const num = nextTaskNumber(args.workDir, prefix);
  const id = `${prefix}-${num}`;
  const tasksDir = join(args.workDir, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  const fileName = `${id.toLowerCase()} - ${slugify(args.title)}.md`;
  const filePath = join(tasksDir, fileName);
  const content = [
    '---',
    `id: ${id}`,
    `title: ${formatYamlString(args.title)}`,
    "status: 'To Do'",
    'assignee: []',
    'labels:',
    ...args.labels.map((l) => `  - ${l}`),
    'dependencies: []',
    'references: []',
    '---',
    '',
    args.body,
    '',
  ].join('\n');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function formatYamlString(value: string): string {
  if (
    value === '' ||
    /[:#]/.test(value) ||
    /^[\s!&*?|>%@`#,[\]{}'"-]/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value)
  ) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export interface RunDorAtImportInput {
  entry: SpecKitTaskEntry;
  /**
   * Caller-provided renderer that, given the allocated backlog ID,
   * produces the markdown body the DoR rubric will score. Decoupled
   * from `task-writer.renderTaskMarkdown` so the writer module stays
   * the single source of truth for task-file format.
   */
  renderTaskMarkdown: (id: string) => string;
}

/**
 * Run the DoR Gate against one generated spec-kit task. Returns the
 * outcome the import orchestrator uses to decide whether to write the
 * task to `backlog/tasks/`, refuse the import, or admit-with-warnings.
 */
export async function runDorAtImport(
  input: RunDorAtImportInput,
  opts: RunDorAtImportOpts,
): Promise<DorAtImportPerTaskResult> {
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const artifactPath = opts.artifactPath;

  const rendered = renderTaskToTempFile(input.entry, {
    workDir: opts.workDir,
    prefix,
    renderTaskMarkdown: input.renderTaskMarkdown,
  });

  let dorResult: RefineBacklogTaskResult;
  try {
    dorResult = opts.evaluateDor
      ? await opts.evaluateDor(rendered.tmpFilePath)
      : await refineBacklogTask(rendered.id, {
          workDir: opts.workDir,
          taskFilePathOverride: rendered.tmpFilePath,
        });
  } finally {
    rendered.cleanup();
  }

  const verdict = dorResult.verdict;

  // AC#3 + AC#4 — analyze auto-resolution. When the metadata file is
  // present, each clarification finding it covered emits a
  // decision-opened + operator-answered pair (audit trail) and drops
  // out of the failing-findings set the import path acts on.
  const analyze = resolveAnalyzeMetadata(opts);
  const { coveredFindings, uncoveredFindings } = classifyAnalyzeCoverage(verdict, analyze);

  const autoResolvedDecisionIds: string[] = [];
  for (const finding of coveredFindings) {
    const id = emitAutoResolvedDecision({
      workDir: opts.workDir,
      upstreamTaskId: input.entry.taskId,
      taskTitle: input.entry.title,
      finding,
      ...(analyze?.rationale ? { analyzeRationale: analyze.rationale } : {}),
    });
    if (id) autoResolvedDecisionIds.push(id);
  }

  const stillFailing = uncoveredFindings;
  const failingGateIds = stillFailing.map((g) => g.gateId);

  if (stillFailing.length === 0) {
    return {
      upstreamTaskId: input.entry.taskId,
      title: input.entry.title,
      outcome: {
        kind: 'admitted',
        verdict,
        autoResolvedDecisionIds,
      },
    };
  }

  // AC#5 + AC#6 + OQ-3 + OQ-10 — strict default refuses; warn-mode admits
  // with the structured warnings carried back in the result.
  if (opts.strictness === 'warn') {
    return {
      upstreamTaskId: input.entry.taskId,
      title: input.entry.title,
      outcome: {
        kind: 'admitted-with-warnings',
        verdict,
        failedGates: failingGateIds,
        autoResolvedDecisionIds,
      },
    };
  }

  const blocked = emitImportBlocked({
    workDir: opts.workDir,
    upstreamTaskId: input.entry.taskId,
    taskTitle: input.entry.title,
    artifactPath: artifactPath,
    failedFindings: stillFailing,
  });

  return {
    upstreamTaskId: input.entry.taskId,
    title: input.entry.title,
    outcome: {
      kind: 'refused-strict',
      verdict,
      decisionId: blocked.decisionId,
      clarificationTaskFile: blocked.clarificationTaskFile,
      failedGates: failingGateIds,
      autoResolvedDecisionIds,
    },
  };
}

function resolveAnalyzeMetadata(opts: RunDorAtImportOpts): AnalyzeMetadata | null {
  if (opts.readAnalyzeMetadata) return opts.readAnalyzeMetadata();
  const rel = opts.analyzeMetadataPath ?? DEFAULT_ANALYZE_PATH;
  const abs = join(opts.workDir, rel);
  return readAnalyzeMetadataFromDisk(abs);
}

/** Exposed for tests / cleanup tooling. */
export function resolveTmpImportDir(workDir: string): string {
  return join(workDir, TMP_DIRNAME);
}

/** Exposed for the import orchestrator's verbose log line. */
export function describeFailedGates(gates: GateId[]): string {
  if (gates.length === 0) return '(none)';
  return gates.map((g) => `Gate ${g}`).join(', ');
}
