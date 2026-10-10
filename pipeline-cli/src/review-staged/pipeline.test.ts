/**
 * The staged review pipeline end to end, with every model call replaced: a real git
 * repository, a recording probe spawner, and planner and synthesizer outputs written by
 * the test. Covers the fail-closed path (the existing set handles the change and the
 * rejections are in the dispatch record), the one-retry plan rule, probe execution and
 * its transcripts, grounding, and the leaf manifest.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeSpawner, ProbeSpawnOpts } from '../review-plan/executor.js';
import type { Baseline, ReviewPlan } from '../review-plan/types.js';
import type { EvidenceBundle } from '../review-plan/executor.js';
import type { ReviewRiskMap } from '../review-risk-map/types.js';
import {
  executeStagedReview,
  extractJsonObject,
  finalizeStagedReview,
  planStagedReview,
  prepareStagedReview,
  recordStagedFallback,
  synthesizerPromptForRun,
  countProbes,
} from './pipeline.js';
import { RUN_FILES, readDispatchRecord, readRunJson, stagedRunDir } from './run-store.js';
import type { LeafManifestEntry } from './leaves.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const TASK = 'AISDLC-676';

interface Fixture {
  repo: string;
  artifacts: string;
}

/** A repo whose HEAD is one commit past `origin/main`, changing source and a test. */
function makeFixture(opts: { extraFile?: string } = {}): Fixture {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'staged-pipeline-')));
  roots.push(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'a.test.ts'), "test('a', () => {});\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(repo, 'src', 'a.test.ts'), "test('a', () => {});\ntest('b', () => {});\n");
  if (opts.extraFile) writeFileSync(join(repo, opts.extraFile), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const artifacts = join(repo, '.ai-sdlc', 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  return { repo, artifacts };
}

const criteria = ['b is exported', 'b is tested'];

async function prepare(f: Fixture, over: Record<string, unknown> = {}) {
  return prepareStagedReview({
    taskId: TASK,
    worktreePath: f.repo,
    sourceKind: 'backlog',
    artifactsDir: f.artifacts,
    acceptanceCriteria: criteria,
    references: ['src/'],
    readBaseConfig: () => null,
    ...over,
  });
}

const okEvidence = JSON.stringify({
  observations: ['b is exported and tested'],
  excerpts: [{ file: 'src/a.ts', startLine: 2, endLine: 2, text: 'export const b = 2;' }],
  commands: [],
  answer: { text: 'looks fine', confidence: 'high' },
});

/** A spawner that declares everything and records each probe it is given. */
function recordingSpawner(): { spawner: ProbeSpawner; calls: ProbeSpawnOpts[] } {
  const calls: ProbeSpawnOpts[] = [];
  return {
    calls,
    spawner: {
      enforcesFileScope: { 'claude-code': true, codex: false },
      honoursEmptyToolList: { 'claude-code': true, codex: false },
      async spawnProbe(opts) {
        calls.push(opts);
        return { status: 'success', output: okEvidence, model: 'haiku-x' };
      },
    },
  };
}

const runDirOf = (f: Fixture) => stagedRunDir(f.artifacts, TASK);

/** Drive prepare, plan and execute to a finished evidence bundle. */
async function throughExecute(f: Fixture) {
  const prep = await prepare(f);
  if (!prep.ok) throw new Error(`prepare failed: ${prep.reason}`);
  const baseline = await readRunJson<Baseline>(prep.runDir, RUN_FILES.baseline);
  const planOut = JSON.stringify({
    schemaVersion: 1,
    baselineVersion: baseline.version,
    probes: baseline.probes,
  });
  const planned = await planStagedReview({
    taskId: TASK,
    artifactsDir: f.artifacts,
    plannerOutput: planOut,
    attempt: 1,
  });
  const { spawner, calls } = recordingSpawner();
  const executed = await executeStagedReview({
    taskId: TASK,
    artifactsDir: f.artifacts,
    executorModel: 'haiku',
    spawner,
    hooks: {
      runCommand: async () => ({ exitStatus: 0, output: 'ok', truncated: false, timedOut: false }),
    },
  });
  return { prep, baseline, planned, executed, calls, spawner };
}

describe('prepareStagedReview', () => {
  it('builds the risk map, baseline, fallback plan and planner prompt', async () => {
    const f = makeFixture();
    const r = await prepare(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const file of [
      RUN_FILES.task,
      RUN_FILES.config,
      RUN_FILES.riskMap,
      RUN_FILES.baseline,
      RUN_FILES.fallbackPlan,
      RUN_FILES.plannerPrompt,
      RUN_FILES.dispatch,
    ]) {
      expect(existsSync(join(r.runDir, file)), file).toBe(true);
    }
    const prompt = readFileSync(r.plannerPromptPath, 'utf8');
    expect(prompt).toContain('<<<UNTRUSTED_PR_DIFF>>>');
    expect(prompt).toContain(r.baselineVersion);
    expect(r.baselineProbes).toBeGreaterThan(0);
    expect(await readDispatchRecord(r.runDir)).toMatchObject({
      status: 'prepared',
      rejections: [],
    });
  });

  it('falls back to the existing set when the baseline cannot be made safe, and records why', async () => {
    // A path git accepts but the plan schema refuses to carry: a leading dash.
    const f = makeFixture({ extraFile: '-weird.ts' });
    const r = await prepare(f);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fallbackSet).toBe('three');
    expect(r.reason).toBe('no-safe-plan');
    const reasons = r.rejections.map((x) => x.reason);
    expect(reasons).toContain('unsafe-path');
    expect(reasons).toContain('unreviewable-input');
    // The staged review does not run: there is no plan and no planner prompt.
    expect(existsSync(join(r.runDir, RUN_FILES.plannerPrompt))).toBe(false);
    expect(existsSync(join(r.runDir, RUN_FILES.plan))).toBe(false);
    // The rejections are in the dispatch record.
    const record = await readDispatchRecord(r.runDir);
    expect(record).toMatchObject({
      status: 'fallback',
      fallbackSet: 'three',
      reason: 'no-safe-plan',
    });
    expect(record?.rejections).toEqual(r.rejections);
  });

  it('falls back for work that is not backlog work', async () => {
    const f = makeFixture();
    const r = await prepare(f, { sourceKind: 'gh-issue' });
    expect(r).toMatchObject({ ok: false, reason: 'untrusted-source', fallbackSet: 'three' });
    expect(existsSync(join(runDirOf(f), RUN_FILES.riskMap))).toBe(false);
  });

  it.each([
    ['an empty diff', { diff: '   \n' }],
    ['an unreadable diff', { runner: async () => ({ stdout: '', stderr: 'x', code: 1 }) }],
  ])('falls back on %s', async (_n, over) => {
    const f = makeFixture();
    const r = await prepare(f, over);
    expect(r).toMatchObject({ ok: false, reason: 'diff-unavailable' });
  });

  it('falls back when HEAD or the merge-base cannot be resolved', async () => {
    const f = makeFixture();
    const r = await prepare(f, { baseRef: 'origin/does-not-exist' });
    expect(r).toMatchObject({ ok: false, reason: 'diff-unavailable' });
    const g = makeFixture();
    const s = await prepare(g, { diff: 'diff --git a/x b/x\n', baseRef: 'origin/does-not-exist' });
    expect(s).toMatchObject({ ok: false, reason: 'revisions-unresolved' });
  });

  it('clears what an earlier run left, so a stale plan cannot feed a new review', async () => {
    const f = makeFixture();
    const first = await throughExecute(f);
    expect(existsSync(join(first.prep.runDir, RUN_FILES.evidence))).toBe(true);
    const again = await prepare(f);
    expect(again.ok).toBe(true);
    expect(existsSync(join(runDirOf(f), RUN_FILES.evidence))).toBe(false);
    expect(existsSync(join(runDirOf(f), RUN_FILES.plan))).toBe(false);
  });

  it('records a fallback found before prepare could run', async () => {
    const f = makeFixture();
    await prepare(f);
    const r = await recordStagedFallback({
      taskId: TASK,
      sourceKind: 'backlog',
      artifactsDir: f.artifacts,
      reason: 'task-unreadable',
      detail: 'no task file',
    });
    expect(r).toMatchObject({ ok: false, reason: 'task-unreadable', fallbackSet: 'three' });
    expect(existsSync(join(r.runDir, RUN_FILES.riskMap))).toBe(false);
    expect((await readDispatchRecord(r.runDir))?.rejections[0]?.detail).toContain('no task file');
  });
});

