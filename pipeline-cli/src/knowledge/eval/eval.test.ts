import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextCli } from '../../cli/context.js';
import { hashValue, type KnowledgeEntry } from '../entry.js';
import { recordLoaded } from '../retrieval/ledger.js';
import { citationRate, renderCitationRate, sessionIds } from './citation.js';
import {
  BASELINE_PATH,
  evaluateGate,
  loadEvaluationConfig,
  readBaseline,
  writeBaseline,
} from './gate.js';
import { liveEntryIds, loadGolden, parseGolden, runEval } from './golden.js';
import { ndcgAtK, recallAtK, reciprocalRank } from './metrics.js';
import {
  generateSynthetic,
  mineQuestions,
  QUARANTINE_DIR,
  quarantineFile,
  scrub,
} from './quarantine.js';

let root: string;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function mk(id: string, value: string): KnowledgeEntry {
  return {
    id,
    trunk: 'systems',
    type: 'fact',
    value,
    confidence: 0.7,
    authority: 'inferred',
    scope: 'internal',
    source: `src/${id}.ts`,
    observed: '2026-10-09',
    decay: 'durable',
    relations: [],
    contentHash: hashValue(value),
    body: '',
  };
}

function project(entries: KnowledgeEntry[], files: Record<string, string> = {}): string {
  root = mkdtempSync(join(tmpdir(), 'eval-'));
  for (const e of entries) {
    const { body, ...fm } = e;
    const p = join(root, '.ai-sdlc/knowledge/systems', `${e.id}.md`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `---\n${JSON.stringify(fm)}\n---\n${body}\n`);
  }
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
}

describe('metrics', () => {
  const rel = new Map([
    ['a', 2],
    ['b', 1],
  ]);
  it('computes recall, reciprocal rank and nDCG with known values', () => {
    expect(recallAtK(['x', 'a', 'y'], rel, 5)).toBe(0.5);
    expect(recallAtK(['x', 'a', 'b'], rel, 2)).toBe(0.5);
    expect(recallAtK([], new Map(), 5)).toBe(0);
    expect(reciprocalRank(['x', 'a'], rel)).toBe(0.5);
    expect(reciprocalRank(['x'], rel)).toBe(0);
    expect(ndcgAtK(['a', 'b'], rel, 5)).toBeCloseTo(1);
    const ideal = 2 + 1 / Math.log2(3);
    expect(ndcgAtK(['b', 'a'], rel, 5)).toBeCloseTo((1 + 2 / Math.log2(3)) / ideal);
    expect(ndcgAtK(['x'], rel, 5)).toBe(0);
    expect(ndcgAtK(['a'], new Map(), 5)).toBe(0);
  });
});

