#!/usr/bin/env node
/**
 * Measure the process-spawn and machine-load cost of our tooling (AISDLC-1441).
 *
 * Evidence for or against rewriting our CLI in a faster-starting language: how much CPU,
 * wall time and machine load our own processes (node CLIs, `gh` spawns, hooks, git) cost
 * during a normal drain, and how much of that is process startup versus work.
 *
 * Three subcommands, each rerunnable:
 *
 *   bench   Startup cost, median of N runs (default 20): `node -e 0` (runtime floor), a node
 *           CLI entry (`node pipeline-cli/bin/cli-decisions.mjs --help`), `gh --version`,
 *           `git --version`, the dispatch `gh` logging shim when present, and a compiled
 *           no-op binary (`/usr/bin/true`). Wall time from the parent's monotonic clock,
 *           CPU time (user + sys) from bash's `times` builtin over the child, ms resolution.
 *
 *   sample  Polls `ps -A` every --interval seconds for --duration and records, per process
 *           that ends (or is still alive when sampling stops): executable class, parent
 *           class, CPU seconds inside the window, wall seconds, and whether it was spawned
 *           inside the window; plus the 1/5/15 minute load average at every tick. Output is
 *           JSON lines. A process that starts and exits between two ticks is never seen, so
 *           sampled spawn counts are a LOWER BOUND; the report corrects `gh` with the exact
 *           gh-calls log and derives a capture rate from it.
 *
 *   report  Renders a markdown (or --json) report from a sample file, an optional bench
 *           file and the optional exact `gh` call log (`<board>/gh-calls.jsonl`, AISDLC-963).
 *
 * Usage:
 *   node scripts/measure-process-load.mjs bench [--runs 20] [--out bench.json]
 *   node scripts/measure-process-load.mjs sample --duration 24h [--interval 1] --out samples.jsonl
 *   node scripts/measure-process-load.mjs report --samples samples.jsonl [--bench bench.json]
 *        [--gh-log .ai-sdlc/dispatch/gh-calls.jsonl] [--json]
 *
 * Report: docs/operations/process-load-measurement-2026-11.md.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `[[dd-]hh:]mm:ss[.ff]` (ps `time` and `etime`) to seconds; NaN when unparseable. */
export function parseClock(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(s).trim());
  if (!m) return Number.NaN;
  const [, d = '0', h = '0', mm, ss] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(mm) * 60 + Number(ss);
}

/** `24h`, `30m`, `90s` or a bare number of seconds. */
export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600 }[m[2]];
}

/** One line of `ps -A -o pid=,ppid=,time=,etime=,args=`. */
export function parsePsLine(line) {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!m) return null;
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    cpuS: parseClock(m[3]),
    etimeS: parseClock(m[4]),
    args: m[5],
  };
}

/**
 * Executable class of a command line. Our own tooling gets its own classes; the model
 * sessions (`claude`) and everything else are kept apart so the report can say what
 * a faster-starting CLI could not touch.
 */
