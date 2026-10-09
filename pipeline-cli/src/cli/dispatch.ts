/**
 * `cli-dispatch` — Dispatch Board operator CLI (RFC-0041 §4.4, AISDLC-377.1).
 *
 * Surfaces the in-process board library at `pipeline-cli/src/dispatch/` to
 * shell callers so the `/ai-sdlc orchestrator-tick` and
 * `/ai-sdlc dispatch-worker` slash command bodies can drive the board with
 * `node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" <subcommand>`.
 *
 * Subcommands:
 *
 *   - `peek` — print queue/inflight/done/failed counts as JSON.
 *   - `claim --worker-kind <kind> [--worker <name>] [--wait <sec>]` — atomic claim of the
 *     next eligible manifest. Prints the manifest JSON on stdout when a
 *     claim succeeds; prints `{"claimed":false}` and exits 0 when the queue
 *     has no eligible manifest. (Empty-queue is NOT an error — it's the
 *     hibernate signal for the Worker loop.) With `--wait <sec>` it blocks,
 *     with no model calls, until a manifest is claimed or the wait lapses.
 *   - `collect-verdicts [--include-failed]` — print all done/+failed/
 *     verdicts as a JSON array, oldest first.
 *   - `write-verdict --task-id <id> --outcome <enum> [--worker <name>] [other
 *     fields]` — emit a verdict JSON to done/ or failed/ (routed by outcome).
 *     Clears inflight artifacts. When the caller resolves to the executor role
 *     in the hierarchy roster, --worker is required and must equal the name
 *     recorded when the task was claimed; a task that is not inflight, or whose
 *     claim recorded no name, is refused, and nothing is written (exit 1, or 2
 *     when --worker is missing). The match guards against a mistake, such as
 *     writing the wrong task's verdict; it is not authentication, the recorded
 *     name being readable from the inflight manifest. Other callers are not
 *     checked.
 *   - `remove-verdict --task-id <id> [--from done|failed]` — Conductor uses
 *     this after fan-out completes.
 *   - `heartbeat --task-id <id> --worker-id <id> --worker-kind <kind>
 *     [--current-step <s>]` — write or refresh a heartbeat.
 *   - `sweep [--stale-ms <n>]` — sweep stale inflight heartbeats; print the
 *     reaped taskIds.
 *   - `release --task-id <id>` — move inflight back to queue/ (surrender
 *     the claim without writing a verdict).
 *   - `write-manifest --json <path>` — Conductor entry point. Reads a JSON
 *     manifest from `<path>` and writes it into queue/.
 *
 * Ordering and parking:
 *
 *   - `enqueue --task <id> [--task <id> ...] [--after <ids>] [--group <name>]
 *     [--priority <n>] [--wave <n>]` or `enqueue --from-brief <path>` —
 *     write one manifest per task into queue/. Refuses a task already on the
 *     board in any state; nothing is written when any task is refused.
 *   - `board [--json]` — print every manifest by state, with eligibility and
 *     the holding rule for queued manifests that cannot be claimed yet.
 *   - `unblock --task-id <id>` — return a parked manifest from blocked/ to
 *     queue/.
 *   - `reap [--stale-ms <n>] [--retry-limit <n>] [--roster <path>]` — return
 *     stale inflight manifests to queue/ (retry count incremented), or to
 *     failed/ once past the retry limit.
 *   - `requeue --task-id <id> [--retry-limit <n>]` — return one failed task to
 *     queue/ with its retry count incremented, restoring the manifest kept
 *     when it failed. Meant for the dispatch session only: a mistake guard
 *     (the one `cli-hierarchy tick` uses; it is not authentication) exits 1,
 *     changing nothing, unless the calling session is the running dispatch
 *     session, and the repository policy must grant `requeue`. `--retry-limit` may not exceed the default of 2 (a
 *     larger value exits 2). Also exits 1, changing nothing, when the task is
 *     not in failed/, has no saved manifest, is already active, or is past the
 *     retry limit.
 *
 *   - `resume --task-id <id> --note <text> [--pr <number>] [--failing-checks <a,b>]
 *     [--finding <text>]` (or `--note-file <path>`) — send a finished task back to
 *     queue/ with a feedback note on its manifest (AISDLC-738). The next claim
 *     prints the note, and `/ai-sdlc execute` re-enters the task's existing worktree
 *     and branch and updates its pull request. Same caller check and `requeue`
 *     grant as `requeue`. Exits 1, changing nothing, when the task is not finished.
 *
 *   - `idle-backoff [--work-dir <path>]` — print `{"sleepSec":n}`, how long an
 *     idle executor waits before its next `claim`: the dispatch config's
 *     `emptyQueueHibernateSec` (default 30) clamped to 5..60, so a new manifest is
 *     claimed within a minute (AISDLC-738).
 *
 * Executor loop (RFC-0051 section 5):
 *
 *   - `complete --task-id <id> --outcome <enum> --worker <name> [--pr <number>]
 *     [--follow-ups <ids>] [--decisions <ids>] [--pr-url <url>] [--notes <s>]`
 *     — write the verdict for the inflight task this executor holds: done/
 *     (success, iterate-needed) or failed/. The task leaves inflight/ except on
 *     iterate-needed, which keeps the manifest. --worker is required and
 *     must equal the name recorded at claim time. Exits 1 when the task is not
 *     inflight or the name differs.
 *   - `next-subid <task-id> [--work-dir <path>]` — print the first free
 *     `<task-id>.<n>` across backlog/, the board and open pull request file
 *     lists, as `{"subId":"..."}`.
 *
 * Phase 1.5 (RFC-0041 OQ-4 / AISDLC-377.2) — iteration mechanism:
 *
 *   - `write-resume-signal --task-id <id> --feedback <s>` — Conductor writes
 *     a resume signal next to the still-inflight manifest. Refuses (exit 1
 *     with `{ok:false,error}`) when no inflight manifest exists OR when
 *     iteration budget is already exhausted.
 *   - `read-resume-signal --task-id <id>` — Worker polls for a Conductor-
 *     written signal. Prints `{present:false}` or `{present:true,signal}`.
 *   - `remove-resume-signal --task-id <id>` — Worker consumes the signal.
 *   - `list-resume-signals` — list every pending resume signal in inflight/.
 *     Filesystem-durable resume discovery (MAJOR #3 iteration-2 close-out):
 *     the Worker scans this BEFORE its env-var lookup so a session restart
 *     between Conductor's write and Worker's next tick doesn't strand the
 *     inflight slot. Prints `{signals:[{taskId,signalPath}]}`.
 *   - `probe-iteration-budget --task-id <id>` — Conductor inspects the
 *     manifest's iteration fields. Prints
 *     `{taskId,attempts,budget,exhausted,hasManifest}`.
 *   - `write-iteration-exhausted --task-id <id> --iterations-attempted <n>
 *     --iteration-budget <n>` — Conductor escalation when an
 *     `iterate-needed` verdict lands at the budget cap.
 *
 * Pattern X (AISDLC-396) — in-session background Agent dispatch:
 *
 *   - `dispatch-bg-agent --manifest-path <path> [--max-sessions <n>]` —
 *     Conductor's Step 5 entry point. Reads the manifest, enforces the
 *     in-session-agent concurrency cap, and writes a synthetic
 *     bg-agent-request/<task-id>.json describing the dev dispatch. The
 *     slash command body's Step 2.5 sweep picks this up and fires the
 *     actual `Agent` tool call (filesystem coordination because plugin
 *     subagents can't use `Agent` — AISDLC-98).
 *   - `list-bg-agent-requests` — slash command body Step 2.5 sweep.
 *     Returns oldest-first JSON array of pending requests.
 *   - `remove-bg-agent-request --task-id <id>` — slash command body
 *     deletes the request after firing the Agent call. Idempotent.
 *   - `prune-orphaned-bg-agent-requests` — GC requests whose corresponding
 *     inflight manifest has been reaped by stale-heartbeat sweeper.
 *   - `count-in-flight-bg-agents` — Conductor's backpressure probe.
 *     Returns the deduplicated count of inflight + pending requests.
 *
 * All subcommands accept `--board-dir <path>` (defaults to
 * `.ai-sdlc/dispatch` relative to the current working directory). Output
 * is always JSON on stdout so slash command bodies can parse it with
 * `node -e ...` or `jq`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  claimNext,
  claimWithWait,
  collectVerdicts,
  DEFAULT_BOARD_DIR,
  enqueueTasks,
  formatResumeFeedback,
  idleBackoffSec,
  MAX_NOTE_CHARS,
  listBoard,
  listResumeSignals,
  peekQueue,
  probeIterationBudget,
  readEmptyQueueHibernateSec,
  readInflightManifest,
  readResumeSignal,
  releaseInflight,
  removeResumeSignal,
  requeueFailed,
  requeueStaleInflight,
  removeVerdict,
  resumeDone,
  TASK_ID_RE,
  sweepStaleHeartbeats,
  unblockManifest,
  writeHeartbeat,
  writeIterationExhaustedDiagnostic,
  writeManifest,
  writeResumeSignal,
  writeVerdict,
} from '../dispatch/index.js';
import { assertClaimHolder, completeTask, splitIdList } from '../dispatch/complete.js';
import { DEFAULT_REQUEUE_RETRY_LIMIT } from '../dispatch/session-reaper.js';
import { checkDispatchCaller, loadOperational, type IdentityDeps } from '../hierarchy/index.js';
import { nextSubId } from '../dispatch/subid.js';
import type {
  BoardEntry,
  EnqueueEntry,
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  ResumeSignal,
  VerdictOutcome,
  WorkerKind,
} from '../dispatch/index.js';
import { loadDispatchConfig } from '../dispatch/recommend-worker.js';
import {
  briefToEnqueueEntries,
  parseBrief,
  resolveCallerRole,
  type HierarchyRole,
} from '../hierarchy/index.js';
import {
  countInFlightBgAgents,
  DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS,
  listBgAgentRequests,
  pruneOrphanedBgAgentRequests,
  removeBgAgentRequest,
  writeBgAgentRequest,
} from '../orchestrator/dispatch-bg-agent.js';
import {
  type BlockedPrSignature,
  classifyReverifyBatch,
  readPassiveTickState,
  resolveReverifyK,
  updatePassiveTickState,
  writePassiveTickState,
} from '../orchestrator/stale-cache-reverify.js';

/**
 * Read a feedback note from a file under the board directory or the temp
 * directory; anything else, a non-regular file, or one larger than the note limit
 * (4 bytes per character at most) is refused with a reason.
 */
