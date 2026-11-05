/**
 * Step 6 (code gate, AISDLC-1078) — run the task's verify commands in the worktree and gate on
 * their exit status, not on the developer's self-reported `verifications`.
 *
 * The developer's claim is kept as `developerClaimed`; the code result is authoritative. A red
 * result is fed back to step 5 as developer feedback before any reviewer is built.
 *
 * @module steps/verify-commands
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { now } from '../clock.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { strippedSessionEnv } from '../hierarchy/session-env.js';
import {
  acquireVerifySlot,
  type VerifySlot,
  type VerifySlotDeps,
} from '../runtime/verify-slots.js';
import { DEFAULT_VERIFY_COMMANDS } from './verify-defaults.js';
import type { DeveloperReturn, VerificationStatus } from '../types.js';

export { DEFAULT_VERIFY_COMMANDS };
/** Per-command timeout default: 20 minutes. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 20 * 60 * 1000;
export const VERIFY_TAIL_LINES = 60;

const KEYS = ['build', 'test', 'lint', 'format'] as const;
type VerifyKey = (typeof KEYS)[number];

export interface VerifyCommandResult {
  command: string;
  exitCode: number;
  timedOut: boolean;
  /** Last 60 lines of combined output. */
  tail: string;
  /** Last non-empty output line: the command's own summary (for example the test totals). */
  summary: string;
  /** Failing test file paths or names parsed from a failing `pnpm test` / `node --test` run. */
  failures: string[];
}

export interface VerifyRunResult {
  ok: boolean;
  /** HEAD commit the run started on (AISDLC-1185). */
  headSha?: string;
  /** `origin/main` at the start of the run; the pre-push hook reuses the run only on a match (AISDLC-1187). */
  baseSha?: string;
  /** Tree object of `headSha`. */
  treeSha?: string;
  /** False when HEAD or the worktree status changed during the run. */
  clean?: boolean;
  /** ISO time the run finished. */
  finishedAt?: string;
  /** `full` or `affected` (AISDLC-1188, DEC-0372): what the test step covered. */
  scope?: 'full' | 'affected';
  /** Packages whose vitest suites ran when `scope` is `affected`. */
  scopePackages?: string[];
  /** `docs-only` when the manifest set `verifyCommands: []`. */
  skipped?: 'docs-only';
  results: VerifyCommandResult[];
  /** Authoritative per-key status computed from exit codes. */
  verifications: Record<VerifyKey, VerificationStatus>;
  /** What the developer reported, kept for the record. */
  developerClaimed?: DeveloperReturn['verifications'];
  failing?: VerifyCommandResult;
}

/** Map a command to the build/test/lint/format key it covers, if any. */
export function verifyKeyFor(command: string): VerifyKey | undefined {
  return KEYS.find((k) => new RegExp(`\\b${k}\\b`).test(command));
}

function tailOf(text: string, n: number): string {
  return text
    .split('\n')
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .slice(-n)
    .join('\n');
}

const MAX_FAILURES = 50;
// eslint-disable-next-line no-control-regex -- strips terminal colour codes
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Failing test files (vitest `FAIL <path>` and `❯ <path> (n tests | m failed)` lines) or test
 * names (node --test `not ok N - name` lines) from a test command's output. Unique, in order of
 * appearance; empty when nothing recognisable is found.
 */
export function parseTestFailures(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.replace(ANSI, '').trim();
    let m = /^FAIL\s+(?:\[[^\]]*\]\s+)?(\S+?)(?:\s+>.*)?$/.exec(line);
    if (!m) m = /^❯\s+(\S+\.[cm]?[jt]sx?)\s+\(\d+ tests?\s*\|\s*\d+ failed/.exec(line);
    if (m?.[1]) {
      found.add(m[1]);
    } else {
      const n = /^not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line);
      if (n?.[1]) found.add(n[1]);
    }
    if (found.size >= MAX_FAILURES) break;
  }
  return [...found];
}

