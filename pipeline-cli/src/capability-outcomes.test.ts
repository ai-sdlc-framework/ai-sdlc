/**
 * Capability outcome reporting from the pipeline-cli call sites (RFC-0049 section 9.2).
 *
 * Hermetic: temp directories, fake invokers/providers, no network. Each site is exercised
 * with reporting enabled and with an unwritable state directory to prove the return value
 * never depends on the report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  readCapabilityState,
  reportCapabilityOutcome,
  resolveJudgmentConfig,
  type CapabilityStateRow,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import { classify } from './classifier/substrate/classify.js';
import { FakeLlmInvoker } from './classifier/substrate/fake-invoker.js';
import { resetInvokerCache } from './capture/invoker-loader.js';
import { MockSpawner } from './runtime/subagent-spawner.js';
import { evaluateIssueE2E } from './dor/composite.js';
import { runBaselineStageB, runStageB, runStageBWithJudgment } from './decisions/stage-b.js';
import { runStageC } from './decisions/stage-c.js';
import { runStageA } from './estimation/stage-a.js';
import { runStageB as runEstimationStageB } from './estimation/stage-b.js';
import { buildJudgmentContext } from './judgment/context.js';
import type { Decision } from './decisions/decision-record.js';
import type { StageAResult } from './estimation/types.js';
import type { IssueInput } from './dor/types.js';
import type { StageAOutput } from './decisions/decision-record.js';

const PIPELINE_CLI_CAPABILITIES = [
  'classifier.capture-triage',
  'classifier.capture-severity',
  'classifier.pr-comment-is-capture',
  'classifier.dor-answer-is-new-concern',
  'decisions.stage-c-recommendation',
  'decisions.stage-b-signals',
  'dor.stage-b',
  'estimation.class-assignment',
  'estimation.stage-b',
] as const;

let root: string;
let artifacts: string;
/** A state directory that cannot be created: its parent is a regular file. */
let unwritable: string;
const savedInvokerModule = process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'capability-outcomes-'));
  artifacts = join(root, 'artifacts');
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'a regular file');
  unwritable = join(blocker, 'artifacts');
  delete process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
  resetInvokerCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedInvokerModule === undefined) delete process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
  else process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = savedInvokerModule;
  resetInvokerCache();
});

function row(id: string, dir = artifacts): CapabilityStateRow {
  const found = readCapabilityState(dir).find((r) => r.id === id);
  if (!found) throw new Error(`capability ${id} not registered`);
  return found;
}

function total(id: string, dir = artifacts): number {
  const { live, shadow, degraded } = row(id, dir).counts;
  return live + shadow + degraded;
}

const IN = { text: 'rename the flag' };