function readNoteFile(file: string, boardDir: string): { note: string } | { error: string } {
  try {
    const real = realpathSync(path.resolve(file));
    const roots = [boardDir, os.tmpdir()].map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return path.resolve(r);
      }
    });
    if (
      !roots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep))
    ) {
      return {
        error: `--note-file must be under the board directory or ${os.tmpdir()}; write the note there, or pass it with --note`,
      };
    }
    const st = statSync(real);
    if (!st.isFile()) return { error: '--note-file is not a regular file' };
    if (st.size > MAX_NOTE_CHARS * 4) {
      return {
        error: `--note-file is larger than the ${MAX_NOTE_CHARS}-character note limit; shorten the note`,
      };
    }
    return { note: readFileSync(real, 'utf-8') };
  } catch {
    return { error: '--note-file could not be read' };
  }
}

/** Parse an optional integer flag. Returns null (after writing an error) when malformed. */
function intFlag(flags: Record<string, string>, name: string): number | undefined | null {
  const raw = flags[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!/^-?\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    process.stderr.write(`cli-dispatch: --${name} must be an integer (got '${raw}')\n`);
    return null;
  }
  return value;
}

/**
 * Minimal argv parser — yargs would be overkill for a JSON-out CLI.
 * Returns `{ subcommand, flags }`. Flags: any token starting with `--`
 * consumes the next token as its value; bare flags (no `=`) become `'true'`.
 */
