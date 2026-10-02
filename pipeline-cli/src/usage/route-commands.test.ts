import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendModelCalls, type ModelCallRecord, type PriceRow } from '@ai-sdlc/reference';
import { buildUsageCli, type UsageCliDeps } from '../cli/usage.js';
import {
  appendDecisionEvent,
  makeOperatorAnsweredEvent,
  projectAll,
  readDecisionEvents,
} from '../decisions/index.js';
import { ROUTING_PROPOSAL_SCOPE, enumerateCells, findOpenProposal } from './route-commands.js';
import { defaultUsageConfig } from './usage-config.js';

const T0 = Date.parse('2026-09-10T00:00:00Z');

let root: string;
let usageDir: string;
let repo: string;
let artifacts: string;
let decisions: string;
let out: string[];
let err: string[];
let exitCode: number | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'route-propose-'));
  usageDir = join(root, 'usage');
  repo = join(root, 'repo-a');
  artifacts = join(root, 'art');
  decisions = join(root, 'decisions');
  mkdirSync(join(repo, '.ai-sdlc', 'reviews'), { recursive: true });
  out = [];
  err = [];
  exitCode = undefined;
  vi.stubEnv('AI_SDLC_USAGE_DIR', usageDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function price(model: string, input: number): PriceRow {
  return {
    model,
    inputPer1M: input,
    outputPer1M: input * 5,
    cacheReadPer1M: input * 0.1,
    cacheWrite5mPer1M: input * 1.25,
    cacheWrite1hPer1M: input * 2,
    source: 'test',
    url: 'https://example.invalid/prices',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    effectiveFrom: '2026-01-01',
    status: 'active',
  };
}

const TABLE = `
apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
spec:
  strength: [model-haiku-a, model-sonnet-a, model-opus-a]
  cells:
    developer:
      '*': { model: model-sonnet-a, candidates: [model-haiku-a] }
    code-reviewer:
      '*': { model: model-sonnet-a, candidates: [model-haiku-a] }
    security-reviewer:
      '*': { model: model-opus-a }
`;

/** `n` tasks for `model`, of which `approved` were approved first pass. */
function seedTasks(prefix: string, model: string, n: number, approved: number): void {
  const calls: ModelCallRecord[] = [];
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const taskId = `${prefix}-${i}`;
    calls.push({
      schemaVersion: 'v1',
      callId: `${taskId}-c`,
      ts: new Date(T0).toISOString(),
      harness: 'claude-code',
      provider: 'anthropic',
      model,
      tokens: { input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
      billingPool: 'subscription-interactive',
      sessionId: 's',
      agentRole: 'ai-sdlc:developer',
      scope: 'framework',
      repo: 'repo-a',
      taskId,
    });
    const ok = i < approved;
    lines.push(
      JSON.stringify({
        taskId,
        prNumber: null,
        commitSha: 'a'.repeat(40),
        iteration: 1,
        role: 'code',
        harness: 'claude-code',
        timestamp: 't',
        verdict: ok ? 'approved' : 'rejected',
        findings: ok ? [] : [{ severity: 'major', summary: 's', title: 't' }],
      }),
    );
  }
  appendModelCalls(calls, { dir: usageDir });
  writeFileSync(join(repo, '.ai-sdlc', 'reviews', `${prefix}.jsonl`), `${lines.join('\n')}\n`);
}

function deps(extra: Partial<UsageCliDeps> = {}): UsageCliDeps {
  return {
    usageDir,
    now: () => new Date(T0 + 3_600_000),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    setExitCode: (c) => void (exitCode = c),
    emit: () => {},
    priceRows: [price('model-sonnet-a', 2), price('model-haiku-a', 1), price('model-opus-a', 10)],
    loadConfig: () => defaultUsageConfig(),
    repoRoot: repo,
    workDir: repo,
    artifactsDir: artifacts,
    decisionsWorkDir: decisions,
    readBaseTable: () => TABLE,
    attributionCounts: () => ({ legacyRecords: 0, unavailableRecords: 0 }),
    ...extra,
  };
}

async function run(args: string[], extra: Partial<UsageCliDeps> = {}): Promise<string> {
  out.length = 0;
  await buildUsageCli(['route', ...args], deps(extra)).parseAsync();
  return out.join('');
}

const catalog = () => readDecisionEvents({ workDir: decisions }).events;

function seedQualifying(): void {
  seedTasks('S', 'model-sonnet-a', 40, 32); // 80%
  seedTasks('H', 'model-haiku-a', 30, 24); // 80%
}

describe('cli-usage route propose', () => {
  it('files nothing and says so when no candidate qualifies', async () => {
    seedTasks('S', 'model-sonnet-a', 40, 32);
    seedTasks('H', 'model-haiku-a', 29, 24);
    const text = await run(['propose']);
    expect(text).toContain('No candidate qualifies');
    expect(text).toContain('29 compared tasks, 30 needed');
    expect(catalog()).toHaveLength(0);
    expect(existsSync(join(artifacts, '_routing', 'evidence'))).toBe(false);
  });

  it('never qualifies without attribution counts, and says why', async () => {
    seedQualifying();
    const text = await run(['propose'], { attributionCounts: undefined });
    expect(text).toContain('evidence not attributable to this repository');
    expect(catalog()).toHaveLength(0);
    out.length = 0;
    await run(['propose'], {
      attributionCounts: () => ({ legacyRecords: 2, unavailableRecords: 0 }),
    });
    expect(catalog()).toHaveLength(0);
  });

  it('dry run lists the change and writes nothing', async () => {
    seedQualifying();
    const text = await run(['propose', '--dry-run']);
    expect(text).toContain('Dry run: would file one Decision listing 1 change');
    expect(text).toContain('developer / *: model-sonnet-a -> model-haiku-a');
    expect(catalog()).toHaveLength(0);
    expect(existsSync(join(artifacts, '_routing'))).toBe(false);
  });

  it('files exactly one Decision with counts, rates and evidence, and no task ids', async () => {
    seedQualifying();
    const text = await run(['propose']);
    expect(text).toContain('Filed DEC-0001 listing 1 change');
    const events = catalog();
    expect(events).toHaveLength(1);
    const d = projectAll({ workDir: decisions }).decisions.get('DEC-0001');
    expect(d?.metadata.scope).toBe(ROUTING_PROPOSAL_SCOPE);
    expect(d?.status.lifecycle).not.toBe('answered');
    expect(d?.spec.options.map((o) => o.id)).toEqual(['approve-all', 'decline']);
    const body = d?.spec.body ?? '';
    expect(body).toContain('24/30 first-pass approved');
    expect(body).toContain('32/40');
    expect(body).toContain('"kind": "model-routing-proposal"');
    // counts and attribution only: no per-task ids, no source content
    expect(body).not.toMatch(/\bS-\d+\b|\bH-\d+\b/);

    const machine = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)?.[1] ?? '{}');
    expect(machine.changes).toHaveLength(1);
    const refs: string[] = machine.changes[0].evidence;
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(ref.startsWith('_routing/evidence/2026-09-10/')).toBe(true);
      const file = JSON.parse(readFileSync(join(artifacts, ref), 'utf8'));
      expect(file.scope).toBe('framework');
    }
  });

  it('files nothing while a proposal is open, then again once it is answered', async () => {
    seedQualifying();
    await run(['propose']);
    expect(findOpenProposal(decisions)).toBe('DEC-0001');
    const text = await run(['propose']);
    expect(text).toContain('DEC-0001) is still open');
    expect(text).toContain('Silence leaves the table unchanged');
    expect(catalog()).toHaveLength(1);

    appendDecisionEvent(
      makeOperatorAnsweredEvent({ decisionId: 'DEC-0001', chosenOptionId: 'decline' }),
      { workDir: decisions },
    );
    expect(findOpenProposal(decisions)).toBeUndefined();
    expect(await run(['propose'])).toContain('Filed DEC-0002');
    expect(catalog().filter((e) => e.type === 'decision-opened')).toHaveLength(2);
  });

  it('ignores open Decisions that are not routing proposals', async () => {
    seedQualifying();
    await run(['propose', '--dry-run']);
    appendDecisionEvent(
      {
        eventVersion: 'v1',
        type: 'decision-opened',
        ts: '2026-09-10T00:00:00.000Z',
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'unrelated',
        options: [{ id: 'a', description: 'a' }],
      },
      { workDir: decisions },
    );
    expect(await run(['propose'])).toContain('Filed DEC-0002');
  });

  it('prints JSON', async () => {
    seedQualifying();
    const json = JSON.parse(await run(['propose', '--json']));
    expect(json.outcome).toBe('filed');
    expect(json.decisionId).toBe('DEC-0001');
    expect(json.changes[0]).toMatchObject({
      role: 'developer',
      from: 'model-sonnet-a',
      to: 'model-haiku-a',
    });
  });

  it('honours --min-tasks and --margin-points', async () => {
    seedTasks('S', 'model-sonnet-a', 40, 32);
    seedTasks('H', 'model-haiku-a', 10, 6); // 60%, 20 points below
    const args = ['propose', '--min-tasks', '10', '--dry-run', '--margin-points'];
    expect(await run([...args, '20'])).toContain('Dry run');
    expect(await run([...args, '19'])).toContain('No candidate qualifies');
    expect(await run(['propose', '--margin-points', '20', '--dry-run'])).toContain(
      'No candidate qualifies',
    );
  });

  it('reports no usable table', async () => {
    const text = await run(['propose'], { readBaseTable: () => null });
    expect(text).toContain('No usable routing table (no-table)');
    expect(text).toContain('No candidate qualifies');
  });

  it('respects the Decision Catalog off switch', async () => {
    seedQualifying();
    const text = await run(['propose'], { env: { AI_SDLC_DECISION_CATALOG: 'off' } });
    expect(text).toContain('Decision Catalog is off');
    expect(catalog()).toHaveLength(0);
  });

  it('rejects a bad --since', async () => {
    await run(['propose', '--since', 'nope']);
    expect(exitCode).toBe(1);
    expect(err.join('')).toContain('Invalid --since');
  });

  it('proposes a reviewer change from replay results and cites that file', async () => {
    mkdirSync(join(artifacts, 'replay'), { recursive: true });
    const score = (model: string, recall: number, fb: number) => ({
      model,
      role: 'code',
      reviews: 40,
      errors: 0,
      knownDefect: { items: 20, blocked: recall * 20 },
      clean: { items: 20, blocked: fb * 20 },
      recall,
      falseBlockRate: fb,
      unitsTotal: 0,
      meanUnitsPerReview: null,
      usageMissing: 0,
    });
    writeFileSync(
      join(artifacts, 'replay', 'results-code-run1.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        runId: 'run1',
        generatedAt: 't',
        role: 'code',
        candidate: 'model-haiku-a',
        reference: 'model-sonnet-a',
        stoppedBy: 'completed',
        limits: { maxItems: 40, maxUnits: 1 },
        itemsReplayed: 40,
        skippedUnreachable: 0,
        scores: [score('model-sonnet-a', 0.9, 0.1), score('model-haiku-a', 0.85, 0.15)],
        items: [],
      }),
    );
    const text = await run(['propose']);
    expect(text).toContain('Filed DEC-0001');
    expect(text).toContain('code-reviewer / *: model-sonnet-a -> model-haiku-a');
    expect(text).toContain('replay of 40 item(s)');
    const body = projectAll({ workDir: decisions }).decisions.get('DEC-0001')?.spec.body ?? '';
    expect(body).toContain(join('replay', 'results-code-run1.json'));
  });

  it('warns about unusable replay results and lists no-longer-cheaper cells', async () => {
    mkdirSync(join(artifacts, 'replay'), { recursive: true });
    writeFileSync(join(artifacts, 'replay', 'results-bad.json'), '{not json');
    const table = `${TABLE}`.replace(
      "'*': { model: model-sonnet-a, candidates: [model-haiku-a] }\n    code-reviewer",
      "'*': { model: model-sonnet-a, previousModel: model-haiku-a, evidence: e.json }\n    code-reviewer",
    );
    const text = await run(['propose'], { readBaseTable: () => table });
    expect(text).toContain('Warning: Replay results ignored');
    expect(text).toContain('No longer cheaper at current prices (information only)');
    expect(text).toContain('developer / *: model-sonnet-a (was model-haiku-a)');
  });

  it('includes the no-longer-cheaper list in the filed Decision', async () => {
    seedQualifying();
    const table = TABLE.replace(
      "security-reviewer:\n      '*': { model: model-opus-a }",
      "security-reviewer:\n      '*': { model: model-opus-a }\n    test-reviewer:\n      '*': { model: model-sonnet-a, previousModel: model-haiku-a }",
    );
    await run(['propose'], { readBaseTable: () => table });
    const body = projectAll({ workDir: decisions }).decisions.get('DEC-0001')?.spec.body ?? '';
    expect(body).toContain('no longer cheaper at current prices');
    expect(body).toContain('test-reviewer / *: model-sonnet-a (was model-haiku-a)');
  });
});

describe('enumerateCells', () => {
  it('excludes explicit classes from the wildcard aggregate', () => {
    const cells = enumerateCells({
      strength: ['a', 'b'],
      exploreShare: 0,
      salt: '',
      cells: { developer: { chore: { model: 'b' }, '*': { model: 'b', candidates: ['a'] } } },
    });
    expect(cells.find((c) => c.taskClass === '*')?.excludeClasses).toEqual(['chore']);
    expect(cells.find((c) => c.taskClass === 'chore')?.excludeClasses).toBeUndefined();
  });
});