describe('classifier substrate', () => {
  it('reports live for a valid above-threshold answer', async () => {
    const invoker = new FakeLlmInvoker({
      'capture-triage': {
        classification: 'quick-fix-task',
        confidence: 0.9,
        reasoning: 'small',
        inputTokens: 1,
        outputTokens: 1,
      },
    });
    const d = await classify(IN, 'capture-triage', {
      invoker,
      repoRoot: root,
      skipCorpus: true,
      judgment: { artifactsDir: artifacts },
    });
    expect(d.metBehindThreshold).toBe(true);
    expect(row('classifier.capture-triage').status).toBe('live');
    expect(total('classifier.capture-triage')).toBe(1);
  });

  it('reports degraded no-invoker when no invoker or judgment exists', async () => {
    const d = await classify(IN, 'capture-severity', {
      repoRoot: root,
      skipCorpus: true,
      judgment: { artifactsDir: artifacts },
    });
    expect(d.classification).toBe('pending');
    const r = row('classifier.capture-severity');
    expect(r.status).toBe('degraded');
    expect(r.lastDegradedReason).toBe('no-invoker');
    expect(total('classifier.capture-severity')).toBe(1);
  });

  it('reports degraded invoker-error when the invoker throws', async () => {
    await classify(IN, 'pr-comment-is-capture', {
      invoker: new FakeLlmInvoker({ throws: new Error('boom') }),
      repoRoot: root,
      skipCorpus: true,
      judgment: { artifactsDir: artifacts },
    });
    expect(row('classifier.pr-comment-is-capture').lastDegradedReason).toBe('invoker-error');
  });

  it('reports degraded invalid-response for a disallowed classification', async () => {
    await classify(IN, 'dor-answer-is-new-concern', {
      invoker: new FakeLlmInvoker({
        default: {
          classification: 'not-a-real-label',
          confidence: 0.99,
          reasoning: 'x',
          inputTokens: 1,
          outputTokens: 1,
        },
      }),
      repoRoot: root,
      skipCorpus: true,
      judgment: { artifactsDir: artifacts },
    });
    expect(row('classifier.dor-answer-is-new-concern').lastDegradedReason).toBe('invalid-response');
  });

  it('reports degraded below-threshold for a low-confidence answer', async () => {
    await classify(IN, 'capture-triage', {
      invoker: new FakeLlmInvoker({
        default: {
          classification: 'quick-fix-task',
          confidence: 0.2,
          reasoning: 'x',
          inputTokens: 1,
          outputTokens: 1,
        },
      }),
      repoRoot: root,
      skipCorpus: true,
      judgment: { artifactsDir: artifacts },
    });
    expect(row('classifier.capture-triage').lastDegradedReason).toBe('below-threshold');
  });

  it('returns the same decision with an unwritable state directory', async () => {
    const run = (dir: string) =>
      classify(IN, 'capture-triage', {
        invoker: new FakeLlmInvoker({
          default: {
            classification: 'quick-fix-task',
            confidence: 0.9,
            reasoning: 'x',
            inputTokens: 1,
            outputTokens: 1,
          },
        }),
        repoRoot: root,
        skipCorpus: true,
        judgment: { artifactsDir: dir },
      });
    const [a, b] = [await run(artifacts), await run(unwritable)];
    expect(b).toEqual(a);
  });

  it('Stage C reports under decisions.stage-c-recommendation', async () => {
    const decision = {
      metadata: { id: 'DEC-1', scope: 'x' },
      spec: {
        summary: 'pick',
        options: [
          { id: 'a', description: 'A' },
          { id: 'b', description: 'B' },
        ],
      },
    } as unknown as Decision;
    const result = await runStageC({
      decision,
      forceFire: true,
      workDir: root,
      corpusDir: join(root, 'corpus'),
    });
    expect(result.fired).toBe(true);
    // Stage C composes the substrate, which reports under its own capability id.
    await classify(
      { text: 'pick', context: { optionIds: ['a', 'b'] } },
      'decision-recommendation',
      { repoRoot: root, skipCorpus: true, judgment: { artifactsDir: artifacts } },
    );
    expect(row('decisions.stage-c-recommendation').lastDegradedReason).toBe('no-invoker');
  });
});

describe('judgment runtime reports (exactly once, no legacy double report)', () => {
  const KEY = 'fake@fake-1';
  const choice = (c: string, confidence: number): JudgmentAnswer => ({
    type: 'choice',
    choice: c,
    probabilities: { [c]: confidence },
    confidence,
  });
  function cfg(mode: 'shadow' | 'enforce') {
    return resolveJudgmentConfig({
      spec: {
        provider: 'fake',
        model: 'fake-1',
        judgments: {
          'capture.triage': {
            mode,
            thresholds: { [KEY]: { confidence: 0.8, distance: 0.3 } },
            promotion: { [KEY]: { path: 'override', evidence: 'operator walkthrough' } },
          },
        },
      },
    });
  }
  function opts(provider: FakeJudgmentProvider, mode: 'shadow' | 'enforce') {
    return {
      repoRoot: root,
      skipCorpus: true,
      sourceKind: 'backlog',
      judgment: { config: cfg(mode), getProvider: () => provider, artifactsDir: artifacts },
    };
  }

  it('enforce + act reports live once', async () => {
    const p = new FakeJudgmentProvider().script('answer', choice('quick-fix-task', 0.95));
    const d = await classify(IN, 'capture-triage', opts(p, 'enforce'));
    expect(d.classification).toBe('quick-fix-task');
    expect(row('classifier.capture-triage').status).toBe('live');
    expect(total('classifier.capture-triage')).toBe(1);
  });

  it('shadow reports shadow once', async () => {
    const p = new FakeJudgmentProvider().script('answer', choice('quick-fix-task', 0.95));
    const d = await classify(IN, 'capture-triage', opts(p, 'shadow'));
    expect(d.classification).toBe('pending');
    expect(row('classifier.capture-triage').status).toBe('shadow');
    expect(total('classifier.capture-triage')).toBe(1);
  });

  it('an abstaining judgment reports degraded with the abstain reason, once', async () => {
    // No scripted answer: the provider errors and the judgment abstains.
    const p = new FakeJudgmentProvider();
    await classify(IN, 'capture-triage', opts(p, 'enforce'));
    const r = row('classifier.capture-triage');
    expect(r.status).toBe('degraded');
    expect(r.lastDegradedReason).toBe('provider-error');
    expect(total('classifier.capture-triage')).toBe(1);
  });

  it('a disabled judgment context still reports degraded through the builder callback', async () => {
    const ctx = buildJudgmentContext({
      artifactsDir: artifacts,
      config: resolveJudgmentConfig({ spec: {} }),
    });
    expect(typeof ctx.onCapabilityOutcome).toBe('function');
    ctx.onCapabilityOutcome?.({
      capabilityId: 'classifier.capture-triage',
      outcome: 'degraded',
      reason: 'disabled',
    });
    expect(row('classifier.capture-triage').lastDegradedReason).toBe('disabled');
  });
});

