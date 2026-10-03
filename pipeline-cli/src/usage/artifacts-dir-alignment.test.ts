import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import { recordModelCall } from '@ai-sdlc/reference';
import { buildUsageCli } from '../cli/usage.js';
import { appendAssignment, assignmentLogPath } from '../routing/assignment-log.js';
import { defaultArtifactsDir, routingArtifactsDir } from '../routing/artifacts-dir.js';
import { resolveModel } from '../routing/resolve-model.js';
import { repoNameFor } from './attribution.js';
import { defaultUsageConfig } from './usage-config.js';
import { isUnderAiSdlc } from './replay-commands.js';

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
let root: string;
let usageDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'align-proj-'));
  usageDir = mkdtempSync(join(tmpdir(), 'align-usage-'));
  savedEnv = process.env.ARTIFACTS_DIR;
  delete process.env.ARTIFACTS_DIR;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ARTIFACTS_DIR;
  else process.env.ARTIFACTS_DIR = savedEnv;
  rmSync(root, RM);
  rmSync(usageDir, RM);
});

async function cli(args: string[]): Promise<{ out: string; err: string; exit: number }> {
  let out = '';
  let err = '';
  let exit = 0;
  await buildUsageCli(args, {
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    setExitCode: (c) => void (exit = c),
    now: () => new Date('2026-09-30T12:00:00Z'),
    usageDir,
    repoRoot: root,
    workDir: root,
    priceRows: [],
    loadConfig: () => defaultUsageConfig(),
  }).parseAsync();
  return { out, err, exit };
}

describe('default artifacts directory', () => {
  it('is the same path for the resolver, the scorecard and replay with ARTIFACTS_DIR unset', async () => {
    const expected = join(root, '.ai-sdlc', 'artifacts');
    expect(defaultArtifactsDir(root)).toBe(expected);
    expect(routingArtifactsDir(root)).toBe(expected);
    const score = await cli(['scorecard']);
    expect(score.out).toContain(`Artifacts directory: ${expected}\n`);
    const replay = await cli(['replay-corpus', 'build']);
    expect(replay.exit).toBe(0);
    expect(existsSync(join(expected, 'replay', 'corpus.json'))).toBe(true);
    expect(replay.out).toContain(`Artifacts directory: ${expected}\n`);
    const resolved = resolveModel({
      role: 'developer',
      taskId: 'DEMO-0',
      taskClass: 'chore',
      workDir: root,
    });
    expect(resolved).toBeDefined();
    expect(existsSync(assignmentLogPath(expected))).toBe(true);
    expect(assignmentLogPath(expected).startsWith(expected)).toBe(true);
  });

  it('scorecard csv prints the artifacts directory on stderr, not stdout', async () => {
    const res = await cli(['scorecard', '--format', 'csv']);
    const line = `Artifacts directory: ${defaultArtifactsDir(root)}`;
    expect(res.err).toContain(line);
    expect(res.out).not.toContain('Artifacts directory:');
  });

  it('lets ARTIFACTS_DIR override the default', () => {
    process.env.ARTIFACTS_DIR = join(root, 'elsewhere');
    expect(routingArtifactsDir(root)).toBe(join(root, 'elsewhere'));
  });

  it('scorecard reads an assignment log the resolver wrote at the default location', async () => {
    const repo = repoNameFor(root);
    const r = resolveModel({
      role: 'developer',
      taskId: 'DEMO-1',
      taskClass: 'chore',
      workDir: root,
    });
    // The resolver may or may not explore; force a known explored record through the real writer too.
    appendAssignment(defaultArtifactsDir(root), {
      ts: '2026-09-30T00:00:00.000Z',
      taskId: 'DEMO-2',
      role: 'developer',
      taskClass: 'chore',
      iteration: 1,
      model: 'model-x',
      arm: 'explore',
      reason: 'explore',
    });
    expect(assignmentLogPath(defaultArtifactsDir(root))).toContain(join('.ai-sdlc', 'artifacts'));
    expect(r.model).toBeDefined();
    expect(readFileSync(assignmentLogPath(defaultArtifactsDir(root)), 'utf8')).toContain(
      '"taskId":"DEMO-1"',
    );
    expect(['default', 'table', 'explore', 'override']).toContain(r.arm);
    expect(existsSync(assignmentLogPath(defaultArtifactsDir(root)))).toBe(true);
    recordModelCall(
      {
        provider: 'anthropic',
        model: 'model-x',
        tokens: { input: 100 },
        agentRole: 'ai-sdlc:developer',
        scope: 'framework',
        repo,
        taskId: 'DEMO-2',
        ts: '2026-09-20T00:00:00Z',
      },
      { dir: usageDir },
    );
    appendReviewLedgerRecord(
      {
        taskId: 'DEMO-2',
        prNumber: null,
        commitSha: 'a'.repeat(40),
        iteration: 1,
        role: 'code',
        harness: 'claude-code',
        timestamp: '2026-09-21T00:00:00Z',
        verdict: 'approved',
        findings: [],
      },
      root,
    );
    const res = await cli(['scorecard', '--format', 'json']);
    expect(res.exit).toBe(0);
    const json = JSON.parse(res.out) as { rows: Array<{ explored: number }> };
    expect(json.rows.reduce((n, row) => n + row.explored, 0)).toBe(1);
    expect(res.err).toContain(`Artifacts directory: ${defaultArtifactsDir(root)}`);
  });
});

