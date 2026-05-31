/**
 * `cli-decisions` — RFC-0035 Decision Catalog CLI (Phase 1).
 *
 * Subcommands:
 *   list                 — enumerate decisions projected from the event log
 *   show <id>            — render one decision with full event history
 *   add                  — author a new Decision (interactive or via flags)
 *
 * Storage: `.ai-sdlc/_decisions/events.jsonl` (event-sourced per OQ-1).
 *
 * Feature flag: `AI_SDLC_DECISION_CATALOG`. **Default-ON since AISDLC-392**
 * (operator promotion 2026-05-22). To opt out, set the var to
 * `off`/`0`/`false`/`no`/`disabled` (case-insensitive). When opted out the
 * CLI degrades open: read subcommands (`list`, `show`) return empty results
 * with an explanatory note on stderr instead of erroring; the mutating
 * `add` subcommand refuses with a clear message + exit 1.
 *
 * @module cli/decisions
 */

import { existsSync, readFileSync } from 'node:fs';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  aggregateDecisionCorpus,
  appendDecisionEvent,
  buildDecisionSupportView,
  buildPendingExemplarsDigest,
  buildSubDecisionGraph,
  clearFatigue,
  computeStageACoverage,
  computeTimeboxExpiresAt,
  DECISION_PRIORITIES,
  DECISION_SOURCES,
  decisionCatalogDisabledMessage,
  disposeAndOptionallyPromote,
  filterExpiredDecisions,
  getFatigueStatus,
  hoursToIsoDuration,
  isDecisionCatalogEnabled,
  isDecisionTimeboxExpired,
  isNotebookSummariesEnabled,
  isStageCAutoApplyEligible,
  listDecisions,
  loadDecisionsConfig,
  makeAutoExpiredEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  makeOverriddenEvent,
  makeRecommendationIssuedEvent,
  makeStageCAutoApplyAnsweredEvent,
  makeStageCCompletedEvent,
  makeTimeboxExtendedEvent,
  mirrorSubstrateEntry,
  msRemainingUntil,
  nextDecisionId,
  notebookSummariesDisabledMessage,
  parseTimebox,
  projectDecision,
  promoteAllDisposedPendingExemplars,
  rankDecisions,
  readDecisionExemplars,
  readNotebookSummary,
  readPendingExemplars,
  readResearchArtifacts,
  rejectPendingExemplar,
  renderDecisionSupportSurface,
  renderPendingExemplarsDigestMarkdown,
  renderSubDecisionGraphHtml,
  renderSubDecisionGraphMermaid,
  resolveDecisionExemplarsPath,
  resolveDecisionsConfig,
  resolveEventLogPath,
  resolveOperatorStatePath,
  resolvePendingExemplarsPath,
  resolveResearchSubagentThreshold,
  resolveStageCRuntimeConfig,
  runCalibrationSweep,
  runStageA,
  runStageB,
  runStageC,
  setFatigue,
  shouldInvokeResearchSubagent,
  sortDecisionsByTimeboxUrgency,
  STAGE_A_COVERAGE_TARGET,
  TIMEBOX_CATEGORICAL_ALIASES,
  type AggregateCorpusResult,
  type Decision,
  type DecisionOption,
  type DecisionPriority,
  type DecisionSource,
  type DecisionSupportView,
  type PendingExemplar,
} from '../decisions/index.js';
import { readCorpus, recordOperatorOverride } from '../classifier/substrate/index.js';
import { buildDependencyGraph } from '../deps/dependency-graph.js';
import { isCompositionEnabled } from '../deps/snapshot.js';

// ── Output helpers ────────────────────────────────────────────────────────────

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function warnToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function fail(reason: string, code = 1): never {
  process.stderr.write(`[cli-decisions] error: ${reason}\n`);
  process.exit(code);
}

// ── Interactive prompt helper ────────────────────────────────────────────────

/**
 * Tiny readline wrapper. Kept inline (no third-party dep) because the
 * prompt surface is small and the project's runtime-dep policy is "ship
 * only when there's a clear payoff". Returns the trimmed answer; "" when
 * the user just hit return.
 */
