/**
 * `cli-judgment`: operator tooling for the judgment layer. Measure a judgment
 * before promoting it (`eval`), replay logged answers under other thresholds
 * (`replay`), inspect the setup (`doctor`, `list`) and run one forced evaluation
 * (`ask`).
 *
 * Usage:
 *   cli-judgment doctor [--live]
 *   cli-judgment list
 *   cli-judgment ask <judgment-id> --input <json-file>
 *   cli-judgment eval <judgment-id> --corpus <jsonl> [--sweep <name>=<from>:<to>:<step>]
 *   cli-judgment replay --since <date> [--judgment <id>]
 */

import { lstatSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  createBuiltInJudgmentProvider,
  createJudgmentCache,
  getJudgmentDefinition,
  isLoopbackUrl,
  isModelAlias,
  judgmentEnforceDowngradeReason,
  listJudgmentDefinitions,
  loadJudgmentConfig,
  providerModelKey,
  readJudgmentLog,
  resolveJudgmentProvider,
  type JudgmentProvider,
  type ResolvedJudgmentConfig,
  type Thresholds,
} from '@ai-sdlc/reference';
import {
  JudgmentCliError,
  buildPromotion,
  collectAnswers,
  composeOutcome,
  computeStats,
  evaluateOnce,
  parseSweep,
  parseThresholdOverrides,
  readCorpusFile,
  reportFileName,
  runSweep,
  summarizeCost,
  writeReportFile,
  type AnyDefinition,
  type Band,
} from '../judgment/eval.js';

class UsageError extends Error {}

const MAX_INPUT_BYTES = 5 * 1024 * 1024;

type Env = Record<string, string | undefined>;

