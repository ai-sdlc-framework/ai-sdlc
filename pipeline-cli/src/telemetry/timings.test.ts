import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendSpan,
  commandName,
  currentSpan,
  DEFAULT_SLOW_SPAN_MS,
  formatDuration,
  formatSlowSpans,
  formatTimingsReport,
  installCommandSpan,
  MAX_FILE_BYTES,
  percentile,
  readSpans,
  recentSlowSpans,
  safeLabel,
  sanitizeSpan,
  slowSpanMs,
  spanKey,
  startSlowWatch,
  startSpan,
  subcommand,
  timingsFile,
  timingsFiles,
  timingsReport,
  type TimingSpan,
} from './timings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'timings-'));
  file = path.join(dir, 'timings.jsonl');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const lines = (f = file) =>
  readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TimingSpan);

const span = (over: Partial<TimingSpan> = {}): TimingSpan => ({
  v: 1,
  kind: 'command',
  name: 'cli-file',
  startedAt: '2026-11-25T10:00:00.000Z',
  durationMs: 1000,
  exitCode: 0,
  pid: 1,
  ...over,
});

describe('redaction (AC 7)', () => {
  it('never records a token, credential, argv value, environment or file contents', () => {
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG',
      'sk-ant-api03-xyz',
      'Bearer abc',
      'AKIAABCDEFGHIJKL',
      'xoxb-123-456',
      'my-secret-value',
      'token',
      'password1',
      'dGhpcyBpcyBhIGxvbmcgYmFzZTY0IGJsb2IgdmFsdWU',
      '/Users/me/.ai-sdlc/signing-key.pem',
      'line one\nline two',
    ];
    for (const s of secrets) {
      appendSpan(
        {
          kind: 'command',
          name: s,
          sub: s,
          waitedOn: s,
          signal: s,
          taskId: s,
          startedAt: 0,
          durationMs: 5,
          exitCode: 0,
          pid: 1,
          argv: ['--body', s],
          env: { GH_TOKEN: s },
          contents: s,
        },
        file,
      );
    }
    const text = readFileSync(file, 'utf8');
    for (const s of secrets) expect(text).not.toContain(s);
    for (const l of lines()) {
      expect(Object.keys(l).sort()).toEqual(
        ['durationMs', 'exitCode', 'kind', 'name', 'pid', 'startedAt', 'v'].sort(),
      );
      expect(l.name).toBe('(redacted)');
    }
  });

  it('keeps plain labels and drops unknown kinds', () => {
    expect(safeLabel('a free slot')).toBe('a free slot');
    expect(safeLabel(' typecheck ')).toBe('typecheck');
    expect(safeLabel(3)).toBeUndefined();
    expect(sanitizeSpan({ kind: 'other', name: 'x' })).toBeNull();
    const s = sanitizeSpan({
      kind: 'wait',
      name: 'verify-slot',
      sub: 'exclusive',
      waitedOn: 'a free slot',
      signal: 'SIGINT',
      taskId: 'AISDLC-1414.2',
      startedAt: '2026-11-25T10:00:00.000Z',
      durationMs: 12.6,
      exitCode: 1,
      pid: 7,
    });
    expect(s).toEqual({
      v: 1,
      kind: 'wait',
      name: 'verify-slot',
      sub: 'exclusive',
      waitedOn: 'a free slot',
      signal: 'SIGINT',
      taskId: 'AISDLC-1414.2',
      startedAt: '2026-11-25T10:00:00.000Z',
      durationMs: 13,
      exitCode: 1,
      pid: 7,
    });
    expect(sanitizeSpan({ kind: 'gate', startedAt: 'junk', durationMs: -4 })).toMatchObject({
      name: '(redacted)',
      startedAt: new Date(0).toISOString(),
      durationMs: 0,
      exitCode: null,
      pid: 0,
    });
  });
});

