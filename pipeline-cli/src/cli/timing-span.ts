/**
 * `node pipeline-cli/dist/cli/timing-span.js` (AISDLC-1414): the pre-push hook's recorder for
 * `gate` spans, run outside any bin so the hook needs no shell clock with millisecond precision.
 *
 *   timing-span.js now                                  prints the clock in ms
 *   timing-span.js gate <name> <start-ms> <exit-code>   appends one gate span ending now
 *
 * Never fails: a bad argument or an unwritable file exits 0 with nothing written.
 *
 * @module cli/timing-span
 */

import { pathToFileURL } from 'node:url';

import { appendSpan, timingsFile } from '../telemetry/timings.js';

export function runTimingSpan(
  argv: readonly string[],
  deps: { now?: () => number; write?: (s: string) => void; file?: string | null } = {},
): number {
  const now = deps.now ?? Date.now;
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const [cmd, name, start, code] = argv;
  if (cmd === 'now') {
    write(`${now()}\n`);
    return 0;
  }
  const startMs = Number(start);
  if (cmd !== 'gate' || !name || !Number.isFinite(startMs) || startMs <= 0) return 0;
  const exit = Number(code);
  const env = process.env;
  appendSpan(
    {
      kind: 'gate',
      name,
      startedAt: startMs,
      durationMs: now() - startMs,
      exitCode: Number.isInteger(exit) ? exit : null,
      pid: process.ppid,
      taskId: env.AI_SDLC_ACTIVE_TASK_ID || env.AI_SDLC_EXECUTOR_TASK,
    },
    deps.file === undefined ? timingsFile() : deps.file,
  );
  return 0;
}

/* c8 ignore next 3 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runTimingSpan(process.argv.slice(2));
}
