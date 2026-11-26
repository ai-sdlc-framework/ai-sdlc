import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  Tracker,
  analyze,
  benchOne,
  classify,
  isOurs,
  machineCpuMs,
  median,
  parseClock,
  parseDuration,
  parsePsLine,
  parseTimes,
  quantile,
  readJsonl,
  renderMarkdown,
  sample,
  stripShimDir,
} from './measure-process-load.mjs';

const SCRIPT = new URL('./measure-process-load.mjs', import.meta.url).pathname;

test('parseClock reads ps time and etime formats', () => {
  assert.equal(parseClock('0:00.03'), 0.03);
  assert.equal(parseClock('01:02'), 62);
  assert.equal(parseClock('1:00:00'), 3600);
  assert.equal(parseClock('02-01:34:39'), 2 * 86400 + 3600 + 34 * 60 + 39);
  assert.ok(Number.isNaN(parseClock('garbage')));
});

test('parseDuration accepts h, m, s and bare seconds', () => {
  assert.equal(parseDuration('24h'), 86400);
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('5'), 5);
  assert.throws(() => parseDuration('soon'), /bad duration/);
});

test('parsePsLine splits pid, ppid, cpu, etime and args', () => {
  assert.deepEqual(parsePsLine('  123   1   0:01.50     00:09 node a b'), {
    pid: 123,
    ppid: 1,
    cpuS: 1.5,
    etimeS: 9,
    args: 'node a b',
  });
  assert.equal(parsePsLine(''), null);
});

test('classify separates our tooling from model sessions and the rest', () => {
  assert.equal(classify('/opt/homebrew/bin/gh pr view 1'), 'gh');
  assert.equal(classify('/usr/bin/git rev-parse HEAD'), 'git');
  assert.equal(classify('/usr/libexec/git-core/git-remote-https origin'), 'git');
  assert.equal(classify('claude --print'), 'claude');
  assert.equal(classify('node /x/@anthropic-ai/claude-code/cli.js'), 'claude');
  assert.equal(classify('node pipeline-cli/bin/cli-file.mjs task x'), 'node:pipeline-cli');
  assert.equal(classify('node /r/ai-sdlc-plugin/hooks/permission-check.js'), 'node:hook');
  assert.equal(classify('node -e appendFileSync(env.AI_SDLC_GH_CALL_LOG)'), 'node:gh-shim');
  assert.equal(classify('node orchestrator/bin/ai-sdlc.mjs'), 'node:orchestrator');
  assert.equal(classify('node /r/node_modules/.bin/vitest run'), 'node:toolchain');
  assert.equal(classify('node /x/.bin/playwright-mcp'), 'node:mcp');
  assert.equal(classify('node server.js'), 'node:other');
  assert.equal(classify('(node)'), 'node:other');
  assert.equal(classify('/bin/sh /r/.ai-sdlc/dispatch/bin/gh api user'), 'shell:ours');
  assert.equal(classify('/bin/zsh -c ls'), 'shell');
  assert.equal(classify('/usr/sbin/WindowServer'), 'other');
  assert.ok(isOurs('gh') && isOurs('node:hook') && isOurs('shell:ours'));
  assert.ok(!isOurs('claude') && !isOurs('other') && !isOurs('shell'));
});

test('quantile and median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([], 0.5), null);
});

test('stripShimDir drops the dispatch gh shim from PATH', () => {
  assert.equal(stripShimDir('/a/.ai-sdlc/dispatch/bin:/usr/bin'), '/usr/bin');
  assert.equal(stripShimDir('/usr/bin:/bin'), '/usr/bin:/bin');
});

test('parseTimes keeps the children line of each times pair', () => {
  const text = '0m0.001s 0m0.002s\n0m0.030s 0m0.010s\n0m0.001s 0m0.002s\n0m0.070s 0m0.020s\n';
  const v = parseTimes(text);
  assert.equal(v.length, 2);
  assert.ok(Math.abs(v[0] - 0.04) < 1e-9);
  assert.ok(Math.abs(v[1] - 0.09) < 1e-9);
});