describe('file location and settings', () => {
  it('defaults to ~/.ai-sdlc/timings.jsonl, honours the override and off', () => {
    expect(timingsFile({})).toMatch(/\.ai-sdlc[/\\]timings\.jsonl$/);
    expect(timingsFile({ AI_SDLC_TIMINGS_FILE: file })).toBe(file);
    expect(timingsFile({ AI_SDLC_TIMINGS_FILE: 'off' })).toBeNull();
    expect(timingsFiles({ AI_SDLC_TIMINGS_FILE: file })).toEqual([`${file}.1`, file]);
    expect(timingsFiles({ AI_SDLC_TIMINGS_FILE: 'off' })).toEqual([]);
  });

  it('reads the slow threshold in seconds', () => {
    expect(slowSpanMs({})).toBe(DEFAULT_SLOW_SPAN_MS);
    expect(slowSpanMs({ AI_SDLC_SLOW_SPAN_SECONDS: '30' })).toBe(30_000);
    expect(slowSpanMs({ AI_SDLC_SLOW_SPAN_SECONDS: '0' })).toBe(0);
    expect(slowSpanMs({ AI_SDLC_SLOW_SPAN_SECONDS: 'x' })).toBe(DEFAULT_SLOW_SPAN_MS);
  });

  it('appends nothing when off, and never throws on an unwritable path', () => {
    appendSpan(span(), null);
    appendSpan({ kind: 'nope' }, file);
    expect(existsSync(file)).toBe(false);
    writeFileSync(path.join(dir, 'blocker'), '');
    expect(() => appendSpan(span(), path.join(dir, 'blocker', 'x.jsonl'))).not.toThrow();
  });

  it('rotates the file past the size limit and reads both, skipping torn lines', () => {
    writeFileSync(file, `${'x'.repeat(MAX_FILE_BYTES + 1)}\n`);
    appendSpan(span({ name: 'after' }), file);
    expect(readdirSync(dir).sort()).toEqual(['timings.jsonl', 'timings.jsonl.1']);
    writeFileSync(`${file}.1`, `${JSON.stringify(span({ name: 'before' }))}\n{torn\n\n`);
    expect(
      readSpans([`${file}.1`, file, null, path.join(dir, 'missing')]).map((s) => s.name),
    ).toEqual(['before', 'after']);
  });
});

describe('spans in flight', () => {
  it('records one wait span with what it waited on and keeps the stack', () => {
    let t = 1_000;
    const now = () => t;
    const outer = startSpan('command', 'cli-x', { now, file, pid: 3, env: {} });
    const inner = startSpan('wait', 'verify-slot', {
      now,
      file,
      pid: 3,
      env: { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-9' },
    });
    expect(currentSpan()?.name).toBe('verify-slot');
    inner.setDetail('a free slot');
    t = 4_000;
    inner.end(0);
    inner.end(1); // ignored
    expect(currentSpan()?.name).toBe('cli-x');
    outer.end(2, { signal: 'SIGINT' });
    expect(currentSpan()).toBeUndefined();
    const [w, c] = lines();
    expect(w).toMatchObject({
      kind: 'wait',
      waitedOn: 'a free slot',
      durationMs: 3000,
      exitCode: 0,
      taskId: 'AISDLC-9',
    });
    expect(c).toMatchObject({ kind: 'command', exitCode: 2, signal: 'SIGINT', durationMs: 3000 });
    expect(c?.waitedOn).toBeUndefined();
  });

  it('a wait that never waited records waitedOn none', () => {
    startSpan('wait', 'verify-slot', { file, env: {} }).end(0);
    expect(lines()[0]?.waitedOn).toBe('none');
  });
});

describe('slow notice (AC 4)', () => {
  it('prints the current span and elapsed time past the threshold, then every 60 s', () => {
    vi.useFakeTimers();
    let t = 0;
    const now = () => t;
    const out: string[] = [];
    const root = startSpan('command', 'cli-file', { sub: 'task', now, startMs: 0, file: null });
    const stop = startSlowWatch({ thresholdMs: 120_000, now, write: (l) => out.push(l) });
    t = 119_000;
    vi.advanceTimersByTime(119_000);
    expect(out).toEqual([]);
    t = 120_000;
    vi.advanceTimersByTime(1_000);
    expect(out).toEqual([
      '[ai-sdlc-timing] command cli-file task still running after 2m 0s; current span: command cli-file task (2m 0s)',
    ]);
    const wait = startSpan('wait', 'verify-slot', { now, file: null });
    wait.setDetail('a free slot');
    t = 180_000;
    vi.advanceTimersByTime(60_000);
    expect(out[1]).toBe(
      '[ai-sdlc-timing] command cli-file task still running after 3m 0s; current span: wait verify-slot on a free slot (1m 0s)',
    );
    wait.end(0);
    root.end(0);
    vi.advanceTimersByTime(60_000);
    expect(out).toHaveLength(2); // nothing in flight: no line
    stop();
    vi.advanceTimersByTime(600_000);
    expect(out).toHaveLength(2);
  });

  it('writes to stderr by default', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const s = startSpan('command', 'cli-y', { file: null });
    const stop = startSlowWatch({ thresholdMs: 10 });
    vi.advanceTimersByTime(10);
    expect(String(spy.mock.calls[0]?.[0])).toContain('still running');
    stop();
    s.end(0);
    spy.mockRestore();
  });
});

