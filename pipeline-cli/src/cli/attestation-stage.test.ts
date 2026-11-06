/**
 * `cli-attestation emit-leaf --stage`: the staged review's stages. Plan and execute
 * stages carry no verdict, only the synthesize stage does, and the reviews ledger takes
 * one `staged` row per review.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGED_REVIEWER_NAME } from '../attestation/staged-review.js';
import { loadReviewLedger } from '../attestation/reviews-ledger.js';
import { buildAttestationCli } from './attestation.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const HEAD = 'f'.repeat(40);
const TASK = 'AISDLC-676';

let root: string;
let savedExit: typeof process.exit;
let savedOut: typeof process.stdout.write;
let savedErr: typeof process.stderr.write;
let stderr: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'emit-leaf-stage-'));
  stderr = [];
  savedExit = process.exit;
  savedOut = process.stdout.write.bind(process.stdout);
  savedErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = savedExit;
  process.stdout.write = savedOut;
  process.stderr.write = savedErr;
  removeFixtureDir(root);
});

function fixture(name: string, transcript: string, verdict: unknown): [string, string] {
  const tDir = join(root, '.ai-sdlc', 'transcripts', TASK.toLowerCase());
  const vDir = join(root, '.ai-sdlc', 'verdicts');
  mkdirSync(tDir, { recursive: true });
  mkdirSync(vDir, { recursive: true });
  const t = join(tDir, `${name}.jsonl`);
  const v = join(vDir, `${name}.json`);
  writeFileSync(t, `${JSON.stringify({ role: 'user', content: transcript })}\n`);
  writeFileSync(v, JSON.stringify(verdict));
  return [t, v];
}

async function emit(
  name: string,
  verdict: unknown,
  extra: string[],
  reviewer = STAGED_REVIEWER_NAME,
): Promise<void> {
  const [t, v] = fixture(name, `transcript of ${name}`, verdict);
  await buildAttestationCli([
    'emit-leaf',
    '--repo-root',
    root,
    '--task-id',
    TASK,
    '--reviewer',
    reviewer,
    '--transcript-path',
    t,
    '--verdict-path',
    v,
    '--head-sha',
    HEAD,
    '--harness',
    'claude-code',
    '--model',
    'sonnet',
    ...extra,
  ]).parseAsync();
}

const critical = {
  approved: true,
  findings: [{ severity: 'critical', file: 'src/a.ts', line: 3, message: 'unchecked input' }],
};

describe('emit-leaf --stage', () => {
  it('adds one `staged` ledger row, from the synthesizer leaf only', async () => {
    await emit('planner', critical, ['--stage', 'plan']);
    await emit('probe-a', critical, ['--stage', 'execute']);
    await emit('synth', critical, ['--stage', 'synthesize', '--iteration', '2']);

    const rows = loadReviewLedger(TASK, root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'staged',
      gating: false,
      iteration: 2,
      commitSha: HEAD,
      verdict: 'approved',
    });
    expect(rows[0]!.findings).toHaveLength(1);
    expect(rows[0]!.findings[0]).toMatchObject({ severity: 'critical', area: 'src/a.ts' });
  });

  it('refuses a stage on any reviewer but the staged set', async () => {
    await expect(emit('code', critical, ['--stage', 'execute'], 'code-reviewer')).rejects.toThrow(
      /process\.exit\(1\)/,
    );
    expect(stderr.join('')).toContain('--stage is only valid with --reviewer staged-review');
    expect(loadReviewLedger(TASK, root)).toHaveLength(0);
  });

  it.each(['', 'review', 'EXECUTE'])('rejects the stage %j', async (bad) => {
    await expect(emit('x', critical, ['--stage', bad])).rejects.toThrow();
    expect(loadReviewLedger(TASK, root)).toHaveLength(0);
  });
});