describe('replay guard narrowing', () => {
  function mk(...parts: string[]): string {
    const p = join(root, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  }

  it('allows .ai-sdlc/artifacts and descendants, refuses the rest of .ai-sdlc', () => {
    mk('.ai-sdlc', 'artifacts');
    expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts'), root)).toBe(false);
    expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts', 'replay', 'c.json'), root)).toBe(
      false,
    );
    for (const sub of [
      'attestations',
      'verdicts',
      'transcripts',
      'reviews',
      'config.yaml',
      'config',
      'artifacts-evil',
      'artifactsX',
    ]) {
      expect(isUnderAiSdlc(join(root, '.ai-sdlc', sub, 'x.json'), root)).toBe(true);
    }
    expect(isUnderAiSdlc(join(root, '.ai-sdlc'), root)).toBe(true);
    expect(
      isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts', '..', 'attestations', 'a'), root),
    ).toBe(true);
    expect(isUnderAiSdlc(join(root, 'artifacts', 'x.json'), root)).toBe(false);
  });

  it('is case-insensitive on darwin and win32 only', () => {
    mk('.ai-sdlc', 'artifacts');
    expect(isUnderAiSdlc(join(root, '.AI-SDLC', 'Attestations', 'x'), root, 'darwin')).toBe(true);
    expect(isUnderAiSdlc(join(root, '.AI-SDLC', 'ATTESTATIONS', 'x'), root, 'win32')).toBe(true);
    expect(isUnderAiSdlc(join(root, '.AI-SDLC', 'Artifacts', 'x'), root, 'darwin')).toBe(false);
    expect(isUnderAiSdlc(join(root, '.AI-SDLC', 'attestations', 'x'), root, 'linux')).toBe(false);
  });

  it('refuses a symlinked .ai-sdlc, even for its artifacts subdirectory', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'align-else-'));
    try {
      mkdirSync(join(elsewhere, 'artifacts'));
      symlinkSync(elsewhere, join(root, '.ai-sdlc'));
      expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts', 'x.json'), root)).toBe(true);
      expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'other', 'x.json'), root)).toBe(true);
    } finally {
      rmSync(elsewhere, RM);
    }
  });

  it('refuses a symlinked .ai-sdlc/artifacts that resolves elsewhere', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'align-else-'));
    try {
      mk('.ai-sdlc');
      symlinkSync(elsewhere, join(root, '.ai-sdlc', 'artifacts'));
      expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts', 'x.json'), root)).toBe(true);
    } finally {
      rmSync(elsewhere, RM);
    }
  });

  it('refuses a symlink under artifacts that points into the rest of .ai-sdlc or outside', () => {
    mk('.ai-sdlc', 'artifacts');
    mk('.ai-sdlc', 'attestations');
    symlinkSync(join(root, '.ai-sdlc', 'attestations'), join(root, '.ai-sdlc', 'artifacts', 'a'));
    const outside = mkdtempSync(join(tmpdir(), 'align-out-'));
    try {
      symlinkSync(outside, join(root, '.ai-sdlc', 'artifacts', 'o'));
      expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts', 'a', 'x.json'), root)).toBe(true);
      expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts', 'o', 'x.json'), root)).toBe(true);
    } finally {
      rmSync(outside, RM);
    }
  });

  it('treats a child named ..x as inside, not outside', () => {
    mk('.ai-sdlc', 'artifacts', '..x');
    expect(isUnderAiSdlc(join(root, '.ai-sdlc', 'artifacts', '..x', 'c.json'), root)).toBe(false);
    mk('.ai-sdlc', '..x');
    expect(isUnderAiSdlc(join(root, '.ai-sdlc', '..x', 'c.json'), root)).toBe(true);
  });

  it('refuses a replay results path that is a symlink into the rest of .ai-sdlc', async () => {
    mk('.ai-sdlc', 'artifacts');
    mk('.ai-sdlc', 'attestations');
    symlinkSync(join('..', 'attestations'), join(root, '.ai-sdlc', 'artifacts', 'replay'));
    const res = await cli([
      'replay',
      '--role',
      'code',
      '--model',
      'm',
      '--max-items',
      '1',
      '--max-units',
      '10',
      '--dry-run',
    ]);
    expect(res.exit).toBe(1);
    expect(res.err).toContain('Refusing to write replay results under .ai-sdlc');
  });

  it('keeps refusing config under .ai-sdlc through the replay and corpus commands', async () => {
    mk('.ai-sdlc');
    const args = [
      'replay',
      '--role',
      'code',
      '--model',
      'm',
      '--max-items',
      '1',
      '--max-units',
      '10',
      '--dry-run',
    ];
    process.env.ARTIFACTS_DIR = join(root, '.ai-sdlc', 'attestations');
    expect((await cli(args)).exit).toBe(1);
    delete process.env.ARTIFACTS_DIR;
    const r = await cli([
      'replay-corpus',
      'build',
      '--out',
      join(root, '.ai-sdlc', 'verdicts', 'c.json'),
    ]);
    expect(r.exit).toBe(1);
    expect(r.err).toContain('Refusing to write the corpus under .ai-sdlc');
  });
});