describe('planStagedReview', () => {
  async function prepared() {
    const f = makeFixture();
    const prep = await prepare(f);
    if (!prep.ok) throw new Error('prepare failed');
    const baseline = await readRunJson<Baseline>(prep.runDir, RUN_FILES.baseline);
    const valid = { schemaVersion: 1, baselineVersion: baseline.version, probes: baseline.probes };
    return { f, prep, baseline, valid };
  }
  const plan = (f: Fixture, plannerOutput: string | undefined, attempt: 1 | 2) =>
    planStagedReview({ taskId: TASK, artifactsDir: f.artifacts, plannerOutput, attempt });

  it('accepts a plan that carries the whole baseline, even inside a code fence', async () => {
    const { f, prep, valid } = await prepared();
    const r = await plan(f, '```json\n' + JSON.stringify(valid) + '\n```', 1);
    expect(r).toMatchObject({ status: 'planned', source: 'planner', rejections: [] });
    const stored = await readRunJson<ReviewPlan>(prep.runDir, RUN_FILES.plan);
    expect(stored.probes.length).toBe(valid.probes.length);
    expect(await readDispatchRecord(prep.runDir)).toMatchObject({
      status: 'planned',
      planSource: 'planner',
      plannerAttempts: 1,
    });
  });

  it('asks once for a corrected plan, then uses the code-built fallback', async () => {
    const { f, prep, valid } = await prepared();
    const missing = { ...valid, probes: valid.probes.slice(1) };
    const first = await plan(f, JSON.stringify(missing), 1);
    expect(first.status).toBe('retry');
    if (first.status !== 'retry') return;
    expect(first.rejections.map((x) => x.reason)).toContain('missing-baseline-probe');
    expect(first.retryNote).toContain('missing-baseline-probe');
    expect(existsSync(join(prep.runDir, RUN_FILES.plan))).toBe(false);

    const second = await plan(f, JSON.stringify(missing), 2);
    expect(second).toMatchObject({ status: 'planned', source: 'fallback' });
    const stored = await readRunJson<ReviewPlan>(prep.runDir, RUN_FILES.plan);
    const fallback = await readRunJson<ReviewPlan>(prep.runDir, RUN_FILES.fallbackPlan);
    expect(stored).toEqual(fallback);
    const record = await readDispatchRecord(prep.runDir);
    expect(record).toMatchObject({ status: 'planned', planSource: 'fallback', plannerAttempts: 2 });
    expect(record?.planRejections?.map((x) => x.reason)).toContain('missing-baseline-probe');
  });

  it.each([
    ['no planner output', undefined],
    ['text that is not JSON', 'I plan to read the files.'],
    ['JSON that is not a plan', '{"hello": 1}'],
  ])('treats %s as a rejected attempt', async (_n, out) => {
    const { f } = await prepared();
    expect((await plan(f, out, 1)).status).toBe('retry');
    expect(await plan(f, out, 2)).toMatchObject({ status: 'planned', source: 'fallback' });
  });

  it('refuses a plan that alters a baseline probe', async () => {
    const { f, valid } = await prepared();
    const altered = {
      ...valid,
      probes: valid.probes.map((p, i) => (i === 0 ? { ...p, question: 'Is it fine?' } : p)),
    };
    const r = await plan(f, JSON.stringify(altered), 1);
    expect(r.status).toBe('retry');
    if (r.status === 'retry')
      expect(r.rejections.map((x) => x.reason)).toContain('modified-baseline-probe');
  });
});