const READY: IssueInput = {
  source: 'backlog',
  id: 'T-1',
  title: 'Add CLI flag',
  body: [
    '## Description',
    'Add a new flag to `pipeline-cli/src/cli/index.ts`.',
    '',
    '## Acceptance Criteria',
    '- [ ] #1 `pipeline-cli/src/cli/index.ts` accepts the flag',
    '- [ ] #2 README documents the flag',
  ].join('\n'),
};

function spawnerPass() {
  return new MockSpawner({
    'refinement-reviewer': {
      type: 'refinement-reviewer',
      output: JSON.stringify({
        gates: [
          { gateId: 4, verdict: 'pass', confidence: 'high', finding: 'ok' },
          { gateId: 6, verdict: 'pass', confidence: 'high', finding: 'ok' },
        ],
      }),
      status: 'success',
      durationMs: 1,
    },
  });
}

const norm = (v: unknown) => ({ ...(v as object), signedAt: 'x' });

describe('DoR Stage B', () => {
  it('reports degraded no-spawner when Stage A is returned alone', async () => {
    await evaluateIssueE2E(READY, { hermetic: true, artifactsDir: artifacts });
    const r = row('dor.stage-b');
    expect(r.status).toBe('degraded');
    expect(r.lastDegradedReason).toBe('no-spawner');
    expect(total('dor.stage-b')).toBe(1);
  });

  it('reports live when a spawner supplies Stage B verdicts', async () => {
    await evaluateIssueE2E(READY, {
      hermetic: true,
      artifactsDir: artifacts,
      stageB: { spawner: spawnerPass() },
    });
    expect(row('dor.stage-b').status).toBe('live');
    expect(total('dor.stage-b')).toBe(1);
  });

  it('returns the same verdict with an unwritable state directory', async () => {
    const a = await evaluateIssueE2E(READY, { hermetic: true, artifactsDir: artifacts });
    const b = await evaluateIssueE2E(READY, { hermetic: true, artifactsDir: unwritable });
    expect(norm(b)).toEqual(norm(a));
  });

  it('records one report when the judgment layer and the spawner both cover the capability', async () => {
    const p = new FakeJudgmentProvider();
    for (const id of [1, 2, 3, 4, 5, 6, 7])
      p.script(`gate-${id}`, { type: 'noul', probability: 0.5 });
    const config = resolveJudgmentConfig({
      spec: { provider: 'fake', model: 'fake-1', defaults: { mode: 'shadow' } },
    });
    const seen: string[] = [];
    await evaluateIssueE2E(READY, {
      hermetic: true,
      artifactsDir: artifacts,
      stageB: { spawner: spawnerPass() },
      judgment: {
        context: {
          config,
          getProvider: () => p,
          onCapabilityOutcome: ({ capabilityId, outcome, reason }) => {
            seen.push(`${capabilityId}:${outcome}`);
            reportCapabilityOutcome(capabilityId, outcome, {
              artifactsDir: artifacts,
              ...(reason ? { reason } : {}),
            });
          },
        },
      },
    });
    expect(seen).toEqual(['dor.stage-b:live']);
    expect(total('dor.stage-b')).toBe(1);
  });

  it('a shadow judgment with no spawner reports shadow once', async () => {
    const p = new FakeJudgmentProvider();
    for (const id of [1, 2, 3, 4, 5, 6, 7])
      p.script(`gate-${id}`, { type: 'noul', probability: 0.5 });
    const config = resolveJudgmentConfig({
      spec: { provider: 'fake', model: 'fake-1', defaults: { mode: 'shadow' } },
    });
    await evaluateIssueE2E(READY, {
      hermetic: true,
      artifactsDir: artifacts,
      judgment: {
        context: {
          config,
          getProvider: () => p,
          onCapabilityOutcome: ({ capabilityId, outcome, reason }) =>
            reportCapabilityOutcome(capabilityId, outcome, {
              artifactsDir: artifacts,
              ...(reason ? { reason } : {}),
            }),
        },
      },
    });
    expect(row('dor.stage-b').status).toBe('shadow');
    expect(total('dor.stage-b')).toBe(1);
  });
});

