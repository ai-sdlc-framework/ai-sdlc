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
  peekQueue,
  releaseInflight,
  removeVerdict,
  sweepStaleHeartbeats,
  writeHeartbeat,
  writeManifest,
  writeVerdict,
} from '../dispatch/index.js';
import type {
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  VerdictOutcome,
  WorkerKind,
} from '../dispatch/index.js';

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
      const target = writeVerdict(boardDir, verdict);
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

const HELP_TEXT = `cli-dispatch — Dispatch Board operator CLI (RFC-0041 §4.4)

Usage:
  cli-dispatch <subcommand> [--board-dir <path>] [...]

Subcommands:
  peek
  claim --worker-kind {in-session-agent|claude-p-shell}
  collect-verdicts [--include-failed]
  write-verdict --task-id <id> --outcome <enum> [--commit-sha <s>] ...
  remove-verdict --task-id <id> [--from done|failed]
  heartbeat --task-id <id> --worker-id <id> --worker-kind <kind>
  sweep [--stale-ms <n>]
  release --task-id <id>
  write-manifest --json <path>
`;
