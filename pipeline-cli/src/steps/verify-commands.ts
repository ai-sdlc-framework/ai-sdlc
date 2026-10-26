/**
 * Step 6 (code gate, AISDLC-1078) — run the task's verify commands in the worktree and gate on
 * their exit status, not on the developer's self-reported `verifications`.
 *
 * The developer's claim is kept as `developerClaimed`; the code result is authoritative. A red
 * result is fed back to step 5 as developer feedback before any reviewer is built.
 *
 * @module steps/verify-commands
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now } from '../clock.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { DeveloperReturn, VerificationStatus } from '../types.js';

export const DEFAULT_VERIFY_COMMANDS = [
  'pnpm build',
  'pnpm test',
  'pnpm lint',
  'pnpm format:check',
] as const;
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
}

export interface VerifyRunResult {
  ok: boolean;
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

export interface RunVerifyOptions {
  commands: readonly string[];
  cwd: string;
  runner?: Runner;
  timeoutMs?: number;
  developerClaimed?: DeveloperReturn['verifications'];
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
  const results: VerifyCommandResult[] = [];
  for (const command of opts.commands) {
    const started = now().getTime();
    const r = await runner('sh', ['-c', command], { cwd: opts.cwd, timeout, allowFailure: true });
    const timedOut = r.code !== 0 && now().getTime() - started >= timeout;
    const res: VerifyCommandResult = {
      command,
      exitCode: r.code,
      timedOut,
      tail: tailOf(`${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`, VERIFY_TAIL_LINES),
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