describe('replay output ordering', () => {
  const sha = 'a'.repeat(40);
  function corpus(): void {
    const dir = join(root, '.ai-sdlc', 'artifacts', 'replay');
    mkdirSync(dir, { recursive: true });
    const item = (label: string, taskId: string) => ({
      taskId,
      role: 'code',
      commitSha: sha,
      mergeBase: 'b'.repeat(40),
      label,
      iteration: 1,
    });
    writeFileSync(
      join(dir, 'corpus.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        generatedAt: '2026-09-30T00:00:00Z',
        baseRef: 'origin/main',
        items: [item('known-defect', 'DEMO-1'), item('clean', 'DEMO-2')],
        skipped: {},
      }),
    );
  }
  const base = [
    'replay',
    '--role',
    'code',
    '--model',
    'm',
    '--max-items',
    '2',
    '--max-units',
    '10',
  ];

  it('prints the Spend cap line before the Artifacts directory line', async () => {
    corpus();
    const res = await cli(base);
    expect(res.exit).toBe(1);
    const spend = res.out.indexOf('Spend cap');
    const dir = res.out.indexOf('Artifacts directory:');
    expect(spend).toBeGreaterThanOrEqual(0);
    expect(dir).toBeGreaterThan(spend);
  });

  it('prints the Artifacts directory line first with --dry-run, with no spend cap line', async () => {
    corpus();
    const res = await cli([...base, '--dry-run']);
    expect(res.exit).toBe(0);
    expect(res.out.startsWith('Artifacts directory:')).toBe(true);
    expect(res.out).not.toContain('Spend cap');
  });
});
