/**
 * cli-classify-pr router tests — drive the yargs program in-process and
 * assert on stdout/stderr. Mirrors the style of cli/deps.test.ts.
 *
 * Covers:
 *   - AC-6: docs-only diff → 0-or-1-reviewer subset (critic only per ruleset)
 *   - AC-7: code diff → meaningful subset (full 3 in default-fallback branch,
 *     subsets in lockfile / CI / auth branches)
 *   - AC-4: missing input falls open (ALL_REVIEWERS) instead of crashing
 *   - AC-5: --artifacts-dir appends the calibration entry
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClassifyPrCli } from './classify-pr.js';
import type { ClassifierDecision } from '../classifier/classifier.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-classify-pr-'));
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
  rmSync(tmp, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli-classify-pr', ...args];
}

function stdoutJson<T = ClassifierDecision>(): T {
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      return JSON.parse(c) as T;
    }
  }
  throw new Error(`no JSON found in stdout: ${stdoutChunks.join('')}`);
}

describe('cli-classify-pr — paths-file input', () => {
  it('AC-6: docs-only diff → critic-only (0-or-1 reviewers per ruleset)', async () => {
    const pathsFile = join(tmp, 'paths.txt');
    writeFileSync(pathsFile, 'README.md\ndocs/intro.md\n');
    setArgv('classify', '--paths-file', pathsFile);
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.fellOpen).toBe(false);
    expect(d.reviewers).toEqual(['critic']);
    // AC-8 uses the confidence value to render "(confidence: N.NN)" in the PR body
    expect(d.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('AC-7: code-diff default-fallback → all 3 reviewers', async () => {
    const pathsFile = join(tmp, 'paths.txt');
    writeFileSync(pathsFile, 'src/foo.ts\nsrc/bar.ts\nsrc/foo.test.ts\n');
    setArgv('classify', '--paths-file', pathsFile);
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.fellOpen).toBe(false);
    expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
  });

  it('AC-7: lockfile-only diff → security + critic subset (testing dropped)', async () => {
    const pathsFile = join(tmp, 'paths.txt');
    writeFileSync(pathsFile, 'package-lock.json\n');
    setArgv('classify', '--paths-file', pathsFile);
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.fellOpen).toBe(false);
    expect([...d.reviewers].sort()).toEqual(['critic', 'security']);
  });

  it('AC-7: auth-touching diff bumps security to opus + runs all 3', async () => {
    const pathsFile = join(tmp, 'paths.txt');
    writeFileSync(pathsFile, 'src/auth/session.ts\n');
    setArgv('classify', '--paths-file', pathsFile);
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
    // modelOverride is preserved on rawOutput so callers can plumb it through
    expect(d.rawOutput?.modelOverride?.security).toBe('opus');
  });
});

describe('cli-classify-pr — diff-file input', () => {
  it('parses unified diff and routes docs-only correctly', async () => {
    const diffFile = join(tmp, 'pr.diff');
    writeFileSync(
      diffFile,
      [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1,2 @@',
        ' # repo',
        '+## new section',
      ].join('\n'),
    );
    setArgv('classify', '--diff-file', diffFile);
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.reviewers).toEqual(['critic']);
  });
});

describe('cli-classify-pr — numstat input', () => {
  it('parses numstat and routes auth-touching diff to all 3 reviewers', async () => {
    const numstatFile = join(tmp, 'numstat.txt');
    writeFileSync(numstatFile, '12\t3\tsrc/auth/session.ts\n0\t5\tsrc/login.ts\n');
    setArgv('classify', '--numstat-file', numstatFile);
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
  });
});

describe('cli-classify-pr — fall-open semantics (AC-4)', () => {
  it('falls open with ALL 3 reviewers when no input flag is given (no --allow-empty)', async () => {
    setArgv('classify');
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('invocation-failed');
    expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
  });

  it('falls open with ALL 3 reviewers when input file does not exist', async () => {
    setArgv('classify', '--paths-file', join(tmp, 'does-not-exist.txt'));
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('invocation-failed');
    expect([...d.reviewers].sort()).toEqual(['critic', 'security', 'testing']);
    // stderr must explain what happened so the operator can debug
    expect(stderrChunks.join('')).toMatch(/failed to read input file/);
  });

  it('falls open when more than one input flag is set (misconfiguration)', async () => {
    const a = join(tmp, 'a.txt');
    const b = join(tmp, 'b.txt');
    writeFileSync(a, 'README.md\n');
    writeFileSync(b, 'src/foo.ts\n');
    setArgv('classify', '--paths-file', a, '--diff-file', b);
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('invocation-failed');
    expect(stderrChunks.join('')).toMatch(/exactly one of/);
  });

  it('--allow-empty + no input → 0 reviewers (no fall-open)', async () => {
    setArgv('classify', '--allow-empty');
    await buildClassifyPrCli().parseAsync();
    const d = stdoutJson();
    expect(d.fellOpen).toBe(false);
    expect(d.reviewers).toEqual([]);
  });
});

describe('cli-classify-pr — calibration log (AC-5)', () => {
  it('writes a JSONL entry to <artifacts-dir>/_classifier/calibration.jsonl', async () => {
    const pathsFile = join(tmp, 'paths.txt');
    writeFileSync(pathsFile, 'README.md\n');
    const artifactsDir = join(tmp, 'artifacts');
    setArgv(
      'classify',
      '--paths-file',
      pathsFile,
      '--artifacts-dir',
      artifactsDir,
      '--issue-id',
      'AISDLC-141',
    );
    await buildClassifyPrCli().parseAsync();

    const logPath = join(artifactsDir, '_classifier', 'calibration.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8').trim();
    const entry = JSON.parse(content);
    expect(entry.issueId).toBe('AISDLC-141');
    expect(entry.diffStats.paths).toEqual(['README.md']);
    expect(entry.fellOpen).toBe(false);
    expect(entry.classifierOutput.reviewers).toEqual(['critic']);
  });

  it('does not write calibration entry when --artifacts-dir is omitted', async () => {
    const pathsFile = join(tmp, 'paths.txt');
    writeFileSync(pathsFile, 'README.md\n');
    setArgv('classify', '--paths-file', pathsFile);
    await buildClassifyPrCli().parseAsync();
    // Sanity: tmp dir should still be empty other than paths.txt
    expect(existsSync(join(tmp, '_classifier'))).toBe(false);
  });

  it('--skip-calibration suppresses the write even with --artifacts-dir set', async () => {
    const pathsFile = join(tmp, 'paths.txt');
    writeFileSync(pathsFile, 'README.md\n');
    const artifactsDir = join(tmp, 'artifacts');
    setArgv(
      'classify',
      '--paths-file',
      pathsFile,
      '--artifacts-dir',
      artifactsDir,
      '--skip-calibration',
    );
    await buildClassifyPrCli().parseAsync();
    expect(existsSync(join(artifactsDir, '_classifier'))).toBe(false);
  });

  it('writes a fall-open entry when input is missing (auditability of bypass)', async () => {
    const artifactsDir = join(tmp, 'artifacts');
    setArgv('classify', '--artifacts-dir', artifactsDir, '--issue-id', 'AISDLC-141');
    await buildClassifyPrCli().parseAsync();
    const logPath = join(artifactsDir, '_classifier', 'calibration.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(entry.fellOpen).toBe(true);
    expect(entry.fellOpenReason).toBe('invocation-failed');
  });
});
