import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import { loadScenario, parseScenario, runDemo, type DemoDeps } from './demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.resolve(here, '../../demo/scenarios/context-pressure.json');

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'demo-'));
}

interface Harness {
  deps: DemoDeps;
  calls: string[][];
  errLines: string[];
}

function harness(over: Partial<DemoDeps> & { prStates?: string[] } = {}): Harness {
  const { prStates = ['OPEN', 'MERGED'], ...rest } = over;
  const calls: string[][] = [];
  const errLines: string[] = [];
  let clock = 0;
  let decision = 0;
  let views = 0;
  const ok = (stdout = ''): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout,
    stderr: '',
  });
  const run: DemoDeps['run'] = (file, args) => {
    const a =
      file === 'node' ? [path.basename(String(args[0])), ...args.slice(1)] : [file, ...args];
    calls.push(a);
    if (a[0] === 'cli-decisions.mjs' && a[1] === 'add') {
      return ok(`decision added: DEC-${String(++decision).padStart(4, '0')}\n`);
    }
    if (a[0] === 'cli-dispatch.mjs') return ok('[{"taskId":"AISDLC-1066","state":"inflight"}]');
    if (a[0] === 'gh' && a[2] === 'list') return ok('[{"number":77}]');
    if (a[0] === 'gh' && a[2] === 'view') {
      const state = prStates[Math.min(views++, prStates.length - 1)];
      return ok(
        JSON.stringify({
          state,
          mergeCommit: state === 'MERGED' ? { oid: 'abcdef1234567' } : null,
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        }),
      );
    }
    return ok();
  };
  const deps: DemoDeps = {
    run,
    out: () => {},
    err: (l) => errLines.push(l),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    which: () => true,
    idleExecutors: () => 1,
    taskState: () => ({ status: 'To Do', dispatchable: true }),
    cleanCheckout: () => true,
    record: () => 0,
    binDir: '/bin-dir',
    cwd: '/repo',
    media: { run: () => ({ status: 0, stdout: '', stderr: '' }), out: () => {}, err: () => {} },
    ...rest,
  };
  return { deps, calls, errLines };
}

describe('scenario loader (AISDLC-1079)', () => {
  it('validates the shipped scenario', () => {
    const s = loadScenario(SCENARIO);
    expect(s.task).toBe('AISDLC-1066');
    expect(s.decisions.length).toBeGreaterThanOrEqual(2);
  });

  it.each(['request', 'task', 'decisions', 'brief', 'timeoutMinutes', 'pollSeconds'])(
    'rejects a scenario missing %s, naming the field',
    (field) => {
      const raw = JSON.parse(readFileSync(SCENARIO, 'utf-8')) as Record<string, unknown>;
      delete raw[field];
      expect(() => parseScenario(JSON.stringify(raw))).toThrow(field);
    },
  );

  it('rejects an answer that is not an option, bad JSON and a missing file', () => {
    const raw = JSON.parse(readFileSync(SCENARIO, 'utf-8')) as {
      decisions: { answer: string }[];
    };
    raw.decisions[0]!.answer = 'nope';
    expect(() => parseScenario(JSON.stringify(raw))).toThrow('decisions[0].answer');
    expect(() => parseScenario('{')).toThrow('not valid JSON');
    expect(() => loadScenario('/no/such/file.json')).toThrow('not found');
  });
});

