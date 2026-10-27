/**
 * `cli-hierarchy demo` (AISDLC-1079): regenerate the terminal demo clip from a scenario file.
 *
 * Stage 1 (`run`) records one real hierarchy run under asciinema and writes the beat timestamps;
 * stage 2 (`cut`) and stage 3 (`render`) live in `demo-media.ts`. Nothing on screen is canned:
 * the only text this module writes itself is the operator's request and the scenario's answers;
 * every other line is the real output of the commands it runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  BEAT_NAMES,
  parseBeatsFile,
  runCut,
  runRender,
  type BeatName,
  type MediaDeps,
} from './demo-media.js';
import type { CommandResult, CommandRunner } from './types.js';

export interface ScenarioDecision {
  summary: string;
  options: { id: string; description: string }[];
  answer: string;
  rationale: string;
}

export interface Scenario {
  request: string;
  task: string;
  author: string;
  decisions: ScenarioDecision[];
  brief: { tasks: string[] };
  timeoutMinutes: number;
  pollSeconds: number;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Parse and validate a scenario file; the error names the first bad field. */
export function parseScenario(text: string): Scenario {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('scenario is not valid JSON');
  }
  const bad = (field: string, why = 'is required'): never => {
    throw new Error(`scenario field '${field}' ${why}`);
  };
  if (!nonEmpty(raw['request'])) bad('request');
  if (!nonEmpty(raw['task'])) bad('task');
  const decisions = raw['decisions'];
  if (!Array.isArray(decisions) || decisions.length < 2) {
    bad('decisions', 'needs at least two decisions');
  }
  (decisions as Record<string, unknown>[]).forEach((d, i) => {
    const at = `decisions[${i}]`;
    if (!nonEmpty(d['summary'])) bad(`${at}.summary`);
    const options = d['options'];
    if (!Array.isArray(options) || options.length < 2) {
      bad(`${at}.options`, 'needs at least two options');
    }
    for (const o of options as Record<string, unknown>[]) {
      if (!nonEmpty(o['id']) || !nonEmpty(o['description'])) {
        bad(`${at}.options`, 'entries need an id and a description');
      }
    }
    if (!nonEmpty(d['answer'])) bad(`${at}.answer`);
    if (!(options as { id: string }[]).some((o) => o.id === d['answer'])) {
      bad(`${at}.answer`, 'must be one of the option ids');
    }
    if (!nonEmpty(d['rationale'])) bad(`${at}.rationale`);
  });
  const brief = raw['brief'] as { tasks?: unknown } | undefined;
  if (
    !brief ||
    !Array.isArray(brief.tasks) ||
    brief.tasks.length === 0 ||
    !brief.tasks.every(nonEmpty)
  ) {
    bad('brief.tasks', 'needs a non-empty list of task ids');
  }
  for (const f of ['timeoutMinutes', 'pollSeconds'] as const) {
    if (typeof raw[f] !== 'number' || !((raw[f] as number) > 0))
      bad(f, 'must be a positive number');
  }
  return {
    request: raw['request'] as string,
    task: raw['task'] as string,
    author: nonEmpty(raw['author']) ? raw['author'] : 'operator',
    decisions: decisions as ScenarioDecision[],
    brief: { tasks: (brief as { tasks: string[] }).tasks },
    timeoutMinutes: raw['timeoutMinutes'] as number,
    pollSeconds: raw['pollSeconds'] as number,
  };
}

export function loadScenario(file: string): Scenario {
  if (!existsSync(file)) throw new Error(`scenario file not found: ${file}`);
  return parseScenario(readFileSync(file, 'utf-8'));
}

export interface DemoDeps {
  run: CommandRunner;
  out(line: string): void;
  err(line: string): void;
  /** Wall clock in milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** True when the tool is on PATH. */
  which(tool: string): boolean;
  idleExecutors(): number;
  /** The task's backlog status and whether it is dispatchable; null when there is no task file. */
  taskState(taskId: string): { status: string; dispatchable: boolean } | null;
  cleanCheckout(): boolean;
  /** Run the recorder (asciinema) in the foreground and return its exit status. */
  record(args: string[]): number;
  /** Absolute directory holding the `cli-*.mjs` bin shims. */
  binDir: string;
  /** Absolute path to the repository's checkout (the working directory of every command). */
  cwd: string;
  /** Runs stage 3's tools. */
  media: MediaDeps;
}

/** Longest silence asciinema keeps (`--idle-time-limit`), mirrored when stamping beats. */
const IDLE_LIMIT_SECONDS = 2;

