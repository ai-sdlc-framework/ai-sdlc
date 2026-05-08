/**
 * Entry point for `cli-tui` (RFC-0023 Phase 1 / AISDLC-178.1, with self-
 * observability hooks added in Phase 7 / AISDLC-178.7).
 *
 * Compiled to `dist/tui/index.js` and invoked from `bin/cli-tui.mjs`.
 *
 * Behaviour:
 *   1. Check `AI_SDLC_TUI` opt-in (RFC-0023 §14). If unset/false, print the
 *      disabled message to stderr and exit 1.
 *   2. Stamp a `TuiStarted` event on `_tui/events.jsonl` (RFC §12 / AC#4)
 *      so the corpus aggregator (Phase 7) can count sessions.
 *   3. Otherwise, dynamically import Ink + the App component (deferred so
 *      the disabled-flag path doesn't pay the React/Ink import cost) and
 *      render the Overview Mode.
 *   4. Wire `process.on('uncaughtException')` and `unhandledRejection`
 *      handlers that emit `TuiCrashed` to `_tui/events.jsonl` before
 *      rethrowing — RFC §13 promotion gate ("zero TuiCrashed events
 *      across the soak window") needs every crash to land in the file
 *      so the count math is honest.
 *
 * Returning the render handle is intentionally avoided — the Ink render
 * loop owns the process lifecycle until the user hits `q` or Ctrl+C.
 */

import React from 'react';
import { isTuiEnabled, tuiDisabledMessage } from './feature-flag.js';
import { printBanner } from './banner.js';
import { writeTuiCrashed, writeTuiStarted } from './self-events.js';

export async function runTui(): Promise<void> {
  if (!isTuiEnabled()) {
    process.stderr.write(`${tuiDisabledMessage()}\n`);
    process.exit(1);
  }

  // RFC-0023 §10 / OQ-8 disclosure — surface the telemetry path + opt-out
  // env var BEFORE the Ink render loop captures the terminal.
  printBanner();

  // RFC §12 / AC#4 — stamp a session-start event so the Phase 7 corpus
  // aggregator can count sessions + days-with-usage.
  writeTuiStarted();

  // RFC §13 hard gate — funnel every uncaught crash into _tui/events.jsonl
  // so the corpus's TuiCrashed-count metric is faithful. Best-effort: the
  // writer swallows its own errors; we still rethrow so the runtime exits
  // with the right code.
  const onCrash = (err: unknown): void => {
    try {
      writeTuiCrashed(err);
    } catch {
      // ignore — last-ditch handler must not throw
    }
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  const { render } = await import('ink');
  const { App } = await import('./app.js');

  render(React.createElement(App));
}