async function prompt(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ── Render helpers (text mode) ───────────────────────────────────────────────

/**
 * Compact human-readable timebox-remaining badge: `4h`, `1d 12h`, `-2h`
 * (negative = expired by). Returns the empty string when the decision has
 * no timebox so untimeboxed rows render as empty cells (and the column
 * itself disappears when nothing in the set has a timebox).
 */
function formatTimeboxBadge(decision: Decision, now: Date = new Date()): string {
  const ms = msRemainingUntil(decision.status.timeboxExpiresAt, now);
  if (ms === null) return '';
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  const sign = ms < 0 ? '-' : '';
  if (days > 0) return `${sign}${days}d ${hours}h`;
  if (hours > 0) return `${sign}${hours}h ${mins}m`;
  return `${sign}${mins}m`;
}

function renderListTable(decisions: Decision[]): string {
  if (decisions.length === 0) return '(no decisions in the catalog)\n';
  const anyTimebox = decisions.some((d) => Boolean(d.status.timeboxExpiresAt));
  const headers = anyTimebox
    ? (['id', 'lifecycle', 'source', 'created', 'timebox', 'summary'] as const)
    : (['id', 'lifecycle', 'source', 'created', 'summary'] as const);
  const now = new Date();
  const rows = decisions.map((d) => {
    const base = [
      d.metadata.id,
      d.status.lifecycle,
      d.metadata.source,
      d.metadata.created.slice(0, 10),
    ];
    if (anyTimebox) base.push(formatTimeboxBadge(d, now));
    base.push(d.spec.summary.length > 60 ? d.spec.summary.slice(0, 57) + '...' : d.spec.summary);
    return base;
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [fmt(headers as unknown as string[]), sep, ...rows.map(fmt)];
  return lines.join('\n') + '\n';
}

function renderPendingExemplarsTable(exemplars: PendingExemplar[]): string {
  if (exemplars.length === 0) return '(no pending exemplars)\n';
  const headers = ['id', 'task', 'pol', 'disposition', 'class', 'override', 'decision'] as const;
  const rows = exemplars.map((e) => [
    e.id.slice(0, 8),
    e.taskType,
    e.polarity,
    e.disposition,
    e.classification,
    e.operatorOverrideClassification ?? '',
    e.decisionId ?? '',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [fmt(headers as unknown as string[]), sep, ...rows.map(fmt)];
  return lines.join('\n') + '\n';
}

function renderShow(decision: Decision): string {
  const lines: string[] = [];
  lines.push(`${decision.metadata.id} — ${decision.spec.summary}`);
  lines.push(`  lifecycle:   ${decision.status.lifecycle}`);
  lines.push(`  source:      ${decision.metadata.source}`);
  lines.push(`  scope:       ${decision.metadata.scope}`);
  lines.push(`  created:     ${decision.metadata.created}`);
  lines.push(`  updated:     ${decision.metadata.updated}`);
  if (decision.spec.reversible !== undefined) {
    lines.push(`  reversible:  ${decision.spec.reversible}`);
  }
  if (decision.status.routing?.assignedActor) {
    lines.push(`  assignedTo:  ${decision.status.routing.assignedActor}`);
  }
  if (decision.status.capacity?.tier) {
    lines.push(`  tier:        ${decision.status.capacity.tier}`);
  }
  if (decision.status.deadline) {
    lines.push(`  deadline:    ${decision.status.deadline}`);
  }
  if (decision.spec.body) {
    lines.push('');
    lines.push('Body:');
    for (const ln of decision.spec.body.split('\n')) lines.push(`  ${ln}`);
  }
  lines.push('');
  lines.push('Options:');
  for (const opt of decision.spec.options) {
    lines.push(`  - ${opt.id}: ${opt.description}`);
    for (const c of opt.consequences ?? []) lines.push(`      • ${c}`);
    for (const sd of opt.subDecisions ?? []) lines.push(`      ↳ sub-decision: ${sd}`);
  }
  lines.push('');
  lines.push(
    `Event history (${decision.decisionLog.length} event${decision.decisionLog.length === 1 ? '' : 's'}):`,
  );
  for (const evt of decision.decisionLog) {
    const actor = typeof evt.by === 'string' && evt.by ? ` by ${evt.by}` : '';
    lines.push(`  - ${evt.ts}  ${evt.type}${actor}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the RFC-0035 Phase 6 (AISDLC-290) decision support surface for a
 * single decision. Composes `renderShow()` (audit-style summary + event log)
 * with the §8 support surface (problem / options / recommendation /
 * counter-arguments / sub-decision graph / Stage A-B-C provenance) so a
 * single `cli-decisions show <id>` invocation surfaces everything the
 * operator needs to act on the decision.
 *
 * AC#5 backward-compat: when a decision has no Stage B/C output yet (e.g.
 * Phase 1-style ad-hoc Decision that has only been opened), the support
 * surface renders the problem + options + (omitted recommendation /
 * counter-arguments / Stage B-C provenance / sub-decision graph) without
 * any "(missing)" markers — see `decision-support-surface.ts` for the
 * gating rules.
 */
function renderShowWithSupportSurface(decision: Decision): string {
  const audit = renderShow(decision);
  const supportSurface = renderDecisionSupportSurface(buildDecisionSupportView(decision));
  return `${audit}\n${supportSurface}`;
}

// ── Interactive `add` flow ───────────────────────────────────────────────────

interface AddInputs {
  summary: string;
  body?: string;
  source: DecisionSource;
  scope: string;
  reversible: boolean;
  options: DecisionOption[];
  assignedActor?: string;
  by?: string;
  /**
   * RFC-0035 AISDLC-447 — canonical ISO-8601 duration after categorical-alias
   * resolution (the original alias is dropped here; the audit lives in the
   * event log via the `by` field + ts). Undefined when no timebox supplied.
   */
  timebox?: string;
  /** AISDLC-463 — operator-authored categorical priority. */
  priority?: DecisionPriority;
  /** AISDLC-463 — operator-authored impact score [0,100]. */
  impactScore?: number;
  /** AISDLC-463 — autonomous-fallback option id (validated against options). */
  autonomousFallbackOptionId?: string;
  /** AISDLC-463 — surfacing-context backlink. */
  contextRef?: string;
}

async function gatherAddInputsInteractive(): Promise<AddInputs> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write('Author a new Decision (Ctrl-C to abort).\n\n');

    let summary = '';
    while (!summary) {
      summary = await prompt(rl, 'Summary (one line): ');
      if (!summary) process.stderr.write('  (required)\n');
    }

    const sourceRaw =
      (await prompt(rl, `Source [${DECISION_SOURCES.join('|')}] (default ad-hoc): `)) || 'ad-hoc';
    if (!DECISION_SOURCES.includes(sourceRaw as DecisionSource)) {
      throw new Error(`invalid source: ${sourceRaw}`);
    }
    const source = sourceRaw as DecisionSource;

    let scope = '';
    while (!scope) {
      scope = await prompt(rl, "Scope (e.g. 'rfc:RFC-0035', 'issue:AISDLC-285', 'workspace'): ");
      if (!scope) process.stderr.write('  (required)\n');
    }

    const reversibleRaw = await prompt(rl, 'Reversible? [Y/n]: ');
    const reversible = reversibleRaw.toLowerCase() !== 'n';

    const body =
      (await prompt(rl, 'Body (optional, single line; leave empty to skip): ')) || undefined;

    const assignedActor =
      (await prompt(rl, 'Assigned actor (optional, email/login): ')) || undefined;

    const by =
      (await prompt(rl, "Author 'by' field (optional, defaults to assigned actor): ")) || undefined;

    const aliasList = Object.keys(TIMEBOX_CATEGORICAL_ALIASES).join('|');
    const timeboxRaw = await prompt(
      rl,
      `Timebox (optional; ISO-8601 duration like PT4H/P1D/P7D or alias ${aliasList}): `,
    );
    let timebox: string | undefined;
    if (timeboxRaw) {
      try {
        timebox = parseTimebox(timeboxRaw).duration;
      } catch (err) {
        throw new Error((err as Error).message);
      }
    }

    process.stderr.write('\nNow enter options. At least one is required.\n');
    process.stderr.write("Press return at the 'Option id' prompt to finish.\n\n");

    const options: DecisionOption[] = [];
    while (true) {
      const idx = options.length + 1;
      const id = await prompt(
        rl,
        `Option ${idx} — id (lowercase slug, e.g. 'opt-a') [blank to finish]: `,
      );
      if (!id) {
        if (options.length === 0) {
          process.stderr.write('  (at least one option is required)\n');
          continue;
        }
        break;
      }
      const description = await prompt(rl, `Option ${idx} — description: `);
      if (!description) {
        process.stderr.write('  (description required, retry this option)\n');
        continue;
      }
      const consequencesRaw = await prompt(
        rl,
        `Option ${idx} — consequences (semicolon-separated; blank=none): `,
      );
      const consequences = consequencesRaw
        ? consequencesRaw
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const opt: DecisionOption = { id, description };
      if (consequences.length > 0) opt.consequences = consequences;
      options.push(opt);
    }

    return {
      summary,
      ...(body ? { body } : {}),
      source,
      scope,
      reversible,
      options,
      ...(assignedActor ? { assignedActor } : {}),
      ...(by ? { by } : {}),
      ...(timebox ? { timebox } : {}),
    };
  } finally {
    rl.close();
  }
}

function gatherAddInputsFromFlags(argv: Record<string, unknown>): AddInputs {
  const summary = String(argv.summary ?? '').trim();
  if (!summary)
    throw new Error('--summary is required (or omit all flags to enter interactive mode)');

  const sourceRaw = String(argv.source ?? 'ad-hoc');
  if (!DECISION_SOURCES.includes(sourceRaw as DecisionSource)) {
    throw new Error(`--source must be one of ${DECISION_SOURCES.join('|')}`);
  }
  const source = sourceRaw as DecisionSource;

  const scope = String(argv.scope ?? '').trim();
  if (!scope) throw new Error('--scope is required');

  const optionInputs = (argv.option as string[] | undefined) ?? [];
  if (optionInputs.length === 0) {
    throw new Error('at least one --option <id>:<description> is required');
  }
  const options: DecisionOption[] = optionInputs.map((raw) => {
    const idx = raw.indexOf(':');
    if (idx <= 0) throw new Error(`--option must be 'id:description' (got: ${raw})`);
    const id = raw.slice(0, idx).trim();
    const description = raw.slice(idx + 1).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`option id must be a lowercase slug (got: ${id})`);
    }
    if (!description) throw new Error(`option description is required (id=${id})`);
    return { id, description };
  });

  const reversible = argv.reversible !== false; // defaults to true
  const inputs: AddInputs = {
    summary,
    source,
    scope,
    reversible,
    options,
  };
  if (typeof argv.body === 'string' && argv.body) inputs.body = String(argv.body);
  if (typeof argv['assigned-actor'] === 'string' && argv['assigned-actor']) {
    inputs.assignedActor = String(argv['assigned-actor']);
  }
  if (typeof argv.by === 'string' && argv.by) inputs.by = String(argv.by);

  // AISDLC-463 — `--timebox-hours <N>` is an ergonomic numeric alias for the
  // existing `--timebox` ISO-duration flag. We map it to ISO form and feed it
  // through the SAME parseTimebox / expiry machinery — no duplicate logic.
  // Passing both is a clear conflict; error rather than silently picking one.
  const hasTimebox = typeof argv.timebox === 'string' && argv.timebox;
  const hasTimeboxHours = argv['timebox-hours'] !== undefined && argv['timebox-hours'] !== null;
  if (hasTimebox && hasTimeboxHours) {
    throw new Error('--timebox and --timebox-hours are mutually exclusive — pass only one');
  }
  if (hasTimebox) {
    // parseTimebox throws on invalid input; the caller catches + fail()s
    // with the operator-friendly message via the surrounding try/catch.
    inputs.timebox = parseTimebox(String(argv.timebox)).duration;
  } else if (hasTimeboxHours) {
    const hours = Number(argv['timebox-hours']);
    inputs.timebox = parseTimebox(hoursToIsoDuration(hours)).duration;
  }

  if (argv.priority !== undefined && argv.priority !== null && String(argv.priority) !== '') {
    const p = String(argv.priority);
    if (!DECISION_PRIORITIES.includes(p as DecisionPriority)) {
      throw new Error(`--priority must be one of ${DECISION_PRIORITIES.join('|')} (got: ${p})`);
    }
    inputs.priority = p as DecisionPriority;
  }

  if (argv['impact-score'] !== undefined && argv['impact-score'] !== null) {
    const n = Number(argv['impact-score']);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(
        `--impact-score must be a number in [0,100] (got: ${String(argv['impact-score'])})`,
      );
    }
    inputs.impactScore = n;
  }

  if (typeof argv['autonomous-fallback'] === 'string' && argv['autonomous-fallback']) {
    const fb = String(argv['autonomous-fallback']);
    if (!options.some((o) => o.id === fb)) {
      throw new Error(
        `--autonomous-fallback "${fb}" must reference one of the declared option ids: ${options.map((o) => o.id).join(', ')}`,
      );
    }
    inputs.autonomousFallbackOptionId = fb;
  }

  if (typeof argv['context-ref'] === 'string' && argv['context-ref']) {
    inputs.contextRef = String(argv['context-ref']);
  }

  return inputs;
}

// ── CLI builder ──────────────────────────────────────────────────────────────

export function buildDecisionsCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-decisions')
    .usage('Usage: $0 <command> [options]\n\nRFC-0035 Decision Catalog CLI (Phase 1).')
    .option('work-dir', {
      alias: 'w',
      describe:
        'Project root (defaults to cwd). Resolves the event log under <work-dir>/.ai-sdlc/_decisions/events.jsonl.',
      type: 'string',
      default: process.cwd(),
    })
    .command(
      'list',
      'List decisions projected from the event log. Default sort is timebox-remaining ascending (most-urgent first; untimeboxed sorted last by created date).',
      (y) =>
        y
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table' as const,
          })
          .option('sort', {
            type: 'string',
            choices: ['timebox', 'created'] as const,
            default: 'timebox' as const,
            describe:
              'AISDLC-447 — sort order. `timebox` = timebox-remaining ascending (most-urgent first); `created` = legacy creation-order ascending.',
          })
          .option('ranked', {
            type: 'boolean',
            default: false,
            describe:
              'AISDLC-463 — rank pending decisions by priority × impact × urgency-decay (most-urgent first). priorityWeight (critical=4/high=3/medium=2/low=1, default low) × impactFactor ((impactScore/100)+1, default impact 50) × urgencyDecay (expired=3 / <1h=2 / <24h=1.5 / else or untimeboxed=1). Ties break by created ascending. Overrides --sort when set.',
          })
          .option('expired', {
            type: 'boolean',
            default: false,
            describe:
              'AISDLC-447 — filter to decisions whose timebox has expired AND are still unresolved (lifecycle ≠ answered / archived / superseded).',
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        if (!isDecisionCatalogEnabled()) {
          // Degrade open per AC#6 — read paths return empty + a stderr notice.
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, decisions: [], skipped: 0 });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }
        const { decisions: rawDecisions, skipped } = listDecisions({ workDir });
        // Apply --expired filter BEFORE sort so the urgency ordering only
        // reflects the visible subset.
        const filtered = argv.expired ? filterExpiredDecisions(rawDecisions) : rawDecisions;
        // AISDLC-463 — `--ranked` is a third ordering mode alongside the
        // AISDLC-447 `--sort timebox|created`. When set it takes precedence
        // (the priority × impact × urgency formula subsumes the plain
        // timebox-remaining order).
        let decisions: Decision[];
        if (argv.ranked) {
          decisions = rankDecisions(filtered);
        } else if (argv.sort === 'created') {
          decisions = filtered;
        } else {
          decisions = sortDecisionsByTimeboxUrgency(filtered);
        }
        if (String(argv.format) === 'json') {
          emit({ ok: true, enabled: true, decisions, skipped });
        } else {
          process.stdout.write(renderListTable(decisions));
          if (skipped > 0) emitText(`(${skipped} malformed event line(s) skipped)`);
        }
      },
    )
    .command(
      'show <id>',
      'Render one decision with its full event history + the Phase 6 decision support surface (recommendation / counter-arguments / sub-decision graph / Stage A-B-C provenance).',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          })
          .option('support-surface-only', {
            type: 'boolean',
            default: false,
            describe:
              'Emit only the RFC-0035 Phase 6 decision support surface (problem / options / recommendation / counter-arguments / sub-decision graph / Stage A-B-C provenance). Suppresses the audit-style header + event history.',
          }),
      // NB: yargs only propagates handler errors via parseAsync rejection
      // when the handler is async — sync throws get swallowed. Keep this
      // (and every handler that calls fail() / process.exit) `async` so
      // tests can assert exits via `.rejects.toThrow`.
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        const supportSurfaceOnly = Boolean(argv['support-surface-only']);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, decision: null });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) {
          if (String(argv.format) === 'json') {
            emit({ ok: false, enabled: true, decision: null, reason: 'not-found' });
          } else {
            emitText(`(no decision found for ${id})`);
          }
          process.exit(1);
        }
        if (String(argv.format) === 'json') {
          // Always include the structured support view alongside the raw
          // decision so callers (TUI, web surface) can consume it without
          // re-deriving. `supportSurface: null` is not used — the view is
          // always buildable from the decision (empty sections when stages
          // haven't run, per AC#5).
          const supportSurface: DecisionSupportView = buildDecisionSupportView(decision);
          emit({ ok: true, enabled: true, decision, supportSurface });
        } else if (supportSurfaceOnly) {
          process.stdout.write(renderDecisionSupportSurface(buildDecisionSupportView(decision)));
        } else {
          process.stdout.write(renderShowWithSupportSurface(decision));
        }
      },
    )
    .command(
      'add',
      'Author a new Decision. Pass --summary + --scope + --option to skip the interactive prompt.',
      (y) =>
        y
          .option('summary', {
            type: 'string',
            describe: 'One-line decision summary.',
          })
          .option('body', {
            type: 'string',
            describe: 'Full problem statement (markdown).',
          })
          .option('source', {
            type: 'string',
            choices: DECISION_SOURCES as unknown as string[],
            default: 'ad-hoc',
            describe: 'Generator class — see RFC-0035 §4.1.',
          })
          .option('scope', {
            type: 'string',
            describe: "Scope reference (e.g. 'rfc:RFC-0035', 'issue:AISDLC-285', 'workspace').",
          })
          .option('reversible', {
            type: 'boolean',
            default: true,
            describe: 'OQ-3/OQ-12 — gates auto-apply + override window. Default true.',
          })
          .option('option', {
            type: 'array',
            string: true,
            describe:
              "Repeat for each option: 'id:description' (e.g. --option opt-a:'Keep as-is').",
          })
          .option('assigned-actor', {
            type: 'string',
            describe: 'Optional initial routing — assigned actor email/login.',
          })
          .option('by', {
            type: 'string',
            describe: "Optional author 'by' field on the decision-opened event.",
          })
          .option('id', {
            type: 'string',
            describe: 'Override the auto-allocated DEC-NNNN id (advanced).',
          })
          .option('timebox', {
            type: 'string',
            describe: `AISDLC-447 — operator-authored timebox. ISO-8601 duration (PT4H, P1D, P7D, P30D, ...) or alias (${Object.keys(TIMEBOX_CATEGORICAL_ALIASES).join('|')}). When set, the decision sorts to the top of \`list\` urgency + expires at created+duration.`,
          })
          .option('timebox-hours', {
            type: 'number',
            describe:
              'AISDLC-463 — ergonomic numeric timebox alias. `--timebox-hours 4` ≡ `--timebox PT4H`; maps onto the same expiry machinery. Mutually exclusive with --timebox.',
          })
          .option('priority', {
            type: 'string',
            choices: DECISION_PRIORITIES as unknown as string[],
            describe:
              'AISDLC-463 — operator-authored categorical priority (critical/high/medium/low). Feeds `list --ranked`.',
          })
          .option('impact-score', {
            type: 'number',
            describe:
              'AISDLC-463 — operator-authored impact score in [0,100] (downstream blast-radius). Feeds `list --ranked`.',
          })
          .option('autonomous-fallback', {
            type: 'string',
            describe:
              'AISDLC-463 — option id auto-selected by `auto-expire` when the timebox lapses unanswered. Must reference a declared --option id.',
          })
          .option('context-ref', {
            type: 'string',
            describe:
              'AISDLC-463 — surfacing-context backlink (a PR url, `pr:N`, or task id) recorded for the audit trail.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        if (!isDecisionCatalogEnabled()) {
          // AC#6 — degrade-open is read-only; the mutating path refuses.
          fail(
            decisionCatalogDisabledMessage() +
              '\n[cli-decisions] add: refusing to mutate the event log while the flag is off.',
          );
        }

        const hasAnyFlag =
          argv.summary !== undefined ||
          argv.scope !== undefined ||
          (Array.isArray(argv.option) && argv.option.length > 0);
        // NB: the AISDLC-463 author flags (--priority / --impact-score /
        // --autonomous-fallback / --context-ref / --timebox-hours) never appear
        // without --summary/--scope/--option (they decorate an add), so the
        // interactive-mode trigger above already covers them.

        let inputs: AddInputs;
        try {
          if (hasAnyFlag) {
            inputs = gatherAddInputsFromFlags(argv as Record<string, unknown>);
          } else {
            if (!process.stdin.isTTY) {
              fail(
                'no flags supplied and stdin is not a TTY — pass --summary/--scope/--option or run from a terminal',
              );
            }
            inputs = await gatherAddInputsInteractive();
          }
        } catch (err) {
          fail((err as Error).message);
        }

        const decisionId =
          typeof argv.id === 'string' && argv.id ? String(argv.id) : nextDecisionId({ workDir });

        // RFC-0035 AISDLC-447 — when --timebox is set, compute expiry from
        // the SAME `now` we'll stamp on the event so the two derived fields
        // agree to the millisecond (the factory uses Date.now() if `now` is
        // omitted, but we want a single shared reference for both).
        const eventNow = new Date();
        let timeboxExpiresAt: string | undefined;
        if (inputs.timebox !== undefined) {
          try {
            const parsed = parseTimebox(inputs.timebox);
            timeboxExpiresAt = computeTimeboxExpiresAt(parsed.durationMs, eventNow);
          } catch (err) {
            // This is belt-and-suspenders — gatherAddInputs* already validated.
            fail((err as Error).message);
          }
        }

        const event = makeDecisionOpenedEvent({
          decisionId,
          source: inputs.source,
          scope: inputs.scope,
          summary: inputs.summary,
          ...(inputs.body !== undefined ? { body: inputs.body } : {}),
          reversible: inputs.reversible,
          options: inputs.options,
          ...(inputs.assignedActor !== undefined
            ? { routing: { assignedActor: inputs.assignedActor } }
            : {}),
          ...(inputs.by !== undefined ? { by: inputs.by } : {}),
          ...(inputs.timebox !== undefined ? { timebox: inputs.timebox } : {}),
          ...(timeboxExpiresAt !== undefined ? { timeboxExpiresAt } : {}),
          // AISDLC-463 — operator-authored ranking + fallback + context fields.
          ...(inputs.priority !== undefined ? { priority: inputs.priority } : {}),
          ...(inputs.impactScore !== undefined ? { impactScore: inputs.impactScore } : {}),
          ...(inputs.autonomousFallbackOptionId !== undefined
            ? { autonomousFallbackOptionId: inputs.autonomousFallbackOptionId }
            : {}),
          ...(inputs.contextRef !== undefined ? { contextRef: inputs.contextRef } : {}),
          now: eventNow,
        });

        const path = appendDecisionEvent(event, { workDir });
        const decision = projectDecision(decisionId, { workDir });

        if (String(argv.format) === 'json') {
          emit({ ok: true, decisionId, path, decision });
        } else {
          emitText(`decision added: ${decisionId}`);
          emitText(`  event log: ${path}`);
          emitText(`  summary:   ${inputs.summary}`);
          emitText(`  options:   ${inputs.options.map((o) => o.id).join(', ')}`);
          if (inputs.timebox !== undefined && timeboxExpiresAt) {
            emitText(`  timebox:   ${inputs.timebox} (expires ${timeboxExpiresAt})`);
          }
          if (inputs.priority !== undefined) emitText(`  priority:  ${inputs.priority}`);
          if (inputs.impactScore !== undefined) emitText(`  impact:    ${inputs.impactScore}`);
          if (inputs.autonomousFallbackOptionId !== undefined) {
            emitText(`  fallback:  ${inputs.autonomousFallbackOptionId}`);
          }
          if (inputs.contextRef !== undefined) emitText(`  context:   ${inputs.contextRef}`);
        }
      },
    )
    .command(
      'log-path',
      'Print the resolved event-log path (no read or write).',
      (y) => y,
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const path = resolveEventLogPath(workDir);
        emit({
          ok: true,
          path,
          exists: existsSync(path),
          sizeBytes: existsSync(path) ? readFileSync(path, 'utf8').length : 0,
        });
      },
    )
    .command(
      'score-a <id>',
      'Run Stage A deterministic scorer on a decision (RFC-0035 Phase 2).',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('store', {
            type: 'boolean',
            default: false,
            describe:
              'Emit a recommendation-issued event to persist the Stage A result on the Decision record (AC#4).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, stageA: null });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }

        const decision = projectDecision(id, { workDir });
        if (decision === null) {
          fail(`decision not found: ${id}`);
        }

        const { decisions: allOpen } = listDecisions({ workDir });
        const openDecisions = allOpen.filter((d) => d.metadata.id !== id);

        // Load RFC-0014 dep-graph when AI_SDLC_DEPS_COMPOSITION is enabled.
        let graph: ReturnType<typeof buildDependencyGraph> | undefined;
        if (isCompositionEnabled()) {
          try {
            graph = buildDependencyGraph({ workDir });
          } catch {
            warnToStderr('[score-a] dep-graph unavailable — blast-radius will default to zeros');
          }
        }

        const stageA = runStageA({ decision, openDecisions, graph, workDir });

        if (argv.store) {
          const event = makeRecommendationIssuedEvent({ decisionId: id, stageAOutput: stageA });
          appendDecisionEvent(event, { workDir });
        }

        if (String(argv.format) === 'json') {
          emit({ ok: true, enabled: true, decisionId: id, stageA, stored: Boolean(argv.store) });
        } else {
          emitText(`Stage A score for ${id}`);
          emitText(`  priority:       ${stageA.prioritySignal.toFixed(3)}`);
          emitText(`  resolvedByStageA: ${stageA.resolvedByStageA}`);
          emitText(`  routingActor:   ${stageA.routingActor ?? '(none — needs Stage B)'}`);
          emitText(`  reversibility:  ${stageA.reversibility}`);
          emitText(
            `  blast-radius:   tasks=${stageA.blastRadius.blockedTaskCount}  rfcs=${stageA.blastRadius.blockedRfcCount}  pillars=[${stageA.blastRadius.affectedPillars.join(', ')}]`,
          );
          emitText(`  treeDepth:      ${stageA.decisionTreeDepth}`);
          emitText(
            `  schema:         ${stageA.schemaValidity.valid ? 'valid' : 'invalid: ' + stageA.schemaValidity.reasons.join('; ')}`,
          );
          emitText(
            `  refs:           ${stageA.referenceResolution.resolved ? 'resolved' : 'broken: ' + stageA.referenceResolution.broken.join('; ')}`,
          );
          emitText(
            `  capacity:       ${stageA.capacityCheck.withinBudget ? 'within budget' : 'over budget'} — ${stageA.capacityCheck.reason}`,
          );
          emitText(
            `  duplicate:      ${stageA.duplicateDetection.isDuplicate ? 'candidate-dup: ' + stageA.duplicateDetection.candidateId : 'unique'} (sim=${stageA.duplicateDetection.similarity.toFixed(3)})`,
          );
          if (argv.store) emitText('  (Stage A result stored as recommendation-issued event)');
        }
      },
    )
    .command(
      'coverage',
      'Report Stage A coverage across the catalog (target ≥40% per RFC-0035 AC#6).',
      (y) =>
        y.option('format', {
          type: 'string',
          choices: ['json', 'text'] as const,
          default: 'text' as const,
        }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        if (!isDecisionCatalogEnabled()) {
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, coverage: null });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }

        const { decisions } = listDecisions({ workDir });

        let graph: ReturnType<typeof buildDependencyGraph> | undefined;
        if (isCompositionEnabled()) {
          try {
            graph = buildDependencyGraph({ workDir });
          } catch {
            warnToStderr('[coverage] dep-graph unavailable — blast-radius defaults to zeros');
          }
        }

        const coverage = computeStageACoverage(decisions, { graph, workDir });

        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            enabled: true,
            coverage,
            target: STAGE_A_COVERAGE_TARGET,
          });
        } else {
          emitText(`Stage A coverage: ${coverage.resolvedByStageA}/${coverage.totalDecisions}`);
          emitText(`  rate:   ${(coverage.coverageRate * 100).toFixed(1)}%`);
          emitText(`  target: ≥${(STAGE_A_COVERAGE_TARGET * 100).toFixed(0)}%`);
          emitText(`  meets target: ${coverage.meetsTarget ? 'yes' : 'no'}`);
        }
      },
    )
    .command(
      'score-c <id>',
      'Run Stage C LLM evaluation on a decision (RFC-0035 Phase 5 / AISDLC-289). Defaults to dry-run; pass --store to persist + --auto-apply to fire the auto-apply path for reversible decisions that meet the confidence threshold.',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('store', {
            type: 'boolean',
            default: false,
            describe:
              'Emit a stage-c-completed event to persist the Stage C result on the Decision record.',
          })
          .option('auto-apply', {
            type: 'boolean',
            default: false,
            describe:
              'When the recommendation meets the threshold AND the decision is reversible, also emit operator-answered (by: framework). Implies --store.',
          })
          .option('force', {
            type: 'boolean',
            default: false,
            describe:
              'Bypass the §5.3 mid-band fire guard so Stage C runs even when Stage B already resolved the decision.',
          })
          .option('threshold', {
            type: 'number',
            describe:
              'Per-call confidence threshold override [0,1]. Default: decisions-config.yaml or 0.7.',
          })
          .option('model', {
            type: 'string',
            describe: 'Model override (e.g. claude-haiku-4-5).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, stageC: null });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }

        const decision = projectDecision(id, { workDir });
        if (decision === null) {
          fail(`decision not found: ${id}`);
        }

        // Compute Stage A + Stage B so the mid-band guard has a real
        // composite score to check against. This mirrors the orchestrator's
        // production flow: A → B → C if mid-band.
        const { decisions: allOpen } = listDecisions({ workDir });
        const openDecisions = allOpen.filter((d) => d.metadata.id !== id);
        let graph: ReturnType<typeof buildDependencyGraph> | undefined;
        if (isCompositionEnabled()) {
          try {
            graph = buildDependencyGraph({ workDir });
          } catch {
            warnToStderr('[score-c] dep-graph unavailable — blast-radius defaults to zeros');
          }
        }
        const stageA = runStageA({ decision, openDecisions, graph, workDir });
        const stageB = runStageB({ decision, stageA });

        // CLI requires no real invoker by design — the CLI is a dry-run
        // surface for operators inspecting "what would Stage C say?". The
        // substrate falls open to a `pending` sentinel which the operator
        // can read as "no LLM wired up". Production callers (the
        // orchestrator) inject a real invoker via the library API.
        const loaded = loadDecisionsConfig({ workDir });
        const { threshold: configThreshold } = resolveStageCRuntimeConfig(loaded);
        const effectiveThreshold =
          typeof argv.threshold === 'number' ? Number(argv.threshold) : configThreshold;

        const result = await runStageC({
          decision,
          stageB,
          workDir,
          forceFire: Boolean(argv.force),
          threshold: effectiveThreshold,
          ...(typeof argv.model === 'string' && argv.model ? { model: String(argv.model) } : {}),
        });

        if (!result.fired) {
          if (String(argv.format) === 'json') {
            emit({
              ok: true,
              enabled: true,
              fired: false,
              skipReason: result.skipReason,
              stageBCompositeScore: stageB.compositeScore,
            });
          } else {
            emitText(`Stage C did not fire for ${id}`);
            emitText(`  reason:                ${result.skipReason}`);
            emitText(`  stage-b composite:     ${stageB.compositeScore.toFixed(3)}`);
            emitText(`  mid-band:              [0.4, 0.7) — pass --force to bypass for spot-check`);
          }
          return;
        }

        const stageC = result.stageC!;
        const autoApply = Boolean(argv['auto-apply']);
        const shouldStore = Boolean(argv.store) || autoApply;
        const autoApplyEligible = autoApply && isStageCAutoApplyEligible(decision, stageC);

        if (shouldStore) {
          const stageCEvent = makeStageCCompletedEvent({
            decisionId: id,
            stageC,
            autoApplied: autoApplyEligible,
          });
          appendDecisionEvent(stageCEvent, { workDir });

          if (autoApplyEligible) {
            const answeredEvent = makeStageCAutoApplyAnsweredEvent({
              decisionId: id,
              chosenOptionId: stageC.recommendation.optionId,
              rationale: stageC.recommendation.rationale,
            });
            appendDecisionEvent(answeredEvent, { workDir });
          }
        }

        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            enabled: true,
            fired: true,
            stageC,
            stored: shouldStore,
            autoApplied: autoApplyEligible,
            stageBCompositeScore: stageB.compositeScore,
          });
        } else {
          emitText(`Stage C result for ${id}`);
          emitText(
            `  fired:               yes (stage-b composite ${stageB.compositeScore.toFixed(3)})`,
          );
          emitText(`  recommendation:      ${stageC.recommendation.optionId}`);
          emitText(`  confidence:          ${stageC.recommendation.confidence.toFixed(3)}`);
          emitText(`  threshold:           ${stageC.effectiveThreshold.toFixed(3)}`);
          emitText(`  meets threshold:     ${stageC.metBehindThreshold}`);
          emitText(`  llm-answer-eligible: ${stageC.llmAnswerEligible}`);
          emitText(`  model:               ${stageC.model}`);
          emitText(`  reversible:          ${decision.spec.reversible !== false}`);
          if (stageC.error) emitText(`  error:               ${stageC.error}`);
          emitText(`  rationale:           ${stageC.recommendation.rationale}`);
          if (shouldStore) {
            emitText(`  (stage-c-completed event persisted)`);
            if (autoApplyEligible) {
              emitText(
                `  (operator-answered event by:framework persisted — override window: ${resolveStageCRuntimeConfig(loaded).overrideWindowHours}h)`,
              );
            }
          }
        }
      },
    )
    .command(
      'graph <id>',
      'RFC-0035 Phase 10 (AISDLC-294) — render the sub-decision graph for a decision. `--format mermaid` (default) emits the raw flowchart source for inclusion in markdown / web surfaces; `--format html` emits a standalone HTML page with the Mermaid CDN renderer embedded so operators can open it in a browser.',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('format', {
            type: 'string',
            choices: ['mermaid', 'html', 'json'] as const,
            default: 'mermaid' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, graph: null });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) {
          fail(`decision not found: ${id}`);
        }
        const evaluation = decision!.status.evaluation as
          | { stageC?: import('../decisions/index.js').StageCOutput }
          | undefined;
        const stageC = evaluation?.stageC;
        const graph = buildSubDecisionGraph(decision!, stageC);
        const mermaid = renderSubDecisionGraphMermaid(graph, id);

        if (String(argv.format) === 'json') {
          emit({ ok: true, enabled: true, decisionId: id, graph, mermaid });
          return;
        }
        if (mermaid === null) {
          emitText(`(no sub-decisions declared or implied for ${id} — empty graph)`);
          return;
        }
        if (String(argv.format) === 'html') {
          const html = renderSubDecisionGraphHtml(graph, id);
          process.stdout.write(html ?? '');
          return;
        }
        process.stdout.write(mermaid + '\n');
      },
    )
    .command(
      'research <id>',
      'RFC-0035 Phase 10 (AISDLC-294) — list / read persisted research-subagent findings for a decision. The framework writes findings under .ai-sdlc/_decisions/research/<DEC>-<ts>.md when Stage C confidence falls below the configured threshold AND an invoker is wired up. This subcommand only READS — it does NOT spawn a subagent (no transport baked into the CLI; production wires the invoker via the library API).',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('format', {
            type: 'string',
            choices: ['text', 'json'] as const,
            default: 'text' as const,
          })
          .option('gate', {
            type: 'boolean',
            default: false,
            describe:
              'Report the gate decision (would the framework invoke?) based on the current Stage C output + configured threshold. Does not spawn the subagent.',
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, artifacts: [], gate: null });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) {
          fail(`decision not found: ${id}`);
        }
        const artifacts = readResearchArtifacts(workDir, id);

        let gateResult: ReturnType<typeof shouldInvokeResearchSubagent> | null = null;
        let effectiveThreshold: number | null = null;
        if (argv.gate) {
          const loaded = loadDecisionsConfig({ workDir });
          effectiveThreshold = resolveResearchSubagentThreshold(loaded);
          const evaluation = decision!.status.evaluation as
            | { stageC?: import('../decisions/index.js').StageCOutput }
            | undefined;
          gateResult = shouldInvokeResearchSubagent({
            stageC: evaluation?.stageC ?? null,
            threshold: effectiveThreshold,
          });
        }

        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            enabled: true,
            decisionId: id,
            artifacts,
            ...(argv.gate ? { gate: gateResult, effectiveThreshold } : {}),
          });
          return;
        }
        if (argv.gate && gateResult) {
          emitText(`Research-subagent gate for ${id}`);
          emitText(`  threshold:           ${effectiveThreshold?.toFixed(3) ?? 'n/a'}`);
          emitText(`  observedConfidence:  ${gateResult.observedConfidence?.toFixed(3) ?? 'n/a'}`);
          emitText(`  invoke:              ${gateResult.invoke}`);
          if (gateResult.skipReason) emitText(`  skipReason:          ${gateResult.skipReason}`);
          emitText('');
        }
        if (artifacts.length === 0) {
          emitText(`(no research findings persisted for ${id})`);
          return;
        }
        emitText(`Research findings for ${id} (${artifacts.length} artifact(s)):`);
        emitText('');
        for (const a of artifacts) {
          emitText(`--- ${a.timestamp} (${a.path}) ---`);
          emitText(a.findingsMarkdown.trimEnd());
          emitText('');
        }
      },
    )
    .command(
      'summary <id>',
      'RFC-0035 Phase 10 (AISDLC-294) — read the persisted NotebookLM-style summary for a decision (gated on AI_SDLC_DECISION_NOTEBOOK_SUMMARIES feature flag). Read-only: does NOT generate; production wires `runNotebookSummary()` from the library API.',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('format', {
            type: 'string',
            choices: ['text', 'json'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          warnToStderr(decisionCatalogDisabledMessage());
          if (String(argv.format) === 'json') {
            emit({ ok: true, enabled: false, summary: null });
          } else {
            emitText('(decision catalog feature flag is off — no decisions)');
          }
          return;
        }
        if (!isNotebookSummariesEnabled()) {
          warnToStderr(notebookSummariesDisabledMessage());
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) {
          fail(`decision not found: ${id}`);
        }
        const summary = readNotebookSummary(workDir, id);
        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            enabled: true,
            notebookSummariesEnabled: isNotebookSummariesEnabled(),
            decisionId: id,
            summary,
          });
          return;
        }
        if (summary === null) {
          emitText(`(no notebook summary persisted for ${id})`);
          return;
        }
        emitText(`Notebook summary for ${id}`);
        emitText(`  (path: ${summary.path})`);
        emitText('');
        emitText(summary.summaryMarkdown.trimEnd());
      },
    )
    .command(
      'answer <id> <optionId>',
      'Resolve a decision by picking an option (operator-answer path).',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .positional('optionId', {
            type: 'string',
            demandOption: true,
            describe: "The option id to pick (must be one of the decision's declared option ids).",
          })
          .option('rationale', { type: 'string', describe: 'Optional free-text rationale.' })
          .option('by', { type: 'string', describe: 'Operator identifier (email / login).' })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        const optionId = String(argv.optionId);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          fail(
            decisionCatalogDisabledMessage() +
              '\n[cli-decisions] answer: refusing to mutate the event log while the flag is off.',
          );
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) fail(`decision not found: ${id}`);
        if (!decision!.spec.options.some((o) => o.id === optionId)) {
          fail(
            `optionId "${optionId}" is not declared on ${id} — valid options: ${decision!.spec.options.map((o) => o.id).join(', ')}`,
          );
        }
        const evt = makeOperatorAnsweredEvent({
          decisionId: id,
          chosenOptionId: optionId,
          ...(typeof argv.rationale === 'string' ? { rationale: String(argv.rationale) } : {}),
          ...(typeof argv.by === 'string' ? { by: String(argv.by) } : {}),
        });
        appendDecisionEvent(evt, { workDir });

        if (String(argv.format) === 'json') {
          emit({ ok: true, decisionId: id, chosenOptionId: optionId });
        } else {
          emitText(`decision answered: ${id} → ${optionId}`);
          if (typeof argv.rationale === 'string' && argv.rationale) {
            emitText(`  rationale: ${argv.rationale}`);
          }
        }
      },
    )
    .command(
      'resolve <id>',
      'AISDLC-463 — operator-driven resolution. Pick an option with --option, recording resolver + chosen option + optional --rationale + surfacing context (--context-ref / --surfacing-agent) as an `operator-answered` audit event. Refuses an already-resolved/archived decision.',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('option', {
            type: 'string',
            demandOption: true,
            describe: "The option id to pick (must be one of the decision's declared option ids).",
          })
          .option('rationale', {
            type: 'string',
            describe: 'Optional free-text rationale for the choice (audited).',
          })
          .option('by', {
            type: 'string',
            describe: 'Resolver identifier (operator email / login). Recorded as the audit actor.',
          })
          .option('context-ref', {
            type: 'string',
            describe:
              'AISDLC-463 — surfacing-context backlink (PR url / `pr:N` / task id). Falls back to the decision spec contextRef when omitted.',
          })
          .option('surfacing-agent', {
            type: 'string',
            describe:
              'AISDLC-463 — the agent / surface that raised the decision, where known. Recorded for audit completeness.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        const optionId = String(argv.option);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          fail(
            decisionCatalogDisabledMessage() +
              '\n[cli-decisions] resolve: refusing to mutate the event log while the flag is off.',
          );
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) fail(`decision not found: ${id}`);
        // Refuse to re-resolve a terminal-state decision (AC#3).
        const lc = decision!.status.lifecycle;
        if (lc === 'answered' || lc === 'archived' || lc === 'superseded') {
          fail(
            `${id} is already ${lc} — refusing to resolve. (answered option: ${decision!.status.answeredOptionId ?? '(none)'})`,
          );
        }
        if (!decision!.spec.options.some((o) => o.id === optionId)) {
          fail(
            `option "${optionId}" is not declared on ${id} — valid options: ${decision!.spec.options.map((o) => o.id).join(', ')}`,
          );
        }

        // AC#7 — capture surfacing context. The --context-ref override falls
        // back to the decision's authored spec.contextRef so the audit trail
        // always backlinks to what raised the decision.
        const contextRef =
          typeof argv['context-ref'] === 'string' && argv['context-ref']
            ? String(argv['context-ref'])
            : decision!.spec.contextRef;

        const evt = makeOperatorAnsweredEvent({
          decisionId: id,
          chosenOptionId: optionId,
          ...(typeof argv.rationale === 'string' ? { rationale: String(argv.rationale) } : {}),
          ...(contextRef !== undefined ? { contextRef } : {}),
          ...(typeof argv['surfacing-agent'] === 'string' && argv['surfacing-agent']
            ? { surfacingAgent: String(argv['surfacing-agent']) }
            : {}),
          ...(typeof argv.by === 'string' ? { by: String(argv.by) } : {}),
        });
        appendDecisionEvent(evt, { workDir });

        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            decisionId: id,
            chosenOptionId: optionId,
            resolver: typeof argv.by === 'string' ? String(argv.by) : null,
            ...(contextRef !== undefined ? { contextRef } : {}),
            ...(typeof argv['surfacing-agent'] === 'string' && argv['surfacing-agent']
              ? { surfacingAgent: String(argv['surfacing-agent']) }
              : {}),
          });
        } else {
          emitText(`decision resolved: ${id} → ${optionId}`);
          if (typeof argv.by === 'string' && argv.by) emitText(`  resolver:  ${argv.by}`);
          if (typeof argv.rationale === 'string' && argv.rationale) {
            emitText(`  rationale: ${argv.rationale}`);
          }
          if (contextRef !== undefined) emitText(`  context:   ${contextRef}`);
          if (typeof argv['surfacing-agent'] === 'string' && argv['surfacing-agent']) {
            emitText(`  surfacing: ${argv['surfacing-agent']}`);
          }
        }
      },
    )
    .command(
      'auto-expire',
      'AISDLC-463 — scan pending decisions; for each whose timebox has expired AND that declared an --autonomous-fallback option, pick the fallback and write an `auto-expired` audit event (resolver = "auto-expired"). Decisions without a fallback are left pending (skipped). Idempotent. Use --dry-run to preview.',
      (y) =>
        y
          .option('dry-run', {
            type: 'boolean',
            default: false,
            describe: 'Report what WOULD be auto-expired without writing any events. No mutation.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const dryRun = Boolean(argv['dry-run']);
        if (!isDecisionCatalogEnabled()) {
          fail(
            decisionCatalogDisabledMessage() +
              '\n[cli-decisions] auto-expire: refusing to mutate the event log while the flag is off.',
          );
        }
        const { decisions } = listDecisions({ workDir });
        const now = new Date();

        const expired: Array<{ decisionId: string; chosenOptionId: string; rationale: string }> =
          [];
        const skipped: Array<{ decisionId: string; reason: string }> = [];

        for (const d of decisions) {
          const lc = d.status.lifecycle;
          // Idempotent: a resolved / terminal-state decision is never re-expired.
          if (lc === 'answered' || lc === 'archived' || lc === 'superseded') {
            continue;
          }
          if (!isDecisionTimeboxExpired(d, now)) {
            continue; // not yet expired — leave pending silently
          }
          const fallback = d.spec.autonomousFallbackOptionId;
          if (fallback === undefined) {
            // Expired but no fallback declared — leave pending, log the skip (AC#4).
            skipped.push({ decisionId: d.metadata.id, reason: 'no-autonomous-fallback' });
            continue;
          }
          // Defensive: a fallback referencing a now-missing option shouldn't
          // happen (add validates it) but a hand-edited log could; skip rather
          // than write an invalid answer.
          if (!d.spec.options.some((o) => o.id === fallback)) {
            skipped.push({ decisionId: d.metadata.id, reason: 'fallback-option-missing' });
            continue;
          }
          const expiresAt = d.status.timeboxExpiresAt ?? now.toISOString();
          const rationale = `fallback after ${d.spec.timebox ?? 'expired'} timebox`;
          expired.push({ decisionId: d.metadata.id, chosenOptionId: fallback, rationale });

          if (!dryRun) {
            const evt = makeAutoExpiredEvent({
              decisionId: d.metadata.id,
              chosenOptionId: fallback,
              rationale,
              expiredAt: expiresAt,
              ...(d.spec.contextRef !== undefined ? { contextRef: d.spec.contextRef } : {}),
              now,
            });
            appendDecisionEvent(evt, { workDir });
          }
        }

        if (String(argv.format) === 'json') {
          emit({ ok: true, dryRun, expired, skipped });
        } else {
          if (dryRun) emitText('(dry-run — no events written)');
          if (expired.length === 0) {
            emitText('no decisions auto-expired.');
          } else {
            emitText(
              `${dryRun ? 'would auto-expire' : 'auto-expired'} ${expired.length} decision(s):`,
            );
            for (const e of expired) {
              emitText(`  ${e.decisionId} → ${e.chosenOptionId} (${e.rationale})`);
            }
          }
          for (const s of skipped) {
            emitText(`  skip ${s.decisionId}: ${s.reason}`);
          }
        }
      },
    )
    .command(
      'override <id> <optionId>',
      'Override a framework-auto-applied decision (RFC-0035 OQ-3 24h window). Records a negative exemplar on the substrate corpus + emits an `overridden` event on the decision log.',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .positional('optionId', {
            type: 'string',
            demandOption: true,
            describe: 'The option id the operator picks instead of the framework choice.',
          })
          .option('rationale', { type: 'string', describe: 'Optional reason for the override.' })
          .option('by', { type: 'string', describe: 'Operator identifier (email / login).' })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        const optionId = String(argv.optionId);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          fail(
            decisionCatalogDisabledMessage() +
              '\n[cli-decisions] override: refusing to mutate the event log while the flag is off.',
          );
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) fail(`decision not found: ${id}`);
        if (!decision!.spec.options.some((o) => o.id === optionId)) {
          fail(
            `optionId "${optionId}" is not declared on ${id} — valid options: ${decision!.spec.options.map((o) => o.id).join(', ')}`,
          );
        }

        // Find the most recent stage-c-completed event with autoApplied:true.
        const lastStageC = [...decision!.decisionLog]
          .reverse()
          .find(
            (e) =>
              e.type === 'stage-c-completed' &&
              (e as { autoApplied?: boolean }).autoApplied === true,
          ) as
          | (import('../decisions/index.js').StageCCompletedEvent & {
              autoApplied: boolean;
            })
          | undefined;
        if (!lastStageC) {
          fail(
            `${id} has no auto-applied stage-c-completed event to override — use 'answer' to set an initial answer instead.`,
          );
        }
        const supersededOptionId = lastStageC!.stageC.recommendation.optionId;
        if (supersededOptionId === optionId) {
          fail(`${id} is already auto-applied to ${optionId}; the override would be a no-op.`);
        }

        // Emit the overridden event on the decision log.
        const evt = makeOverriddenEvent({
          decisionId: id,
          chosenOptionId: optionId,
          supersededOptionId,
          ...(typeof argv.rationale === 'string' ? { rationale: String(argv.rationale) } : {}),
          ...(typeof argv.by === 'string' ? { by: String(argv.by) } : {}),
        });
        appendDecisionEvent(evt, { workDir });

        // Flip the substrate corpus polarity to negative (AC#6).
        const corpusEntryId = lastStageC!.stageC.corpusEntryId ?? null;
        const corpusFlip = recordOperatorOverride({
          repoRoot: workDir,
          taskType: 'decision-recommendation',
          corpusEntryId,
          newClassification: optionId,
          ...(typeof argv.rationale === 'string' ? { reason: String(argv.rationale) } : {}),
        });

        // Phase 9 mirror — when the substrate flip succeeded, also mirror the
        // corpus entry into pending-exemplars.yaml as a negative candidate
        // for operator review (AC#1). Skip when the substrate flip was a
        // no-op (no corpus entry, window expired) — there's nothing to
        // mirror in that case.
        let pendingMirror: { appended: boolean; entryId?: string } = { appended: false };
        if (corpusFlip.flipped && corpusFlip.entry) {
          const result = mirrorSubstrateEntry({
            repoRoot: workDir,
            entry: corpusFlip.entry,
            decisionId: id,
          });
          if (result) {
            pendingMirror = { appended: result.appended, entryId: result.entry.id };
          }
        }

        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            decisionId: id,
            chosenOptionId: optionId,
            supersededOptionId,
            corpusFlip,
            pendingMirror,
          });
        } else {
          emitText(`decision overridden: ${id} — ${supersededOptionId} → ${optionId}`);
          if (corpusFlip.flipped) {
            emitText(`  substrate corpus: negative exemplar recorded`);
          } else {
            emitText(`  substrate corpus: no flip (${corpusFlip.reason ?? 'unknown'})`);
          }
          if (pendingMirror.appended) {
            emitText(
              `  pending-exemplars: mirrored as negative candidate (id=${pendingMirror.entryId})`,
            );
          } else if (corpusFlip.flipped) {
            emitText(`  pending-exemplars: already mirrored (no-op)`);
          }
        }
      },
    )
    .command(
      'extend <id>',
      'AISDLC-447 — extend (or set) a decision timebox. Emits a `timebox-extended` event with the previous + new expiry timestamps for audit. Accepts ISO-8601 durations or categorical aliases (URGENT/24H/WEEK/BACKLOG).',
      (y) =>
        y
          .positional('id', {
            type: 'string',
            demandOption: true,
            describe: 'Decision id (DEC-NNNN).',
          })
          .option('timebox', {
            type: 'string',
            demandOption: true,
            describe: `New timebox. ISO-8601 duration (PT4H, P1D, ...) or alias (${Object.keys(TIMEBOX_CATEGORICAL_ALIASES).join('|')}). Expiry is computed as now+duration.`,
          })
          .option('rationale', {
            type: 'string',
            describe: 'Optional rationale for the extension.',
          })
          .option('by', { type: 'string', describe: 'Operator identifier (email / login).' })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
        if (!/^DEC-\d{4,}$/.test(id)) {
          fail(`invalid decision id: ${id} — expected DEC-NNNN`);
        }
        if (!isDecisionCatalogEnabled()) {
          fail(
            decisionCatalogDisabledMessage() +
              '\n[cli-decisions] extend: refusing to mutate the event log while the flag is off.',
          );
        }
        const decision = projectDecision(id, { workDir });
        if (decision === null) fail(`decision not found: ${id}`);

        let parsed: ReturnType<typeof parseTimebox>;
        try {
          parsed = parseTimebox(String(argv.timebox));
        } catch (err) {
          fail((err as Error).message);
        }

        const eventNow = new Date();
        const newExpiresAt = computeTimeboxExpiresAt(parsed.durationMs, eventNow);
        const previousExpiresAt = decision!.status.timeboxExpiresAt ?? null;

        const evt = makeTimeboxExtendedEvent({
          decisionId: id,
          newTimebox: parsed.duration,
          newTimeboxExpiresAt: newExpiresAt,
          previousTimeboxExpiresAt: previousExpiresAt,
          ...(typeof argv.rationale === 'string' ? { rationale: String(argv.rationale) } : {}),
          ...(typeof argv.by === 'string' ? { by: String(argv.by) } : {}),
          now: eventNow,
        });
        appendDecisionEvent(evt, { workDir });

        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            decisionId: id,
            newTimebox: parsed.duration,
            newTimeboxExpiresAt: newExpiresAt,
            previousTimeboxExpiresAt: previousExpiresAt,
          });
        } else {
          emitText(`decision timebox extended: ${id}`);
          emitText(`  previous expiry: ${previousExpiresAt ?? '(none)'}`);
          emitText(`  new timebox:     ${parsed.duration}`);
          emitText(`  new expiry:      ${newExpiresAt}`);
        }
      },
    )
    .command(
      'fatigue',
      'RFC-0035 §7.2 — operator fatigue signal: set, clear, status. Under fatigue, m/l/xl decisions defer to tomorrow; only small + reversible + LLM-eligible auto-decide.',
      (sub) =>
        sub
          .command(
            'set',
            'Declare explicit operator fatigue. Defers m/l/xl decisions; only small reversible decisions are surfaced.',
            (y) =>
              y
                .option('reason', {
                  type: 'string',
                  describe:
                    'Optional short note (e.g. "long walkthrough day"). Persisted to .ai-sdlc/operator-state.yaml for audit.',
                })
                .option('format', {
                  type: 'string',
                  choices: ['json', 'text'] as const,
                  default: 'text' as const,
                }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              // Phase 7 read-write: `fatigue` is a session-state command, NOT a
              // decision-mutating one. It works regardless of the catalog flag
              // because the orchestrator's tier-aware dispatch policy uses the
              // operator-state file independently of the catalog itself.
              const { path, state } = setFatigue(workDir, {
                ...(typeof argv.reason === 'string' && argv.reason
                  ? { reason: String(argv.reason) }
                  : {}),
              });
              if (String(argv.format) === 'json') {
                emit({ ok: true, path, state });
              } else {
                emitText(`fatigue set: active (declaredAt=${state.fatigueDeclaredAt})`);
                if (state.fatigueReason) emitText(`  reason: ${state.fatigueReason}`);
                emitText(`  state file: ${path}`);
                emitText(
                  '  policy: m/l/xl decisions deferred; only small + reversible + LLM-eligible auto-decide.',
                );
              }
            },
          )
          .command(
            'clear',
            'Clear explicit operator fatigue. Resumes normal dispatch policy. Audit fields (declaredAt, reason) are preserved.',
            (y) =>
              y.option('format', {
                type: 'string',
                choices: ['json', 'text'] as const,
                default: 'text' as const,
              }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const { path, state } = clearFatigue(workDir);
              if (String(argv.format) === 'json') {
                emit({ ok: true, path, state });
              } else {
                emitText('fatigue cleared.');
                emitText(`  state file: ${path}`);
              }
            },
          )
          .command(
            'status',
            'Show current fatigue status (explicit + inferred when opted-in).',
            (y) =>
              y.option('format', {
                type: 'string',
                choices: ['json', 'text'] as const,
                default: 'text' as const,
              }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              // Compose with the project's decisions-config.yaml so the
              // inferFromBehavior flag controls whether the status reflects
              // any inferred signal at all. We do NOT compute inferred signal
              // here — that requires hot-path analytics; `status` just reports
              // the explicit state + config gates.
              const cfg = resolveDecisionsConfig(loadDecisionsConfig({ workDir }));
              const status = getFatigueStatus(workDir, { config: cfg.fatigue });
              if (String(argv.format) === 'json') {
                emit({
                  ok: true,
                  active: status.active,
                  explicit: status.explicit,
                  inferred: status.inferred,
                  declaredAt: status.declaredAt,
                  reason: status.reason,
                  config: status.config,
                  statePath: resolveOperatorStatePath(workDir),
                });
              } else {
                emitText(`fatigue active:    ${status.active}`);
                emitText(`  explicit:        ${status.explicit}`);
                emitText(`  inferred:        ${status.inferred}`);
                emitText(
                  `  inferFromBehavior: ${status.config.inferFromBehavior} (opt-in; default off per OQ-8)`,
                );
                if (status.declaredAt) emitText(`  declaredAt:      ${status.declaredAt}`);
                if (status.reason) emitText(`  reason:          ${status.reason}`);
                emitText(`  state file:      ${resolveOperatorStatePath(workDir)}`);
              }
            },
          )
          .demandCommand(1, 'A fatigue subcommand is required (set | clear | status).')
          .strict(),
    )
    .command(
      'corpus',
      'Substrate calibration corpus commands (composes with RFC-0024 shared substrate).',
      (sub) =>
        sub
          .command(
            'aggregate',
            'Aggregate the substrate corpus across all 5 task types (per-task metrics + cross-task rollup + anchor candidates per OQ-11).',
            (y) =>
              y
                .option('format', {
                  type: 'string',
                  choices: ['json', 'text'] as const,
                  default: 'text' as const,
                })
                .option('anchor-threshold', {
                  type: 'number',
                  describe:
                    'Override the anchor-promotion threshold (default 3 per OQ-11). Negative-polarity clusters at or above this size surface as anchor candidates.',
                }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const opts: Parameters<typeof aggregateDecisionCorpus>[0] = { workDir };
              if (typeof argv['anchor-threshold'] === 'number') {
                opts.anchorPromotionThreshold = Number(argv['anchor-threshold']);
              }
              const result: AggregateCorpusResult = aggregateDecisionCorpus(opts);
              if (String(argv.format) === 'json') {
                emit({ ok: true, ...result });
              } else {
                emitText('Substrate calibration corpus aggregate');
                emitText('  per-task-type:');
                for (const m of result.perTaskType) {
                  emitText(
                    `    ${m.taskType.padEnd(28)} total=${m.total}  pos=${m.positive}  neg=${m.negative}  pending=${m.pending}` +
                      `  accuracy=${m.accuracy === null ? 'n/a' : m.accuracy.toFixed(3)}` +
                      `  coverage=${m.coverage === null ? 'n/a' : m.coverage.toFixed(3)}` +
                      `  avgConf=${m.avgConfidence === null ? 'n/a' : m.avgConfidence.toFixed(3)}`,
                  );
                }
                emitText('  aggregate:');
                const a = result.aggregate;
                emitText(
                  `    total=${a.total}  pos=${a.positive}  neg=${a.negative}  pending=${a.pending}` +
                    `  accuracy=${a.accuracy === null ? 'n/a' : a.accuracy.toFixed(3)}` +
                    `  coverage=${a.coverage === null ? 'n/a' : a.coverage.toFixed(3)}`,
                );
                emitText(
                  `  anchor candidates (≥${result.anchorPromotionThreshold} consistent overrides):`,
                );
                if (result.anchorCandidates.length === 0) {
                  emitText('    (none)');
                } else {
                  for (const ac of result.anchorCandidates) {
                    emitText(
                      `    ${ac.taskType.padEnd(28)} → ${ac.operatorOverrideClassification}` +
                        `  count=${ac.count}  avgConfWhenWrong=${ac.avgConfidenceWhenWrong.toFixed(3)}`,
                    );
                  }
                }
              }
            },
          )
          .demandCommand(1, 'A corpus subcommand is required (e.g. aggregate).')
          .strict(),
    )
    .command(
      'exemplars',
      'RFC-0035 Phase 9 — override-driven calibration loop (pending-exemplars.yaml).',
      (sub) =>
        sub
          .command(
            'list',
            'List pending exemplars from .ai-sdlc/pending-exemplars.yaml.',
            (y) =>
              y
                .option('format', {
                  type: 'string',
                  choices: ['json', 'table'] as const,
                  default: 'table' as const,
                })
                .option('disposition', {
                  type: 'string',
                  choices: ['pending', 'affirmed', 'reclassified', 'rejected', 'all'] as const,
                  default: 'pending' as const,
                  describe: 'Filter by disposition. Default: pending (review queue).',
                }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const all = readPendingExemplars(workDir);
              const filtered =
                argv.disposition === 'all'
                  ? all
                  : all.filter((e) => e.disposition === argv.disposition);
              if (String(argv.format) === 'json') {
                emit({ ok: true, exemplars: filtered });
              } else {
                if (filtered.length === 0) {
                  emitText(`(no exemplars with disposition=${argv.disposition})`);
                } else {
                  process.stdout.write(renderPendingExemplarsTable(filtered));
                }
              }
            },
          )
          .command(
            'affirm <exemplarId>',
            'Affirm a pending exemplar (LLM was right) — promotes to decision-exemplars.yaml.',
            (y) =>
              y
                .positional('exemplarId', { type: 'string', demandOption: true })
                .option('rationale', { type: 'string' })
                .option('by', { type: 'string' })
                .option('defer-promote', {
                  type: 'boolean',
                  default: false,
                  describe: 'Set disposition only; defer promotion to a later `promote-all` batch.',
                }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const result = disposeAndOptionallyPromote({
                repoRoot: workDir,
                exemplarId: String(argv.exemplarId),
                disposition: 'affirmed',
                ...(typeof argv.rationale === 'string'
                  ? { rationale: String(argv.rationale) }
                  : {}),
                ...(typeof argv.by === 'string' ? { by: String(argv.by) } : {}),
                autoPromote: !argv['defer-promote'],
              });
              if (!result.disposition.updated) {
                if (result.disposition.reason === 'not-found') {
                  fail(`pending exemplar not found: ${argv.exemplarId}`);
                }
                emitText(
                  `no-op: ${argv.exemplarId} (${result.disposition.reason ?? 'already-disposed'})`,
                );
                return;
              }
              const promoted = result.promotion?.promoted ?? false;
              emit({ ok: true, disposition: 'affirmed', promoted, exemplarId: argv.exemplarId });
            },
          )
          .command(
            'reclassify <exemplarId>',
            'Reclassify a pending exemplar (operator picks a different classification).',
            (y) =>
              y
                .positional('exemplarId', { type: 'string', demandOption: true })
                .option('classification', {
                  type: 'string',
                  demandOption: true,
                  describe: 'The classification the operator picks instead.',
                })
                .option('rationale', { type: 'string' })
                .option('by', { type: 'string' })
                .option('defer-promote', { type: 'boolean', default: false }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const result = disposeAndOptionallyPromote({
                repoRoot: workDir,
                exemplarId: String(argv.exemplarId),
                disposition: 'reclassified',
                classification: String(argv.classification),
                ...(typeof argv.rationale === 'string'
                  ? { rationale: String(argv.rationale) }
                  : {}),
                ...(typeof argv.by === 'string' ? { by: String(argv.by) } : {}),
                autoPromote: !argv['defer-promote'],
              });
              if (!result.disposition.updated) {
                if (result.disposition.reason === 'not-found') {
                  fail(`pending exemplar not found: ${argv.exemplarId}`);
                }
                emitText(
                  `no-op: ${argv.exemplarId} (${result.disposition.reason ?? 'already-disposed'})`,
                );
                return;
              }
              emit({
                ok: true,
                disposition: 'reclassified',
                promoted: result.promotion?.promoted ?? false,
                exemplarId: argv.exemplarId,
              });
            },
          )
          .command(
            'reject <exemplarId>',
            'Reject a pending exemplar (not a useful calibration signal).',
            (y) =>
              y
                .positional('exemplarId', { type: 'string', demandOption: true })
                .option('rationale', { type: 'string' })
                .option('by', { type: 'string' }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const result = rejectPendingExemplar({
                repoRoot: workDir,
                exemplarId: String(argv.exemplarId),
                ...(typeof argv.rationale === 'string'
                  ? { rationale: String(argv.rationale) }
                  : {}),
                ...(typeof argv.by === 'string' ? { by: String(argv.by) } : {}),
              });
              if (!result.updated) {
                if (result.reason === 'not-found') {
                  fail(`pending exemplar not found: ${argv.exemplarId}`);
                }
                emitText(`no-op: ${argv.exemplarId} (${result.reason ?? 'already-disposed'})`);
                return;
              }
              emit({ ok: true, disposition: 'rejected', exemplarId: argv.exemplarId });
            },
          )
          .command(
            'promote-all',
            'Promote every disposed (affirmed / reclassified) pending exemplar to decision-exemplars.yaml.',
            (y) =>
              y.option('by', { type: 'string' }).option('format', {
                type: 'string',
                choices: ['json', 'text'] as const,
                default: 'text' as const,
              }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const result = promoteAllDisposedPendingExemplars({
                repoRoot: workDir,
                ...(typeof argv.by === 'string' ? { promotedBy: String(argv.by) } : {}),
              });
              if (String(argv.format) === 'json') {
                emit({ ok: true, ...result });
              } else {
                emitText(
                  `promoted ${result.promotedCount} pending exemplars (${result.skippedCount} already promoted).`,
                );
                for (const [taskType, count] of Object.entries(result.perTaskType)) {
                  emitText(`  ${taskType}: ${count}`);
                }
              }
            },
          )
          .command(
            'sweep',
            'Mirror substrate corpus polarity-resolved entries into pending-exemplars.yaml.',
            (y) =>
              y
                .option('include-positives', {
                  type: 'boolean',
                  default: false,
                  describe:
                    'Also mirror positive (silence-promoted) entries. Default: negatives only.',
                })
                .option('format', {
                  type: 'string',
                  choices: ['json', 'text'] as const,
                  default: 'text' as const,
                }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const result = runCalibrationSweep({
                repoRoot: workDir,
                mode: argv['include-positives'] ? 'include-positives' : 'negatives-only',
              });
              if (String(argv.format) === 'json') {
                emit({ ok: true, ...result });
              } else {
                emitText(
                  `mirrored ${result.mirroredCount} substrate entries into pending-exemplars.yaml (mode=${result.mode}).`,
                );
                emitText(`  skipped existing: ${result.skippedExisting}`);
                for (const [taskType, count] of Object.entries(result.perTaskType)) {
                  emitText(`  ${taskType}: ${count}`);
                }
              }
            },
          )
          .command(
            'digest',
            'Render the weekly pending-exemplars digest (AC#3).',
            (y) =>
              y
                .option('window-days', { type: 'number', default: 7 })
                .option('format', {
                  type: 'string',
                  choices: ['markdown', 'json'] as const,
                  default: 'markdown' as const,
                })
                .option('oldest-limit', { type: 'number', default: 10 }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              const digest = buildPendingExemplarsDigest({
                repoRoot: workDir,
                windowDays: Number(argv['window-days']),
                oldestLimit: Number(argv['oldest-limit']),
              });
              if (String(argv.format) === 'json') {
                emit({ ok: true, digest });
              } else {
                process.stdout.write(renderPendingExemplarsDigestMarkdown(digest));
              }
            },
          )
          .command(
            'paths',
            'Print resolved pending-exemplars / decision-exemplars paths and substrate corpus dirs.',
            (y) =>
              y.option('format', {
                type: 'string',
                choices: ['json'] as const,
                default: 'json' as const,
              }),
            async (argv) => {
              const workDir = String(argv['work-dir']);
              emit({
                ok: true,
                pendingExemplarsPath: resolvePendingExemplarsPath(workDir),
                decisionExemplarsPath: resolveDecisionExemplarsPath(workDir),
                pendingCount: readPendingExemplars(workDir).length,
                decisionExemplarsCount: readDecisionExemplars(workDir).length,
                // Touch readCorpus and promotePendingExemplar to keep tree-shake-safe
                // re-exports stable (callers may inspect substrate corpus sizes separately).
                substrateNegativeCount: ((): number => {
                  let n = 0;
                  for (const tt of [
                    'capture-triage',
                    'capture-severity',
                    'pr-comment-is-capture',
                    'dor-answer-is-new-concern',
                    'decision-recommendation',
                  ] as const) {
                    for (const e of readCorpus(workDir, tt)) {
                      if (e.polarity === 'negative') n++;
                    }
                  }
                  return n;
                })(),
              });
            },
          )
          .demandCommand(1, 'An exemplars subcommand is required.')
          .strict(),
    )
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runDecisionsCli(): Promise<void> {
  await buildDecisionsCli().parseAsync();
}
