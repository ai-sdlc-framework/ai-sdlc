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
  appendDecisionEvent,
  computeStageACoverage,
  DECISION_SOURCES,
  decisionCatalogDisabledMessage,
  isDecisionCatalogEnabled,
  listDecisions,
  makeDecisionOpenedEvent,
  makeRecommendationIssuedEvent,
  nextDecisionId,
  projectDecision,
  resolveEventLogPath,
  runStageA,
  STAGE_A_COVERAGE_TARGET,
  type Decision,
  type DecisionOption,
  type DecisionSource,
} from '../decisions/index.js';
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
      'Render one decision with its full event history.',
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
          }),
      // NB: yargs only propagates handler errors via parseAsync rejection
      // when the handler is async — sync throws get swallowed. Keep this
      // (and every handler that calls fail() / process.exit) `async` so
      // tests can assert exits via `.rejects.toThrow`.
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const id = String(argv.id);
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
          emit({ ok: true, enabled: true, decision });
        } else {
          process.stdout.write(renderShow(decision));
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
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runDecisionsCli(): Promise<void> {
  await buildDecisionsCli().parseAsync();
}
