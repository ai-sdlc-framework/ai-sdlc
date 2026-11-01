import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendModelCalls, type ModelCallRecord, type PriceRow } from '@ai-sdlc/reference';
import { buildUsageCli, type UsageCliDeps } from '../cli/usage.js';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  projectAll,
} from '../decisions/index.js';
import { editTableText, modelToWrite, type CommandRunner } from './route-apply.js';
import { repoIdFor } from './repo-id.js';
import { defaultUsageConfig } from './usage-config.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const T0 = Date.parse('2026-09-10T00:00:00Z');
const SONNET = 'claude-sonnet-4-5';
const HAIKU = 'claude-haiku-4-5';

let root: string;
let usageDir: string;
let repo: string;
let artifacts: string;
let decisions: string;
let out: string[];
let err: string[];
let exitCode: number | undefined;
let repoId: string;
let calls: Array<{ cmd: string; args: string[] }>;
let dirty: string;
let written: Map<string, string>;

function gitInit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...a], {
      stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '', HOME: root },
    });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  return repoIdFor(dir) as string;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'route-apply-'));
  usageDir = join(root, 'usage');
  repo = join(root, 'repo-a');
  artifacts = join(root, 'art');
  decisions = join(root, 'decisions');
  mkdirSync(join(repo, '.ai-sdlc', 'reviews'), { recursive: true });
  repoId = gitInit(repo);
  out = [];
  err = [];
  calls = [];
  dirty = '';
  written = new Map();
  exitCode = undefined;
  vi.stubEnv('AI_SDLC_USAGE_DIR', usageDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeFixtureDir(root);
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

const TABLE = `# header comment
apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
spec:
  strength: [haiku, sonnet, opus] # weakest first
  cells:
    developer:
      '*': { model: sonnet, candidates: [haiku] } # dev
    code-reviewer:
      '*': { model: sonnet }
    security-reviewer:
      '*': { model: opus }
`;

function seedTasks(prefix: string, model: string, n: number, approved: number): void {
  const recs: ModelCallRecord[] = [];
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const taskId = `${prefix}-${i}`;
    recs.push({
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
      repoId,
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
  appendModelCalls(recs, { dir: usageDir });
  writeFileSync(join(repo, '.ai-sdlc', 'reviews', `${prefix}.jsonl`), `${lines.join('\n')}\n`);
}

let committedTable = '';
const exec: CommandRunner = (cmd, args, cwd) => {
  calls.push({ cmd, args });
  if (cmd === 'git' && args[0] === 'status') return dirty;
  if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
    mkdirSync(args[4] as string, { recursive: true });
  }
  if (cmd === 'git' && args.includes('commit')) {
    committedTable = readFileSync(join(cwd, '.ai-sdlc', 'model-routing.yaml'), 'utf8');
  }
  if (cmd === 'git' && args[0] === 'add') {
    // record what would be committed
    for (const f of args.slice(2)) written.set(f, 'staged');
  }
  if (cmd === 'gh') return 'https://github.com/o/r/pull/9\n';
  return '';
};

function deps(extra: Partial<UsageCliDeps> = {}): UsageCliDeps {
  return {
    usageDir,
    now: () => new Date(T0 + 3_600_000),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    setExitCode: (c) => void (exitCode = c),
    emit: () => {},
    priceRows: [price(SONNET, 2), price(HAIKU, 1)],
    loadConfig: () => defaultUsageConfig(),
    repoRoot: repo,
    workDir: repo,
    artifactsDir: artifacts,
    decisionsWorkDir: decisions,
    readBaseTable: () => TABLE,
    routeExec: exec,
    ...extra,
  };
}

async function run(args: string[], extra: Partial<UsageCliDeps> = {}): Promise<string> {
  out.length = 0;
  err.length = 0;
  exitCode = undefined;
  await buildUsageCli(['route', ...args], deps(extra)).parseAsync();
  return out.join('');
}

/** Files a real proposal and returns its body. */
async function propose(): Promise<void> {
  seedTasks('S', SONNET, 40, 32);
  seedTasks('H', HAIKU, 30, 24);
  await run(['propose']);
}

const answer = (id: string, option: string, by: string | undefined = 'op@example.invalid') =>
  appendDecisionEvent(
    makeOperatorAnsweredEvent({
      decisionId: id,
      chosenOptionId: option,
      ...(by ? { by } : {}),
      now: new Date(T0 + 7_200_000),
    }),
    { workDir: decisions },
  );

function body(id = 'DEC-0001'): string {
  return projectAll({ workDir: decisions }).decisions.get(id)?.spec.body ?? '';
}

/** Files a second Decision carrying an edited body, as a hand-crafted proposal would. */
function fileCrafted(
  edit: (b: string) => string,
  by = 'framework:route-propose',
  source = 'framework-calibration',
  extraOptions: string[] = [],
): string {
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId: 'DEC-0002',
      source: source as 'framework-calibration',
      scope: 'routing:model-proposal',
      summary: 'crafted',
      body: edit(body()),
      reversible: true,
      options: [
        { id: 'approve-all', description: 'a' },
        { id: 'decline', description: 'd' },
        ...extraOptions.map((id) => ({ id, description: id })),
      ],
      by,
      now: new Date(T0 + 3_700_000),
    }),
    { workDir: decisions },
  );
  return 'DEC-0002';
}