describe('golden set', () => {
  const golden = `questions:
  - id: q1
    question: first
    relevant: { a: 2, b: 1 }
  - id: q2
    question: second
    relevant: [c]
  - id: q3
    question: gone
    relevant: [removed]
`;
  const ranks: Record<string, string[]> = {
    first: ['a', 'x', 'b'],
    second: ['x', 'y', 'c'],
    gone: ['a'],
  };

  it('scores a fixture with known values and retires questions without live entries', async () => {
    const qs = parseGolden(golden);
    const report = await runEval(qs, new Set(['a', 'b', 'c']), async (t) => ranks[t]);
    expect(report.scored).toBe(2);
    expect(report.retired).toEqual(['q3']);
    expect(report.recallAt5).toBe(1);
    expect(report.mrr).toBeCloseTo((1 + 1 / 3) / 2);
    expect(report.ndcgAt5).toBeGreaterThan(0.7);
  });

  it('rejects malformed questions and loads the file from disk', () => {
    expect(() => parseGolden('questions: [{id: 1}]')).toThrow(/needs string/);
    expect(() => parseGolden('questions: [{id: q, question: x, relevant: []}]')).toThrow(
      /no judgments/,
    );
    expect(parseGolden('{}')).toEqual([]);
    project([mk('a', 'v')], { '.ai-sdlc/context-eval/golden.yaml': golden });
    expect(loadGolden(root)).toHaveLength(3);
    expect([...liveEntryIds(root)]).toEqual(['a']);
    const empty = mkdtempSync(join(tmpdir(), 'eval-empty-'));
    expect(loadGolden(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('gate and config', () => {
  const cfg = { goldenRecallAt5: 0.8, maxRegressionPoints: 2 };

  it('fails below the recall floor and passes at or above it', () => {
    expect(evaluateGate(0.79, cfg, null).ok).toBe(false);
    expect(evaluateGate(0.8, cfg, null).ok).toBe(true);
    expect(evaluateGate(0.95, cfg, null).ok).toBe(true);
  });

  it('fails when recall drops more than 2 points from the previous release', () => {
    const base = { release: 'v1', recallAt5: 0.95 };
    const bad = evaluateGate(0.92, cfg, base);
    expect(bad.ok).toBe(false);
    expect(bad.failures[0]).toMatch(/dropped 3.0 points/);
    expect(evaluateGate(0.93, cfg, base).ok).toBe(true);
    expect(evaluateGate(0.97, cfg, base).ok).toBe(true);
  });

  it('reads the thresholds from context.yaml with the stated defaults', () => {
    project([]);
    expect(loadEvaluationConfig(root)).toEqual(cfg);
    mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(root, '.ai-sdlc/context.yaml'), 'knowledge: {}\n');
    expect(loadEvaluationConfig(root)).toEqual(cfg);
    mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(root, '.ai-sdlc/context.yaml'),
      'evaluation:\n  goldenRecallAt5: 0.9\n  maxRegressionPoints: 1\n',
    );
    expect(loadEvaluationConfig(root)).toEqual({ goldenRecallAt5: 0.9, maxRegressionPoints: 1 });
  });

  it('round-trips the baseline', () => {
    project([]);
    expect(readBaseline(root)).toBeNull();
    writeBaseline(root, { release: 'v2', recallAt5: 0.9 });
    expect(readBaseline(root)).toEqual({ release: 'v2', recallAt5: 0.9 });
    writeFileSync(join(root, BASELINE_PATH), '{}');
    expect(readBaseline(root)).toBeNull();
  });
});

describe('quarantine', () => {
  const line = (text: string): string =>
    JSON.stringify({ type: 'user', message: { content: text } });

  it('writes only under the quarantine directory', () => {
    project([]);
    mineQuestions(root, [line('How does the retrieval ranking work in this repo?')]);
    const files = readdirSync(join(root, QUARANTINE_DIR));
    expect(files).toEqual(['mined.jsonl']);
    expect(readdirSync(join(root, '.ai-sdlc')).sort()).toEqual(['context']);
    expect(() => quarantineFile(root, '../escape.jsonl')).toThrow(/refused/);
    expect(() => quarantineFile(root, '.')).toThrow(/refused/);
  });

  it('scrubs secrets and identifiers', () => {
    const out = scrub(
      'Why did dev@example.com use ghp_abcdefghijklmnop1234 at /Users/alice/x on 10.0.0.1 for AISDLC-778 via https://x.io/a? token=abc123',
    );
    expect(out).not.toMatch(/example\.com|ghp_|alice|10\.0\.0\.1|AISDLC-778|https:|abc123/);
    expect(out).toContain('<email>');
    expect(out).toContain('<home>');
  });

  it('de-duplicates repeated questions across runs and within a run', () => {
    project([]);
    const t = [
      line('Where is the load ledger stored?'),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'where is the LOAD ledger stored??' }] },
      }),
      'not json, but is a question about ranking order?',
      JSON.stringify({ type: 'assistant', message: { content: 'Is this skipped?' } }),
      line('short?'),
    ].join('\n');
    const first = mineQuestions(root, [t]);
    expect(first).toEqual({ written: 2, duplicates: 1 });
    expect(mineQuestions(root, [t])).toEqual({ written: 0, duplicates: 3 });
    const rows = readFileSync(join(root, QUARANTINE_DIR, 'mined.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(rows).toHaveLength(2);
  });

  it('generates at least one synthetic question per entry', () => {
    const entries = [mk('alpha-one', 'Alpha does a thing. More.'), mk('beta_two', '')];
    const qs = generateSynthetic([...entries, { ...mk('old', 'x'), superseded: true }]);
    expect(qs.map((q) => q.entryId)).toEqual(['alpha-one', 'beta_two']);
    expect(qs[0].question).toContain('alpha one');
    expect(qs[1].question.endsWith('?')).toBe(true);
  });
});

describe('quarantine is never read by a prompt path', () => {
  it('no hook, agent or non-eval source references the quarantine directory', () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const allowed = new Set([
      'pipeline-cli/src/knowledge/eval/quarantine.ts',
      'pipeline-cli/src/knowledge/eval/eval.test.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.name === 'node_modules' || d.name === 'dist' || d.name.startsWith('.')) continue;
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs|sh|md)$/.test(d.name)) {
          const rel = p.slice(repo.length + 1);
          if (!allowed.has(rel) && /eval-quarantine/.test(readFileSync(p, 'utf-8'))) {
            offenders.push(rel);
          }
        }
      }
    };
    for (const sub of ['ai-sdlc-plugin', 'pipeline-cli/src', 'orchestrator/src']) {
      walk(join(repo, sub));
    }
    expect(offenders).toEqual([]);
  });
});