const DECISION = {
  metadata: { id: 'DEC-1', scope: 'x' },
  spec: { summary: 'pick', options: [{ id: 'a', description: 'A' }] },
} as unknown as Decision;

const STAGE_A = {
  reversibility: 'reversible',
  blastRadius: { blockedTaskCount: 0, affectedPillars: [] },
  decisionTreeDepth: 0,
  capacityCheck: { available: true },
  prioritySignal: 0.5,
  resolvedByStageA: false,
} as unknown as StageAOutput;

describe('decision Stage B signals', () => {
  it('reports degraded constant for every constant run, once per call', () => {
    runStageB({ decision: DECISION, stageA: STAGE_A, artifactsDir: artifacts });
    expect(row('decisions.stage-b-signals').lastDegradedReason).toBe('constant');
    expect(total('decisions.stage-b-signals')).toBe(1);
    runBaselineStageB({
      decision: DECISION,
      stageA: STAGE_A as never,
      artifactsDir: artifacts,
    });
    expect(total('decisions.stage-b-signals')).toBe(2);
  });

  it('reports live when judged signals are supplied', () => {
    runStageB({
      decision: DECISION,
      stageA: STAGE_A,
      signals: { novelty: 0.2, exemplarSimilarity: 0.9 },
      artifactsDir: artifacts,
    });
    expect(row('decisions.stage-b-signals').status).toBe('live');
  });

  it('returns the same output with an unwritable state directory', () => {
    const a = runStageB({ decision: DECISION, stageA: STAGE_A, artifactsDir: artifacts });
    const b = runStageB({ decision: DECISION, stageA: STAGE_A, artifactsDir: unwritable });
    expect(b).toEqual(a);
  });

  it('runStageBWithJudgment reports once per invocation, and not when the judgment ran', () => {
    const input = {
      decision: DECISION,
      stageAInput: { decision: DECISION, workDir: root },
      artifactsDir: artifacts,
    };
    runStageBWithJudgment(input);
    expect(row('decisions.stage-b-signals').lastDegradedReason).toBe('constant');
    expect(total('decisions.stage-b-signals')).toBe(1);
    runStageBWithJudgment({ ...input, judgmentConsulted: true });
    expect(total('decisions.stage-b-signals')).toBe(1);
  });
});

function writeTask(dir: string, id: string, title: string, extra = ''): void {
  mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, 'backlog', 'tasks', `${id.toLowerCase()} - task.md`),
    `---\nid: ${id}\ntitle: "${title}"\nstatus: To Do\n${extra}---\n\n## Description\n\nDo the thing.\n`,
  );
}