export function parseArgv(argv: readonly string[]): {
  subcommand: string;
  flags: Record<string, string>;
} {
  const [subcommand = '', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true';
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { subcommand, flags };
}

/**
 * The worker name for a task: an explicit `--worker` / `--worker-id`, else the
 * name recorded on the inflight manifest at claim time, so a claim, its
 * heartbeats and its completion all carry the same value.
 */
function resolveWorkerId(
  boardDir: string,
  flags: Record<string, string>,
  taskId: string,
): string | undefined {
  const explicit = flags['worker'] ?? flags['worker-id'];
  if (explicit !== undefined && explicit !== '' && explicit !== 'true') return explicit;
  try {
    return readInflightManifest(boardDir, taskId)?.workerId;
  } catch {
    return undefined;
  }
}

function resolveBoardDir(flags: Record<string, string>): string {
  return path.resolve(flags['board-dir'] ?? DEFAULT_BOARD_DIR);
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

/** Collaborators a test can replace so the CLI never reaches the network. */
export interface DispatchCliDeps {
  /** File paths touched by open pull requests. Throws when they cannot be listed. */
  openPrFiles?: () => string[];
  /** Replaces the roster and process lookups that identify the calling session (`requeue`). */
  identity?: IdentityDeps;
  /** Replaces the git lookup of the main checkout and its board (`requeue`). */
  trustedBoard?: { root: string; boardDir: string } | null;
  /** Replaces the install directory of the running module (`requeue`). */
  installDir?: string | null;
  /** Replaces the policy file as the source of the operational grants (`requeue`). */
  operational?: ReadonlySet<string>;
  /** Working directory used to find the main checkout (`requeue`); default the process's. */
  cwd?: string;
  /** Role the calling process holds in the roster; null when it holds none. */
  callerRole?: () => HierarchyRole | null;
}

/** File paths touched by open pull requests, from the `gh` CLI. */
function listOpenPrFiles(workDir: string): string[] {
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'files'],
    { cwd: workDir, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const prs = JSON.parse(raw) as { files?: { path?: string }[] }[];
  return prs.flatMap((pr) =>
    (pr.files ?? []).map((f) => f.path).filter((p): p is string => typeof p === 'string'),
  );
}

/**
 * CLI entry point. Returns the intended exit code (0 = success). Tests
 * invoke this directly with synthetic argv + a fake stdout collector.
 */
export async function runDispatchCli(
  argv: readonly string[] = process.argv.slice(2),
  deps: DispatchCliDeps = {},
): Promise<number> {
  const { subcommand, flags } = parseArgv(argv);
  const boardDir = resolveBoardDir(flags);

  switch (subcommand) {
    case 'peek': {
      out(peekQueue(boardDir));
      return 0;
    }

    case 'claim': {
      const kind = flags['worker-kind'];
      if (!kind) {
        process.stderr.write('cli-dispatch claim: --worker-kind is required\n');
        return 2;
      }
      if (kind !== 'in-session-agent' && kind !== 'claude-p-shell') {
        process.stderr.write(`cli-dispatch claim: invalid --worker-kind '${kind}'\n`);
        return 2;
      }
      const named = flags['worker'];
      const legacy = flags['worker-id'];
      if (named !== undefined && legacy !== undefined && named !== legacy) {
        process.stderr.write('cli-dispatch claim: --worker and --worker-id disagree\n');
        return 2;
      }
      const workerId = named ?? legacy;
      if (workerId !== undefined && (workerId === '' || workerId === 'true')) {
        process.stderr.write('cli-dispatch claim: --worker needs a non-empty name\n');
        return 2;
      }
      const waitRaw = flags['wait'];
      if (waitRaw !== undefined && !/^[0-9]+$/.test(waitRaw)) {
        process.stderr.write(
          `cli-dispatch claim: --wait must be a whole number of seconds (got '${waitRaw}')\n`,
        );
        return 2;
      }
      const result =
        waitRaw === undefined
          ? claimNext(
              boardDir,
              kind as WorkerKind,
              undefined,
              workerId === undefined ? {} : { workerId },
            )
          : await claimWithWait(boardDir, kind as WorkerKind, {
              waitSec: Number.parseInt(waitRaw, 10),
              ...(workerId === undefined ? {} : { workerId }),
            });
      if (!result.claimed) {
        out({ claimed: false });
        return 0;
      }
      out({
        claimed: true,
        manifestPath: result.manifestPath,
        manifest: result.manifest,
        ...(result.manifest?.resume
          ? { resumeFeedback: formatResumeFeedback(result.manifest.resume) }
          : {}),
      });
      return 0;
    }

    case 'collect-verdicts': {
      const includeFailed = flags['include-failed'] === 'true' || flags['include-failed'] === '1';
      const verdicts = collectVerdicts(boardDir, { includeFailed });
      out(verdicts);
      return 0;
    }

    case 'write-verdict': {
      const taskId = requireFlag(flags, 'task-id');
      const outcome = requireFlag(flags, 'outcome') as VerdictOutcome;
      // An executor caller must name itself and must hold the claim, exactly as
      // `complete` requires. A mistake-guard, not authentication: the claim's
      // recorded name is readable from the inflight manifest. Nothing is written
      // on a refusal. Any other caller (a worker, the conductor, an unresolved
      // session) keeps the legacy behaviour, unnamed claims included.
      const role = (deps.callerRole ?? (() => resolveCallerRole(boardDir)))();
      let workerId: string;
      if (role === 'executor') {
        const worker = flags['worker'];
        if (worker === undefined || worker === '' || worker === 'true') {
          process.stderr.write(
            'cli-dispatch write-verdict: an executor must pass --worker, the name recorded when the task was claimed\n',
          );
          return 2;
        }
        const legacyWorker = flags['worker-id'];
        if (legacyWorker !== undefined && legacyWorker !== worker) {
          process.stderr.write('cli-dispatch write-verdict: --worker and --worker-id disagree\n');
          return 2;
        }
        try {
          workerId = assertClaimHolder(boardDir, taskId, worker);
        } catch (err) {
          process.stderr.write(
            `cli-dispatch write-verdict: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return 1;
        }
      } else {
        workerId = resolveWorkerId(boardDir, flags, taskId) ?? `worker-${process.pid}`;
      }
      const verdict: DispatchVerdict = {
        schemaVersion: 'v1',
        taskId,
        outcome,
        completedAt: flags['completed-at'] ?? new Date().toISOString(),
        workerId,
      };
      if (flags['worker-kind']) {
        verdict.workerKind = flags['worker-kind'] as WorkerKind;
      }
      if (flags['commit-sha']) verdict.commitSha = flags['commit-sha'];
      if (flags['pushed-branch']) verdict.pushedBranch = flags['pushed-branch'];
      if (flags['pr-url']) verdict.prUrl = flags['pr-url'];
      if (flags['notes']) verdict.notes = flags['notes'];
      if (flags['cause']) verdict.cause = flags['cause'];
      if (flags['retry-after']) {
        verdict.retryAfter = Number.parseInt(flags['retry-after'], 10);
      }
      if (flags['verifications']) {
        verdict.verifications = JSON.parse(
          flags['verifications'],
        ) as DispatchVerdict['verifications'];
      }
      if (flags['acceptance-criteria-met']) {
        verdict.acceptanceCriteriaMet =
          (JSON.parse(flags['acceptance-criteria-met']) as number[]) ?? [];
      }
      if (flags['duration-ms']) {
        verdict.durationMs = Number.parseInt(flags['duration-ms'], 10);
      }
      if (flags['iterations-attempted']) {
        verdict.iterationsAttempted = Number.parseInt(flags['iterations-attempted'], 10);
      }
      if (flags['session-id']) {
        verdict.sessionId = flags['session-id'];
      }
      const target = writeVerdict(boardDir, verdict);
      out({ ok: true, path: target });
      return 0;
    }

    case 'complete': {
      const taskId = requireFlag(flags, 'task-id');
      const outcome = requireFlag(flags, 'outcome');
      const workerId = requireFlag(flags, 'worker');
      const prRaw = flags['pr'];
      let prNumber: number | undefined;
      if (prRaw !== undefined) {
        if (!/^[0-9]+$/.test(prRaw)) {
          process.stderr.write(`cli-dispatch complete: --pr must be a number (got '${prRaw}')\n`);
          return 2;
        }
        prNumber = Number.parseInt(prRaw, 10);
      }
      try {
        const result = completeTask(boardDir, {
          taskId,
          outcome,
          ...(prNumber === undefined ? {} : { prNumber }),
          ...(flags['pr-url'] ? { prUrl: flags['pr-url'] } : {}),
          followUpIds: splitIdList(flags['follow-ups']),
          decisionIds: splitIdList(flags['decisions']),
          ...(flags['notes'] ? { notes: flags['notes'] } : {}),
          ...(flags['cause'] ? { cause: flags['cause'] } : {}),
          workerId,
        });
        out({ ok: true, path: result.verdictPath, state: result.state });
        return 0;
      } catch (err) {
        process.stderr.write(
          `cli-dispatch complete: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }

    case 'next-subid': {
      const parent = argv[1] && !argv[1].startsWith('--') ? argv[1] : flags['task-id'];
      if (!parent) {
        process.stderr.write('cli-dispatch next-subid: a task id is required\n');
        return 2;
      }
      const workDir = path.resolve(flags['work-dir'] ?? process.cwd());
      let openPrFiles: string[] = [];
      let openPrScan: 'ok' | 'unavailable' = 'ok';
      try {
        openPrFiles = (deps.openPrFiles ?? (() => listOpenPrFiles(workDir)))();
      } catch (err) {
        openPrScan = 'unavailable';
        process.stderr.write(
          `cli-dispatch next-subid: open pull requests could not be listed (${err instanceof Error ? err.message : String(err)}); the id is checked against the backlog and the board only\n`,
        );
      }
      try {
        out({ subId: nextSubId({ taskId: parent, workDir, boardDir, openPrFiles }), openPrScan });
        return 0;
      } catch (err) {
        process.stderr.write(
          `cli-dispatch next-subid: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 2;
      }
    }

    case 'write-resume-signal': {
      const taskId = requireFlag(flags, 'task-id');
      const feedback = requireFlag(flags, 'feedback');
      const signal: ResumeSignal = {
        schemaVersion: 'v1',
        taskId,
        feedback,
        triggeredAt: flags['triggered-at'] ?? new Date().toISOString(),
        triggeredBy: flags['triggered-by'] ?? 'conductor',
        priorOutcome: 'iterate-needed',
      };
      if (flags['prior-iteration']) {
        signal.priorIteration = Number.parseInt(flags['prior-iteration'], 10);
      }
      const writeOpts: { iterationBudget?: number; iterationsAttempted?: number } = {};
      if (flags['iteration-budget']) {
        writeOpts.iterationBudget = Number.parseInt(flags['iteration-budget'], 10);
      }
      if (flags['iterations-attempted']) {
        writeOpts.iterationsAttempted = Number.parseInt(flags['iterations-attempted'], 10);
      }
      try {
        const target = writeResumeSignal(boardDir, signal, writeOpts);
        out({ ok: true, path: target });
        return 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out({ ok: false, error: message });
        return 1;
      }
    }

    case 'read-resume-signal': {
      const taskId = requireFlag(flags, 'task-id');
      const signal = readResumeSignal(boardDir, taskId);
      if (!signal) {
        out({ present: false });
        return 0;
      }
      out({ present: true, signal });
      return 0;
    }

    case 'remove-resume-signal': {
      const taskId = requireFlag(flags, 'task-id');
      removeResumeSignal(boardDir, taskId);
      out({ ok: true });
      return 0;
    }

    case 'list-resume-signals': {
      // MAJOR #3 (iteration-2 review): filesystem-durable resume discovery.
      // The Worker scans this list BEFORE falling back to its
      // AI_SDLC_DISPATCH_RESUME_TASK_ID env var so a Worker-session restart
      // between Conductor's resume-write and Worker's next tick doesn't
      // strand the inflight slot until the stale-heartbeat sweep reaps it.
      const signals = listResumeSignals(boardDir);
      out({ signals });
      return 0;
    }

    case 'probe-iteration-budget': {
      const taskId = requireFlag(flags, 'task-id');
      const probe = probeIterationBudget(boardDir, taskId);
      // Strip the manifest from the JSON output — the manifest is already
      // available via `claim` / `peek`, and including it would balloon the
      // bash-callable surface unnecessarily.
      out({
        taskId,
        attempts: probe.attempts,
        budget: probe.budget,
        exhausted: probe.exhausted,
        hasManifest: probe.manifest !== undefined,
      });
      return 0;
    }

    case 'write-iteration-exhausted': {
      const taskId = requireFlag(flags, 'task-id');
      const iterationsAttempted = Number.parseInt(requireFlag(flags, 'iterations-attempted'), 10);
      const iterationBudget = Number.parseInt(requireFlag(flags, 'iteration-budget'), 10);
      const args: Parameters<typeof writeIterationExhaustedDiagnostic>[1] = {
        taskId,
        iterationsAttempted,
        iterationBudget,
      };
      if (flags['worker-id']) args.workerId = flags['worker-id'];
      if (flags['worker-kind']) args.workerKind = flags['worker-kind'] as WorkerKind;
      if (flags['notes']) args.notes = flags['notes'];
      const target = writeIterationExhaustedDiagnostic(boardDir, args);
      out({ ok: true, path: target });
      return 0;
    }

    case 'remove-verdict': {
      const taskId = requireFlag(flags, 'task-id');
      const from = (flags['from'] ?? 'done') as 'done' | 'failed';
      removeVerdict(boardDir, taskId, from);
      out({ ok: true });
      return 0;
    }

    case 'heartbeat': {
      const taskId = requireFlag(flags, 'task-id');
      const workerId = resolveWorkerId(boardDir, flags, taskId) ?? requireFlag(flags, 'worker-id');
      const workerKind = requireFlag(flags, 'worker-kind') as WorkerKind;
      const hb: InflightHeartbeat = {
        taskId,
        workerId,
        workerKind,
        startedAt: flags['started-at'] ?? new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      };
      if (flags['current-step']) hb.currentStep = flags['current-step'];
      if (flags['pid']) hb.pid = Number.parseInt(flags['pid'], 10);
      writeHeartbeat(boardDir, hb);
      out({ ok: true });
      return 0;
    }

    case 'sweep': {
      const staleMs = intFlag(flags, 'stale-ms');
      if (staleMs === null) return 2;
      const result = sweepStaleHeartbeats(boardDir, { staleMs });
      out(result);
      return 0;
    }

    case 'release': {
      const taskId = requireFlag(flags, 'task-id');
      const released = releaseInflight(boardDir, taskId);
      out({ released });
      return 0;
    }

    case 'write-manifest': {
      const jsonPath = requireFlag(flags, 'json');
      const manifest = JSON.parse(readFileSync(jsonPath, 'utf-8')) as DispatchManifest;
      const target = writeManifest(boardDir, manifest);
      out({ ok: true, path: target });
      return 0;
    }

    // -----------------------------------------------------------------------
    // Pattern X (AISDLC-396) — in-session background Agent dispatch.
    //
    // Conductor (running in the slash command body) emits a manifest, claims
    // it into inflight/, and ALSO writes a bg-agent-request/ file that the
    // slash command body's Step 2.5 sweep picks up and converts into an
    // actual `Agent` tool call. Filesystem coordination because plugin
    // subagents can't use `Agent` directly (AISDLC-98).
    // -----------------------------------------------------------------------

    case 'dispatch-bg-agent': {
      // Reads the manifest at `--manifest-path` and writes a synthetic
      // bg-agent-request describing the dev dispatch. The slash command
      // body's next-step sweep fires the `Agent` tool call from this.
      const manifestPath = requireFlag(flags, 'manifest-path');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DispatchManifest;
      // Concurrency cap — Conductor MUST respect inSessionAgentMaxSessions.
      // We re-check here as a defense-in-depth measure even though the
      // Conductor's Step 5 also gates on `peek` before calling us.
      //
      // AISDLC-396 round-2 MAJOR-3 fix — cap precedence:
      //   1. Explicit `--max-sessions <n>` flag wins (operator override or
      //      slash command body passing the resolved cap forward).
      //   2. Fall back to `spec.parallelism.inSessionAgentMaxSessions` from
      //      `<workDir>/.ai-sdlc/dispatch-config.yaml` (where workDir is
      //      derived from `--work-dir` flag OR the boardDir's parent's parent —
      //      .ai-sdlc/dispatch/ → .ai-sdlc/ → workDir).
      //   3. Final fallback: DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS (4).
      // Previously the yaml field was non-functional: the CLI always used 4
      // and the operator's `inSessionAgentMaxSessions: 6` setting was silently
      // ignored.
      const yamlMaxSessions = resolveYamlInSessionAgentMaxSessions(flags, boardDir);
      const fallback = yamlMaxSessions ?? DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS;
      const maxSessions = parseMaxSessions(flags, fallback);
      const inFlight = countInFlightBgAgents(boardDir);
      // Subtract the manifest we're about to dispatch FOR — it's already
      // counted in inflight (the Conductor's Step 5 claims before calling
      // us) so the comparison is against "other tasks already in flight".
      const otherInFlight = Math.max(0, inFlight - 1);
      if (otherInFlight >= maxSessions) {
        out({
          ok: false,
          error: `dispatch-bg-agent: in-flight count ${otherInFlight} already meets cap ${maxSessions}; refuse to dispatch`,
          inFlight: otherInFlight,
          maxSessions,
        });
        return 1;
      }
      const writeOpts: { requestedAt?: string; requestedBy?: string } = {};
      if (flags['requested-at']) writeOpts.requestedAt = flags['requested-at'];
      if (flags['requested-by']) writeOpts.requestedBy = flags['requested-by'];
      try {
        const target = writeBgAgentRequest(boardDir, manifest, writeOpts);
        out({ ok: true, path: target, taskId: manifest.taskId });
        return 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out({ ok: false, error: message });
        return 1;
      }
    }

    case 'list-bg-agent-requests': {
      // The slash command body's Step 2.5 sweep enumerates pending
      // requests with this. Returns oldest-first by requestedAt so the
      // sweep fires dispatches in FIFO order.
      const requests = listBgAgentRequests(boardDir);
      out({ requests });
      return 0;
    }

    case 'remove-bg-agent-request': {
      // The slash command body's Step 2.5 sweep calls this after firing
      // the Agent call (status moves implicitly: pending → fired → file
      // removed when the dev verdict lands). Idempotent.
      const taskId = requireFlag(flags, 'task-id');
      removeBgAgentRequest(boardDir, taskId);
      out({ ok: true });
      return 0;
    }

    case 'prune-orphaned-bg-agent-requests': {
      // Garbage-collect requests whose corresponding inflight manifest has
      // been reaped by the stale-heartbeat sweeper. Safe to call every tick.
      const pruned = pruneOrphanedBgAgentRequests(boardDir);
      out({ pruned });
      return 0;
    }

    case 'count-in-flight-bg-agents': {
      // Conductor's Step 5 backpressure probe — returns the union count of
      // pending requests + inflight manifests (deduplicated by taskId).
      const count = countInFlightBgAgents(boardDir);
      out({ count });
      return 0;
    }

    // -----------------------------------------------------------------------
    // Stale-cache reverify (AISDLC-449) — Step 6.5 of orchestrator-tick.
    //
    // The skill body passes the blocked-PR observation it gathered this tick
    // (PR numbers + per-PR failing-check signatures) plus the dispatch count.
    // This subcommand reads/updates the persisted passive-tick counter and
    // tells the skill body whether the reverify gate should fire (K
    // consecutive no-change ticks with no new dispatch). When `--fresh` is
    // also supplied (a freshly-fetched check-signature map from a `gh pr
    // checks` re-fetch), it ALSO classifies each blocked PR as `new-signal`
    // (AC-3 — surface via Decision Catalog / AskUserQuestion) vs
    // `same-blocker` (AC-4 — escalate timebox urgency).
    // -----------------------------------------------------------------------
    case 'reverify-blocked-prs': {
      // `--blocked-prs` is a JSON array of {prNumber, checkSignature}.
      // Default to an empty observation so a tick with nothing blocked
      // simply resets the counter.
      let blockedPrs: BlockedPrSignature[] = [];
      if (flags['blocked-prs']) {
        try {
          const parsed = JSON.parse(flags['blocked-prs']) as unknown;
          if (Array.isArray(parsed)) {
            blockedPrs = parsed
              .filter(
                (p): p is BlockedPrSignature =>
                  p !== null &&
                  typeof p === 'object' &&
                  typeof (p as BlockedPrSignature).prNumber === 'string' &&
                  typeof (p as BlockedPrSignature).checkSignature === 'string',
              )
              .map((p) => ({ prNumber: p.prNumber, checkSignature: p.checkSignature }));
          }
        } catch (err) {
          out({ ok: false, error: `invalid --blocked-prs JSON: ${(err as Error).message}` });
          return 1;
        }
      }
      const dispatchCount = flags['dispatch-count']
        ? Number.parseInt(flags['dispatch-count'], 10)
        : 0;
      const kOverride = flags['k'] ? Number.parseInt(flags['k'], 10) : undefined;
      const prev = readPassiveTickState(boardDir);
      const { next, shouldReverify, k } = updatePassiveTickState(
        prev,
        {
          blockedPrs,
          dispatchCount: Number.isFinite(dispatchCount) ? dispatchCount : 0,
        },
        kOverride !== undefined && Number.isFinite(kOverride) ? { k: kOverride } : {},
      );
      // Persist unless the caller asked for a dry-run probe (used by the
      // skill body to peek without advancing the counter — rare).
      if (flags['dry-run'] !== 'true') {
        writePassiveTickState(boardDir, next);
      }

      // Optional classification when a fresh signature map is supplied.
      let classifications: ReturnType<typeof classifyReverifyBatch> | undefined;
      if (flags['fresh']) {
        try {
          const fresh = JSON.parse(flags['fresh']) as Record<string, string>;
          // Classify against the PREVIOUS observation's cached signatures —
          // those are the "cached blockers" we're reverifying.
          classifications = classifyReverifyBatch(prev.lastBlockedPrs, fresh);
        } catch (err) {
          out({ ok: false, error: `invalid --fresh JSON: ${(err as Error).message}` });
          return 1;
        }
      }

      out({
        ok: true,
        shouldReverify,
        k,
        consecutiveNoChangeTicks: next.consecutiveNoChangeTicks,
        blockedPrs,
        ...(classifications ? { classifications } : {}),
      });
      return 0;
    }

    case 'reverify-k': {
      // Convenience probe: print the resolved K (env + default). The skill
      // body uses this to log the active grace window.
      const kOverride = flags['k'] ? Number.parseInt(flags['k'], 10) : undefined;
      const k = resolveReverifyK(
        kOverride !== undefined && Number.isFinite(kOverride) ? { override: kOverride } : {},
      );
      out({ ok: true, k });
      return 0;
    }

    case 'enqueue': {
      const workDir = path.resolve(flags['work-dir'] ?? '.');
      try {
        let entries: EnqueueEntry[];
        if (flags['from-brief']) {
          entries = briefToEnqueueEntries(
            parseBrief(readFileSync(path.resolve(flags['from-brief']), 'utf-8')),
          );
        } else {
          const ids = argv.flatMap((tok, i) =>
            tok === '--task' && argv[i + 1] ? [argv[i + 1]!] : [],
          );
          if (ids.length === 0) {
            process.stderr.write(
              'cli-dispatch enqueue: pass --task <id> (repeatable) or --from-brief <path>\n',
            );
            return 2;
          }
          const shared: Omit<EnqueueEntry, 'taskId'> = {};
          if (flags['after'])
            shared.after = flags['after']
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
          if (flags['group']) shared.sequenceGroup = flags['group'];
          const priority = intFlag(flags, 'priority');
          const wave = intFlag(flags, 'wave');
          if (priority === null || wave === null) return 2;
          if (priority !== undefined) shared.priority = priority;
          if (wave !== undefined) shared.wave = wave;
          entries = ids.map((taskId) => ({ taskId, ...shared }));
        }
        const paths = enqueueTasks(boardDir, entries, {
          baseSha: flags['base-sha'] ?? resolveBaseSha(workDir),
          dispatchedBy: flags['dispatched-by'] ?? `operator-${process.pid}`,
          resolveTaskFile: (id) => findTaskFile(workDir, id),
        });
        out({ ok: true, enqueued: entries.map((e) => e.taskId), paths });
        return 0;
      } catch (err) {
        process.stderr.write(
          `cli-dispatch enqueue: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }

    case 'board': {
      const entries = listBoard(boardDir);
      if (flags['json'] === 'true') {
        out(entries);
        return 0;
      }
      process.stdout.write(formatBoard(entries));
      return 0;
    }

    case 'unblock': {
      const taskId = requireFlag(flags, 'task-id');
      if (!TASK_ID_RE.test(taskId)) {
        process.stderr.write(`cli-dispatch unblock: '${taskId}' is not a valid task id\n`);
        return 2;
      }
      if (!unblockManifest(boardDir, taskId)) {
        process.stderr.write(`cli-dispatch unblock: ${taskId} is not parked in blocked/\n`);
        return 1;
      }
      out({ ok: true, taskId });
      return 0;
    }

    case 'reap': {
      const opts: Parameters<typeof requeueStaleInflight>[1] = {};
      const staleMs = intFlag(flags, 'stale-ms');
      const retryLimit = intFlag(flags, 'retry-limit');
      if (staleMs === null || retryLimit === null) return 2;
      if (staleMs !== undefined) opts.staleMs = staleMs;
      if (retryLimit !== undefined) opts.retryLimit = retryLimit;
      if (flags['roster']) {
        let names: unknown;
        try {
          names = JSON.parse(readFileSync(path.resolve(flags['roster']), 'utf-8'));
        } catch (err) {
          process.stderr.write(
            `cli-dispatch: --roster must be a readable JSON file (${err instanceof Error ? err.message : String(err)})\n`,
          );
          return 2;
        }
        if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
          process.stderr.write('cli-dispatch: --roster must be a JSON array of strings\n');
          return 2;
        }
        opts.roster = new Set(names as string[]);
      }
      out(requeueStaleInflight(boardDir, opts));
      return 0;
    }

    case 'requeue': {
      const taskId = requireFlag(flags, 'task-id');
      if (!TASK_ID_RE.test(taskId)) {
        process.stderr.write(`cli-dispatch requeue: '${taskId}' is not a valid task id\n`);
        return 2;
      }
      const cwd = deps.cwd ?? process.cwd();
      const caller = checkDispatchCaller({
        label: 'cli-dispatch requeue',
        cwd,
        boardDir,
        workDir: flags['work-dir'],
        worker: flags['worker'],
        identity: deps.identity,
        trustedBoard: deps.trustedBoard,
        installDir: deps.installDir,
      });
      if (!caller.ok) {
        process.stderr.write(`${caller.reason}\n`);
        return 1;
      }
      const granted = deps.operational ?? loadOperational(cwd, cwd);
      if (!granted.has('requeue')) {
        process.stderr.write(
          'cli-dispatch requeue: refused; the repository policy does not grant requeue to the dispatch session. ' +
            'Raise it with `cli-decisions escalate` so the decision is recorded and routed, ' +
            'and once it is answered the operator adds `requeue` to `spec.governance.operational` in .ai-sdlc/agent-role.yaml\n',
        );
        return 1;
      }
      const retryLimit = intFlag(flags, 'retry-limit');
      if (retryLimit === null) return 2;
      if (retryLimit !== undefined && retryLimit > DEFAULT_REQUEUE_RETRY_LIMIT) {
        process.stderr.write(
          `cli-dispatch requeue: --retry-limit may not exceed ${DEFAULT_REQUEUE_RETRY_LIMIT}; use ${DEFAULT_REQUEUE_RETRY_LIMIT} or less, or escalate with \`cli-decisions escalate\`\n`,
        );
        return 2;
      }
      try {
        out({
          ok: true,
          ...requeueFailed(boardDir, taskId, retryLimit === undefined ? {} : { retryLimit }),
        });
        return 0;
      } catch (err) {
        process.stderr.write(
          `cli-dispatch requeue: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }

    case 'idle-backoff': {
      // How long an idle executor sleeps before the next claim: never more than a minute.
      out({
        sleepSec: idleBackoffSec(
          readEmptyQueueHibernateSec(path.resolve(flags['work-dir'] ?? '.')),
        ),
      });
      return 0;
    }

    case 'resume': {
      const taskId = requireFlag(flags, 'task-id');
      if (!TASK_ID_RE.test(taskId)) {
        process.stderr.write(`cli-dispatch resume: '${taskId}' is not a valid task id\n`);
        return 2;
      }
      let note = flags['note'] ?? '';
      if (flags['note'] === undefined && flags['note-file']) {
        const read = readNoteFile(flags['note-file'], boardDir);
        if ('error' in read) {
          process.stderr.write(`cli-dispatch resume: ${read.error}\n`);
          return 2;
        }
        note = read.note;
      }
      if (!note || note === 'true') {
        process.stderr.write(
          'cli-dispatch resume: --note <text> (or --note-file <path>) is required\n',
        );
        return 2;
      }
      const prNumber = intFlag(flags, 'pr');
      if (prNumber === null) return 2;
      const cwd = deps.cwd ?? process.cwd();
      const caller = checkDispatchCaller({
        label: 'cli-dispatch resume',
        cwd,
        boardDir,
        workDir: flags['work-dir'],
        worker: flags['worker'],
        identity: deps.identity,
        trustedBoard: deps.trustedBoard,
        installDir: deps.installDir,
      });
      if (!caller.ok) {
        process.stderr.write(`${caller.reason}\n`);
        return 1;
      }
      // Sending a finished task back is a kind of requeue: the same grant applies.
      const granted = deps.operational ?? loadOperational(cwd, cwd);
      if (!granted.has('requeue')) {
        process.stderr.write(
          'cli-dispatch resume: refused; the repository policy does not grant requeue to the dispatch session. ' +
            'Raise it with `cli-decisions escalate` so the decision is recorded and routed\n',
        );
        return 1;
      }
      const workDir = path.resolve(flags['work-dir'] ?? '.');
      try {
        out({
          ok: true,
          ...resumeDone(
            boardDir,
            taskId,
            {
              note,
              ...(prNumber !== undefined ? { prNumber } : {}),
              failingChecks: splitIdList(flags['failing-checks']),
              findings: flags['finding'] ? [flags['finding']] : [],
            },
            {
              resumedBy: flags['worker'] ?? `dispatch-${process.pid}`,
              resolveBaseSha: () => flags['base-sha'] ?? resolveBaseSha(workDir),
              resolveTaskFile: (id) => findTaskFile(workDir, id),
            },
          ),
        });
        return 0;
      } catch (err) {
        process.stderr.write(
          `cli-dispatch resume: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }

    case '':
    case 'help':
    case '--help':
    case '-h': {
      process.stdout.write(HELP_TEXT);
      return 0;
    }

    default: {
      process.stderr.write(`cli-dispatch: unknown subcommand '${subcommand}'\n`);
      process.stderr.write(HELP_TEXT);
      return 2;
    }
  }
}

/** Commit the manifests of a batch are based on: `origin/main`, else `HEAD`. */
export function resolveBaseSha(workDir: string): string {
  for (const ref of ['origin/main', 'HEAD']) {
    try {
      return execFileSync('git', ['rev-parse', ref], { cwd: workDir, encoding: 'utf-8' }).trim();
    } catch {
      /* try the next ref */
    }
  }
  throw new Error('cannot resolve a base commit; pass --base-sha <sha>');
}

/** Repo-relative backlog task file for an id, or undefined. */
export function findTaskFile(workDir: string, taskId: string): string | undefined {
  const dir = path.join(workDir, 'backlog', 'tasks');
  if (!existsSync(dir)) return undefined;
  const prefix = `${taskId.toLowerCase()} - `;
  const hit = readdirSync(dir).find((f) => f.toLowerCase().startsWith(prefix) && f.endsWith('.md'));
  return hit ? path.posix.join('backlog', 'tasks', hit) : undefined;
}

/** Render the board listing: one line per manifest, grouped by state. */
export function formatBoard(entries: readonly BoardEntry[]): string {
  if (entries.length === 0) return 'board is empty\n';
  const lines: string[] = [];
  for (const e of entries) {
    const parts = [e.state.padEnd(8), e.taskId];
    if (e.state === 'queue') parts.push(e.eligible ? 'eligible' : `held: ${e.reason}`);
    else if (e.reason) parts.push(e.reason);
    lines.push(parts.join('  '));
  }
  return lines.join('\n') + '\n';
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) {
    throw new Error(`cli-dispatch: --${name} is required`);
  }
  return v;
}

/**
 * Parse the `--max-sessions` flag if present, else return the fallback.
 * Validates the value is a non-negative integer; an unparseable value
 * silently falls back so the Conductor isn't stranded on a typo.
 */
function parseMaxSessions(flags: Record<string, string>, fallback: number): number {
  const raw = flags['max-sessions'];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Resolve the yaml `spec.parallelism.inSessionAgentMaxSessions` knob
 * (AISDLC-396 round-2 MAJOR-3 fix). Returns `undefined` when the yaml is
 * missing, the field is absent, OR the value is non-numeric — callers
 * fall through to {@link DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS}.
 *
 * The workDir is derived from `--work-dir <path>` if supplied, otherwise
 * inferred from `boardDir`:
 *   - boardDir = `<workDir>/.ai-sdlc/dispatch` → workDir = `<two parents up>`
 *   - boardDir = `<workDir>/.ai-sdlc/dispatch/` → same
 *   - bespoke boardDir paths (test fixtures pointing at /tmp/...) → workDir
 *     defaults to the boardDir's grandparent if it looks like an `.ai-sdlc`
 *     parent; else we can't locate the yaml and return undefined.
 *
 * Tests can pass `--work-dir <tmp>` explicitly to drive the yaml load.
 */
function resolveYamlInSessionAgentMaxSessions(
  flags: Record<string, string>,
  boardDir: string,
): number | undefined {
  const explicit = flags['work-dir'];
  let workDir: string | undefined = explicit ? path.resolve(explicit) : undefined;
  if (!workDir) {
    // boardDir naming convention: <workDir>/.ai-sdlc/dispatch
    // → two `..` hops up. If boardDir doesn't match, we leave workDir
    // undefined and skip the yaml load (test fixtures often supply ad-hoc
    // tmp dirs that aren't structured as <workDir>/.ai-sdlc/dispatch).
    const parent = path.dirname(boardDir); // .ai-sdlc
    const grandparent = path.dirname(parent); // workDir
    if (path.basename(parent) === '.ai-sdlc') {
      workDir = grandparent;
    }
  }
  if (!workDir) return undefined;
  const cfg = loadDispatchConfig(workDir);
  return cfg?.inSessionAgentMaxSessions;
}

const HELP_TEXT = `cli-dispatch — Dispatch Board operator CLI (RFC-0041 §4.4)

Usage:
  cli-dispatch <subcommand> [--board-dir <path>] [...]

Subcommands:
  peek
  claim --worker-kind {in-session-agent|claude-p-shell} [--worker <name>] [--wait <sec>]
  collect-verdicts [--include-failed]
  write-verdict --task-id <id> --outcome <enum> [--worker <name>; required for executors]
                [--commit-sha <s>]
                [--iterations-attempted <n>] [--session-id <uuid>] ...
  remove-verdict --task-id <id> [--from done|failed]
  heartbeat --task-id <id> --worker-id <id> --worker-kind <kind>
  sweep [--stale-ms <n>]
  release --task-id <id>
  write-manifest --json <path>
  enqueue --task <id> [--task <id> ...] [--after <ids>] [--group <name>]
          [--priority <n>] [--wave <n>] [--base-sha <sha>] | --from-brief <path>
  board [--json]
  unblock --task-id <id>
  reap [--stale-ms <n>] [--retry-limit <n>] [--roster <path>]
  requeue --task-id <id> [--retry-limit <n>]   (meant for the dispatch session; mistake guard, limit at most 2)
  complete --task-id <id> --outcome <enum> --worker <name> [--pr <number>] [--pr-url <url>]
           [--follow-ups <ids>] [--decisions <ids>] [--notes <s>] [--cause <s>]
  next-subid <task-id> [--work-dir <path>]

Phase 1.5 (RFC-0041 OQ-4 / AISDLC-377.2) — iteration mechanism:
  write-resume-signal --task-id <id> --feedback <s>
                      [--triggered-by <s>] [--prior-iteration <n>]
                      [--iteration-budget <n>] [--iterations-attempted <n>]
  read-resume-signal --task-id <id>
  remove-resume-signal --task-id <id>
  list-resume-signals
  probe-iteration-budget --task-id <id>
  write-iteration-exhausted --task-id <id>
                            --iterations-attempted <n> --iteration-budget <n>
                            [--worker-id <s>] [--worker-kind <kind>] [--notes <s>]

Pattern X (AISDLC-396) — in-session background Agent dispatch:
  dispatch-bg-agent --manifest-path <path> [--max-sessions <n>]
                    [--requested-at <iso>] [--requested-by <s>]
  list-bg-agent-requests
  remove-bg-agent-request --task-id <id>
  prune-orphaned-bg-agent-requests
  count-in-flight-bg-agents

Stale-cache reverify (AISDLC-449) — Step 6.5 of orchestrator-tick:
  reverify-blocked-prs [--blocked-prs <json>] [--dispatch-count <n>]
                       [--k <n>] [--fresh <json>] [--dry-run]
  reverify-k [--k <n>]
`;