export interface BeatsDoc {
  task: string;
  prNumber: number | null;
  mergeSha: string | null;
  beats: { name: BeatName; elapsedSeconds: number }[];
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** One line per missing tool; returns whether preflight passed. */
export function preflight(scenario: Scenario, deps: DemoDeps): boolean {
  let ok = true;
  const fail = (line: string): void => {
    deps.err(line);
    ok = false;
  };
  for (const tool of ['asciinema', 'agg', 'ffmpeg']) {
    if (!deps.which(tool)) fail(`cli-hierarchy demo: ${tool} is not on PATH`);
  }
  if (!ok) return false;
  if (deps.idleExecutors() < 1) fail('cli-hierarchy demo: the roster has no idle executor');
  const state = deps.taskState(scenario.task);
  if (!state || state.status !== 'To Do' || !state.dispatchable) {
    fail(`cli-hierarchy demo: ${scenario.task} is not a dispatchable To Do task`);
  }
  if (!deps.cleanCheckout()) fail('cli-hierarchy demo: the checkout is not clean');
  return ok;
}

function tryJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The inner run: executes the real commands in order, stamping each beat. */
export async function runInner(
  scenario: Scenario,
  outDir: string,
  deps: DemoDeps,
): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  const startMs = deps.now();
  let lastMs = startMs;
  let recorded = 0;
  /** Seconds on the cast clock: wall gaps are capped like asciinema's idle limit. */
  const advance = (): number => {
    const t = deps.now();
    recorded += Math.min((t - lastMs) / 1000, IDLE_LIMIT_SECONDS);
    lastMs = t;
    return recorded;
  };
  const doc: BeatsDoc = { task: scenario.task, prNumber: null, mergeSha: null, beats: [] };
  const flush = (): void =>
    writeFileSync(path.join(outDir, 'beats.json'), `${JSON.stringify(doc, null, 2)}\n`);
  const say = (line: string): void => {
    advance();
    deps.out(line);
  };
  const beat = (name: BeatName): void => {
    doc.beats.push({ name, elapsedSeconds: Math.round(advance() * 1000) / 1000 });
    flush();
  };
  const exec = (label: string, file: string, args: string[]): CommandResult | null => {
    say(`$ ${label}`);
    const r = deps.run(file, args, { cwd: deps.cwd });
    if (r.stdout.trim()) say(r.stdout.replace(/\n$/, ''));
    if (r.status !== 0) {
      if (r.stderr.trim()) say(r.stderr.replace(/\n$/, ''));
      deps.err(`cli-hierarchy demo: '${label}' exited ${r.status}`);
      return null;
    }
    return r;
  };
  const cli = (name: string, args: string[]): CommandResult | null =>
    exec(`${name} ${args.map((a) => (/^[\w./:=,-]+$/.test(a) ? a : quote(a))).join(' ')}`, 'node', [
      path.join(deps.binDir, `${name}.mjs`),
      ...args,
    ]);

  say(`> ${scenario.request}`);
  beat('request');

  const ids: string[] = [];
  for (const d of scenario.decisions) {
    const r = cli('cli-decisions', [
      'add',
      '--summary',
      d.summary,
      '--scope',
      `issue:${scenario.task}`,
      '--source',
      'ad-hoc',
      '--by',
      scenario.author,
      ...d.options.flatMap((o) => ['--option', `${o.id}:${o.description}`]),
    ]);
    const id = r && /DEC-\d{4,}/.exec(r.stdout)?.[0];
    if (!id) {
      if (r) deps.err('cli-hierarchy demo: cli-decisions add printed no decision id');
      flush();
      return 1;
    }
    ids.push(id);
  }
  if (!cli('cli-decisions', ['list'])) return (flush(), 1);
  beat('questions');

  for (const [i, d] of scenario.decisions.entries()) {
    say(`> ${d.answer}`);
    if (
      !cli('cli-decisions', [
        'answer',
        ids[i] as string,
        d.answer,
        '--rationale',
        d.rationale,
        '--by',
        scenario.author,
      ])
    ) {
      return (flush(), 1);
    }
  }
  beat('answers');

  if (!cli('cli-hierarchy', ['brief', '--tasks', scenario.brief.tasks.join(','), '--notify'])) {
    return (flush(), 1);
  }
  beat('brief');