export interface JudgmentCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  cwd?: string;
  env?: Env;
  loadConfig?: (opts: { workDir: string; env: Env }) => ResolvedJudgmentConfig;
  getProvider?: (name: string, config: ResolvedJudgmentConfig) => JudgmentProvider | undefined;
  getDefinition?: (id: string) => AnyDefinition | undefined;
  listDefinitions?: () => AnyDefinition[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface Session {
  workDir: string;
  env: Env;
  config: ResolvedJudgmentConfig;
  artifactsDir: string;
  provider: JudgmentProvider | undefined;
}

interface CommonArgs {
  cwd?: string;
  config?: string;
  'artifacts-dir'?: string;
  threshold?: string[];
  'source-kind'?: string;
}

function resolveProvider(
  config: ResolvedJudgmentConfig,
  deps: JudgmentCliDeps,
): JudgmentProvider | undefined {
  if (!config.provider) return undefined;
  try {
    if (deps.getProvider) return deps.getProvider(config.provider, config);
    return (
      resolveJudgmentProvider(config.provider, config.providerOptions, config.model) ??
      createBuiltInJudgmentProvider(config.provider, {
        ...(config.model ? { model: config.model } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: config.defaults.timeoutMs,
      })
    );
  } catch {
    return undefined;
  }
}

function openSession(args: CommonArgs, deps: JudgmentCliDeps): Session {
  const workDir = resolve(args.cwd ?? deps.cwd ?? process.cwd());
  const env: Env = { ...(deps.env ?? process.env) };
  if (args.config) env.AI_SDLC_JUDGMENT_CONFIG_PATH = resolve(workDir, args.config);
  const config = (deps.loadConfig ?? loadJudgmentConfig)({ workDir, env });
  const artifactsDir = resolve(
    workDir,
    args['artifacts-dir'] ?? env.ARTIFACTS_DIR ?? join('.ai-sdlc', 'artifacts'),
  );
  return { workDir, env, config, artifactsDir, provider: resolveProvider(config, deps) };
}

/** Remove any credential value from text before it reaches the output. */
function scrub(text: string, env: Env, provider: JudgmentProvider | undefined): string {
  const secret = provider ? env[provider.requires.envVar] : undefined;
  return secret && secret.length >= 4 ? text.split(secret).join('[redacted]') : text;
}

const modelOf = (config: ResolvedJudgmentConfig, provider: JudgmentProvider): string =>
  config.model ?? provider.modelId;

function requireDefinition(id: string, deps: JudgmentCliDeps): AnyDefinition {
  const def = (deps.getDefinition ?? getJudgmentDefinition)(id);
  if (!def) {
    const known = (deps.listDefinitions ?? listJudgmentDefinitions)().map((d) => d.id);
    throw new JudgmentCliError(
      `unknown judgment '${id}' (registered: ${known.length ? known.join(', ') : 'none'})`,
    );
  }
  return def;
}

function egressRefusal(def: AnyDefinition): string {
  return (
    `refused: judgment '${def.id}' sends '${def.egressClass}' data and this class is not allowed. ` +
    `Add '${def.egressClass}' to spec.egress.allow in the judgment config to allow it.`
  );
}

function effectiveMode(
  def: AnyDefinition,
  config: ResolvedJudgmentConfig,
  provider: JudgmentProvider | undefined,
): { configured: string; effective: string; reason?: string } {
  const configured = config.provider
    ? (config.judgments[def.id]?.mode ?? config.defaults.mode)
    : 'off';
  if (!config.provider || configured === 'off') return { configured, effective: 'off' };
  if (!provider) return { configured, effective: 'off', reason: 'provider-unavailable' };
  if (!config.egressAllow.includes(def.egressClass) && !isLoopbackUrl(provider.baseUrl)) {
    return { configured, effective: 'off', reason: 'egress-not-permitted' };
  }
  if (configured === 'enforce') {
    const reason = judgmentEnforceDowngradeReason(def, config, provider);
    if (reason) return { configured, effective: 'shadow', reason };
  }
  return { configured, effective: configured };
}

function thresholdsFor(
  def: AnyDefinition,
  config: ResolvedJudgmentConfig,
  key: string,
  overrides: Thresholds,
): Thresholds {
  return { ...(config.judgments[def.id]?.thresholds[key] ?? {}), ...overrides };
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

// --- commands -----------------------------------------------------------

async function runDoctor(args: CommonArgs & { live?: boolean }, deps: JudgmentCliDeps) {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const s = openSession(args, deps);
  const enabled = !!s.config.provider;
  const provider = s.provider;
  const secret = provider ? s.env[provider.requires.envVar] : undefined;
  const keyPresent = !!secret && secret.trim() !== '';
  const model = s.config.model;
  const pinned = !!model && !isModelAlias(model);
  out(`judgment layer: ${enabled ? 'enabled' : 'disabled'}\n`);
  out(
    `provider: ${s.config.provider ?? '(none)'}${enabled && !provider ? ' (not registered)' : ''}\n`,
  );
  out(
    `credential${provider ? ` (${provider.requires.envVar})` : ''}: ${keyPresent ? 'present' : 'missing'}\n`,
  );
  out(`model: ${model ?? '(not set)'} (${pinned ? 'pinned' : 'not pinned to an exact version'})\n`);
  if (!args.live) return 0;
  if (!provider || !keyPresent) {
    (deps.err ?? ((t) => process.stderr.write(t)))(
      'live check skipped: needs a registered provider and its credential\n',
    );
    return 1;
  }
  try {
    const res = await provider.evaluate({
      state: 'ping',
      consumerLabel: 'cli-judgment-doctor',
      questions: { ok: { type: 'noul', instructions: 'Is the text non-empty?' } },
    });
    out(`live: ok, modelVersion ${res.modelVersion}, latency ${res.latencyMs}ms\n`);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    (deps.err ?? ((t) => process.stderr.write(t)))(
      `live: failed: ${scrub(msg, s.env, provider)}\n`,
    );
    return 1;
  }
}

function runList(args: CommonArgs, deps: JudgmentCliDeps) {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const s = openSession(args, deps);
  const defs = (deps.listDefinitions ?? listJudgmentDefinitions)();
  if (defs.length === 0) {
    out('no judgments registered\n');
    return 0;
  }
  const rows = defs.map((d) => {
    const m = effectiveMode(d, s.config, s.provider);
    return [
      d.id,
      String(d.version),
      d.riskClass,
      d.direction,
      d.egressClass,
      m.configured,
      m.reason ? `${m.effective} (${m.reason})` : m.effective,
    ];
  });
  out(
    `${table(['id', 'version', 'riskClass', 'direction', 'egressClass', 'configured', 'effective'], rows)}\n`,
  );
  return 0;
}

function readJsonFile(path: string): unknown {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_INPUT_BYTES) {
      throw new JudgmentCliError(
        `input '${path}' must be a regular file under ${MAX_INPUT_BYTES} bytes`,
      );
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e instanceof JudgmentCliError) throw e;
    throw new JudgmentCliError(`cannot read '${path}' as JSON`);
  }
}

async function runAsk(args: CommonArgs & { id: string; input: string }, deps: JudgmentCliDeps) {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const err = deps.err ?? ((t) => process.stderr.write(t));
  const def = requireDefinition(args.id, deps);
  const s = openSession(args, deps);
  const input = readJsonFile(resolve(s.workDir, args.input));
  const overrides = parseThresholdOverrides(args.threshold ?? []);
  const sourceKind = args['source-kind'] ?? 'backlog';
  if (!s.config.provider || !s.provider) {
    err('refused: no judgment provider is configured (set spec.provider in the judgment config)\n');
    return 1;
  }
  const rec = await evaluateOnce(def, input, {
    config: s.config,
    getProvider: () => s.provider,
    sourceKind,
  });
  if (rec.answers === null) {
    const reason = rec.outcome.kind === 'abstain' ? rec.outcome.reason : 'unknown';
    err(`${reason === 'egress-not-permitted' ? egressRefusal(def) : `no answers: ${reason}`}\n`);
    return 1;
  }
  const key = providerModelKey(s.provider.name, modelOf(s.config, s.provider));
  const thresholds = thresholdsFor(def, s.config, key, overrides);
  const outcome = composeOutcome(def, rec.answers, input, thresholds, sourceKind);
  out(
    `${JSON.stringify(
      {
        judgment: def.id,
        provider: key,
        modelVersion: rec.modelVersion,
        latencyMs: rec.latencyMs,
        answers: rec.answers,
        thresholds,
        outcome,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

async function runEval(
  args: CommonArgs & { id: string; corpus: string; sweep?: string },
  deps: JudgmentCliDeps,
) {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const def = requireDefinition(args.id, deps);
  if (typeof def.agrees !== 'function') {
    throw new JudgmentCliError(
      `judgment '${def.id}' has no agrees(); eval cannot compare with labels`,
    );
  }
  const s = openSession(args, deps);
  const overrides = parseThresholdOverrides(args.threshold ?? []);
  const sweepSpec = args.sweep ? parseSweep(args.sweep) : undefined;
  const sourceKind = args['source-kind'] ?? 'backlog';
  const corpus = readCorpusFile(resolve(s.workDir, args.corpus));
  const provider = s.provider;
  const model = provider ? modelOf(s.config, provider) : (s.config.model ?? 'none');
  const providerName = provider?.name ?? s.config.provider ?? 'none';
  const key = providerModelKey(providerName, model);

  const items = await collectAnswers(def, corpus, {
    config: s.config,
    getProvider: () => provider,
    cache: createJudgmentCache(s.artifactsDir),
    sourceKind,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const thresholds = thresholdsFor(def, s.config, key, overrides);
  const stats = computeStats(def, items, thresholds, sourceKind);
  const cost = summarizeCost(items);
  const sweep = sweepSpec ? runSweep(def, items, thresholds, sweepSpec, sourceKind) : undefined;

  const reasons = new Map<string, number>();
  for (const i of items) {
    if (i.abstainReason) reasons.set(i.abstainReason, (reasons.get(i.abstainReason) ?? 0) + 1);
  }
  const notes: string[] = [];
  if (reasons.has('egress-not-permitted')) notes.push(egressRefusal(def));
  if (reasons.has('disabled')) {
    notes.push('the judgment layer is disabled or the provider is unavailable; items abstained');
  }

  const date = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const fileName = reportFileName({ id: def.id, provider: providerName, model, date });
  const relPath = join('.ai-sdlc', 'judgment-evals', fileName);
  const promotion = buildPromotion(def, key, stats, relPath);
  const report = {
    judgmentId: def.id,
    version: def.version,
    riskClass: def.riskClass,
    provider: providerName,
    model,
    date,
    corpus: basename(args.corpus),
    thresholds,
    ...stats,
    latencyMs: cost.latencyMs,
    calls: cost.calls,
    cacheHits: cost.cacheHits,
    totalInputTokens: cost.totalInputTokens,
    totalCostUsd: cost.totalCostUsd,
    abstainReasons: Object.fromEntries(reasons),
    ...(sweepSpec ? { sweep: { spec: sweepSpec, rows: sweep } } : {}),
    promotion: { key, met: promotion.met, statement: promotion.statement },
    notes,
  };
  writeReportFile(s.workDir, fileName, report);

  const bands = (['act', 'escalate', 'abstain'] as Band[])
    .map((b) => `${b} ${stats.counts[b]} (${pct(stats.shares[b])})`)
    .join(', ');
  out(`judgment ${def.id} v${def.version} on ${key}: n=${stats.n}\n`);
  out(`bands: ${bands}\n`);
  out(
    `act-band precision: ${pct(stats.actBandPrecision)} (${stats.actAgreeing}/${stats.counts.act})\n`,
  );
  out(
    `latency p50 ${cost.latencyMs.p50 ?? 'n/a'}ms p95 ${cost.latencyMs.p95 ?? 'n/a'}ms; ` +
      `${cost.calls} calls, ${cost.cacheHits} cache hits; input tokens ${cost.totalInputTokens}; cost $${cost.totalCostUsd.toFixed(6)}\n`,
  );
  if (stats.confusion) {
    out('confusion (decision rows, label columns):\n');
    out(`${JSON.stringify(stats.confusion.rows)}\n`);
  } else {
    out('confusion: not shown (too many distinct decisions or labels)\n');
  }
  if (sweep && sweepSpec) {
    out(`sweep ${sweepSpec.name}:\n`);
    out(
      `${table(
        [sweepSpec.name, 'act', 'escalate', 'abstain', 'actBandPrecision'],
        sweep.map((r) => [
          String(r.value),
          String(r.counts.act),
          String(r.counts.escalate),
          String(r.counts.abstain),
          pct(r.actBandPrecision),
        ]),
      )}\n`,
    );
  }
  for (const n of notes) out(`note: ${n}\n`);
  out(`report written to ${relPath}\n`);
  out(`${promotion.statement}\n`);
  out(`promotion snippet:\n${promotion.snippet}\n`);
  return 0;
}

function parseSince(text: string): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : new Date(text);
  if (Number.isNaN(d.getTime()))
    throw new JudgmentCliError(`--since '${text}' is not a valid date`);
  return d;
}

async function runReplay(
  args: CommonArgs & { since: string; judgment?: string },
  deps: JudgmentCliDeps,
) {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const s = openSession(args, deps);
  const since = parseSince(args.since);
  const overrides = parseThresholdOverrides(args.threshold ?? []);
  const hasOverrides = Object.keys(overrides).length > 0;
  const sourceKind = args['source-kind'] ?? 'backlog';
  const log = readJudgmentLog(s.artifactsDir, {
    since,
    ...(args.judgment ? { judgmentId: args.judgment } : {}),
  });
  const ids = [...new Set(log.entries.map((e) => e.judgmentId))].sort();
  out(
    `replay since ${since.toISOString()}: ${log.entries.length} records, ${ids.length} judgments` +
      `${log.malformedLines ? `, ${log.malformedLines} malformed lines skipped` : ''}\n`,
  );
  for (const id of ids) {
    const def = (deps.getDefinition ?? getJudgmentDefinition)(id);
    const entries = log.entries.filter((e) => e.judgmentId === id);
    if (!def) {
      out(`${id}: ${entries.length} records, definition not registered, skipped\n`);
      continue;
    }
    const counts: Record<Band, number> = { act: 0, escalate: 0, abstain: 0 };
    let withAnswers = 0;
    let errors = 0;
    let comparable = 0;
    let reproduced = 0;
    let incumbents = 0;
    let incumbentAgree = 0;
    for (const e of entries) {
      if (!e.answers) {
        counts.abstain += 1;
        continue;
      }
      withAnswers += 1;
      const key = e.provider && e.modelVersion ? providerModelKey(e.provider, e.modelVersion) : '';
      const thresholds = {
        ...(e.thresholds ?? s.config.judgments[id]?.thresholds[key] ?? {}),
        ...overrides,
      };
      // The log keeps the state hash, not the input, so compose runs without it.
      let outcome;
      try {
        outcome = def.compose(e.answers, undefined, thresholds, {
          permissiveAllowed: def.direction === 'bidirectional' && sourceKind === 'backlog',
          ...(def.agrees ? { agrees: def.agrees.bind(def) } : {}),
          ...(def.capabilityId ? { capabilityId: def.capabilityId } : {}),
        });
      } catch {
        errors += 1;
        continue;
      }
      counts[outcome.kind] += 1;
      if (!hasOverrides && e.thresholds && e.outcome) {
        comparable += 1;
        if (JSON.stringify(outcome) === JSON.stringify(e.outcome)) reproduced += 1;
      }
      if (e.incumbent !== null && outcome.kind === 'act' && typeof def.agrees === 'function') {
        incumbents += 1;
        try {
          if (def.agrees(outcome.decision, e.incumbent) === true) incumbentAgree += 1;
        } catch {
          // a throwing comparison counts as disagreement
        }
      }
    }
    out(
      `${id}: ${entries.length} records, ${withAnswers} with answers; ` +
        `act ${counts.act}, escalate ${counts.escalate}, abstain ${counts.abstain}` +
        `${errors ? `; ${errors} could not be recomputed` : ''}\n`,
    );
    if (!hasOverrides) {
      out(`  logged outcomes reproduced: ${reproduced}/${comparable}\n`);
    }
    out(
      `  incumbent agreement: ${incumbents === 0 ? 'n/a' : `${incumbentAgree}/${incumbents} (${pct(incumbentAgree / incumbents)})`}\n`,
    );
  }
  return 0;
}

// --- yargs wiring -------------------------------------------------------

function commonOptions<T>(y: Argv<T>) {
  return y
    .option('cwd', { type: 'string', describe: 'Working directory (default: current directory).' })
    .option('config', {
      type: 'string',
      describe: 'Judgment config file to use instead of the one on the trusted base branch.',
    })
    .option('artifacts-dir', {
      type: 'string',
      describe: 'Artifacts directory (default: $ARTIFACTS_DIR or .ai-sdlc/artifacts).',
    });
}

function thresholdOptions<T>(y: Argv<T>) {
  return y
    .option('threshold', {
      type: 'string',
      array: true,
      describe: 'Threshold override <name>=<number>; repeatable.',
    })
    .option('source-kind', {
      type: 'string',
      describe: 'Kind of the work items (default: backlog); only backlog may decide permissively.',
    });
}

/** Build the yargs router. `exitCode` receives the handler's result. */
export function buildJudgmentCli(
  argv: string[],
  deps: JudgmentCliDeps,
  setResult: (p: Promise<number>) => void,
): Argv {
  const run = (fn: () => number | Promise<number>) => setResult(Promise.resolve().then(fn));
  return commonOptions(yargs(argv))
    .scriptName('cli-judgment')
    .command(
      'doctor',
      'Report whether the layer is enabled, the provider, key presence and model pinning.',
      (y) => y.option('live', { type: 'boolean', describe: 'Send one minimal request.' }),
      (a) => run(() => runDoctor(a as never, deps)),
    )
    .command(
      'list',
      'List registered judgments with their configured and effective modes.',
      (y) => y,
      (a) => run(() => runList(a as never, deps)),
    )
    .command(
      'ask <id>',
      'Run one forced evaluation and print answers, outcome and thresholds.',
      (y) =>
        thresholdOptions(y)
          .positional('id', { type: 'string', demandOption: true })
          .option('input', { type: 'string', demandOption: true, describe: 'JSON input file.' }),
      (a) => run(() => runAsk(a as never, deps)),
    )
    .command(
      'eval <id>',
      'Measure a judgment over a labelled JSONL corpus and print the promotion snippet.',
      (y) =>
        thresholdOptions(y)
          .positional('id', { type: 'string', demandOption: true })
          .option('corpus', { type: 'string', demandOption: true, describe: 'JSONL corpus.' })
          .option('sweep', {
            type: 'string',
            describe: 'Recompute across a threshold range: <name>=<from>:<to>:<step>.',
          }),
      (a) => run(() => runEval(a as never, deps)),
    )
    .command(
      'replay',
      'Recompute logged outcomes under other thresholds; no provider calls.',
      (y) =>
        thresholdOptions(y)
          .option('since', { type: 'string', demandOption: true, describe: 'Start date.' })
          .option('judgment', { type: 'string', describe: 'Only this judgment id.' }),
      (a) => run(() => runReplay(a as never, deps)),
    )
    .demandCommand(1, 'Choose a command: doctor, list, ask, eval or replay.')
    .strict()
    .exitProcess(false)
    .help();
}

/** Run the CLI and resolve to a process exit code. */
export async function runJudgmentCli(
  argv: string[] = hideBin(process.argv),
  deps: JudgmentCliDeps = {},
): Promise<number> {
  const err = deps.err ?? ((t: string) => process.stderr.write(t));
  let result: Promise<number> | undefined;
  try {
    await buildJudgmentCli(argv, deps, (p) => {
      result = p;
    })
      .fail((msg, e) => {
        throw e ?? new UsageError(msg);
      })
      .parseAsync();
    return result ? await result : 0;
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof JudgmentCliError ? 1 : 2;
  }
}