test('Tracker records spawned and pre-existing processes, CPU inside the window only', () => {
  const tr = new Tracker({ startT: 1000, selfPid: 9 });
  const t1 = [
    { pid: 1, ppid: 0, cpuS: 50, etimeS: 5000, args: '/sbin/launchd' },
    { pid: 2, ppid: 1, cpuS: 10, etimeS: 4000, args: 'node server.js' },
    { pid: 9, ppid: 1, cpuS: 1, etimeS: 1, args: 'node measure' },
    { pid: 10, ppid: 9, cpuS: 0, etimeS: 0, args: 'ps -A' },
  ];
  assert.deepEqual(tr.observe(1000, t1), []);
  const t2 = [
    { pid: 1, ppid: 0, cpuS: 51, etimeS: 5001, args: '/sbin/launchd' },
    { pid: 2, ppid: 1, cpuS: 12, etimeS: 4001, args: 'node server.js' },
    { pid: 3, ppid: 2, cpuS: 0.2, etimeS: 0, args: 'gh api user' },
  ];
  assert.deepEqual(tr.observe(1001, t2), []);
  const t3 = [
    { pid: 1, ppid: 0, cpuS: 52, etimeS: 5002, args: '/sbin/launchd' },
    // pid 2 reused by a different command
    { pid: 2, ppid: 1, cpuS: 0.1, etimeS: 0, args: '/usr/bin/git status' },
  ];
  const done = tr.observe(1002, t3);
  const byPid = Object.fromEntries(done.map((r) => [`${r.pid}:${r.cls}`, r]));
  assert.equal(byPid['2:node:other'].cpuS, 2);
  assert.equal(byPid['2:node:other'].spawned, false);
  assert.equal(byPid['3:gh'].spawned, true);
  assert.equal(byPid['3:gh'].parentCls, 'node:other');
  assert.equal(byPid['3:gh'].cpuS, 0.2);
  const rest = tr.flush();
  assert.equal(rest.length, 2);
  const git = rest.find((r) => r.cls === 'git');
  assert.equal(git.spawned, true);
  assert.equal(rest.find((r) => r.pid === 1).cpuS, 2);
  assert.equal(tr.flush().length, 0);
});

function fixture() {
  const startT = 1_800_000_000;
  const lines = [
    { type: 'meta', startT, intervalS: 1, durationS: 3600, ncpu: 4, platform: 'test' },
  ];
  for (let i = 0; i < 10; i += 1)
    lines.push({ type: 'load', t: startT + i * 360, load: [i, i, i] });
  const proc = (cls, cpuS, spawned, parentCls = 'claude') => ({
    type: 'proc',
    pid: lines.length,
    exe: cls,
    cls,
    parentCls,
    spawned,
    cpuS,
    wallS: spawned ? 1 : 3600,
    firstT: startT,
    lastT: startT + 1,
  });
  for (let i = 0; i < 5; i += 1) lines.push(proc('gh', 0.01, true, 'node:pipeline-cli'));
  for (let i = 0; i < 4; i += 1) lines.push(proc('node:pipeline-cli', 0.5, true));
  lines.push(proc('claude', 100, false));
  lines.push(proc('other', 50, false, 'unknown'));
  lines.push({ type: 'end', t: startT + 3600 });
  const ghCalls = [];
  for (let i = 0; i < 10; i += 1) {
    ghCalls.push({
      at: new Date((startT + i * 60) * 1000).toISOString(),
      session: i < 6 ? 'a' : 'b',
      argv: [],
    });
  }
  ghCalls.push({ at: new Date((startT - 10) * 1000).toISOString(), session: 'a', argv: [] });
  const bench = {
    results: {
      'noop-compiled': { argv: ['/usr/bin/true'], runs: 20, wallMedianMs: 1, cpuMedianMs: 1 },
      'node-runtime': { argv: ['node', '-e', '0'], runs: 20, wallMedianMs: 25, cpuMedianMs: 25 },
      'node-cli': {
        argv: ['node', 'cli.mjs', '--help'],
        runs: 20,
        wallMedianMs: 240,
        cpuMedianMs: 301,
      },
      gh: { argv: ['gh', '--version'], runs: 20, wallMedianMs: 44, cpuMedianMs: 51 },
      broken: { argv: ['nope'], error: 'ENOENT' },
    },
  };
  return { lines, ghCalls, bench };
}

test('analyze applies the exact gh count, capture rate, startup share and ceilings', () => {
  const { lines, ghCalls, bench } = fixture();
  const a = analyze({ lines, bench, ghCalls });
  assert.equal(a.window.hours, 1);
  assert.equal(a.gh.exact, 10);
  assert.deepEqual(a.gh.bySession, { a: 6, b: 4 });
  assert.equal(a.gh.captureRate, 0.5);
  const gh = a.rows.find((r) => r.cls === 'gh');
  assert.equal(gh.spawnsEst, 10);
  assert.ok(Math.abs(gh.cpuS - 0.51) < 1e-9);
  assert.equal(gh.startupShare, 1);
  const cli = a.rows.find((r) => r.cls === 'node:pipeline-cli');
  assert.equal(cli.spawnsEst, 8);
  assert.equal(cli.spawnsPerHour, 8);
  assert.ok(Math.abs(cli.removableCpuS - 2.4) < 1e-9);
  assert.equal(a.rows.find((r) => r.cls === 'claude').startupCpuS, null);
  assert.ok(Math.abs(a.totals.nodeStartupRemovableS - 2.4) < 1e-9);
  assert.ok(Math.abs(a.totals.ghSpawnRemovableS - 0.5) < 1e-9);
  assert.equal(a.load.p50, 4);
  assert.equal(a.load.max, 9);
  assert.equal(a.load.hist.length, 5);
  const md = renderMarkdown(a);
  assert.match(md, /Startup benchmarks \(median of 20 runs\)/);
  assert.match(md, /\| broken \| `nope` \| error \|/);
  assert.match(md, /Exact `gh` calls in the window/);
  assert.match(md, /Ceiling for a faster-starting CLI/);
});