export function classify(args) {
  const argv0 = String(args).split(/\s+/)[0] ?? '';
  // ps shows an exiting process as `(name)`; classify it as the executable it was.
  const exe = basename(argv0).replace(/^\((.*)\)$/, '$1');
  if (exe === 'gh') return 'gh';
  if (exe === 'git' || exe.startsWith('git-')) return 'git';
  if (exe === 'claude' || /\/claude(-code)?\/cli\.js|@anthropic-ai\/claude-code/.test(args))
    return 'claude';
  if (exe === 'node') {
    if (/AI_SDLC_GH_CALL_LOG/.test(args)) return 'node:gh-shim';
    if (/pipeline-cli\/(?:bin|dist)\//.test(args)) return 'node:pipeline-cli';
    if (/ai-sdlc-plugin\/hooks\//.test(args)) return 'node:hook';
    if (/orchestrator\/(?:bin|dist)\//.test(args)) return 'node:orchestrator';
    if (/\b(?:vitest|eslint|prettier|tsc|pnpm|npm|npx|turbo)\b/.test(args)) return 'node:toolchain';
    if (/\bmcp\b|mcp-|-mcp/.test(args)) return 'node:mcp';
    return 'node:other';
  }
  if (/^(?:sh|bash|zsh|dash)$/.test(exe)) {
    return /ai-sdlc-plugin\/hooks\/|\.ai-sdlc\/dispatch\/bin\/gh/.test(args)
      ? 'shell:ours'
      : 'shell';
  }
  return 'other';
}

export const isOurs = (cls) =>
  cls === 'gh' || cls === 'git' || cls.startsWith('node:') || cls === 'shell:ours';

export function quantile(xs, q) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
export const median = (xs) => quantile(xs, 0.5);

/**
 * Tracks processes across `ps` snapshots. `observe` returns the records of processes that
 * disappeared since the previous snapshot; `flush` returns the rest.
 */
export class Tracker {
  constructor({ startT, selfPid = -1 }) {
    this.startT = startT;
    this.selfPid = selfPid;
    this.live = new Map();
  }

  observe(t, procs) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const done = [];
    const seen = new Set();
    for (const p of procs) {
      if (p.pid === this.selfPid || p.ppid === this.selfPid) continue;
      if (!Number.isFinite(p.cpuS) || !Number.isFinite(p.etimeS)) continue;
      seen.add(p.pid);
      let s = this.live.get(p.pid);
      if (s && (s.args !== p.args || p.etimeS + 1 < s.etimeLast)) {
        done.push(this.#record(s)); // pid reused
        this.live.delete(p.pid);
        s = undefined;
      }
      if (!s) {
        const spawned = t - p.etimeS >= this.startT - 1;
        const parent = byPid.get(p.ppid);
        s = {
          pid: p.pid,
          args: p.args,
          cls: classify(p.args),
          parentCls: parent ? classify(parent.args) : 'unknown',
          spawned,
          cpuBase: spawned ? 0 : p.cpuS,
          firstT: t,
        };
        this.live.set(p.pid, s);
      }
      s.cpuLast = p.cpuS;
      s.etimeLast = p.etimeS;
      s.lastT = t;
    }
    for (const [pid, s] of this.live) {
      if (seen.has(pid)) continue;
      done.push(this.#record(s));
      this.live.delete(pid);
    }
    return done;
  }

  flush() {
    const out = [...this.live.values()].map((s) => this.#record(s));
    this.live.clear();
    return out;
  }

  #record(s) {
    return {
      type: 'proc',
      pid: s.pid,
      exe: basename(s.args.split(/\s+/)[0] ?? ''),
      cls: s.cls,
      parentCls: s.parentCls,
      spawned: s.spawned,
      cpuS: Math.max(0, s.cpuLast - s.cpuBase),
      wallS: s.spawned ? s.etimeLast : s.lastT - s.firstT,
      firstT: s.firstT,
      lastT: s.lastT,
    };
  }
}

function psSnapshot() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,etime=,args='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map(parsePsLine).filter(Boolean);
}

/** Cumulative busy CPU milliseconds of the whole machine (user + nice + sys + irq, all cores). */
export const machineCpuMs = (list = cpus()) =>
  list.reduce((a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.irq, 0);

export async function sample({
  durationS,
  intervalS,
  out,
  now = () => Date.now() / 1000,
  stop = { requested: false },
}) {
  const startT = now();
  writeFileSync(
    out,
    JSON.stringify({
      type: 'meta',
      startT,
      intervalS,
      durationS,
      ncpu: cpus().length,
      platform: process.platform,
    }) + '\n',
  );
  const tracker = new Tracker({ startT, selfPid: process.pid });
  let t = startT;
  while (t - startT < durationS && !stop.requested) {
    const procs = psSnapshot();
    t = now();
    const lines = [
      { type: 'load', t, load: loadavg(), cpuMs: machineCpuMs() },
      ...tracker.observe(t, procs),
    ];
    appendFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await new Promise((r) => setTimeout(r, intervalS * 1000));
    t = now();
  }
  const rest = tracker.flush();
  const tail = [...rest, { type: 'end', t }];
  appendFileSync(out, tail.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** Parse bash `times` output pairs; returns cumulative children CPU seconds per line pair. */
export function parseTimes(text) {
  const vals = [];
  for (const line of text.split('\n')) {
    const m = /^(\d+)m([\d.]+)s\s+(\d+)m([\d.]+)s$/.exec(line.trim());
    if (m) vals.push(Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) * 60 + Number(m[4]));
  }
  // `times` prints the shell's own line then the children's line; keep the children's.
  return vals.filter((_, i) => i % 2 === 1);
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Median wall and CPU milliseconds of `runs` executions of argv. */
export function benchOne(argv, { runs = 20, env = process.env, cwd = ROOT } = {}) {
  const walls = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(argv[0], argv.slice(1), { env, cwd, stdio: 'ignore' });
    walls.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (r.error) return { argv, error: r.error.message };
  }
  const cmd = argv.map(shQuote).join(' ');
  const script = `for i in $(seq ${runs}); do ${cmd} >/dev/null 2>&1; times; done`;
  const r = spawnSync('bash', ['-c', script], { env, cwd, encoding: 'utf8' });
  const cum = parseTimes(r.stdout ?? '');
  const cpu = cum.map((v, i) => (v - (i === 0 ? 0 : cum[i - 1])) * 1000);
  return {
    argv,
    runs,
    wallMedianMs: round(median(walls)),
    cpuMedianMs: cpu.length === runs ? round(median(cpu)) : null,
  };
}

const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

function mainCheckout() {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    ).trim();
    return dirname(common);
  } catch {
    return ROOT;
  }
}

/** PATH without any `.ai-sdlc/dispatch/bin` entry (the gh logging shim). */
export const stripShimDir = (path) =>
  path
    .split(':')
    .filter((d) => !/\.ai-sdlc\/dispatch\/bin\/?$/.test(d))
    .join(':');

export function bench({ runs = 20 } = {}) {
  const ghShim = join(mainCheckout(), '.ai-sdlc/dispatch/bin/gh');
  // Plain cases run without the dispatch gh shim (and without its call log), so `gh` is the
  // real binary and the benchmark never writes into the board's gh-calls log.
  const plainEnv = { ...process.env, PATH: stripShimDir(process.env.PATH ?? '') };
  delete plainEnv.AI_SDLC_GH_CALL_LOG;
  const cases = {
    'noop-compiled': ['/usr/bin/true'],
    'node-runtime': [process.execPath, '-e', '0'],
    'node-cli': [process.execPath, 'pipeline-cli/bin/cli-decisions.mjs', '--help'],
    gh: ['gh', '--version'],
    git: ['git', '--version'],
  };
  const results = {};
  for (const [name, argv] of Object.entries(cases))
    results[name] = benchOne(argv, { runs, env: plainEnv });
  if (existsSync(ghShim)) {
    const log = join(tmpdir(), `measure-process-load-gh-${process.pid}.jsonl`);
    const env = { ...plainEnv, AI_SDLC_GH_CALL_LOG: log };
    delete env.AI_SDLC_GH_CALL_LOGGED;
    results['gh-via-shim'] = benchOne([ghShim, '--version'], { runs, env });
  }
  return {
    type: 'bench',
    node: process.version,
    platform: process.platform,
    ncpu: cpus().length,
    results,
  };
}

export function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Startup bench case used to price one spawn of a class. */
const BENCH_FOR = {
  gh: 'gh',
  git: 'git',
  'node:pipeline-cli': 'node-cli',
  'node:hook': 'node-runtime',
  'node:gh-shim': 'node-runtime',
  'node:orchestrator': 'node-cli',
  'node:toolchain': 'node-runtime',
  'node:mcp': 'node-runtime',
  'node:other': 'node-runtime',
};

/** Aggregate sample lines (+ optional bench and exact gh log lines) into report data. */
export function analyze({ lines, bench: b = null, ghCalls = null }) {
  const meta = lines.find((l) => l.type === 'meta');
  if (!meta) throw new Error('sample file has no meta line');
  const loads = lines.filter((l) => l.type === 'load');
  const procs = lines.filter((l) => l.type === 'proc');
  const endT = lines.find((l) => l.type === 'end')?.t ?? loads.at(-1)?.t ?? meta.startT;
  const windowS = Math.max(1, endT - meta.startT);
  const hours = windowS / 3600;

  const classes = {};
  let machineCpuS = 0;
  for (const p of procs) {
    machineCpuS += p.cpuS;
    const c = (classes[p.cls] ??= { spawns: 0, cpuS: 0, wallS: 0, byParent: {} });
    c.cpuS += p.cpuS;
    if (p.spawned) {
      c.spawns += 1;
      c.wallS += p.wallS;
      c.byParent[p.parentCls] = (c.byParent[p.parentCls] ?? 0) + 1;
    }
  }

  let gh = null;
  if (ghCalls) {
    const inWin = ghCalls.filter((c) => {
      const t = Date.parse(c.at) / 1000;
      return t >= meta.startT && t <= endT;
    });
    const bySession = {};
    for (const c of inWin) bySession[c.session] = (bySession[c.session] ?? 0) + 1;
    gh = { exact: inWin.length, perHour: inWin.length / hours, bySession };
    const sampled = classes.gh?.spawns ?? 0;
    // The log misses gh calls made outside a hierarchy session, so the sampler can see more.
    gh.captureRate = inWin.length > 0 ? Math.min(1, sampled / inWin.length) : null;
  }

  const res = b?.results ?? {};
  const cpuMs = (name) => res[name]?.cpuMedianMs ?? null;
  const noop = cpuMs('noop-compiled') ?? 0;
  const capture = gh?.captureRate && gh.captureRate > 0 ? gh.captureRate : null;

  const rows = Object.entries(classes)
    .map(([cls, c]) => {
      const spawnsEst =
        cls === 'gh' && gh
          ? Math.max(gh.exact, c.spawns)
          : capture && c.spawns
            ? c.spawns / capture
            : c.spawns;
      const per = cpuMs(BENCH_FOR[cls]);
      const startupCpuS = per != null ? (spawnsEst * per) / 1000 : null;
      const cpuEst = cls === 'gh' && gh && per != null ? Math.max(c.cpuS, startupCpuS) : c.cpuS;
      return {
        cls,
        ours: isOurs(cls),
        spawnsObserved: c.spawns,
        spawnsEst,
        spawnsPerHour: spawnsEst / hours,
        cpuS: cpuEst,
        wallS: c.wallS,
        startupCpuS,
        startupShare: startupCpuS != null && cpuEst > 0 ? Math.min(1, startupCpuS / cpuEst) : null,
        removableCpuS: per != null ? (spawnsEst * Math.max(0, per - noop)) / 1000 : null,
        topParents: Object.entries(c.byParent)
          .sort((a, b2) => b2[1] - a[1])
          .slice(0, 3),
      };
    })
    .sort((a, b2) => b2.cpuS - a.cpuS);

  const ghExtraCpuS = rows.find((r) => r.cls === 'gh')
    ? rows.find((r) => r.cls === 'gh').cpuS - (classes.gh?.cpuS ?? 0)
    : 0;
  const procCpuS = machineCpuS + Math.max(0, ghExtraCpuS);
  const metered = loads.filter((l) => typeof l.cpuMs === 'number');
  const meteredS = metered.length > 1 ? (metered.at(-1).cpuMs - metered[0].cpuMs) / 1000 : null;
  // Machine CPU from the kernel counters when sampled; the per-process sum misses processes
  // that start and end between two ticks, so it is only a fallback.
  const totalCpuS = meteredS != null && meteredS > 0 ? Math.max(meteredS, procCpuS) : procCpuS;
  const capacityS = (meta.ncpu ?? 1) * windowS;
  const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const ourCpuS = sum((r) => (r.ours ? r.cpuS : 0));
  const nodeRemovableS = sum((r) => (r.cls.startsWith('node:') ? r.removableCpuS : 0));
  const ghRemovableS = sum((r) => (r.cls === 'gh' ? r.removableCpuS : 0));
  const load1 = loads.map((l) => l.load[0]);
  const ncpu = meta.ncpu ?? 1;
  const buckets = [0, 0.5, 1, 1.5, 2].map((f) => f * ncpu);
  const hist = buckets.map((lo, i) => {
    const hi = buckets[i + 1] ?? Infinity;
    return {
      lo,
      hi,
      share: load1.length ? load1.filter((x) => x >= lo && x < hi).length / load1.length : 0,
    };
  });

  return {
    window: {
      startT: meta.startT,
      endT,
      hours,
      intervalS: meta.intervalS,
      ncpu,
      platform: meta.platform,
    },
    rows,
    gh,
    bench: b,
    totals: {
      machineCpuS: totalCpuS,
      attributedCpuS: procCpuS,
      machineCpuSource: meteredS != null && meteredS > 0 ? 'kernel counters' : 'per-process sum',
      capacityS,
      machineUtil: totalCpuS / capacityS,
      ourCpuS,
      ourShareOfMachine: totalCpuS > 0 ? ourCpuS / totalCpuS : 0,
      nodeStartupRemovableS: nodeRemovableS,
      nodeStartupRemovableShare: totalCpuS > 0 ? nodeRemovableS / totalCpuS : 0,
      ghSpawnRemovableS: ghRemovableS,
      ghSpawnRemovableShare: totalCpuS > 0 ? ghRemovableS / totalCpuS : 0,
    },
    load: {
      samples: load1.length,
      p50: quantile(load1, 0.5),
      p90: quantile(load1, 0.9),
      p99: quantile(load1, 0.99),
      max: load1.length ? Math.max(...load1) : null,
      hist,
    },
  };
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 1) => (x == null ? 'n/a' : x.toFixed(d));

export function renderMarkdown(a) {
  const w = a.window;
  const L = [];
  L.push(
    `Window: ${new Date(w.startT * 1000).toISOString()} to ${new Date(w.endT * 1000).toISOString()} (${num(w.hours, 2)} h), ps interval ${w.intervalS} s, ${w.ncpu} CPUs, ${w.platform}.`,
  );
  L.push('');
  if (a.bench) {
    L.push(
      '### Startup benchmarks (median of ' +
        (Object.values(a.bench.results)[0]?.runs ?? '?') +
        ' runs)',
    );
    L.push('');
    L.push('| case | command | wall ms | CPU ms |');
    L.push('| --- | --- | --- | --- |');
    for (const [name, r] of Object.entries(a.bench.results)) {
      const cmd = r.argv.map((x) => basename(String(x))).join(' ');
      L.push(
        `| ${name} | \`${cmd}\` | ${r.error ? 'error' : num(r.wallMedianMs)} | ${num(r.cpuMedianMs)} |`,
      );
    }
    L.push('');
  }
  L.push('### Spawns and CPU by executable class');
  L.push('');
  L.push(
    '| class | ours | spawns observed | spawns est. | spawns/h | CPU s | wall s (spawned) | startup CPU s | startup share | top parents |',
  );
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of a.rows) {
    const parents = r.topParents.map(([p, n]) => `${p} ${n}`).join(', ');
    L.push(
      `| ${r.cls} | ${r.ours ? 'yes' : 'no'} | ${r.spawnsObserved} | ${num(r.spawnsEst, 0)} | ${num(r.spawnsPerHour)} | ${num(r.cpuS)} | ${num(r.wallS, 0)} | ${num(r.startupCpuS)} | ${pct(r.startupShare)} | ${parents} |`,
    );
  }
  L.push('');
  if (a.gh) {
    L.push(
      `Exact \`gh\` calls in the window (gh-calls log): ${a.gh.exact} (${num(a.gh.perHour)}/h); ps sampling caught ${pct(a.gh.captureRate)} of them, which is the capture rate applied to the other short-lived classes.`,
    );
    L.push('');
  }
  const t = a.totals;
  L.push('### Totals');
  L.push('');
  L.push(
    `- Machine CPU (${t.machineCpuSource}): ${num(t.machineCpuS, 0)} s of ${num(t.capacityS, 0)} s capacity (${pct(t.machineUtil)} average utilisation); ${num(t.attributedCpuS, 0)} s attributed to sampled processes.`,
  );
  L.push(
    `- Our tooling (node, gh, git, our shell wrappers): ${num(t.ourCpuS, 0)} s, ${pct(t.ourShareOfMachine)} of observed machine CPU.`,
  );
  L.push(
    `- Ceiling for a faster-starting CLI (node startup minus compiled no-op startup, every node spawn): ${num(t.nodeStartupRemovableS, 0)} s, ${pct(t.nodeStartupRemovableShare)} of machine CPU.`,
  );
  L.push(
    `- Ceiling for replacing \`gh\` spawns with in-process HTTP (gh startup minus no-op, every call): ${num(t.ghSpawnRemovableS, 0)} s, ${pct(t.ghSpawnRemovableShare)} of machine CPU.`,
  );
  L.push('');
  L.push('### Load average (1 min)');
  L.push('');
  L.push(
    `Samples ${a.load.samples}; p50 ${num(a.load.p50, 2)}, p90 ${num(a.load.p90, 2)}, p99 ${num(a.load.p99, 2)}, max ${num(a.load.max, 2)}.`,
  );
  L.push('');
  L.push('| load1 range | share of samples |');
  L.push('| --- | --- |');
  for (const h of a.load.hist)
    L.push(`| ${num(h.lo, 0)} to ${h.hi === Infinity ? 'inf' : num(h.hi, 0)} | ${pct(h.share)} |`);
  return L.join('\n') + '\n';
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      runs: { type: 'string', default: '20' },
      out: { type: 'string' },
      duration: { type: 'string', default: '24h' },
      interval: { type: 'string', default: '1' },
      samples: { type: 'string' },
      bench: { type: 'string' },
      'gh-log': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (cmd === 'bench') {
    const r = bench({ runs: Number(values.runs) });
    const text = JSON.stringify(r, null, 2) + '\n';
    if (values.out) writeFileSync(values.out, text);
    process.stdout.write(text);
    return 0;
  }
  if (cmd === 'sample') {
    if (!values.out) throw new Error('sample needs --out <file.jsonl>');
    // SIGINT/SIGTERM end the window early but still write the live processes and the end line.
    const stop = { requested: false };
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => (stop.requested = true));
    await sample({
      durationS: parseDuration(values.duration),
      intervalS: Number(values.interval),
      out: values.out,
      stop,
    });
    return 0;
  }
  if (cmd === 'report') {
    if (!values.samples) throw new Error('report needs --samples <file.jsonl>');
    const a = analyze({
      lines: readJsonl(values.samples),
      bench: values.bench ? JSON.parse(readFileSync(values.bench, 'utf8')) : null,
      ghCalls: values['gh-log'] ? readJsonl(values['gh-log']) : null,
    });
    process.stdout.write(values.json ? JSON.stringify(a, null, 2) + '\n' : renderMarkdown(a));
    return 0;
  }
  process.stderr.write(
    'usage: measure-process-load.mjs bench|sample|report [options] (see header)\n',
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    },
  );
}
