/**
 * `cli-staged-review`, driven in process over a real git repository. The probe spawner is
 * injected, so nothing starts a model.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeSpawner } from '../review-plan/executor.js';
import { buildStagedReviewCli } from './staged-review.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const TASK = 'AISDLC-676';
const TASK_FILE = `---
id: AISDLC-676
title: staged
status: In Progress
references:
  - src/
---

## Acceptance Criteria
- [ ] #1 b is exported
- [ ] #2 b is tested
`;

function makeRepo(withTask = true): { repo: string; artifacts: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'staged-cli-')));
  roots.push(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });
  if (withTask) writeFileSync(join(repo, 'backlog', 'tasks', `aisdlc-676 - staged.md`), TASK_FILE);
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'a.test.ts'), "test('a', () => {});\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return { repo, artifacts: join(repo, '.ai-sdlc', 'artifacts') };
}

let out: string[];
let savedOut: typeof process.stdout.write;
beforeEach(() => {
  out = [];
  savedOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = savedOut;
});

async function run(
  argv: string[],
  deps: Parameters<typeof buildStagedReviewCli>[1] = {},
): Promise<Record<string, unknown>> {
  out = [];
  await buildStagedReviewCli(argv, deps).parseAsync();
  return JSON.parse(out.join('')) as Record<string, unknown>;
}

const prepArgs = (f: { repo: string; artifacts: string }) => [
  'prepare',
  ...common(f),
  '--source-kind',
  'backlog',
];

const common = (f: { repo: string; artifacts: string }) => [
  '--task-id',
  TASK,
  '--work-dir',
  f.repo,
  '--artifacts-dir',
  f.artifacts,
];

const evidence = JSON.stringify({
  observations: ['b is exported'],
  excerpts: [],
  commands: [],
  answer: { text: 'yes', confidence: 'high' },
});
const spawner: ProbeSpawner = {
  enforcesFileScope: { 'claude-code': true, codex: false },
  honoursEmptyToolList: { 'claude-code': true, codex: false },
  async spawnProbe() {
    return { status: 'success', output: evidence };
  },
};

describe('cli-staged-review', () => {
  it('walks prepare, plan, execute, synth-prompt, finalize and status', async () => {
    const f = makeRepo();
    const prep = await run(prepArgs(f));
    expect(prep.ok).toBe(true);
    const runDir = prep.runDir as string;
    expect(readFileSync(prep.plannerPromptPath as string, 'utf8')).toContain('b is exported');

    const baseline = JSON.parse(readFileSync(join(runDir, 'baseline.json'), 'utf8')) as {
      version: string;
      probes: unknown[];
    };
    const plannerOut = join(f.repo, 'planner.txt');
    writeFileSync(
      plannerOut,
      JSON.stringify({
        schemaVersion: 1,
        baselineVersion: baseline.version,
        probes: baseline.probes,
      }),
    );
    const planned = await run([
      'plan',
      ...common(f),
      '--seal',
      prep.seal as string,
      '--planner-output',
      plannerOut,
    ]);
    expect(planned).toMatchObject({ status: 'planned', source: 'planner' });

    const executed = await run(['execute', ...common(f), '--seal', planned.seal as string], {
      spawner,
    });
    expect((executed.probes as { total: number }).total).toBe(baseline.probes.length);

    const synth = await run(['synth-prompt', ...common(f), '--seal', executed.seal as string]);
    expect(existsSync(synth.promptPath as string)).toBe(true);

    const synthOut = join(f.repo, 'synth.txt');
    writeFileSync(
      synthOut,
      JSON.stringify({
        approved: true,
        findings: [],
        summary: 'ok',
        promptInjectionDetected: false,
      }),
    );
    const done = await run([
      'finalize',
      ...common(f),
      '--seal',
      executed.seal as string,
      '--synthesizer-output',
      synthOut,
      '--planner-model',
      'opus',
      '--synthesizer-model',
      'fable',
    ]);
    expect(done.ok).toBe(true);
    const leaves = JSON.parse(readFileSync(done.leavesPath as string, 'utf8')) as {
      stage: string;
      model: string;
    }[];
    expect(leaves[0]).toMatchObject({ stage: 'plan', model: 'opus' });
    expect(leaves.at(-1)).toMatchObject({ stage: 'synthesize', model: 'fable' });

    const status = await run(['status', ...common(f)]);
    expect(status).toMatchObject({ status: 'finalized', taskId: TASK });
  });

  it('asks for a corrected plan, then falls back, from the command line', async () => {
    const f = makeRepo();
    const prep = await run(prepArgs(f));
    const seal = ['--seal', prep.seal as string];
    const bad = join(f.repo, 'planner.txt');
    writeFileSync(bad, '{"schemaVersion":1,"baselineVersion":"1","probes":[]}');
    expect((await run(['plan', ...common(f), ...seal, '--planner-output', bad])).status).toBe(
      'retry',
    );
    expect(
      await run(['plan', ...common(f), ...seal, '--planner-output', bad, '--attempt', '2']),
    ).toMatchObject({ status: 'planned', source: 'fallback' });
    // A missing planner file counts as a rejected attempt, not a crash.
    const absent = join(f.repo, 'absent.txt');
    expect((await run(['plan', ...common(f), ...seal, '--planner-output', absent])).status).toBe(
      'retry',
    );
    expect(
      (await run(['plan', ...common(f), ...seal, '--planner-output', absent, '--attempt', '2']))
        .status,
    ).toBe('planned');
  });

  it('requires the source kind and a seal on every later phase', async () => {
    const f = makeRepo();
    await expect(run(['prepare', ...common(f)])).rejects.toThrow();
    await expect(run(['plan', ...common(f)])).rejects.toThrow();
  });

  it('falls back to the existing set when the run state no longer matches its seal', async () => {
    const f = makeRepo();
    const prep = await run(prepArgs(f));
    const cfgPath = join(prep.runDir as string, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { commandAllowlist: string[] };
    // What a prompt-injected agent with a write tool could do: widen the command allowlist.
    writeFileSync(
      cfgPath,
      JSON.stringify({ ...cfg, commandAllowlist: [...cfg.commandAllowlist, 'curl x'] }),
    );
    const r = await run(['plan', ...common(f), '--seal', prep.seal as string]);
    expect(r).toMatchObject({ ok: false, reason: 'integrity-check-failed', fallbackSet: 'three' });
    expect(await run(['status', ...common(f)])).toMatchObject({
      status: 'fallback',
      fallbackSet: 'three',
      reason: 'integrity-check-failed',
    });
  });

  it('answers fallback for gh-issue work and records it', async () => {
    const f = makeRepo();
    const r = await run(['prepare', ...common(f), '--source-kind', 'gh-issue']);
    expect(r).toMatchObject({ ok: false, reason: 'untrusted-source', fallbackSet: 'three' });
    expect(await run(['status', ...common(f)])).toMatchObject({
      status: 'fallback',
      fallbackSet: 'three',
    });
  });

  it('answers fallback when the task cannot be read', async () => {
    const f = makeRepo(false);
    const r = await run(prepArgs(f));
    expect(r).toMatchObject({ ok: false, reason: 'task-unreadable', fallbackSet: 'three' });
  });

  it('reports no record before anything ran, and reads a diff from a file', async () => {
    const f = makeRepo();
    expect(await run(['status', ...common(f)])).toEqual({ status: 'none' });
    const diffFile = join(f.repo, 'x.diff');
    writeFileSync(diffFile, '   ');
    expect(await run([...prepArgs(f), '--diff-file', diffFile])).toMatchObject({
      ok: false,
      reason: 'diff-unavailable',
    });
  });
});
