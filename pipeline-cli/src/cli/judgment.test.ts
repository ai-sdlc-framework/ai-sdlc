/**
 * cli-judgment tests. Hermetic: a fake provider, temp directories for every
 * file the CLI writes, no network and nothing written into the repository.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  createJudgmentLogSink,
  evaluateJudgment,
  resolveJudgmentConfig,
  type JudgmentDefinition,
  type JudgmentProvider,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';
import { runJudgmentCli, type JudgmentCliDeps } from './judgment.js';
import {
  parseCorpus,
  parseSweep,
  sanitizePathComponent,
  reportFileName,
  writeReportFile,
  percentile,
} from '../judgment/eval.js';

interface In {
  p: number;
}
type Dec = { ok: boolean };

function makeDef(over: Partial<JudgmentDefinition<In, Dec>> = {}): JudgmentDefinition<In, Dec> {
  return {
    id: 'test.judgment',
    version: 1,
    egressClass: 'work-item-text',
    direction: 'tighten-only',
    riskClass: 'seam',
    buildState: (i: In) => ({ p: i.p }),
    questions: () => ({ ok: { type: 'noul', instructions: 'Is it fine?' } }),
    compose: (answers, _input, t) => {
      const a = answers.ok as { probability: number };
      if (a.probability >= (t.pass ?? 0.85)) return { kind: 'act', decision: { ok: true } };
      if (a.probability <= (t.fail ?? 0.15)) {
        return { kind: 'escalate', to: 'operator', reason: 'low' };
      }
      return { kind: 'abstain', reason: 'unsure' };
    },
    agrees: (d, label) => d.ok === label,
    ...over,
  } as JudgmentDefinition<In, Dec>;
}

function makeFake(): FakeJudgmentProvider {
  const fake = new FakeJudgmentProvider();
  fake.script('ok', (req) => ({
    type: 'noul',
    probability: (req.state as { p: number }).p,
  }));
  return fake;
}

const KEY = 'fake@fake-1';
function makeConfig(over: Record<string, unknown> = {}): ResolvedJudgmentConfig {
  return resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      judgments: { 'test.judgment': { thresholds: { [KEY]: { pass: 0.85, fail: 0.15 } } } },
      ...over,
    },
  });
}

let tmp: string;
let outText: string;
let errText: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-judgment-'));
  outText = '';
  errText = '';
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function deps(over: Partial<JudgmentCliDeps> = {}): JudgmentCliDeps {
  return {
    out: (t) => (outText += t),
    err: (t) => (errText += t),
    cwd: tmp,
    env: {},
    now: () => new Date('2026-10-14T12:00:00Z'),
    loadConfig: () => makeConfig(),
    ...over,
  };
}

const run = (argv: string[], d: JudgmentCliDeps): Promise<number> =>
  runJudgmentCli([...argv, '--artifacts-dir', join(tmp, 'art')], d);

function writeCorpus(rows: Array<{ p: number; label: unknown }>, name = 'corpus.jsonl'): string {
  const path = join(tmp, name);
  writeFileSync(
    path,
    rows.map((r) => JSON.stringify({ input: { p: r.p }, label: r.label })).join('\n'),
  );
  return path;
}

// Hand-computed: act = 0.95,0.9,0.9,0.92,0.97,0.99 (labels T,T,T,F,T,T -> 5/6),
// escalate = 0.1, abstain = 0.2,0.5,0.6.
const CASE = [
  { p: 0.95, label: true },
  { p: 0.9, label: true },
  { p: 0.9001, label: true },
  { p: 0.92, label: false },
  { p: 0.97, label: true },
  { p: 0.99, label: true },
  { p: 0.1, label: false },
  { p: 0.2, label: false },
  { p: 0.5, label: true },
  { p: 0.6, label: false },
];

describe('help', () => {
  it('lists the five subcommands', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      await runJudgmentCli(['--help'], deps());
    } finally {
      console.log = orig;
    }
    const text = lines.join('\n');
    for (const c of ['doctor', 'list', 'ask', 'eval', 'replay']) expect(text).toContain(c);
  });

  it('exits 2 on a missing command', async () => {
    const code = await runJudgmentCli([], deps());
    expect(code).toBe(2);
    expect(errText).toContain('Choose a command');
  });
});

describe('eval', () => {
  it('reports hand-computed n, band shares, precision and the promotion snippet', async () => {
    const fake = makeFake();
    const corpus = writeCorpus(CASE);
    const code = await run(
      ['eval', 'test.judgment', '--corpus', corpus],
      deps({ getProvider: () => fake, getDefinition: () => makeDef() }),
    );
    expect(code).toBe(0);
    expect(fake.requests).toHaveLength(10);
    const dir = join(tmp, '.ai-sdlc', 'judgment-evals');
    const files = readdirSync(dir);
    expect(files).toEqual(['test.judgment-fake-fake-1-2026-10-14.json']);
    const report = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(report.n).toBe(10);
    expect(report.counts).toEqual({ act: 6, escalate: 1, abstain: 3 });
    expect(report.shares).toEqual({ act: 0.6, escalate: 0.1, abstain: 0.3 });
    expect(report.actBandPrecision).toBe(0.8333);
    expect(report.confusion.rows['act:{"ok":true}']).toEqual({ true: 5, false: 1 });
    expect(report.promotion.met).toBe(false);
    expect(outText).toContain('n: 10');
    expect(outText).toContain('actBandPrecision: 0.8333');
    expect(outText).toContain('NOT MET');
    expect(outText).toContain('seam bar');
    expect(outText).toContain(
      'evalReport: .ai-sdlc/judgment-evals/test.judgment-fake-fake-1-2026-10-14.json',
    );
    // the repository's own .ai-sdlc was never touched
    expect(existsSync(join(process.cwd(), '.ai-sdlc', 'judgment-evals', files[0]))).toBe(false);
  });

  it('sweeps without extra provider calls', async () => {
    const fake = makeFake();
    const corpus = writeCorpus(CASE);
    const code = await run(
      ['eval', 'test.judgment', '--corpus', corpus, '--sweep', 'pass=0.5:0.9:0.1'],
      deps({ getProvider: () => fake, getDefinition: () => makeDef() }),
    );
    expect(code).toBe(0);
    expect(fake.requests).toHaveLength(10);
    const report = JSON.parse(
      readFileSync(
        join(
          tmp,
          '.ai-sdlc',
          'judgment-evals',
          readdirSync(join(tmp, '.ai-sdlc', 'judgment-evals'))[0],
        ),
        'utf8',
      ),
    );
    expect(report.sweep.rows.map((r: { value: number }) => r.value)).toEqual([
      0.5, 0.6, 0.7, 0.8, 0.9,
    ]);
    // at pass=0.9 the 0.9 item is act (>=), 0.9001 act too: act = 0.95,0.9,0.9001,0.92,0.97,0.99
    expect(report.sweep.rows[4].counts.act).toBe(6);
    // at pass=0.5 the 0.5 and 0.6 items join the act band
    expect(report.sweep.rows[0].counts.act).toBe(8);
    expect(outText).toContain('sweep pass:');
  });

  it('reuses the cache on a second run', async () => {
    const fake = makeFake();
    const corpus = writeCorpus(CASE);
    const d = deps({ getProvider: () => fake, getDefinition: () => makeDef() });
    await run(['eval', 'test.judgment', '--corpus', corpus], d);
    await run(['eval', 'test.judgment', '--corpus', corpus], d);
    expect(fake.requests).toHaveLength(10);
    expect(outText).toContain('10 cache hits');
  });

  it('states met for a seam definition at the bar and not met for relax', async () => {
    const rows = Array.from({ length: 50 }, () => ({ p: 0.95, label: true }));
    const corpus = writeCorpus(rows);
    for (const [risk, expected] of [
      ['seam', 'MET'],
      ['tighten', 'MET'],
      ['relax', 'MET'],
    ] as const) {
      outText = '';
      const fake = makeFake();
      await run(
        ['eval', 'test.judgment', '--corpus', corpus],
        deps({
          getProvider: () => fake,
          getDefinition: () => makeDef({ riskClass: risk }),
          cache: undefined,
        } as Partial<JudgmentCliDeps>),
      );
      expect(outText).toContain(`${expected}: ${risk} bar`);
      expect(outText).not.toContain('NOT MET');
      expect(outText).toContain(
        risk === 'relax' ? 'findings ledger' : 'operator-override path is also allowed',
      );
    }
  });

  it('applies the 95% relax bar', async () => {
    // 50 acts, 47 agreeing: precision 0.94 clears 0.9 but not 0.95
    const rows = Array.from({ length: 50 }, (_, i) => ({ p: 0.95 + i * 0.0001, label: i >= 3 }));
    const corpus = writeCorpus(rows);
    const fake = makeFake();
    await run(
      ['eval', 'test.judgment', '--corpus', corpus],
      deps({ getProvider: () => fake, getDefinition: () => makeDef({ riskClass: 'relax' }) }),
    );
    expect(outText).toContain('NOT MET: relax bar');
    outText = '';
    await run(
      ['eval', 'test.judgment', '--corpus', corpus],
      deps({ getProvider: () => fake, getDefinition: () => makeDef({ riskClass: 'tighten' }) }),
    );
    expect(outText).toContain('MET: tighten bar');
    expect(outText).not.toContain('NOT MET');
  });

  it('fails when the definition has no agrees()', async () => {
    const corpus = writeCorpus(CASE);
    const code = await run(
      ['eval', 'test.judgment', '--corpus', corpus],
      deps({ getDefinition: () => makeDef({ agrees: undefined }) }),
    );
    expect(code).toBe(1);
    expect(errText).toContain('no agrees()');
  });

  it('fails on an unreadable corpus and names the line of a malformed one', async () => {
    const d = deps({ getProvider: () => makeFake(), getDefinition: () => makeDef() });
    expect(await run(['eval', 'test.judgment', '--corpus', join(tmp, 'missing.jsonl')], d)).toBe(1);
    expect(errText).toContain('cannot read corpus');
    errText = '';
    const bad = join(tmp, 'bad.jsonl');
    writeFileSync(bad, `${JSON.stringify({ input: { p: 1 }, label: true })}\n\n{not json}\n`);
    expect(await run(['eval', 'test.judgment', '--corpus', bad], d)).toBe(1);
    expect(errText).toContain('corpus line 3 is not valid JSON');
  });

  it('fails on an unknown judgment and bad flags', async () => {
    const corpus = writeCorpus(CASE);
    const d = deps({
      getProvider: () => makeFake(),
      getDefinition: () => undefined,
      listDefinitions: () => [makeDef()],
    });
    expect(await run(['eval', 'nope', '--corpus', corpus], d)).toBe(1);
    expect(errText).toContain("unknown judgment 'nope'");
    const d2 = deps({ getProvider: () => makeFake(), getDefinition: () => makeDef() });
    errText = '';
    expect(
      await run(['eval', 'test.judgment', '--corpus', corpus, '--sweep', 'pass=0.1:0.5:0'], d2),
    ).toBe(1);
    expect(errText).toContain('step must be greater than 0');
    errText = '';
    expect(
      await run(['eval', 'test.judgment', '--corpus', corpus, '--threshold', 'pass=abc'], d2),
    ).toBe(1);
    expect(errText).toContain('must be finite');
  });

  it('exits zero and notes the egress rule when egress is not allowed', async () => {
    const corpus = writeCorpus(CASE.slice(0, 2));
    const fake = makeFake();
    const code = await run(
      ['eval', 'test.judgment', '--corpus', corpus],
      deps({
        getProvider: () => fake,
        getDefinition: () => makeDef({ egressClass: 'code-diff' }),
      }),
    );
    expect(code).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(outText).toContain('spec.egress.allow');
  });

  it('exits zero with abstains when the layer is disabled', async () => {
    const corpus = writeCorpus(CASE.slice(0, 2));
    const code = await run(
      ['eval', 'test.judgment', '--corpus', corpus],
      deps({ loadConfig: () => resolveJudgmentConfig({}), getDefinition: () => makeDef() }),
    );
    expect(code).toBe(0);
    expect(outText).toContain('disabled');
    expect(outText).toContain('no items in the act band');
  });

  it('applies --threshold overrides', async () => {
    const fake = makeFake();
    const corpus = writeCorpus(CASE);
    await run(
      ['eval', 'test.judgment', '--corpus', corpus, '--threshold', 'pass=0.5'],
      deps({ getProvider: () => fake, getDefinition: () => makeDef() }),
    );
    expect(outText).toContain('act 8');
  });
});

describe('eval helpers', () => {
  it('parses corpus lines strictly', () => {
    expect(() => parseCorpus('[1]')).toThrow('line 1 must be a JSON object');
    expect(() => parseCorpus('{"input":1}')).toThrow('"input" and "label"');
    expect(parseCorpus('\n{"input":1,"label":null}\n')).toEqual([{ input: 1, label: null }]);
  });

  it('validates sweep specs', () => {
    expect(() => parseSweep('x')).toThrow('must look like');
    expect(() => parseSweep('a b=0:1:0.1')).toThrow('invalid');
    expect(() => parseSweep('p=0:NaN:1')).toThrow('finite');
    expect(() => parseSweep('p=1:0:0.1')).toThrow('must not exceed');
    expect(() => parseSweep('p=0:1:0.00001')).toThrow('more than');
    expect(parseSweep('p=0:1:0.25')).toEqual({ name: 'p', from: 0, to: 1, step: 0.25 });
  });

  it('keeps report names inside the evals directory', () => {
    expect(sanitizePathComponent('../../etc')).not.toMatch(/[/\\]|\.\./);
    expect(sanitizePathComponent('..')).toBe('_');
    expect(sanitizePathComponent('')).toBe('_');
    const name = reportFileName({
      id: '../x',
      provider: 'a/b',
      model: '..\\m',
      date: '2026-01-01',
    });
    expect(name).not.toMatch(/[/\\]/);
    const path = writeReportFile(tmp, name, { ok: true });
    expect(existsSync(join(tmp, path))).toBe(true);
  });

  it('refuses to write through a symlink', () => {
    const dir = join(tmp, '.ai-sdlc', 'judgment-evals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tmp, 'target.json'), '{}');
    symlinkSync(join(tmp, 'target.json'), join(dir, 'r.json'));
    expect(() => writeReportFile(tmp, 'r.json', {})).toThrow('symlink');
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});

describe('ask', () => {
  it('prints answers, outcome and thresholds', async () => {
    const input = join(tmp, 'in.json');
    writeFileSync(input, JSON.stringify({ p: 0.93 }));
    const code = await run(
      ['ask', 'test.judgment', '--input', input],
      deps({ getProvider: () => makeFake(), getDefinition: () => makeDef() }),
    );
    expect(code).toBe(0);
    const printed = JSON.parse(outText);
    expect(printed.answers.ok).toEqual({ type: 'noul', probability: 0.93 });
    expect(printed.outcome).toEqual({ kind: 'act', decision: { ok: true } });
    expect(printed.thresholds).toEqual({ pass: 0.85, fail: 0.15 });
  });

  it('refuses a definition whose egress class is not allowed and names the config key', async () => {
    const input = join(tmp, 'in.json');
    writeFileSync(input, JSON.stringify({ p: 0.93 }));
    const fake = makeFake();
    const code = await run(
      ['ask', 'test.judgment', '--input', input],
      deps({
        getProvider: () => fake,
        getDefinition: () => makeDef({ egressClass: 'agent-output' }),
      }),
    );
    expect(code).toBe(1);
    expect(errText).toContain('spec.egress.allow');
    expect(errText).toContain("'agent-output'");
    expect(fake.requests).toHaveLength(0);
  });

  it('fails clearly for no provider, bad input and provider errors', async () => {
    const input = join(tmp, 'in.json');
    writeFileSync(input, JSON.stringify({ p: 0.93 }));
    expect(
      await run(
        ['ask', 'test.judgment', '--input', input],
        deps({ loadConfig: () => resolveJudgmentConfig({}), getDefinition: () => makeDef() }),
      ),
    ).toBe(1);
    expect(errText).toContain('no judgment provider');
    errText = '';
    writeFileSync(input, '{bad');
    expect(
      await run(
        ['ask', 'test.judgment', '--input', input],
        deps({ getProvider: () => makeFake(), getDefinition: () => makeDef() }),
      ),
    ).toBe(1);
    expect(errText).toContain('as JSON');
    errText = '';
    writeFileSync(input, '{"p":0.9}');
    const failing = makeFake().failWith('network');
    expect(
      await run(
        ['ask', 'test.judgment', '--input', input],
        deps({ getProvider: () => failing, getDefinition: () => makeDef() }),
      ),
    ).toBe(1);
    expect(errText).toContain('provider-error');
  });
});

describe('doctor', () => {
  it('reports state without printing the key', async () => {
    const secret = 'sk-very-secret-value';
    const fake = makeFake();
    const code = await run(
      ['doctor'],
      deps({ env: { FAKE_JUDGMENT_API_KEY: secret }, getProvider: () => fake }),
    );
    expect(code).toBe(0);
    expect(outText).toContain('judgment layer: enabled');
    expect(outText).toContain('provider: fake');
    expect(outText).toContain('FAKE_JUDGMENT_API_KEY): present');
    expect(outText).toContain('model: fake-1 (pinned)');
    expect(outText).not.toContain(secret);
  });

  it('reports a disabled layer, a missing key and an unpinned model', async () => {
    await run(['doctor'], deps({ loadConfig: () => resolveJudgmentConfig({}) }));
    expect(outText).toContain('judgment layer: disabled');
    expect(outText).toContain('credential: missing');
    outText = '';
    await run(
      ['doctor'],
      deps({
        loadConfig: () => makeConfig({ model: 'fake-latest' }),
        getProvider: () => makeFake(),
      }),
    );
    expect(outText).toContain('credential (FAKE_JUDGMENT_API_KEY): missing');
    expect(outText).toContain('not pinned');
  });

  it('--live reports the model version and latency', async () => {
    const code = await run(
      ['doctor', '--live'],
      deps({
        env: { FAKE_JUDGMENT_API_KEY: 'sk-abcdef' },
        getProvider: () => makeFake().script('ok', { type: 'noul', probability: 1 }),
      }),
    );
    expect(code).toBe(0);
    expect(outText).toMatch(/live: ok, modelVersion fake-1, latency \d+ms/);
  });

  it('--live never leaks the key from a provider error', async () => {
    const secret = 'sk-leaky-secret-9';
    const leaky = Object.assign(Object.create(makeFake()) as JudgmentProvider, {
      evaluate: async () => {
        throw new Error(`upstream said bad key ${secret}`);
      },
    });
    const code = await run(
      ['doctor', '--live'],
      deps({ env: { FAKE_JUDGMENT_API_KEY: secret }, getProvider: () => leaky }),
    );
    expect(code).toBe(1);
    expect(errText).toContain('[redacted]');
    expect(errText + outText).not.toContain(secret);
  });

  it('--live without a key is reported, not attempted', async () => {
    const fake = makeFake();
    const code = await run(['doctor', '--live'], deps({ getProvider: () => fake }));
    expect(code).toBe(1);
    expect(errText).toContain('live check skipped');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('list', () => {
  it('prints every definition with configured and effective mode', async () => {
    const defs = [
      makeDef(),
      makeDef({ id: 'b.enforced', riskClass: 'relax', direction: 'bidirectional' }),
      makeDef({ id: 'c.egress', egressClass: 'code-diff' }),
    ];
    const config = makeConfig({
      judgments: {
        'b.enforced': { mode: 'enforce', thresholds: { [KEY]: { pass: 0.9 } } },
        'c.egress': { mode: 'shadow', thresholds: {} },
      },
    });
    const code = await run(
      ['list'],
      deps({
        loadConfig: () => config,
        getProvider: () => makeFake(),
        listDefinitions: () => defs,
      }),
    );
    expect(code).toBe(0);
    expect(outText).toMatch(
      /test\.judgment\s+1\s+seam\s+tighten-only\s+work-item-text\s+shadow\s+shadow/,
    );
    expect(outText).toMatch(
      /b\.enforced\s+1\s+relax\s+bidirectional\s+work-item-text\s+enforce\s+shadow \(no-promotion\)/,
    );
    expect(outText).toMatch(/c\.egress .*shadow\s+off \(egress-not-permitted\)/);
  });

  it('handles an empty registry and a disabled layer', async () => {
    await run(['list'], deps({ listDefinitions: () => [] }));
    expect(outText).toContain('no judgments registered');
    outText = '';
    await run(
      ['list'],
      deps({ loadConfig: () => resolveJudgmentConfig({}), listDefinitions: () => [makeDef()] }),
    );
    expect(outText).toMatch(/off\s+off/);
    outText = '';
    await run(['list'], deps({ listDefinitions: () => [makeDef()], getProvider: () => undefined }));
    expect(outText).toContain('off (provider-unavailable)');
  });
});

describe('replay', () => {
  async function seedLog(): Promise<void> {
    const sink = createJudgmentLogSink({ artifactsDir: join(tmp, 'art') });
    const def = makeDef();
    const fake = makeFake();
    const enforce = makeConfig({
      judgments: {
        'test.judgment': {
          mode: 'enforce',
          thresholds: { [KEY]: { pass: 0.85, fail: 0.15 } },
          promotion: { [KEY]: { path: 'corpus', n: 75, actBandPrecision: 0.97 } },
        },
      },
    });
    const shadow = makeConfig({
      judgments: {
        'test.judgment': { mode: 'shadow', thresholds: { [KEY]: { pass: 0.85, fail: 0.15 } } },
      },
    });
    for (const p of [0.95, 0.9, 0.5, 0.1]) {
      await evaluateJudgment(
        def,
        { p },
        {
          config: enforce,
          getProvider: () => fake,
          sinks: [sink],
          sourceKind: 'backlog',
          incumbent: true,
        },
      );
    }
    for (const p of [0.95, 0.4]) {
      await evaluateJudgment(
        def,
        { p },
        { config: shadow, getProvider: () => fake, sinks: [sink], incumbent: p > 0.9 },
      );
    }
  }

  it('reproduces logged outcomes and reports incumbent agreement from shadow records', async () => {
    await seedLog();
    const fake = makeFake();
    const code = await run(
      ['replay', '--since', '2020-01-01'],
      deps({ getDefinition: () => makeDef(), getProvider: () => fake, now: undefined }),
    );
    expect(code).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(outText).toContain('replay since 2020-01-01T00:00:00.000Z: 6 records, 1 judgments');
    expect(outText).toContain('logged outcomes reproduced: 4/4');
    // acts with an incumbent: enforce 0.95, 0.9 (incumbent ok:true) + shadow 0.95 (ok:true)
    expect(outText).toContain('incumbent agreement: 3/3 (100.0%)');
  });

  it('recomputes under command-line thresholds and filters by judgment', async () => {
    await seedLog();
    const d = deps({ getDefinition: () => makeDef(), now: undefined });
    await run(
      ['replay', '--since', '2020-01-01', '--judgment', 'test.judgment', '--threshold', 'pass=0.4'],
      d,
    );
    expect(outText).not.toContain('logged outcomes reproduced');
    // 0.95, 0.9, 0.5 (enforce) and 0.95, 0.4 (shadow) act at pass=0.4
    expect(outText).toContain('act 5');
    outText = '';
    await run(['replay', '--since', '2020-01-01', '--judgment', 'other.id'], d);
    expect(outText).toContain('0 records, 0 judgments');
  });

  it('skips unregistered definitions, counts throwing compose and rejects bad dates', async () => {
    await seedLog();
    await run(
      ['replay', '--since', '2020-01-01'],
      deps({ getDefinition: () => undefined, now: undefined }),
    );
    expect(outText).toContain('definition not registered');
    outText = '';
    await run(
      ['replay', '--since', '2020-01-01T00:00:00Z'],
      deps({
        getDefinition: () =>
          makeDef({
            compose: () => {
              throw new Error('boom');
            },
          }),
        now: undefined,
      }),
    );
    expect(outText).toContain('could not be recomputed');
    expect(await run(['replay', '--since', 'garbage'], deps())).toBe(1);
    expect(errText).toContain('not a valid date');
  });

  it('handles an empty log', async () => {
    await run(['replay', '--since', '2020-01-01'], deps());
    expect(outText).toContain('0 records');
  });
});