describe('extractJsonObject', () => {
  it.each([
    ['plain', '{"a":1}', { a: 1 }],
    ['fenced', '```json\n{"a":1}\n```', { a: 1 }],
    ['fenced without a language', '```\n{"a":1}\n```', { a: 1 }],
    ['wrapped in prose', 'Here you go: {"a":1} done', { a: 1 }],
    ['absent', undefined, undefined],
    ['no object', 'nothing here', undefined],
    ['unbalanced', '{"a":', undefined],
  ])('%s', (_n, input, expected) => {
    expect(extractJsonObject(input)).toEqual(expected);
  });
});

describe('executeStagedReview', () => {
  it('runs the probes, writes evidence, and one transcript per probe that ran a model', async () => {
    const f = makeFixture();
    const { executed, calls, baseline } = await throughExecute(f);
    const evidence = await readRunJson<EvidenceBundle>(runDirOf(f), RUN_FILES.evidence);

    expect(executed.probes.total).toBe(baseline.probes.length);
    expect(executed.probes).toEqual(countProbes(evidence));
    // A trace probe needs a dependency query that is not wired, so it is refused, not run.
    const traces = evidence.entries.filter((e) => e.probeId.includes('trace'));
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((e) => e.status === 'refused')).toBe(true);

    expect(calls.length).toBe(executed.transcripts);
    expect(executed.transcripts).toBe(evidence.entries.filter((e) => e.status === 'ok').length);
    const tDir = join(f.repo, '.ai-sdlc', 'transcripts', TASK.toLowerCase());
    const files = readdirSync(tDir).sort();
    expect(files.length).toBe(executed.transcripts);
    expect(files.every((n) => n.startsWith('staged-review-execute-') && n.endsWith('.jsonl'))).toBe(
      true,
    );
    const lines = readFileSync(join(tDir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l: { role: string }) => l.role)).toEqual(['user', 'assistant']);
    expect(lines[1]).toMatchObject({ harness: 'claude-code', model: 'haiku-x' });

    // Each transcript has a verdict stub carrying no verdict.
    const stub = JSON.parse(
      readFileSync(
        join(f.repo, '.ai-sdlc', 'verdicts', readdirSync(join(f.repo, '.ai-sdlc', 'verdicts'))[0]!),
        'utf8',
      ),
    );
    expect(stub).toMatchObject({ approved: false, findings: [] });

    const leaves = await readRunJson<{ probeId: string }[]>(runDirOf(f), RUN_FILES.executeLeaves);
    expect(leaves.length).toBe(executed.transcripts);
    expect(await readDispatchRecord(runDirOf(f))).toMatchObject({ status: 'executed' });
  });

  it('gives the executor the routed model, trust for run probes, and no Codex without a bridge', async () => {
    const f = makeFixture();
    const { calls } = await throughExecute(f);
    expect(calls.every((c) => c.harness === 'claude-code' && c.model === 'haiku')).toBe(true);
    // The run probe ran: the work is trusted backlog work.
    const evidence = await readRunJson<EvidenceBundle>(runDirOf(f), RUN_FILES.evidence);
    const run = evidence.entries.find((e) => e.probeId === 'tests-run');
    expect(run?.status).toBe('ok');
    expect(run?.commands[0]).toMatchObject({ command: 'pnpm test', exitStatus: 0 });
  });

  it('refuses every run probe for work that is not trusted', async () => {
    const f = makeFixture();
    const prep = await prepare(f);
    if (!prep.ok) throw new Error('prepare failed');
    const baseline = await readRunJson<Baseline>(prep.runDir, RUN_FILES.baseline);
    await planStagedReview({
      taskId: TASK,
      artifactsDir: f.artifacts,
      plannerOutput: JSON.stringify({
        schemaVersion: 1,
        baselineVersion: baseline.version,
        probes: baseline.probes,
      }),
      attempt: 1,
    });
    // Mark the stored task as untrusted work, as if it came from another source.
    const taskPath = join(prep.runDir, RUN_FILES.task);
    const stored = JSON.parse(readFileSync(taskPath, 'utf8'));
    writeFileSync(taskPath, JSON.stringify({ ...stored, sourceKind: 'gh-issue' }));
    const { spawner } = recordingSpawner();
    await executeStagedReview({ taskId: TASK, artifactsDir: f.artifacts, spawner });
    const evidence = await readRunJson<EvidenceBundle>(prep.runDir, RUN_FILES.evidence);
    expect(evidence.entries.find((e) => e.probeId === 'tests-run')).toMatchObject({
      status: 'refused',
      refusals: [{ reason: 'run-not-trusted' }],
    });
  });

  it('offers Codex only to a spawner that has a bridge, and keeps going when a hook fails', async () => {
    const f = makeFixture();
    const prep = await prepare(f);
    if (!prep.ok) throw new Error('prepare failed');
    const baseline = await readRunJson<Baseline>(prep.runDir, RUN_FILES.baseline);
    await planStagedReview({
      taskId: TASK,
      artifactsDir: f.artifacts,
      plannerOutput: JSON.stringify({
        schemaVersion: 1,
        baselineVersion: baseline.version,
        probes: baseline.probes,
      }),
      attempt: 1,
    });
    const seen: string[] = [];
    const codexLike: ProbeSpawner = {
      enforcesFileScope: { 'claude-code': true, codex: true },
      honoursEmptyToolList: { 'claude-code': true, codex: true },
      async spawnProbe(o) {
        seen.push(o.harness);
        return { status: 'success', output: okEvidence };
      },
    };
    await executeStagedReview({
      taskId: TASK,
      artifactsDir: f.artifacts,
      spawner: codexLike,
      codexAvailable: true,
      hooks: {
        runCommand: async () => ({
          exitStatus: 0,
          output: 'ok',
          truncated: false,
          timedOut: false,
        }),
        captureTranscript: async () => {
          throw new Error('caller hook failed');
        },
      },
    });
    expect(seen).toContain('codex');
  });
});

