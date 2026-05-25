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
  computeStageACoverage,
  DECISION_SOURCES,
  decisionCatalogDisabledMessage,
  disposeAndOptionallyPromote,
  isDecisionCatalogEnabled,
  isStageCAutoApplyEligible,
  listDecisions,
  loadDecisionsConfig,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  makeOverriddenEvent,
  makeRecommendationIssuedEvent,
  makeStageCAutoApplyAnsweredEvent,
  makeStageCCompletedEvent,
  mirrorSubstrateEntry,
  nextDecisionId,
  projectDecision,
  promoteAllDisposedPendingExemplars,
  readDecisionExemplars,
  readPendingExemplars,
  rejectPendingExemplar,
  renderDecisionSupportSurface,
  renderPendingExemplarsDigestMarkdown,
  resolveDecisionExemplarsPath,
  resolveEventLogPath,
  resolvePendingExemplarsPath,
  resolveStageCRuntimeConfig,
  runCalibrationSweep,
  runStageA,
  runStageB,
  runStageC,
  STAGE_A_COVERAGE_TARGET,
  type AggregateCorpusResult,
  type Decision,
  type DecisionOption,
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

function renderListTable(decisions: Decision[]): string {
  if (decisions.length === 0) return '(no decisions in the catalog)\n';
  const headers = ['id', 'lifecycle', 'source', 'created', 'summary'] as const;
  const rows = decisions.map((d) => [
    d.metadata.id,
    d.status.lifecycle,
    d.metadata.source,
    d.metadata.created.slice(0, 10),
    d.spec.summary.length > 60 ? d.spec.summary.slice(0, 57) + '...' : d.spec.summary,
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
      'List decisions projected from the event log.',
      (y) =>
        y.option('format', {
          type: 'string',
          choices: ['json', 'table'] as const,
          default: 'table' as const,
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
        const { decisions, skipped } = listDecisions({ workDir });
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