test('analyze works without bench or gh log and rejects a file without meta', () => {
  const { lines } = fixture();
  const a = analyze({ lines });
  assert.equal(a.gh, null);
  assert.equal(a.rows.find((r) => r.cls === 'gh').spawnsEst, 5);
  assert.equal(a.totals.nodeStartupRemovableS, 0);
  assert.doesNotMatch(renderMarkdown(a), /Startup benchmarks/);
  assert.throws(() => analyze({ lines: [] }), /no meta line/);
});

test('benchOne measures wall and CPU, and reports a missing executable', () => {
  const r = benchOne(['/bin/sh', '-c', ':'], { runs: 2 });
  assert.equal(r.runs, 2);
  assert.ok(r.wallMedianMs >= 0);
  assert.ok(r.cpuMedianMs === null || r.cpuMedianMs >= 0);
  assert.match(benchOne(['/definitely/missing-binary'], { runs: 1 }).error, /ENOENT/);
});

test('sample writes meta, load, proc and end lines that report can read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-'));
  const out = join(dir, 's.jsonl');
  await sample({ durationS: 0.3, intervalS: 0.1, out });
  const lines = readJsonl(out);
  assert.equal(lines[0].type, 'meta');
  assert.ok(lines.some((l) => l.type === 'load'));
  assert.ok(lines.some((l) => l.type === 'proc'));
  assert.equal(lines.at(-1).type, 'end');
  const r = spawnSync(process.execPath, [SCRIPT, 'report', '--samples', out, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).rows.length > 0);
});

test('CLI: usage error, missing options and report from files', () => {
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.match(run('sample').stderr, /needs --out/);
  assert.match(run('report').stderr, /needs --samples/);
  const dir = mkdtempSync(join(tmpdir(), 'mpl-'));
  const { lines, ghCalls, bench } = fixture();
  const w = (n, rows) => {
    writeFileSync(join(dir, n), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
    return join(dir, n);
  };
  const s = w('s.jsonl', lines);
  const g = w('g.jsonl', ghCalls);
  writeFileSync(join(dir, 'b.json'), JSON.stringify(bench));
  const r = run('report', '--samples', s, '--gh-log', g, '--bench', join(dir, 'b.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /### Totals/);
  const b = run('bench', '--runs', '1', '--out', join(dir, 'bench-out.json'));
  assert.equal(b.status, 0, b.stderr);
  assert.ok(JSON.parse(readFileSync(join(dir, 'bench-out.json'), 'utf8')).results['noop-compiled']);
});

test('machineCpuMs sums busy time across cores', () => {
  const core = (user, nice, sys, idle, irq) => ({ times: { user, nice, sys, idle, irq } });
  assert.equal(machineCpuMs([core(10, 1, 5, 100, 2), core(20, 0, 5, 50, 0)]), 43);
  assert.ok(machineCpuMs() > 0);
});

test('analyze prefers kernel CPU counters over the per-process sum', () => {
  const { lines } = fixture();
  const loads = lines.filter((l) => l.type === 'load');
  loads.forEach((l, i) => (l.cpuMs = i * 100_000));
  const a = analyze({ lines });
  assert.equal(a.totals.machineCpuSource, 'kernel counters');
  assert.equal(a.totals.machineCpuS, 900);
  assert.ok(a.totals.attributedCpuS < 900);
  assert.match(renderMarkdown(a), /Machine CPU \(kernel counters\): 900 s/);
});

test('sample stops early on request and still writes the end line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-'));
  const out = join(dir, 's.jsonl');
  const stop = { requested: true };
  await sample({ durationS: 3600, intervalS: 0.1, out, stop });
  const lines = readJsonl(out);
  assert.equal(lines.at(-1).type, 'end');
  assert.equal(lines.filter((l) => l.type === 'load').length, 0);
});

test('CLI sample flushes on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-'));
  const out = join(dir, 's.jsonl');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [
    SCRIPT,
    'sample',
    '--duration',
    '1h',
    '--interval',
    '0.2',
    '--out',
    out,
  ]);
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (readFileSync(out, 'utf8').includes('"type":"load"')) break;
    } catch {
      // not written yet
    }
  }
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(readJsonl(out).at(-1).type, 'end');
});
