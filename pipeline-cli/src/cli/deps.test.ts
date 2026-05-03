/**
 * cli-deps router tests — drive the yargs program in-process and assert on
 * stdout/stderr. Mirrors the pattern used by cli/index.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDepsCli } from './deps.js';
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
  process.argv = ['node', 'cli-deps', ...args];
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function stdoutJson(): unknown {
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

describe('cli-deps router', () => {
  it('frontier returns ok=true with an empty list when no tasks exist', async () => {
    setArgv('frontier', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const r = stdoutJson() as { ok: boolean; frontier: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.frontier).toEqual([]);
  });

  it('frontier returns the dispatch-ready tasks (JSON)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-B'] });
    setArgv('frontier', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const r = stdoutJson() as { frontier: Array<{ id: string }> };
    expect(r.frontier.map((e) => e.id)).toEqual(['AISDLC-B']);
  });

  it('frontier --format table emits human-readable text', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'alpha' });
    setArgv('frontier', '--format', 'table', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const text = stdoutText();
    expect(text).toContain('ID');
    expect(text).toContain('AISDLC-A');
    expect(text).toContain('alpha');
  });

  it('blockers lists the transitive open deps for a task', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-B'] });
    setArgv('blockers', 'AISDLC-C', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const r = stdoutJson() as { ok: boolean; blockers: Array<{ id: string }> };
    expect(r.ok).toBe(true);
    expect(r.blockers.map((b) => b.id)).toEqual(['AISDLC-A', 'AISDLC-B']);
  });

  it('blockers --format table renders columns', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    setArgv('blockers', 'AISDLC-B', '--format', 'table', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    expect(stdoutText()).toContain('AISDLC-A');
  });

  it('blockers fails when target is unknown', async () => {
    setArgv('blockers', 'AISDLC-NOPE', '--work-dir', tmp);
    await expect(buildDepsCli().parseAsync()).rejects.toThrow(/process\.exit/);
    expect(stderrChunks.join('')).toContain('unknown task');
  });

  it('impact lists the transitive reverse closure', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-B'] });
    setArgv('impact', 'AISDLC-A', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const r = stdoutJson() as { impact: Array<{ id: string }> };
    expect(r.impact.map((b) => b.id)).toEqual(['AISDLC-B', 'AISDLC-C']);
  });

  it('impact --format table renders columns', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    setArgv('impact', 'AISDLC-A', '--format', 'table', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    expect(stdoutText()).toContain('AISDLC-B');
  });

  it('impact fails when target is unknown', async () => {
    setArgv('impact', 'AISDLC-NOPE', '--work-dir', tmp);
    await expect(buildDepsCli().parseAsync()).rejects.toThrow(/process\.exit/);
  });

  it('validate ok on a clean graph (exit 0)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    setArgv('validate', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const r = stdoutJson() as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it('validate exits non-zero on a cycle', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', dependencies: ['AISDLC-B'] });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    setArgv('validate', '--work-dir', tmp);
    await expect(buildDepsCli().parseAsync()).rejects.toThrow(/process\.exit/);
    const r = stdoutJson() as { cycles: unknown[] };
    expect(r.cycles.length).toBe(1);
  });

  it('validate exits non-zero on dangling refs', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-A',
      title: 'a',
      dependencies: ['AISDLC-MISSING'],
    });
    setArgv('validate', '--work-dir', tmp);
    await expect(buildDepsCli().parseAsync()).rejects.toThrow(/process\.exit/);
  });

  it('graph defaults to mermaid', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    setArgv('graph', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    expect(stdoutText()).toContain('flowchart TD');
  });

  it('graph --format dot emits dot', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    setArgv('graph', '--format', 'dot', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    expect(stdoutText()).toContain('digraph deps');
  });

  it('preflight ok exits 0 on a ready task', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    setArgv('preflight', 'AISDLC-B', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const r = stdoutJson() as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it('preflight exits non-zero with reason when blockers exist', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    setArgv('preflight', 'AISDLC-B', '--work-dir', tmp);
    await expect(buildDepsCli().parseAsync()).rejects.toThrow(/process\.exit/);
    const r = stdoutJson() as { ok: boolean; reason: string; blockers: Array<{ id: string }> };
    expect(r.ok).toBe(false);
    expect(r.blockers[0].id).toBe('AISDLC-A');
  });

  it('preflight exits non-zero on already-shipped task', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    setArgv('preflight', 'AISDLC-A', '--work-dir', tmp);
    await expect(buildDepsCli().parseAsync()).rejects.toThrow(/process\.exit/);
    const r = stdoutJson() as { reason: string };
    expect(r.reason).toMatch(/already shipped/);
  });

  it('preflight exits non-zero on unknown task', async () => {
    setArgv('preflight', 'AISDLC-NOPE', '--work-dir', tmp);
    await expect(buildDepsCli().parseAsync()).rejects.toThrow(/process\.exit/);
    const r = stdoutJson() as { reason: string };
    expect(r.reason).toMatch(/unknown task/);
  });

  // AISDLC-153: stale tasks (file in tasks/ but status: Done) get reclassified
  // as completed AND surface a one-line warning on stderr so the operator can
  // `git mv` + commit without blocking the dispatch loop.
  it('frontier emits a stderr warning for stale-Done tasks but still treats them as completed', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'stale', status: 'Done' });
    writeTaskFile(tmp, {
      id: 'AISDLC-2',
      title: 'next',
      status: 'To Do',
      dependencies: ['AISDLC-1'],
    });
    setArgv('frontier', '--work-dir', tmp);
    await buildDepsCli().parseAsync();
    const r = stdoutJson() as { ok: boolean; frontier: Array<{ id: string }> };
    expect(r.ok).toBe(true);
    // AISDLC-1 is treated as done, so AISDLC-2 unblocks; AISDLC-1 itself is not
    // listed (not open).
    expect(r.frontier.map((e) => e.id)).toEqual(['AISDLC-2']);
    const stderr = stderrChunks.join('');
    expect(stderr).toMatch(/warning: stale task: AISDLC-1/);
    expect(stderr).toMatch(/git mv/);
  });

  // RFC-0014 Phase 1 — snapshot / gc / inspect smoke tests through the router.
  // The deeper functional tests live in `src/deps/snapshot.test.ts`; here we
  // only assert the wiring (subcommand parses, flag is respected, JSON shape).
  describe('RFC-0014 Phase 1 subcommands', () => {
    let priorFlag: string | undefined;

    beforeEach(() => {
      priorFlag = process.env.AI_SDLC_DEPS_COMPOSITION;
    });

    afterEach(() => {
      if (priorFlag === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
      else process.env.AI_SDLC_DEPS_COMPOSITION = priorFlag;
    });

    it('snapshot is a no-op when AI_SDLC_DEPS_COMPOSITION is unset', async () => {
      delete process.env.AI_SDLC_DEPS_COMPOSITION;
      writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
      setArgv('snapshot', '--tag', 'rolling', '--work-dir', tmp);
      await buildDepsCli().parseAsync();
      const r = stdoutJson() as { ok: boolean; written: boolean; reason: string };
      expect(r.ok).toBe(true);
      expect(r.written).toBe(false);
      expect(r.reason).toMatch(/AI_SDLC_DEPS_COMPOSITION/);
    });

    it('snapshot writes a file when the flag is ON', async () => {
      process.env.AI_SDLC_DEPS_COMPOSITION = '1';
      writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
      setArgv(
        'snapshot',
        '--tag',
        'dispatch',
        '--work-dir',
        tmp,
        '--artifacts-dir',
        `${tmp}/artifacts`,
      );
      await buildDepsCli().parseAsync();
      const r = stdoutJson() as {
        ok: boolean;
        written: boolean;
        recordCount: number;
        path: string;
      };
      expect(r.ok).toBe(true);
      expect(r.written).toBe(true);
      expect(r.recordCount).toBe(1);
      expect(r.path).toMatch(/\.dispatch\.jsonl$/);
    });

    it('gc reports counts even when the dir is empty', async () => {
      setArgv('gc', '--work-dir', tmp, '--artifacts-dir', `${tmp}/artifacts`);
      await buildDepsCli().parseAsync();
      const r = stdoutJson() as {
        ok: boolean;
        trimmedCount: number;
        keptCount: number;
        bytesFreed: number;
      };
      expect(r.ok).toBe(true);
      expect(r.trimmedCount).toBe(0);
      expect(r.keptCount).toBe(0);
      expect(r.bytesFreed).toBe(0);
    });

    it('inspect returns an empty list when the dir is empty', async () => {
      setArgv('inspect', '--work-dir', tmp, '--artifacts-dir', `${tmp}/artifacts`);
      await buildDepsCli().parseAsync();
      const r = stdoutJson() as { ok: boolean; snapshots: unknown[] };
      expect(r.ok).toBe(true);
      expect(r.snapshots).toEqual([]);
    });

    it('inspect --format table renders headers', async () => {
      setArgv(
        'inspect',
        '--format',
        'table',
        '--work-dir',
        tmp,
        '--artifacts-dir',
        `${tmp}/artifacts`,
      );
      await buildDepsCli().parseAsync();
      const text = stdoutText();
      expect(text).toContain('Timestamp');
      expect(text).toContain('Tag');
      expect(text).toContain('Records');
    });

    it('snapshot accepts every known tag value', async () => {
      process.env.AI_SDLC_DEPS_COMPOSITION = '1';
      writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
      // Smoke through every member of the SnapshotTag enum so a typo in the
      // yargs `choices` array would surface here. We don't assert on the file
      // path (timestamp-dependent), only that the call resolves with ok=true.
      for (const tag of ['rolling', 'dispatch', 'calibration', 'lifecycle-transition']) {
        stdoutChunks = [];
        setArgv('snapshot', '--tag', tag, '--work-dir', tmp, '--artifacts-dir', `${tmp}/artifacts`);
        await buildDepsCli().parseAsync();
        const r = stdoutJson() as { ok: boolean; tag: string };
        expect(r.ok).toBe(true);
        expect(r.tag).toBe(tag);
      }
    });
  });
});