  const deadline = deps.now() + scenario.timeoutMinutes * 60_000;
  let lastBoard = '';
  let lastChecks = '';
  while (deps.now() < deadline) {
    const board = deps.run(
      'node',
      [path.join(deps.binDir, 'cli-dispatch.mjs'), 'board', '--json'],
      {
        cwd: deps.cwd,
      },
    );
    const entry = tryJson<{ taskId: string; state: string }[]>(board.stdout)?.find(
      (e) => e.taskId === scenario.task,
    );
    const label = entry ? (entry.state === 'queue' ? 'queued' : entry.state) : '';
    if (label && label !== lastBoard) {
      say(`board: ${scenario.task} ${label}`);
      if (label === 'inflight') say(`board: ${scenario.task} claimed by an executor`);
      lastBoard = label;
    }
    if (doc.prNumber === null) {
      const list = deps.run(
        'gh',
        [
          'pr',
          'list',
          '--search',
          scenario.task,
          '--state',
          'all',
          '--json',
          'number',
          '--limit',
          '1',
        ],
        { cwd: deps.cwd },
      );
      const n = tryJson<{ number: number }[]>(list.stdout)?.[0]?.number;
      if (typeof n === 'number') {
        doc.prNumber = n;
        say(`pr: #${n} opened`);
        beat('pr-opened');
      }
    }
    if (doc.prNumber !== null) {
      const view = deps.run(
        'gh',
        ['pr', 'view', String(doc.prNumber), '--json', 'state,mergeCommit,statusCheckRollup'],
        { cwd: deps.cwd },
      );
      const pr = tryJson<{
        state: string;
        mergeCommit?: { oid?: string } | null;
        statusCheckRollup?: { conclusion?: string; status?: string }[];
      }>(view.stdout);
      if (pr) {
        const rollup = pr.statusCheckRollup ?? [];
        const done = rollup.filter((c) => c.conclusion || c.status === 'COMPLETED').length;
        const checks = `${done}/${rollup.length}`;
        if (rollup.length > 0 && checks !== lastChecks) {
          say(`pr: #${doc.prNumber} checks ${checks} complete`);
          lastChecks = checks;
        }
        if (pr.state === 'MERGED') {
          doc.mergeSha = pr.mergeCommit?.oid ?? null;
          say(
            `pr: #${doc.prNumber} merged${doc.mergeSha ? ` as ${doc.mergeSha.slice(0, 9)}` : ''}`,
          );
          beat('pr-landed');
          return 0;
        }
      }
    }
    await deps.sleep(scenario.pollSeconds * 1000);
  }
  deps.err(
    `cli-hierarchy demo: ${scenario.task} did not merge within ${scenario.timeoutMinutes} minutes`,
  );
  flush();
  return 1;
}

/** True when beats.json carries all six beats. */
function beatsComplete(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const have = new Set(parseBeatsFile(readFileSync(file, 'utf-8')).beats.map((b) => b.name));
    return BEAT_NAMES.every((n) => have.has(n));
  } catch {
    return false;
  }
}

/** Stage 1: preflight, then re-execute the inner run under asciinema. */
export async function runDemoRun(flags: Record<string, string>, deps: DemoDeps): Promise<number> {
  const { scenario: file, out } = flags;
  if (!file || file === 'true' || !out || out === 'true') {
    deps.err('cli-hierarchy demo run: --scenario and --out are required');
    return 2;
  }
  let scenario: Scenario;
  try {
    scenario = loadScenario(file);
  } catch (err) {
    deps.err(`cli-hierarchy demo run: ${(err as Error).message}`);
    return 2;
  }
  if (flags['inner'] === 'true') return runInner(scenario, out, deps);
  if (!preflight(scenario, deps)) return 1;
  mkdirSync(out, { recursive: true });
  const cast = path.join(out, 'hierarchy.cast');
  const inner = [
    'node',
    path.join(deps.binDir, 'cli-hierarchy.mjs'),
    'demo',
    'run',
    '--inner',
    '--scenario',
    path.resolve(file),
    '--out',
    path.resolve(out),
  ]
    .map(quote)
    .join(' ');
  const status = deps.record([
    'rec',
    '--overwrite',
    '--idle-time-limit',
    String(IDLE_LIMIT_SECONDS),
    '--cols',
    '120',
    '--rows',
    '30',
    '--command',
    inner,
    cast,
  ]);
  if (status !== 0 || !beatsComplete(path.join(out, 'beats.json'))) {
    deps.err(`cli-hierarchy demo run: the run did not finish; ${cast} is kept for inspection`);
    return 1;
  }
  deps.out(`recorded ${cast}`);
  return 0;
}

/** Run the stage named by the first positional, or all three in order. */
export async function runDemo(
  stage: string | undefined,
  flags: Record<string, string>,
  deps: DemoDeps,
): Promise<number> {
  switch (stage) {
    case 'run':
      return runDemoRun(flags, deps);
    case 'cut':
      return runCut(flags, deps);
    case 'render':
      return runRender(flags, deps.media);
    case undefined: {
      const { out } = flags;
      if (!flags['scenario'] || flags['scenario'] === 'true' || !out || out === 'true') {
        deps.err('cli-hierarchy demo: --scenario and --out are required');
        return 2;
      }
      const cut = path.join(out, 'hierarchy.cut.cast');
      const code = await runDemoRun(flags, deps);
      if (code !== 0) return code;
      const cutCode = runCut(
        { cast: path.join(out, 'hierarchy.cast'), beats: path.join(out, 'beats.json'), out: cut },
        deps,
      );
      if (cutCode !== 0) return cutCode;
      return runRender({ cast: cut, out }, deps.media);
    }
    default:
      deps.err(`cli-hierarchy demo: unknown stage '${stage}' (run, cut or render)`);
      return 2;
  }
}
