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
 *      render the Overview Mode.
 *
 * Returning the render handle is intentionally avoided — the Ink render
 * loop owns the process lifecycle until the user hits `q` or Ctrl+C.
 */

import React from 'react';
import { isTuiEnabled, tuiDisabledMessage } from './feature-flag.js';

export async function runTui(): Promise<void> {
  if (!isTuiEnabled()) {
    process.stderr.write(`${tuiDisabledMessage()}\n`);
    process.exit(1);
  }

  const { render } = await import('ink');
  const { App } = await import('./app.js');

  render(React.createElement(App));
}