const gitCalls = (name: string) => calls.filter((c) => c.cmd === 'git' && c.args[0] === name);

describe('cli-usage route apply', () => {
  it('writes the family alias, leaves strength alone, and opens a PR with only table + evidence', async () => {
    await propose();
    answer('DEC-0001', 'approve-all');
    const text = await run(['apply', '--decision', 'DEC-0001']);
    expect(text).toContain('https://github.com/o/r/pull/9');
    expect(exitCode).toBeUndefined();
    const add = gitCalls('add')[0]?.args.slice(2) ?? [];
    expect(add[0]).toBe('.ai-sdlc/model-routing.yaml');
    expect(add.slice(1).every((f) => f.startsWith('.ai-sdlc/routing-evidence/DEC-0001/'))).toBe(
      true,
    );
    expect(add.length).toBeGreaterThan(1);
    const pr = calls.find((c) => c.cmd === 'gh')?.args.join('\n') ?? '';
    expect(pr).toContain(`Ids counted as the same model: ${HAIKU}`);
    expect(pr).toContain('sonnet -> haiku');
    expect(pr).toContain('24/30');
    expect(gitCalls('worktree').some((c) => c.args[1] === 'remove')).toBe(true);
    expect(committedTable).toContain('strength: [haiku, sonnet, opus] # weakest first');
    expect(committedTable).toContain(
      "model: haiku, candidates: [haiku], evidence: '.ai-sdlc/routing-evidence/DEC-0001/",
    );
    expect(committedTable).toContain('previousModel: sonnet');
  });

  it('with --pin writes the versioned id and adds it to strength', async () => {
    await propose();
    answer('DEC-0001', 'approve-all');
    await run(['apply', '--decision', 'DEC-0001', '--pin']);
    expect(exitCode).toBeUndefined();
    expect(calls.some((c) => c.cmd === 'gh')).toBe(true);
    expect(committedTable).toContain(`strength: [haiku, ${HAIKU}, sonnet, opus]`);
    expect(committedTable).toContain(`model: ${HAIKU}, candidates`);
  });

  it('modelToWrite: alias by default, pinned on request, refuses unknown family', () => {
    expect(modelToWrite({ to: HAIKU, mergedModels: [] }, true, false)).toEqual({
      model: 'haiku',
      pinned: false,
    });
    expect(modelToWrite({ to: HAIKU, mergedModels: [] }, true, true)).toEqual({
      model: HAIKU,
      pinned: true,
    });
    expect(modelToWrite({ to: 'haiku', mergedModels: [HAIKU] }, true, true)).toEqual({
      model: HAIKU,
      pinned: true,
    });
    expect(modelToWrite({ to: 'haiku', mergedModels: [] }, true, true)).toContain('--pin');
    expect(modelToWrite({ to: 'gpt-5', mergedModels: [] }, true, false)).toContain('no known');
    expect(modelToWrite({ to: 'gpt-5', mergedModels: [] }, false, false)).toEqual({
      model: 'gpt-5',
      pinned: false,
    });
  });

  it('editTableText changes only the cell line and the strength line', () => {
    const edit = {
      role: 'developer',
      taskClass: '*',
      model: 'haiku',
      previousModel: 'sonnet',
      evidence: '.ai-sdlc/routing-evidence/x.json',
    };
    const r = editTableText(TABLE, [edit], [{ id: HAIKU, after: 'haiku' }]);
    expect(typeof r).toBe('string');
    const before = TABLE.split('\n');
    const after = (r as string).split('\n');
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toContain(`haiku, ${HAIKU}, sonnet`);
    expect(changed[1]).toContain("model: haiku, candidates: [haiku], evidence: '.ai-sdlc/");
    expect(changed[1]).toContain('# dev');
    expect(editTableText(TABLE, [{ ...edit, role: 'nope' }], [])).toHaveProperty('error');
    expect(editTableText(TABLE, [{ ...edit, taskClass: 'x' }], [])).toHaveProperty('error');
    expect(editTableText('a: 1', [], [{ id: 'x', after: 'y' }])).toHaveProperty('error');
    expect(editTableText(TABLE, [], [{ id: 'x', after: 'nope' }])).toHaveProperty('error');
  });

  it('refuses an unanswered Decision and a declined one, changing nothing', async () => {
    await propose();
    await run(['apply', '--decision', 'DEC-0001']);
    expect(exitCode).toBe(1);
    expect(out.join('')).toContain('has not been answered');
    answer('DEC-0001', 'decline');
    await run(['apply', '--decision', 'DEC-0001']);
    expect(exitCode).toBe(1);
    expect(out.join('')).toContain('declined');
    expect(calls).toHaveLength(0);
  });

  it('refuses a missing decision, bad id and non-proposal', async () => {
    await run(['apply', '--decision', 'nope']);
    expect(out.join('')).toContain('invalid decision id');
    await run(['apply', '--decision', 'DEC-0099']);
    expect(out.join('')).toContain('not found');
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'framework-calibration',
        scope: 'other',
        summary: 's',
        reversible: true,
        options: [{ id: 'x', description: 'x' }],
        by: 'framework:route-propose',
      }),
      { workDir: decisions },
    );
    answer('DEC-0001', 'x');
    await run(['apply', '--decision', 'DEC-0001']);
    expect(out.join('')).toContain('not a routing proposal');
    expect(calls).toHaveLength(0);
  });

  it('refuses when an evidence file no longer matches its digest', async () => {
    await propose();
    answer('DEC-0001', 'approve-all');
    const ref = /"evidence": \[\s*"([^"]+)"/.exec(body())?.[1] as string;
    writeFileSync(join(artifacts, ref), '{"tampered":true}\n');
    await run(['apply', '--decision', 'DEC-0001']);
    expect(exitCode).toBe(1);
    expect(out.join('')).toContain('does not match its recorded digest');
    expect(calls).toHaveLength(0);
  });

  it('refuses when the evidence no longer qualifies on re-derivation', async () => {
    await propose();
    answer('DEC-0001', 'approve-all');
    // Candidate quality collapses: 30 more haiku tasks, all rejected.
    seedTasks('H2', HAIKU, 30, 0);
    await run(['apply', '--decision', 'DEC-0001']);
    expect(exitCode).toBe(1);
    expect(out.join('')).toContain('no longer qualifies');
    expect(calls).toHaveLength(0);
  });

  it('refuses decisions not filed by the proposal command or answered by the framework', async () => {
    await propose();
    const forged = fileCrafted((b) => b, 'someone', 'ad-hoc');
    answer(forged, 'approve-all');
    await run(['apply', '--decision', forged]);
    expect(out.join('')).toContain('not filed by the routing proposal command');

    const framework = fileCrafted((b) => b);
    expect(framework).toBe('DEC-0002');
  });

  it('refuses an answer recorded as the framework', async () => {
    await propose();
    answer('DEC-0001', 'approve-all', 'framework');
    await run(['apply', '--decision', 'DEC-0001']);
    expect(out.join('')).toContain('not recorded by the operator');
    expect(calls).toHaveLength(0);
  });

  it('refuses a model name or run id outside the grammar before any write', async () => {
    await propose();
    const bad = fileCrafted((b) => b.replace('"to": "haiku"', '"to": "haiku; rm -rf /"'));
    answer(bad, 'approve-all');
    await run(['apply', '--decision', bad]);
    expect(out.join('')).toContain('outside the allowed grammar');
    expect(calls).toHaveLength(0);
  });

  it('refuses a versioned id that maps to no known family', async () => {
    await propose();
    const bad = fileCrafted((b) => b.replace('"to": "haiku"', '"to": "gpt-5"'));
    answer(bad, 'approve-all');
    await run(['apply', '--decision', bad]);
    expect(out.join('')).toContain('maps to no known model family');
    expect(calls).toHaveLength(0);
  });

  it('refuses a dirty working tree, and a catalog that is off', async () => {
    await propose();
    answer('DEC-0001', 'approve-all');
    dirty = ' M file\n';
    await run(['apply', '--decision', 'DEC-0001']);
    expect(out.join('')).toContain('uncommitted changes');
    expect(gitCalls('worktree')).toHaveLength(0);
    await run(['apply', '--decision', 'DEC-0001'], { env: { AI_SDLC_DECISIONS: 'off' } });
    expect(exitCode).toBe(1);
  });

  it('applies only the approved cells of a subset approval', async () => {
    await propose();
    const two = fileCrafted(
      (b) => {
        const m = /```json\n([\s\S]*?)\n```/.exec(b) as RegExpExecArray;
        const block = JSON.parse(m[1] as string);
        block.changes.push({ ...block.changes[0], taskClass: 'other' });
        return b.replace(m[1] as string, JSON.stringify(block));
      },
      'framework:route-propose',
      'framework-calibration',
      ['approve-1', 'approve-2'],
    );
    answer(two, 'approve-1');
    await run(['apply', '--decision', two]);
    expect(exitCode).toBeUndefined();
    const pr = calls.find((c) => c.cmd === 'gh')?.args.join('\n') ?? '';
    expect(pr).toContain('Not approved');
    expect(pr).toContain('developer / other');
  });

  it('refuses an answer that names a change that does not exist', async () => {
    await propose();
    const crafted = fileCrafted((b) => b, 'framework:route-propose', 'framework-calibration', [
      'approve-7',
    ]);
    answer(crafted, 'approve-7');
    await run(['apply', '--decision', crafted]);
    expect(out.join('')).toContain('does not exist');
    expect(calls).toHaveLength(0);
  });

  it('refuses when the table cell moved since the proposal', async () => {
    await propose();
    answer('DEC-0001', 'approve-all');
    await run(['apply', '--decision', 'DEC-0001'], {
      readBaseTable: () => TABLE.replace('model: sonnet, candidates', 'model: opus, candidates'),
    });
    expect(out.join('')).toContain('no longer uses sonnet');
    expect(readFileSync(join(repo, '.ai-sdlc', 'reviews', 'S.jsonl'), 'utf8')).toBeTruthy();
  });
});
