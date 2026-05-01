/**
 * CLI router tests — drive the yargs program in-process and assert on
 * stdout JSON. We swap process.argv per test to simulate `ai-sdlc-pipeline <cmd>`
 * invocations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCli } from './index.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = makeTmpProject();
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  // Prevent the process from actually exiting under yargs strict-mode failure.
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  cleanupTmpProject(tmp);
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'ai-sdlc-pipeline', ...args];
}

function stdoutJson(): unknown {
  // The last JSON-looking chunk (yargs may emit other text first).
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
  }
  return null;
}

describe('CLI router', () => {
  it('validate-task emits ok=true for a valid task', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'cli demo', status: 'To Do' });
    setArgv('validate-task', 'AISDLC-1', '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { ok: boolean; task?: { id: string } };
    expect(result.ok).toBe(true);
    expect(result.task?.id).toBe('AISDLC-1');
  });

  it('validate-task emits ok=false for a Draft task', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'd', status: 'Draft' });
    setArgv('validate-task', 'AISDLC-2', '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { ok: boolean; reason?: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Draft/);
  });

  it('compute-branch returns branch + worktreePath', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-3', title: 'compute me', status: 'To Do' });
    setArgv('compute-branch', 'AISDLC-3', '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { branch: string; worktreePath: string };
    expect(result.branch).toMatch(/^ai-sdlc\/aisdlc-3-/);
    expect(result.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-3'));
  });

  it('build-dev-prompt returns the prompt + branch', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-4', title: 'prompt', status: 'To Do' });
    setArgv('build-dev-prompt', 'AISDLC-4', '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { prompt: string; branch: string };
    expect(result.prompt).toContain('AISDLC-4');
    expect(result.branch).toMatch(/aisdlc-4/);
  });

  it('parse-dev-return surfaces the parsed developer return on success', async () => {
    const dev = JSON.stringify({
      summary: 's',
      filesChanged: [],
      commitSha: 'abc',
      verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
      acceptanceCriteriaMet: [1],
    });
    setArgv('parse-dev-return', '--return', dev, '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it('aggregate-verdicts returns APPROVED for clean verdicts', async () => {
    const verdicts = JSON.stringify([
      { agentId: 'code-reviewer', harness: 'claude-code', approved: true, findings: [] },
      { agentId: 'test-reviewer', harness: 'claude-code', approved: true, findings: [] },
      { agentId: 'security-reviewer', harness: 'claude-code', approved: true, findings: [] },
    ]);
    setArgv('aggregate-verdicts', '--verdicts', verdicts, '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { decision: string };
    expect(result.decision).toBe('APPROVED');
  });

  it('cleanup-task is a no-op when sentinel absent (idempotent)', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-5'), { recursive: true });
    setArgv('cleanup-task', 'AISDLC-5', '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { sentinelRemoved: boolean };
    expect(result.sentinelRemoved).toBe(false);
  });

  it('sweep-worktrees returns swept=[] when .worktrees does not exist', async () => {
    setArgv('sweep-worktrees', '--work-dir', tmp);
    await buildCli().parseAsync();
    const result = stdoutJson() as { swept: unknown[] };
    expect(result.swept).toEqual([]);
  });
});