class FakeProc extends EventEmitter {
  exits: number[] = [];
  exit(code?: number) {
    this.exits.push(code ?? 0);
    this.emit('exit', code ?? 0);
  }
}

describe('command span of a bin (AC 1)', () => {
  const env = () => ({ AI_SDLC_TIMINGS_FILE: file, AI_SDLC_SLOW_SPAN_SECONDS: '0' });

  it('names the command and only a plain subcommand word', () => {
    expect(commandName('/x/pipeline-cli/bin/cli-file.mjs')).toBe('cli-file');
    expect(commandName(undefined)).toBeUndefined();
    expect(subcommand(['node', 'cli', 'task', '--pr'])).toBe('task');
    expect(subcommand(['node', 'cli', '--json'])).toBeUndefined();
    expect(subcommand(['node', 'cli', 'ghp_secretsecretsecret'])).toBeUndefined();
    expect(subcommand(['node', 'cli', 'Some Title'])).toBeUndefined();
  });

  it('appends one span with duration and exit code on exit and on failure', () => {
    for (const code of [0, 2]) {
      const p = new FakeProc();
      let t = 100;
      installCommandSpan(p, {
        argv: ['node', '/b/cli-file.mjs', 'task', '--title', 'secret words'],
        env: env(),
        startMs: 100,
        now: () => t,
      });
      t = 1_600;
      p.emit('exit', code);
    }
    const [ok, failed] = lines();
    expect(ok).toMatchObject({
      kind: 'command',
      name: 'cli-file',
      sub: 'task',
      durationMs: 1500,
      exitCode: 0,
    });
    expect(failed?.exitCode).toBe(2);
    expect(readFileSync(file, 'utf8')).not.toContain('secret words');
  });

  it('on SIGINT with no other handler exits 130 and records the signal', () => {
    const p = new FakeProc();
    installCommandSpan(p, { argv: ['node', 'cli-hierarchy.mjs', 'tick'], env: env() });
    p.emit('SIGINT');
    expect(p.exits).toEqual([130]);
    expect(lines()[0]).toMatchObject({ exitCode: 130, signal: 'SIGINT', sub: 'tick' });
  });

  it('leaves a command-owned SIGTERM handler in charge', () => {
    const p = new FakeProc();
    installCommandSpan(p, { argv: ['node', 'cli-x.mjs'], env: env() });
    p.on('SIGTERM', () => {});
    p.emit('SIGTERM');
    expect(p.exits).toEqual([]);
    p.emit('exit', 0);
    expect(lines()[0]).toMatchObject({ exitCode: 0, signal: 'SIGTERM' });
  });

  it('does nothing without a script name and watches only bounded commands', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const quiet = { AI_SDLC_TIMINGS_FILE: file, AI_SDLC_SLOW_SPAN_SECONDS: '1' };
    installCommandSpan(new FakeProc(), { argv: ['node'], env: quiet });
    const long = new FakeProc();
    installCommandSpan(long, {
      argv: ['node', 'cli-tui.mjs'],
      env: quiet,
      write: (l) => out.push(l),
    });
    vi.advanceTimersByTime(5_000);
    expect(out).toEqual([]);
    long.emit('exit', 0);
    const slow = new FakeProc();
    installCommandSpan(slow, {
      argv: ['node', 'cli-pr.mjs'],
      env: quiet,
      write: (l) => out.push(l),
    });
    vi.advanceTimersByTime(1_000);
    expect(out[0]).toContain('[ai-sdlc-timing] command cli-pr still running');
    slow.emit('exit', 0);
    vi.advanceTimersByTime(120_000);
    expect(out).toHaveLength(1);
  });

  it('every bin imports the command span first', () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
    const missing = readdirSync(bin)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => {
        const text = readFileSync(path.join(bin, f), 'utf8');
        const first = /^import .*$/m.exec(text)?.[0];
        return first !== "import '../dist/cli/command-span.js';";
      });
    expect(missing).toEqual([]);
  });
});

