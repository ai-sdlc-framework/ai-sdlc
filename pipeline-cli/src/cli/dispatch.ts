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
 *   - `claim --worker-kind <kind> [--worker-id <id>]` — atomic claim of the
 *     next eligible manifest. Prints the manifest JSON on stdout when a
 *     claim succeeds; prints `{"claimed":false}` and exits 0 when the queue
 *     has no eligible manifest. (Empty-queue is NOT an error — it's the
 *     hibernate signal for the Worker loop.)
 *   - `collect-verdicts [--include-failed]` — print all done/+failed/
 *     verdicts as a JSON array, oldest first.
 *   - `write-verdict --task-id <id> --outcome <enum> [other fields]` —
 *     emit a verdict JSON to done/ or failed/ (routed by outcome). Clears
 *     inflight artifacts.
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  claimNext,
  collectVerdicts,
  DEFAULT_BOARD_DIR,
  listResumeSignals,
  peekQueue,
  probeIterationBudget,
  readResumeSignal,
  releaseInflight,
  removeResumeSignal,
  removeVerdict,
  sweepStaleHeartbeats,
  writeHeartbeat,
  writeIterationExhaustedDiagnostic,
  writeManifest,
  writeResumeSignal,
  writeVerdict,
} from '../dispatch/index.js';
import type {
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  ResumeSignal,
  VerdictOutcome,
  WorkerKind,
} from '../dispatch/index.js';
import {
  countInFlightBgAgents,
  DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS,
  listBgAgentRequests,
  pruneOrphanedBgAgentRequests,
  removeBgAgentRequest,
  writeBgAgentRequest,
} from '../orchestrator/dispatch-bg-agent.js';

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

function resolveBoardDir(flags: Record<string, string>): string {
  return path.resolve(flags['board-dir'] ?? DEFAULT_BOARD_DIR);
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

/**
 * CLI entry point. Returns the intended exit code (0 = success). Tests
 * invoke this directly with synthetic argv + a fake stdout collector.
 */
export async function runDispatchCli(
  argv: readonly string[] = process.argv.slice(2),
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
      const result = claimNext(boardDir, kind as WorkerKind);
      if (!result.claimed) {
        out({ claimed: false });
        return 0;
      }
      out({
        claimed: true,
        manifestPath: result.manifestPath,
        manifest: result.manifest,
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
      const workerId = flags['worker-id'] ?? `worker-${process.pid}`;
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
      const workerId = requireFlag(flags, 'worker-id');
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
      const staleMs = flags['stale-ms'] ? Number.parseInt(flags['stale-ms'], 10) : undefined;
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
      const maxSessions = parseMaxSessions(flags, DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS);
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

const HELP_TEXT = `cli-dispatch — Dispatch Board operator CLI (RFC-0041 §4.4)

Usage:
  cli-dispatch <subcommand> [--board-dir <path>] [...]

Subcommands:
  peek
  claim --worker-kind {in-session-agent|claude-p-shell}
  collect-verdicts [--include-failed]
  write-verdict --task-id <id> --outcome <enum> [--commit-sha <s>]
                [--iterations-attempted <n>] [--session-id <uuid>] ...
  remove-verdict --task-id <id> [--from done|failed]
  heartbeat --task-id <id> --worker-id <id> --worker-kind <kind>
  sweep [--stale-ms <n>]
  release --task-id <id>
  write-manifest --json <path>

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
`;
