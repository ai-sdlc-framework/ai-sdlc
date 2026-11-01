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
    return await runAll(opts, runner, timeout, verifications, base, slot);
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
      ...(env ? { env } : {}),
    });
    const timedOut = r.code !== 0 && now().getTime() - started >= timeout;
    const tail = tailOf(`${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`, VERIFY_TAIL_LINES);
    const res: VerifyCommandResult = {
      command,
      exitCode: r.code,
      timedOut,
      tail,
      summary: summaryLineOf(tail),
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