describe('report (AC 5) and status slow list (AC 6)', () => {
  const at = (min: number) =>
    new Date(Date.parse('2026-11-25T12:00:00.000Z') - min * 60_000).toISOString();

  it('reports p50, p95 and max per command, gate and wait, and the slowest spans', () => {
    const spans = [
      ...[1, 2, 3, 4, 100].map((s) =>
        span({ name: 'cli-file', sub: 'task', durationMs: s * 1000, startedAt: at(30) }),
      ),
      span({ kind: 'gate', name: 'typecheck', durationMs: 40_000, exitCode: 1, startedAt: at(10) }),
      span({
        kind: 'wait',
        name: 'verify-slot',
        waitedOn: 'a free slot',
        durationMs: 7_000,
        startedAt: at(5),
      }),
      span({ name: 'old', durationMs: 1, startedAt: at(60 * 24 * 30) }),
    ];
    const r = timingsReport(spans, new Date('2026-11-25T12:00:00.000Z'), 7 * 86_400_000, 2);
    expect(r.groups).toEqual([
      {
        key: 'command cli-file task',
        kind: 'command',
        count: 5,
        failures: 0,
        p50Ms: 3000,
        p95Ms: 100_000,
        maxMs: 100_000,
      },
      {
        key: 'gate typecheck',
        kind: 'gate',
        count: 1,
        failures: 1,
        p50Ms: 40_000,
        p95Ms: 40_000,
        maxMs: 40_000,
      },
      {
        key: 'wait verify-slot',
        kind: 'wait',
        count: 1,
        failures: 0,
        p50Ms: 7000,
        p95Ms: 7000,
        maxMs: 7000,
      },
    ]);
    expect(r.slowest.map((s) => s.durationMs)).toEqual([100_000, 40_000]);
    const text = formatTimingsReport(r);
    expect(text).toContain('command cli-file task');
    expect(text).toContain('1m 40s');
    expect(text).toContain('slowest spans:');
    expect(text).toContain('gate typecheck, 40s, exit 1');
    expect(formatTimingsReport(timingsReport([], new Date(), 1000))).toContain('no spans recorded');
  });

  it('lists spans over the threshold from the last hour, not long-running ones', () => {
    const now = new Date('2026-11-25T12:00:00.000Z');
    const spans = [
      span({
        name: 'cli-file',
        sub: 'task',
        durationMs: 898_000,
        startedAt: at(20),
        taskId: 'AISDLC-1',
      }),
      span({
        kind: 'wait',
        name: 'verify-slot',
        waitedOn: 'a free slot',
        durationMs: 200_000,
        signal: 'SIGINT',
        startedAt: at(10),
      }),
      span({ name: 'cli-file', durationMs: 5_000, startedAt: at(10) }),
      span({ name: 'cli-pr', durationMs: 900_000, startedAt: at(120) }),
      span({ name: 'cli-tui', durationMs: 900_000, startedAt: at(20) }),
      span({ name: 'cli-hierarchy', sub: 'webhook', durationMs: 900_000, startedAt: at(20) }),
    ];
    const slow = recentSlowSpans(spans, now, 120_000);
    expect(slow.map(spanKey)).toEqual(['command cli-file task', 'wait verify-slot']);
    expect(recentSlowSpans(spans, now, 0)).toEqual([]);
    const out = formatSlowSpans(slow, 120_000);
    expect(out[0]).toBe('slow spans in the last hour (over 2m 0s): 2');
    expect(out[1]).toContain('command cli-file task, 14m 58s, exit 0');
    expect(out[1]).toContain('task AISDLC-1');
    expect(out[2]).toContain('wait verify-slot on a free slot, 3m 20s, SIGINT');
    expect(formatSlowSpans([], 1)).toEqual([]);
  });

  it('percentile and duration helpers', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(formatDuration(90_061_000)).toBe('1d 1h');
    expect(formatDuration(3_660_000)).toBe('1h 1m');
  });
});