describe('demo run (AISDLC-1079)', () => {
  it.each(['asciinema', 'agg', 'ffmpeg'])(
    'refuses with one line when %s is missing',
    async (tool) => {
      const h = harness({ which: (t) => t !== tool });
      const code = await runDemo('run', { scenario: SCENARIO, out: tmp() }, h.deps);
      expect(code).toBe(1);
      expect(h.errLines).toEqual([`cli-hierarchy demo: ${tool} is not on PATH`]);
    },
  );

  it('refuses without an idle executor, a To Do task or a clean checkout', async () => {
    const h = harness({
      idleExecutors: () => 0,
      taskState: () => ({ status: 'Done', dispatchable: true }),
      cleanCheckout: () => false,
    });
    expect(await runDemo('run', { scenario: SCENARIO, out: tmp() }, h.deps)).toBe(1);
    expect(h.errLines).toHaveLength(3);
  });

  it('requires flags and a valid scenario, and rejects unknown stages', async () => {
    const h = harness();
    expect(await runDemo('run', {}, h.deps)).toBe(2);
    expect(await runDemo('run', { scenario: '/missing.json', out: tmp() }, h.deps)).toBe(2);
    expect(await runDemo('bogus', {}, h.deps)).toBe(2);
    expect(await runDemo(undefined, {}, h.deps)).toBe(2);
  });

  it('executes the commands in order and writes six beats', async () => {
    const out = tmp();
    const h = harness();
    expect(await runDemo('run', { scenario: SCENARIO, out, inner: 'true' }, h.deps)).toBe(0);
    const verbs = h.calls.map((c) => `${c[0]} ${c[1]}`);
    expect(verbs.slice(0, 3)).toEqual(Array(3).fill('cli-decisions.mjs add'));
    expect(verbs[3]).toBe('cli-decisions.mjs list');
    expect(verbs.slice(4, 7)).toEqual(Array(3).fill('cli-decisions.mjs answer'));
    expect(h.calls[7]).toEqual([
      'cli-hierarchy.mjs',
      'brief',
      '--tasks',
      'AISDLC-1066',
      '--notify',
    ]);
    expect(verbs.some((v) => v === 'gh pr')).toBe(true);
    const beats = JSON.parse(readFileSync(path.join(out, 'beats.json'), 'utf-8')) as {
      prNumber: number;
      mergeSha: string;
      beats: { name: string; elapsedSeconds: number }[];
    };
    expect(beats.beats.map((b) => b.name)).toEqual([
      'request',
      'questions',
      'answers',
      'brief',
      'pr-opened',
      'pr-landed',
    ]);
    expect(beats.beats.every((b) => typeof b.elapsedSeconds === 'number')).toBe(true);
    expect(beats.prNumber).toBe(77);
    expect(beats.mergeSha).toBe('abcdef1234567');
  });

  it('fails the run when a command fails or prints no decision id', async () => {
    const h = harness({ run: () => ({ status: 3, stdout: '', stderr: 'boom' }) });
    expect(await runDemo('run', { scenario: SCENARIO, out: tmp(), inner: 'true' }, h.deps)).toBe(1);
    const h2 = harness({ run: () => ({ status: 0, stdout: 'no id', stderr: '' }) });
    expect(await runDemo('run', { scenario: SCENARIO, out: tmp(), inner: 'true' }, h2.deps)).toBe(
      1,
    );
  });

  it('exits non-zero on timeout, keeps the cast and renders nothing', async () => {
    const out = tmp();
    const h = harness({ prStates: ['OPEN'] });
    // the recorder stub runs the inner run, as asciinema would
    h.deps.record = () => {
      writeFileSync(path.join(out, 'hierarchy.cast'), '{"version":2}\n');
      return 1;
    };
    expect(await runDemo('run', { scenario: SCENARIO, out }, h.deps)).toBe(1);
    expect(existsSync(path.join(out, 'hierarchy.cast'))).toBe(true);
    expect(existsSync(path.join(out, 'hierarchy.mp4'))).toBe(false);
    const timeout = harness({ prStates: ['OPEN'] });
    expect(
      await runDemo('run', { scenario: SCENARIO, out: tmp(), inner: 'true' }, timeout.deps),
    ).toBe(1);
    expect(timeout.errLines.join('\n')).toContain('did not merge within 90 minutes');
  });

  it('records under asciinema and accepts a finished run', async () => {
    const out = tmp();
    const h = harness();
    let args: string[] = [];
    h.deps.record = (a) => {
      args = a;
      return 0;
    };
    // no beats.json yet: the recorded run did not finish
    expect(await runDemo('run', { scenario: SCENARIO, out }, h.deps)).toBe(1);
    await runDemo('run', { scenario: SCENARIO, out, inner: 'true' }, h.deps);
    expect(await runDemo('run', { scenario: SCENARIO, out }, h.deps)).toBe(0);
    expect(args.slice(0, 8)).toEqual([
      'rec',
      '--overwrite',
      '--idle-time-limit',
      '2',
      '--cols',
      '120',
      '--rows',
      '30',
    ]);
  });

  it('runs all three stages and stops at the first failure', async () => {
    const out = tmp();
    const h = harness();
    h.deps.record = () => 1;
    expect(await runDemo(undefined, { scenario: SCENARIO, out }, h.deps)).toBe(1);
    expect(existsSync(path.join(out, 'hierarchy.cut.cast'))).toBe(false);
    // run passes, cut fails (no cast file)
    h.deps.record = () => 0;
    await runDemo('run', { scenario: SCENARIO, out, inner: 'true' }, h.deps);
    expect(await runDemo(undefined, { scenario: SCENARIO, out }, h.deps)).toBe(1);
    expect(h.errLines.join('\n')).toContain('demo cut');
  });

  it('is reachable through runHierarchyCli', async () => {
    const h = harness({ which: () => false });
    const code = await runHierarchyCli(
      ['demo', 'run', '--scenario', SCENARIO, '--out', tmp()],
      {},
      { demo: h.deps },
    );
    expect(code).toBe(1);
    expect(h.errLines[0]).toContain('asciinema is not on PATH');
  });
});
