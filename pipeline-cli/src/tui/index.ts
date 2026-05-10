/**
 * Entry point for `cli-tui` (RFC-0023 Phase 1 / AISDLC-178.1).
 *
 * Compiled to `dist/tui/index.js` and invoked from `bin/cli-tui.mjs`.
 *
 * Behaviour:
 *   1. Check `AI_SDLC_TUI` opt-in (RFC-0023 §14). If unset/false, print the
 *      disabled message to stderr and exit 1.
 *   2. Otherwise, dynamically import Ink + the App component (deferred so
 *      the disabled-flag path doesn't pay the React/Ink import cost) and
 *      render the Overview Mode inside the terminal alt-screen buffer.
 *
 * Alt-screen buffer (AISDLC-236):
 *   Without alt-screen mode Ink uses an erase-previous-lines strategy
 *   (`log-update`) to redraw. When the rendered height changes between
 *   frames (e.g. list navigation grows/shrinks the output), the line
 *   count becomes stale and subsequent erases leave orphaned rows above
 *   the new frame — producing the visible "content drifts down" symptom.
 *
 *   The fix emits `\e[?1049h` on entry (switches to the alternate screen
 *   buffer, a blank slate where Ink can use `clearTerminal` reliably) and
 *   `\e[?1049l` on exit (restores the primary buffer + pre-TUI scroll
 *   history). This is the approach used by every full-screen terminal UI
 *   (vim, htop, less, etc.) and requires a terminal that supports
 *   xterm-style alternate-screen sequences — which is universally true
 *   for every modern terminal emulator.
 *
 *   Ink's `patchConsole: true` is also explicitly set (it is the default,
 *   but making it explicit guards against callers accidentally disabling
 *   it) so that any `console.log` / `console.error` calls inside the
 *   component tree are routed through Ink's output buffer rather than
 *   stomping the render directly on stdout.
 *
 *   Error handling: uncaught exceptions + unhandled rejections are
 *   captured BEFORE Ink mounts and written to stderr AFTER Ink unmounts
 *   so the operator can see what went wrong once the alt-screen has been
 *   restored (AC#7).
 *
 * Returning the render handle is intentionally avoided — the Ink render
 * loop owns the process lifecycle until the user hits `q` or Ctrl+C.
 */

import React from 'react';
import { isTuiEnabled, tuiDisabledMessage } from './feature-flag.js';
import { printBanner } from './banner.js';

// Alt-screen escape sequences (xterm / VT100 private-mode 1049).
// These are the same sequences used by vim, less, htop, etc.
export const ALT_SCREEN_ENTER = '\x1b[?1049h';
export const ALT_SCREEN_EXIT = '\x1b[?1049l';

/**
 * Emit the alt-screen enter sequence and register cleanup handlers so the
 * terminal is always restored on exit (normal exit, Ctrl+C, uncaught error).
 *
 * Returns a cleanup function for callers that manage the lifecycle
 * themselves (e.g., tests that need deterministic teardown).
 */
export function enterAltScreen(stdout: NodeJS.WriteStream = process.stdout): () => void {
  stdout.write(ALT_SCREEN_ENTER);

  const restore = (): void => {
    stdout.write(ALT_SCREEN_EXIT);
  };

  // Ensure we restore on every exit path.
  process.once('exit', restore);
  process.once('SIGINT', () => {
    restore();
    process.exit(130); // conventional SIGINT exit code
  });
  process.once('SIGTERM', () => {
    restore();
    process.exit(143); // conventional SIGTERM exit code
  });

  return restore;
}

export async function runTui(): Promise<void> {
  if (!isTuiEnabled()) {
    process.stderr.write(`${tuiDisabledMessage()}\n`);
    process.exit(1);
  }

  // RFC-0023 §10 / OQ-8 disclosure — surface the telemetry path + opt-out
  // env var BEFORE the Ink render loop captures the terminal.
  printBanner();

  // AC#7: capture uncaught errors before Ink mounts so they can be
  // surfaced to stderr after Ink unmounts (when the alt-screen is gone
  // and the operator can actually read the output).
  const pendingErrors: unknown[] = [];
  const captureError = (err: unknown): void => {
    pendingErrors.push(err);
  };
  process.on('uncaughtException', captureError);
  process.on('unhandledRejection', captureError);

  // Enter the alt-screen buffer (AISDLC-236).
  enterAltScreen(process.stdout);

  const { render } = await import('ink');
  const { App } = await import('./app.js');

  // patchConsole: true is the Ink default but we make it explicit so
  // future callers can't accidentally disable it by passing a partial
  // options object. This routes any console.log/error calls inside the
  // component tree through Ink's output buffer rather than stomping the
  // rendered frame on stdout.
  const instance = render(React.createElement(App), { patchConsole: true });

  // Wait for the Ink render loop to finish (user pressed `q` or Ctrl+C).
  await instance.waitUntilExit();

  // Deregister error listeners now that Ink has unmounted.
  process.off('uncaughtException', captureError);
  process.off('unhandledRejection', captureError);

  // AC#7: flush any errors that were captured while the alt-screen was
  // active. They're written to stderr AFTER waitUntilExit() so they
  // appear in the primary buffer where the operator can see them.
  for (const err of pendingErrors) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`[cli-tui] uncaught error:\n${msg}\n`);
  }
}