describe('citation rate', () => {
  it('reports the cited share of injected entries without gating', () => {
    project([]);
    const hit = (id: string) => ({ id, contentHash: 'h', score: 1, citations: [], tokens: 1 });
    recordLoaded(root, 's1', [hit('alpha'), hit('beta')]);
    recordLoaded(root, 's2', [hit('gamma')]);
    expect(sessionIds(root).sort()).toEqual(['s1', 's2']);
    const r = citationRate(root, ['s1', 's2'], 'As Alpha says, and GAMMA too');
    expect(r).toEqual({ injected: 3, cited: 2, rate: 2 / 3 });
    expect(renderCitationRate(r)).toContain('66.7%');
    expect(renderCitationRate(r)).toContain('not a gate');
    expect(citationRate(root, [], 'x').rate).toBe(0);
    const empty = mkdtempSync(join(tmpdir(), 'eval-none-'));
    expect(sessionIds(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('cli-context eval end to end', () => {
  async function run(...args: string[]): Promise<{ out: string; err: string; code: number }> {
    let out = '';
    let err = '';
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.exitCode = undefined;
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
    try {
      await buildContextCli(['--project-dir', root, ...args]).parseAsync();
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return { out, err, code };
  }

  it('indexes a fixture, scores the golden set and applies the gate', async () => {
    project(
      [
        mk('ledger-store', 'The session load ledger is stored as jsonl per session.'),
        mk('zebra-habitat', 'Zebras graze on savanna grassland.'),
      ],
      {
        '.ai-sdlc/context-eval/golden.yaml': `questions:
  - id: q1
    question: where is the session load ledger stored
    relevant: [ledger-store]
  - id: q2
    question: where do zebras graze
    relevant: [zebra-habitat]
  - id: q3
    question: retired
    relevant: [missing-entry]
`,
      },
    );
    expect((await run('index')).code).toBe(0);
    const ok = await run('eval', '--gate', '--update-baseline', 'v1');
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('"scored": 2');
    expect(ok.out).toContain('"retired": [\n    "q3"');
    expect(ok.out).toContain('baseline written');
    writeBaseline(root, { release: 'v0', recallAt5: 1.5 });
    const regress = await run('eval', '--gate');
    expect(regress.code).toBe(1);
    expect(regress.err).toMatch(/dropped/);
    writeFileSync(
      join(root, '.ai-sdlc/context.yaml'),
      'evaluation:\n  goldenRecallAt5: 1.1\n  maxRegressionPoints: 100\n',
    );
    const low = await run('eval', '--gate');
    expect(low.code).toBe(1);
    expect(low.err).toMatch(/below 1.1/);

    expect((await run('synthesize')).out).toContain('2 synthetic');
    const synth = await run('eval', '--set', 'synthetic', '--gate');
    expect(synth.code).toBe(0);
    expect(synth.out).toContain('"set": "synthetic"');

    writeFileSync(
      join(root, 't.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'What is the ledger format?' } }),
    );
    expect((await run('mine', join(root, 't.jsonl'))).out).toContain('1 written');
    writeFileSync(join(root, 'out.txt'), 'see ledger-store');
    const cr = await run('citation-rate', '--text-file', join(root, 'out.txt'));
    expect(cr.out).toContain('citation rate');
  });

  it('skips the gate when no golden question is scoreable', async () => {
    project([], { '.ai-sdlc/context-eval/golden.yaml': 'questions: []\n' });
    await run('index');
    const r = await run('eval', '--gate');
    expect(r.code).toBe(0);
    expect(r.out).toContain('gate skipped');
  });

  it('reports an error for a malformed golden set', async () => {
    project([], { '.ai-sdlc/context-eval/golden.yaml': 'questions: [{id: 1}]\n' });
    const r = await run('eval');
    expect(r.code).toBe(1);
  });
});
