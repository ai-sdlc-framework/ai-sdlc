/**
 * Hermetic tests for `cli-merge-if-eligible`'s render helpers
 * (RFC-0048 Phase 3 / AISDLC-603). The pure eligibility core is covered in
 * `../governance/merge-if-eligible.test.ts`; this file only covers the
 * CLI-facing render/format layer that the yargs router calls.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMergeIfEligibleCli, renderJsonResult, renderResult } from './merge-if-eligible.js';
import { STRICT_DEFAULTS, type RunMergeIfEligibleResult } from '../governance/merge-if-eligible.js';
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

// ── yargs router ──────────────────────────────────────────────────────

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

const HEAD = 'a'.repeat(40);
const GREEN_YAML =
  'spec:\n  governance:\n    allowMerge: onGreenClean\n    mergeAuthors: [operator]\n';
const NEVER_YAML = 'spec:\n  governance:\n    allowMerge: never\n';

const MAIN_REF = {
  'git/ref/heads/main': { stdout: JSON.stringify({ type: 'commit', sha: 'c'.repeat(40) }) },
  'pulls/42/files': {
    stdout: JSON.stringify({ filename: 'backlog/tasks/aisdlc-9 - x.md', status: 'added' }),
  },
};

const GOOD_PR = JSON.stringify({
  headRefOid: HEAD,
  headRefName: 'ai-sdlc/aisdlc-9-x',
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'operator' },
  title: 'fix: x (AISDLC-9)',
  mergeStateStatus: 'CLEAN',
  files: [{ path: 'backlog/tasks/aisdlc-9 - x.md', changeType: 'ADDED' }],
});

describe('buildMergeIfEligibleCli — yargs router', () => {
  let savedArgv: string[];
  let savedExit: typeof process.exit;
  let savedStdout: typeof process.stdout.write;
  let savedStderr: typeof process.stderr.write;
  let savedEnv: NodeJS.ProcessEnv;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    savedEnv = { ...process.env };
    savedArgv = process.argv;
    savedExit = process.exit;
    savedStdout = process.stdout.write.bind(process.stdout);
    savedStderr = process.stderr.write.bind(process.stderr);
    out = [];
    err = [];
    process.stdout.write = ((c: string | Uint8Array) => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exit = savedExit;
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
    process.env = savedEnv;
  });

  async function runCli(
    argv: string[],
    runner: Runner,
    trustedRootOverride?: { root: string; policyYaml: string | null },
  ): Promise<string> {
    process.argv = ['node', 'merge-if-eligible', ...argv];
    try {
      await buildMergeIfEligibleCli({ runner, trustedRootOverride }).parseAsync();
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  const repoView = { 'gh repo view': { stdout: 'org/repo\n' } };

  it('refuses (exit 1) under a strict committed policy, with only the slug lookup spent', async () => {
    const fake = makeFakeRunner(repoView);
    const msg = await runCli(['42', '--source-kind', 'backlog', '--format', 'json'], fake.runner, {
      root: '/main',
      policyYaml: NEVER_YAML,
    });
    expect(msg).toBe('process.exit(1)');
    const parsed = JSON.parse(out.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/allowMerge="never"/);
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses (exit 1) for an external sourceKind', async () => {
    const fake = makeFakeRunner(repoView);
    const msg = await runCli(['42', '--source-kind', 'gh-issue', '--format', 'json'], fake.runner, {
      root: '/main',
      policyYaml: GREEN_YAML,
    });
    expect(msg).toBe('process.exit(1)');
    expect(JSON.parse(out.join('')).ok).toBe(false);
  });

  it('prints a clean REFUSED line (exit 1) when gh cannot resolve the repository', async () => {
    const fake = makeFakeRunner({ 'gh repo view': { code: 1, stderr: 'no remote' } });
    const msg = await runCli(['42', '--source-kind', 'backlog'], fake.runner, {
      root: '/main',
      policyYaml: GREEN_YAML,
    });
    expect(msg).toBe('process.exit(1)');
    expect(out.join('')).toMatch(/REFUSED.*could not determine the repository/);
  });

  it('an eligible dry-run exits 0 and prints DRY-RUN (full PR flow through the fake runner)', async () => {
    const fake = makeFakeRunner({
      ...repoView,
      'gh pr view 42': { stdout: GOOD_PR },
      ...MAIN_REF,
      [`commits/${HEAD} --jq {author`]: { stdout: '{"author":"operator","committer":"operator"}' },
      'gh pr checks 42 --required': { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]) },
      [`commits/${HEAD}/check-runs`]: {
        stdout: JSON.stringify({ name: 'ci', status: 'completed', conclusion: 'success' }),
      },
      [`commits/${HEAD}/status`]: { stdout: '' },
      'contents/backlog/config.yml': { stdout: "task_prefix: 'AISDLC'\n" },
    });
    const msg = await runCli(['42', '--source-kind', 'backlog', '--dry-run'], fake.runner, {
      root: '/main',
      policyYaml: GREEN_YAML,
    });
    expect(msg).toBe('ok');
    expect(out.join('')).toContain('DRY-RUN');
    expect(out.join('')).toContain('eligible=true');
  });

  it('--arm arms auto-merge for a trusted PR: prints ARMED, exits 0, argv pins the head', async () => {
    const fake = makeFakeRunner({
      ...repoView,
      'gh pr view 42': { stdout: GOOD_PR },
      ...MAIN_REF,
      [`commits/${HEAD} --jq {author`]: { stdout: '{"author":"operator","committer":"operator"}' },
      'contents/backlog/config.yml': { stdout: "task_prefix: 'AISDLC'\n" },
      'gh pr merge 42': {},
    });
    const msg = await runCli(['42', '--source-kind', 'backlog', '--arm'], fake.runner, {
      root: '/main',
      policyYaml: GREEN_YAML,
    });
    expect(msg).toBe('ok');
    expect(out.join('')).toMatch(/PR #42 \| ARMED \|/);
    const arm = fake.calls.find((c) => c.args.includes('--auto'));
    expect(arm?.args).toEqual(expect.arrayContaining(['--match-head-commit', HEAD, '--squash']));
  });

  it('--arm --format json reports armed, and exits 1 when refused (policy never)', async () => {
    const ok = makeFakeRunner({
      ...repoView,
      'gh pr view 42': { stdout: GOOD_PR },
      ...MAIN_REF,
      [`commits/${HEAD} --jq {author`]: { stdout: '{"author":"operator","committer":"operator"}' },
      'contents/backlog/config.yml': { stdout: 'x: 1\n' },
      'gh pr merge 42': {},
    });
    expect(
      await runCli(['42', '--source-kind', 'backlog', '--arm', '--format', 'json'], ok.runner, {
        root: '/main',
        policyYaml: GREEN_YAML,
      }),
    ).toBe('ok');
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, armed: true, merged: false });
    out = [];
    const refused = makeFakeRunner(repoView);
    expect(
      await runCli(
        ['42', '--source-kind', 'backlog', '--arm', '--format', 'json'],
        refused.runner,
        { root: '/main', policyYaml: NEVER_YAML },
      ),
    ).toBe('process.exit(1)');
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, armed: false });
  });

  it('production path: an unverifiable cwd refuses with zero gh calls, whatever argv/env say', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'aisdlc-663-5-cwd-'));
    try {
      process.env['AI_SDLC_MERGE_POLICY_ROOT_FOR_TESTS'] = '1';
      process.env['CLAUDE_PLUGIN_ROOT'] = plain;
      const fake = makeFakeRunner({});
      const msg = await runCli(
        ['42', '--source-kind', 'backlog', '--cwd', plain, '--format', 'json'],
        fake.runner,
      );
      expect(msg).toBe('process.exit(1)');
      const parsed = JSON.parse(out.join(''));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toMatch(/verified main checkout/);
      expect(fake.calls).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('--repo-root and --repo no longer exist: yargs rejects them (exit 1) and nothing runs', async () => {
    for (const extra of [
      ['--repo-root', '/tmp/x'],
      ['--repo', 'org/repo'],
    ]) {
      out = [];
      err = [];
      const fake = makeFakeRunner(repoView);
      const msg = await runCli(['42', '--source-kind', 'backlog', ...extra], fake.runner, {
        root: '/main',
        policyYaml: GREEN_YAML,
      });
      expect(msg).toBe('process.exit(1)');
      expect(out.join('')).not.toContain('MERGED');
      expect(fake.calls).toEqual([]);
    }
  });
});