describe('synthesizer prompt and finalize', () => {
  async function evidenceFixture() {
    const f = makeFixture();
    await throughExecute(f);
    const evidence = await readRunJson<EvidenceBundle>(runDirOf(f), RUN_FILES.evidence);
    const okProbe = evidence.entries.find((e) => e.status === 'ok')!;
    const refusedProbe = evidence.entries.find((e) => e.status === 'refused')!;
    return { f, evidence, okProbe, refusedProbe };
  }

  const verdict = (over: Record<string, unknown> = {}) => ({
    approved: true,
    findings: [],
    summary: 'fine',
    promptInjectionDetected: false,
    ...over,
  });
  const finalize = (f: Fixture, out: unknown, extra: Record<string, unknown> = {}) =>
    finalizeStagedReview({
      taskId: TASK,
      artifactsDir: f.artifacts,
      synthesizerOutput: typeof out === 'string' ? out : JSON.stringify(out),
      ...extra,
    });

  it('writes a synthesizer prompt that holds the evidence and the criteria', async () => {
    const { f, okProbe } = await evidenceFixture();
    const { promptPath } = await synthesizerPromptForRun({
      taskId: TASK,
      artifactsDir: f.artifacts,
    });
    const text = readFileSync(promptPath, 'utf8');
    expect(text).toContain(okProbe.probeId);
    expect(text).toContain('b is exported');
    expect(text).toContain('OUTPUT CONTRACT');
  });

  it('approves a clean grounded verdict and writes the verdict, the Step 8 shape and the leaves', async () => {
    const { f } = await evidenceFixture();
    const r = await finalize(f, verdict(), { plannerModel: 'opus', synthesizerModel: 'opus' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.approved).toBe(true);
    expect(r.reviewerVerdict).toMatchObject({
      agentId: 'staged-review',
      approved: true,
      findings: [],
    });
    expect(r.uncoveredHunks.length).toBeGreaterThanOrEqual(0);

    const manifest = JSON.parse(readFileSync(r.leavesPath, 'utf8')) as LeafManifestEntry[];
    expect(manifest[0]).toMatchObject({ stage: 'plan', reviewer: 'staged-review', model: 'opus' });
    expect(manifest.at(-1)).toMatchObject({ stage: 'synthesize', model: 'opus' });
    const middle = manifest.slice(1, -1);
    expect(middle.length).toBeGreaterThan(0);
    expect(middle.every((m) => m.stage === 'execute' && typeof m.probeId === 'string')).toBe(true);
    expect(manifest.every((m) => m.reviewer === 'staged-review')).toBe(true);
    // The synthesize leaf reads the grounded verdict, in the shape emit-leaf consumes.
    const written = JSON.parse(readFileSync(manifest.at(-1)!.verdictPath, 'utf8'));
    expect(written).toMatchObject({ approved: true, findings: [], summary: 'fine' });
    expect(await readDispatchRecord(runDirOf(f))).toMatchObject({
      status: 'finalized',
      droppedFindings: 0,
    });
  });

  it('keeps a finding grounded in a probe that returned evidence, and blocks on it', async () => {
    const { f, okProbe } = await evidenceFixture();
    const r = await finalize(
      f,
      verdict({
        approved: true,
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            line: 2,
            message: 'b is exported without validation',
            evidence: [{ probeId: okProbe.probeId }],
          },
        ],
      }),
    );
    if (!r.ok) throw new Error('finalize failed');
    expect(r.verdict.findings).toHaveLength(1);
    // The synthesizer approved, but a blocking finding is left: tighten, never loosen.
    expect(r.verdict.approved).toBe(false);
    expect(r.reviewerVerdict.findings[0]).toMatchObject({
      severity: 'critical',
      file: 'src/a.ts',
      line: 2,
    });
  });

  it('drops findings no probe evidence backs, and counts them', async () => {
    const { f, okProbe, refusedProbe } = await evidenceFixture();
    const r = await finalize(
      f,
      verdict({
        approved: false,
        findings: [
          { severity: 'major', message: 'unknown probe', evidence: [{ probeId: 'no-such-probe' }] },
          {
            severity: 'major',
            message: 'refused probe',
            evidence: [{ probeId: refusedProbe.probeId }],
          },
          {
            severity: 'major',
            message: 'invented quote',
            evidence: [{ probeId: okProbe.probeId, excerpt: 'text the probe never returned' }],
          },
          { severity: 'minor', message: 'kept', evidence: [{ probeId: okProbe.probeId }] },
        ],
      }),
    );
    if (!r.ok) throw new Error('finalize failed');
    expect(r.dropped).toBe(3);
    expect(r.verdict.findings.map((x) => x.message)).toEqual(['kept']);
    expect(r.verdict.groundingDropped).toBe(3);
    expect(r.reviewerVerdict.summary).toContain('3 finding(s) were dropped');
    expect(await readDispatchRecord(runDirOf(f))).toMatchObject({ droppedFindings: 3 });
  });

  it('names the hunks that no probe covered', async () => {
    const { f } = await evidenceFixture();
    const r = await finalize(f, verdict());
    if (!r.ok) throw new Error('finalize failed');
    const record = await readDispatchRecord(runDirOf(f));
    expect(record?.uncoveredHunks).toEqual(r.uncoveredHunks);
    if (r.uncoveredHunks.length > 0) {
      expect(r.reviewerVerdict.summary).toContain('Hunks with no probe evidence');
    }
  });

  it('carries a suspicious injection screen onto the verdict', async () => {
    const { f } = await evidenceFixture();
    const mapPath = join(runDirOf(f), RUN_FILES.riskMap);
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as ReviewRiskMap;
    writeFileSync(
      mapPath,
      JSON.stringify({ ...map, injectionScreen: { status: 'suspicious', findings: ['x'] } }),
    );
    const r = await finalize(f, verdict({ promptInjectionDetected: false }));
    if (!r.ok) throw new Error('finalize failed');
    expect(r.verdict.promptInjectionDetected).toBe(true);
  });

  it.each([
    ['output that is not JSON', 'the code looks fine'],
    ['a verdict with no summary', { approved: true, findings: [], promptInjectionDetected: false }],
    [
      'a finding with no evidence',
      verdict({ findings: [{ severity: 'major', message: 'no evidence', evidence: [] }] }),
    ],
  ])('falls back to the existing set on %s, and says why', async (_n, out) => {
    const { f } = await evidenceFixture();
    const r = await finalize(f, out);
    expect(r).toMatchObject({ ok: false, reason: 'invalid-verdict', fallbackSet: 'three' });
    if (r.ok) return;
    expect(r.rejections.map((x) => x.reason)).toEqual(['schema-invalid', 'unreviewable-input']);
    expect(await readDispatchRecord(runDirOf(f))).toMatchObject({
      status: 'fallback',
      fallbackSet: 'three',
      reason: 'invalid-verdict',
    });
  });
});