describe('estimation', () => {
  it('class assignment reports degraded regex when the heuristic decides', () => {
    writeTask(root, 'T-1', 'fix: crash on start');
    const r = runStageA({ taskId: 'T-1', workDir: root, artifactsDir: artifacts });
    expect(r.classSource).toBe('heuristic');
    const c = row('estimation.class-assignment');
    expect(c.status).toBe('degraded');
    expect(c.lastDegradedReason).toBe('regex');
    expect(total('estimation.class-assignment')).toBe(1);
  });

  it('reports nothing when frontmatter decides', () => {
    writeTask(root, 'T-2', 'fix: crash on start', 'class: chore\n');
    const r = runStageA({ taskId: 'T-2', workDir: root, artifactsDir: artifacts });
    expect(r.classSource).toBe('frontmatter');
    expect(total('estimation.class-assignment')).toBe(0);
  });

  it('does not report a second time when the judgment layer was consulted', () => {
    writeTask(root, 'T-3', 'fix: crash on start');
    runStageA({ taskId: 'T-3', workDir: root, artifactsDir: artifacts, judgmentConsulted: true });
    expect(total('estimation.class-assignment')).toBe(0);
  });

  it('returns the same Stage A result with an unwritable state directory', () => {
    writeTask(root, 'T-4', 'feat: add thing');
    const a = runStageA({ taskId: 'T-4', workDir: root, artifactsDir: artifacts });
    const b = runStageA({ taskId: 'T-4', workDir: root, artifactsDir: unwritable });
    expect(b.taskClass).toBe(a.taskClass);
    expect(b.candidateBucket).toBe(a.candidateBucket);
  });

  const stageAResult = {
    escalateToStageB: true,
    confidence: 'low',
    taskClass: 'feature',
    candidateBucket: 'M',
    signals: [],
  } as unknown as StageAResult;

  it('Stage B reports degraded no-invoker when escalation asks for it with no invoker', async () => {
    const r = await runEstimationStageB({
      taskTitle: 't',
      taskDescription: '',
      stageAResult,
      variance: 0,
      artifactsDir: artifacts,
    });
    expect(r.invoked).toBe(false);
    expect(row('estimation.stage-b').lastDegradedReason).toBe('no-invoker');
    expect(total('estimation.stage-b')).toBe(1);
  });

  it('Stage B reports nothing when escalation conditions are not met', async () => {
    await runEstimationStageB({
      taskTitle: 't',
      taskDescription: '',
      stageAResult: { ...stageAResult, escalateToStageB: false } as StageAResult,
      variance: 0,
      artifactsDir: artifacts,
    });
    expect(total('estimation.stage-b')).toBe(0);
  });

  it('Stage B reports live for a parsed verdict and degraded otherwise', async () => {
    const ok = await runEstimationStageB({
      taskTitle: 't',
      taskDescription: '',
      stageAResult,
      variance: 0,
      invoker: async () => 'BUCKET: M\nJUSTIFICATION: fine',
      artifactsDir: artifacts,
    });
    expect(ok.invoked).toBe(true);
    expect(row('estimation.stage-b').status).toBe('live');
    await runEstimationStageB({
      taskTitle: 't',
      taskDescription: '',
      stageAResult,
      variance: 0,
      invoker: async () => {
        throw new Error('down');
      },
      artifactsDir: artifacts,
    });
    expect(row('estimation.stage-b').lastDegradedReason).toBe('invoker-error');
    await runEstimationStageB({
      taskTitle: 't',
      taskDescription: '',
      stageAResult,
      variance: 0,
      invoker: async () => 'no verdict here',
      artifactsDir: artifacts,
    });
    expect(row('estimation.stage-b').lastDegradedReason).toBe('invalid-response');
  });

  it('Stage B returns the same result with an unwritable state directory', async () => {
    const args = { taskTitle: 't', taskDescription: '', stageAResult, variance: 0 };
    const a = await runEstimationStageB({ ...args, artifactsDir: artifacts });
    const b = await runEstimationStageB({ ...args, artifactsDir: unwritable });
    expect(b).toEqual(a);
  });
});

describe('nothing configured: every pipeline-cli capability degrades with a reason', () => {
  it('exercises each instrumented site once', async () => {
    const dir = artifacts;
    const sites = [
      'capture-triage',
      'capture-severity',
      'pr-comment-is-capture',
      'dor-answer-is-new-concern',
      'decision-recommendation',
    ] as const;
    for (const task of sites) {
      await classify(IN, task, {
        repoRoot: root,
        skipCorpus: true,
        judgment: { artifactsDir: dir },
      });
    }
    runStageB({ decision: DECISION, stageA: STAGE_A, artifactsDir: dir });
    await evaluateIssueE2E(READY, { hermetic: true, artifactsDir: dir });
    writeTask(root, 'T-9', 'fix: crash');
    runStageA({ taskId: 'T-9', workDir: root, artifactsDir: dir });
    await runEstimationStageB({
      taskTitle: 't',
      taskDescription: '',
      stageAResult: {
        escalateToStageB: true,
        confidence: 'low',
        taskClass: 'feature',
        candidateBucket: 'M',
        signals: [],
      } as unknown as StageAResult,
      variance: 0,
      artifactsDir: dir,
    });
    for (const id of PIPELINE_CLI_CAPABILITIES) {
      const r = row(id, dir);
      expect(r.status, id).toBe('degraded');
      expect((r.lastDegradedReason ?? '').length, id).toBeGreaterThan(0);
    }
    // The state file never carries input text.
    const raw = readFileSync(join(dir, '_capabilities', 'state.json'), 'utf8');
    expect(raw).not.toContain('rename the flag');
  });
});
