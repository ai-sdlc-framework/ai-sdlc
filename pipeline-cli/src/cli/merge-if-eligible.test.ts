/**
 * Hermetic tests for `cli-merge-if-eligible`'s render helpers
 * (RFC-0048 Phase 3 / AISDLC-603). The pure eligibility core is covered in
 * `../governance/merge-if-eligible.test.ts`; this file only covers the
 * CLI-facing render/format layer that the yargs router calls.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMergeIfEligibleCli, renderJsonResult, renderResult } from './merge-if-eligible.js';
import {
  loadTrustedPolicyModule,
  STRICT_DEFAULTS,
  TEST_ONLY_POLICY_ROOT_ENV,
  type RunMergeIfEligibleResult,
} from '../governance/merge-if-eligible.js';
import type { ExecResult, Runner } from '../runtime/exec.js';

function baseResult(overrides: Partial<RunMergeIfEligibleResult> = {}): RunMergeIfEligibleResult {
  return {
    prNumber: 42,
    policy: STRICT_DEFAULTS,
    eligibility: { eligible: false, reason: 'governance policy allowMerge="never"' },
    merged: false,
    dryRun: false,
    ...overrides,
  };
}

describe('renderResult', () => {
  it('renders a REFUSED line with the reason', () => {
    const text = renderResult(baseResult());
    expect(text).toContain('PR #42');
    expect(text).toContain('REFUSED');
    expect(text).toContain('allowMerge="never"');
  });

  it('renders a MERGED line', () => {
    const text = renderResult(
      baseResult({
        merged: true,
        eligibility: { eligible: true, reason: 'all checks green' },
      }),
    );
    expect(text).toContain('MERGED');
  });

  it('renders a DRY-RUN line', () => {
    const text = renderResult(
      baseResult({
        dryRun: true,
        eligibility: { eligible: true, reason: 'all checks green' },
      }),
    );
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('eligible=true');
  });
});

describe('renderJsonResult', () => {
  it('serialises ok/merged/dryRun/policy/reason', () => {
    const json = JSON.parse(
      renderJsonResult(
        baseResult({
          merged: true,
          eligibility: { eligible: true, reason: 'all good' },
        }),
      ),
    );
    expect(json).toMatchObject({
      ok: true,
      prNumber: 42,
      merged: true,
      dryRun: false,
      reason: 'all good',
    });
    expect(json.policy).toEqual(STRICT_DEFAULTS);
  });

  it('reports ok:false for a refusal', () => {
    const json = JSON.parse(renderJsonResult(baseResult()));
    expect(json.ok).toBe(false);
  });
});

// ── yargs router (end-to-end, real repoRoot filesystem lookup) ────────

function makeFakeRunner(handlers: Record<string, Partial<ExecResult> | Error>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: Runner = async (command, args, opts) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(' ')}`;
    for (const [pattern, response] of Object.entries(handlers)) {
      if (key.includes(pattern)) {
        if (response instanceof Error) throw response;
        const r: ExecResult = { stdout: '', stderr: '', code: 0, ...response };
        if (r.code !== 0 && !opts?.allowFailure) {
          throw new Error(`fake ${key} failed`);
        }
        return r;
      }
    }
    throw new Error(`no fake handler registered for: ${key}`);
  };
  return { runner, calls };
}

describe('buildMergeIfEligibleCli — yargs router', () => {
  let savedArgv: string[];
  let savedExit: typeof process.exit;
  let savedStdout: typeof process.stdout.write;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let savedStderr: typeof process.stderr.write;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[TEST_ONLY_POLICY_ROOT_ENV];
    // These tests drive --repo-root at a nonexistent dir: that override is
    // only honoured under the explicit test-only env var.
    process.env[TEST_ONLY_POLICY_ROOT_ENV] = '1';
    savedStderr = process.stderr.write.bind(process.stderr);
    stderrChunks = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    savedArgv = process.argv;
    savedExit = process.exit;
    savedStdout = process.stdout.write.bind(process.stdout);
    stdoutChunks = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exit = savedExit;
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
    if (savedEnv === undefined) delete process.env[TEST_ONLY_POLICY_ROOT_ENV];
    else process.env[TEST_ONLY_POLICY_ROOT_ENV] = savedEnv;
  });

  it('AC1 — refuses (process.exit(1)) under strict policy, no gh calls beyond repo-slug resolution', async () => {
    process.argv = [
      'node',
      'merge-if-eligible',
      '42',
      '--source-kind',
      'backlog',
      '--repo',
      'org/repo',
      '--repo-root',
      '/definitely/does/not/exist/aisdlc-603',
      '--format',
      'json',
    ];
    const fake = makeFakeRunner({});
    let thrown: unknown;
    try {
      await buildMergeIfEligibleCli({ runner: fake.runner }).parseAsync();
    } catch (e) {
      thrown = e;
    }
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).toBe('process.exit(1)');
    const parsed = JSON.parse(stdoutChunks.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/allowMerge="never"/);
  });

  it('AC3 — refuses (process.exit(1)) for an external sourceKind', async () => {
    process.argv = [
      'node',
      'merge-if-eligible',
      '42',
      '--source-kind',
      'gh-issue',
      '--repo',
      'org/repo',
      '--repo-root',
      '/definitely/does/not/exist/aisdlc-603',
      '--format',
      'json',
    ];
    const fake = makeFakeRunner({});
    let thrown: unknown;
    try {
      await buildMergeIfEligibleCli({ runner: fake.runner }).parseAsync();
    } catch (e) {
      thrown = e;
    }
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).toBe('process.exit(1)');
    const parsed = JSON.parse(stdoutChunks.join(''));
    expect(parsed.ok).toBe(false);
  });

  async function runCli(argv: string[], runner: Runner): Promise<string> {
    process.argv = ['node', 'merge-if-eligible', ...argv];
    let thrown: unknown;
    try {
      await buildMergeIfEligibleCli({ runner }).parseAsync();
    } catch (e) {
      thrown = e;
    }
    return thrown instanceof Error ? thrown.message : String(thrown);
  }

  it('test-only mode without --repo derives the slug from cwd via gh and refuses under strict', async () => {
    const fake = makeFakeRunner({ 'gh repo view': { stdout: 'org/repo\n' } });
    const msg = await runCli(
      ['42', '--source-kind', 'backlog', '--repo-root', '/definitely/does/not/exist/aisdlc-663'],
      fake.runner,
    );
    expect(msg).toBe('process.exit(1)');
    expect(stdoutChunks.join('')).toContain('REFUSED');
    expect(fake.calls).toHaveLength(1);
  });

  it('production: --repo-root is ignored (with a notice) and an unverifiable cwd refuses with zero gh calls', async () => {
    delete process.env[TEST_ONLY_POLICY_ROOT_ENV];
    const plain = mkdtempSync(join(tmpdir(), 'aisdlc-663-5-cwd-'));
    try {
      const fake = makeFakeRunner({});
      const msg = await runCli(
        [
          '42',
          '--source-kind',
          'backlog',
          '--repo-root',
          plain,
          '--cwd',
          plain,
          '--format',
          'json',
        ],
        fake.runner,
      );
      expect(msg).toBe('process.exit(1)');
      const parsed = JSON.parse(stdoutChunks.join(''));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toMatch(/verified main checkout/);
      expect(stderrChunks.join('')).toMatch(/--repo-root is test-only and was ignored/);
      expect(fake.calls).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const canVerify =
    loadTrustedPolicyModule(pkgRoot, '/nonexistent-plugin-cache')?.verifiedMainRoot(pkgRoot) !==
    null;

  it.skipIf(!canVerify)(
    'production: a --repo that disagrees with the verified checkout repository is refused',
    async () => {
      delete process.env[TEST_ONLY_POLICY_ROOT_ENV];
      const fake = makeFakeRunner({ 'gh repo view': { stdout: 'org/real\n' } });
      const msg = await runCli(
        ['42', '--source-kind', 'backlog', '--repo', 'org/other', '--format', 'json'],
        fake.runner,
      );
      expect(msg).toBe('process.exit(1)');
      const parsed = JSON.parse(stdoutChunks.join(''));
      expect(parsed.reason).toMatch(/does not match the verified checkout/);
      // Only the slug derivation ran; the PR was never read.
      expect(fake.calls.every((c) => c.args[0] === 'repo')).toBe(true);
    },
  );
});
