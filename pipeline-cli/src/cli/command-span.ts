/**
 * Side-effect entry imported first by every `pipeline-cli/bin/cli-*.mjs` shim (AISDLC-1414): times
 * the process as one `command` span (see `telemetry/timings`). The start is the process start, so
 * Node startup and module loading count.
 *
 * @module cli/command-span
 */

import { performance } from 'node:perf_hooks';

import { installCommandSpan } from '../telemetry/timings.js';

try {
  installCommandSpan(process, { startMs: Math.round(performance.timeOrigin) });
} catch {
  // timing is best effort and never stops the command
}