function isTestCommand(command: string): boolean {
  return /\btest\b|--test\b/.test(command);
}

function summaryLineOf(tail: string): string {
  const lines = tail.split('\n').filter((l) => l.trim() !== '');
  const line = (lines[lines.length - 1] ?? '').trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** Per-key one-line summaries of the commands that ran (machine-written). */
export function verifySummaries(
  run: VerifyRunResult,
): Partial<Record<'build' | 'test' | 'lint' | 'format', string>> {
  const out: Partial<Record<VerifyKey, string>> = {};
  for (const r of run.results) {
    const key = verifyKeyFor(r.command);
    if (key && r.summary) out[key] = r.summary;
  }
  return out;
}

export interface RunVerifyOptions {
  commands: readonly string[];
  cwd: string;
  runner?: Runner;
  timeoutMs?: number;
  developerClaimed?: DeveloperReturn['verifications'];
  /** Board directory holding the shared verify slots; omitted = no cross-run limiting. */
  boardDir?: string;
  slotDeps?: VerifySlotDeps;
  /**
   * Path of the previous verify record for this task. Set only on rounds after the first
   * (AISDLC-1188, DEC-0372); omitted means a full run.
   */
  narrowFrom?: string;
}

const ROOT_TEST_CHAIN_REST =
  'pnpm test:gates && pnpm rfc:check && pnpm dark-code:check && pnpm git-env-hygiene:check && pnpm lint:publishable && pnpm knowledge:check';

/** Patch gate command, run after the tests (AISDLC-1185). */
export function patchGateCommand(headSha: string): string {
  return `node scripts/check-pr-patch-coverage.mjs --base origin/main --head ${headSha}`;
}

/**
 * Replace `pnpm test` with: touched packages under `test:coverage` (once each), the untouched
 * packages' plain tests, the root gate chain, then the patch gate (AISDLC-1185). No touched
 * package: the commands are returned unchanged and no gate runs.
 */
export function expandVerifyCommands(
  commands: readonly string[],
  packages: readonly string[],
  headSha: string,
  affected?: readonly string[],
): string[] {
  const i = commands.indexOf('pnpm test');
  if (i < 0 || (packages.length === 0 && !affected)) return [...commands];
  const filters = (list: readonly string[]) => list.map((p) => `--filter './${p}'`).join(' ');
  const plain = affected ? affected.filter((p) => !packages.includes(p)) : [];
  const plainCmd = affected
    ? plain.length > 0
      ? [`pnpm -r --no-bail ${filters(plain)} test`]
      : []
    : [`pnpm -r --no-bail ${packages.map((p) => `--filter '!./${p}'`).join(' ')} test`];
  return [
    ...commands.slice(0, i),
    ...packages.map((p) => `pnpm --filter ./${p} test:coverage`),
    ...plainCmd,
    ROOT_TEST_CHAIN_REST,
    ...(packages.length > 0 ? [patchGateCommand(headSha)] : []),
    ...commands.slice(i + 1),
  ];
}

/**
 * Packages to run vitest for on a later round (AISDLC-1188, DEC-0372): those changed since the
 * previous clean pass plus their dependents. `undefined` means run everything; narrowing fails
 * closed on every doubt.
 */
export async function affectedPackages(
  runner: Runner,
  cwd: string,
  recordFile: string,
): Promise<string[] | undefined> {
  let prevSha: string;
  try {
    const rec = JSON.parse(readFileSync(recordFile, 'utf8')) as VerifyRunResult;
    if (rec.ok !== true || rec.clean !== true || !rec.headSha) return undefined;
    prevSha = rec.headSha;
  } catch {
    return undefined;
  }
  const git = (args: string[]) =>
    runner('git', args, { cwd, allowFailure: true, env: strippedSessionEnv() }).catch(() => ({
      code: 1,
      stdout: '',
      stderr: '',
    }));
  if ((await git(['merge-base', '--is-ancestor', prevSha, 'HEAD'])).code !== 0) return undefined;
  const diff = await git(['diff', '--name-only', prevSha]);
  const untracked = await git(['ls-files', '--others', '--exclude-standard']);
  if (diff.code !== 0 || untracked.code !== 0) return undefined;
  const files = `${diff.stdout}\n${untracked.stdout}`
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  for (const file of files) {
    let dir = dirname(file);
    while (dir !== '.' && !existsSync(join(cwd, dir, 'package.json'))) dir = dirname(dir);
    if (dir === '.') return undefined;
  }
  if (files.length === 0) return [];
  try {
    const r = await runner(
      'pnpm',
      ['ls', '-r', '--depth', '-1', '--json', '--filter', `...[${prevSha}]`],
      { cwd, allowFailure: true, env: strippedSessionEnv() },
    );
    if (r.code !== 0) return undefined;
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return undefined;
    const out = parsed
      .map((x) => (x as { path?: unknown }).path)
      .filter((x): x is string => typeof x === 'string')
      .map((x) => relative(cwd, x))
      .filter((x) => x !== '' && !x.startsWith('..'));
    return out.sort();
  } catch {
    return undefined;
  }
}

async function gitOut(runner: Runner, cwd: string, args: string[]): Promise<string> {
  try {
    const r = await runner('git', args, { cwd, allowFailure: true, env: strippedSessionEnv() });
    return r.code === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

async function snapshot(runner: Runner, cwd: string) {
  const headSha = await gitOut(runner, cwd, ['rev-parse', 'HEAD']);
  const treeSha = await gitOut(runner, cwd, ['rev-parse', 'HEAD^{tree}']);
  const status = await gitOut(runner, cwd, ['status', '--porcelain']);
  const baseSha = await gitOut(runner, cwd, ['rev-parse', 'origin/main']);
  return { headSha, treeSha, status, baseSha };
}

async function coveragePackages(runner: Runner, cwd: string): Promise<string[]> {
  try {
    const r = await runner('node', ['scripts/list-coverage-packages.mjs'], {
      cwd,
      allowFailure: true,
      env: strippedSessionEnv(),
    });
    if (r.code !== 0) return [];
    const parsed: unknown = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Run every command in order, stopping at the first failure. */
export async function runVerifyCommands(opts: RunVerifyOptions): Promise<VerifyRunResult> {
  const runner = opts.runner ?? defaultRunner;
  const timeout = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const verifications: Record<VerifyKey, VerificationStatus> = {
    build: 'skipped',
    test: 'skipped',
    lint: 'skipped',
    format: 'skipped',
  };
  const base = opts.developerClaimed ? { developerClaimed: opts.developerClaimed } : {};
  if (opts.commands.length === 0) {
    return { ok: true, skipped: 'docs-only', results: [], verifications, ...base };
  }
  let slot: VerifySlot | undefined;
  if (opts.boardDir) {
    try {
      slot = await acquireVerifySlot(opts.boardDir, opts.slotDeps);
    } catch {
      // best effort: an unwritable board runs unlimited rather than blocking the gate
    }
  }
  try {
    const before = await snapshot(runner, opts.cwd);
    let commands = opts.commands;
    let affected: string[] | undefined;
    if (before.headSha && commands.includes('pnpm test')) {
      if (opts.narrowFrom) affected = await affectedPackages(runner, opts.cwd, opts.narrowFrom);
      commands = expandVerifyCommands(
        commands,
        await coveragePackages(runner, opts.cwd),
        before.headSha,
        affected,
      );
    }
    const run = await runAll({ ...opts, commands }, runner, timeout, verifications, base, slot);
    const after = await snapshot(runner, opts.cwd);
    return {
      ...run,
      scope: affected ? 'affected' : 'full',
      ...(affected ? { scopePackages: affected } : {}),
      headSha: before.headSha,
      baseSha: before.baseSha,
      treeSha: before.treeSha,
      clean: before.headSha === after.headSha && before.status === after.status,
      finishedAt: now().toISOString(),
    };
  } finally {
    slot?.release();
  }
}

async function runAll(
  opts: RunVerifyOptions,
  runner: Runner,
  timeout: number,
  verifications: Record<VerifyKey, VerificationStatus>,
  base: object,
  slot: VerifySlot | undefined,
): Promise<VerifyRunResult> {
  const env = slot ? { AI_SDLC_VITEST_MAX_WORKERS: String(slot.workers) } : undefined;
  const results: VerifyCommandResult[] = [];
  for (const command of opts.commands) {
    const started = now().getTime();
    const r = await runner('sh', ['-c', command], {
      cwd: opts.cwd,
      timeout,
      allowFailure: true,
      env: { ...strippedSessionEnv(), ...env },
    });
    const timedOut = r.code !== 0 && now().getTime() - started >= timeout;
    const tail = tailOf(`${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`, VERIFY_TAIL_LINES);
    const res: VerifyCommandResult = {
      command,
      exitCode: r.code,
      timedOut,
      tail,
      summary: summaryLineOf(tail),
      failures:
        r.code !== 0 && isTestCommand(command)
          ? parseTestFailures(`${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`)
          : [],
    };
    results.push(res);
    const key = verifyKeyFor(command);
    if (key) verifications[key] = r.code === 0 ? 'passed' : 'failed';
    if (r.code !== 0) {
      return { ok: false, results, verifications, failing: res, ...base };
    }
  }
  return { ok: true, results, verifications, ...base };
}

/** Replace the developer's claimed verifications with the machine-written run result. */
export function applyVerifyRun(dev: DeveloperReturn, run: VerifyRunResult): DeveloperReturn {
  return {
    ...dev,
    verifications: { ...run.verifications },
    verificationSummaries: verifySummaries(run),
    ...(run.scope
      ? {
          verificationScope:
            run.scope === 'affected'
              ? `affected packages: ${run.scopePackages?.join(', ') || 'none'}`
              : 'full',
        }
      : {}),
  };
}

/** True when the developer claimed every non-skipped key green but code found red. */
export function claimedGreenButRed(run: VerifyRunResult): boolean {
  if (run.ok || !run.developerClaimed) return false;
  return KEYS.every((k) => run.developerClaimed![k] !== 'failed');
}

/** Developer feedback for step 5 built from the failing command. */
export function formatVerifyFeedback(run: VerifyRunResult): string {
  const f = run.failing;
  if (!f) return '';
  return [
    `The orchestrator ran \`${f.command}\` in your worktree and it ${
      f.timedOut ? 'timed out' : `exited ${f.exitCode}`
    }. Your reported verifications were not accepted; fix the failure and re-run it yourself.`,
    '',
    ...(f.failures.length > 0 ? ['Failing tests:', ...f.failures.map((x) => `  - ${x}`), ''] : []),
    `Last ${VERIFY_TAIL_LINES} lines of output:`,
    f.tail,
  ].join('\n');
}

/** Persist the run state (best effort) under the artifacts directory. */
export function writeVerifyRunState(
  artifactsDir: string,
  taskId: string,
  run: VerifyRunResult,
): void {
  try {
    const file = join(artifactsDir, 'verify-runs', `${taskId}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(run, null, 2) + '\n');
  } catch {
    // best effort: the gate result already drove the run
  }
}

/** Log a developer-honesty event in the usage ledger (best effort). */
export function recordDeveloperHonestyEvent(
  projectRoot: string,
  taskId: string,
  run: VerifyRunResult,
): void {
  try {
    const file = join(projectRoot, '.ai-sdlc', 'usage', 'developer-honesty.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      JSON.stringify({
        at: now().toISOString(),
        taskId,
        event: 'developer-honesty',
        claimed: run.developerClaimed,
        actual: run.verifications,
        failingCommand: run.failing?.command,
      }) + '\n',
    );
  } catch {
    // best effort
  }
}
