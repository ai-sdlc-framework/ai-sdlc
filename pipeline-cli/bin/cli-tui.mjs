#!/usr/bin/env node
/**
 * Bin shim for `cli-tui` (RFC-0023 Phase 1 / AISDLC-178.1).
 *
 * Operator-facing TUI for monitoring + steering the autonomous pipeline.
 * Forwards to the compiled Ink renderer. Compiled entry lives in
 * `dist/tui/index.js` after `pnpm build`.
 *
 * Invoke directly via `node pipeline-cli/bin/cli-tui.mjs` —
 * never via `pnpm exec` (AISDLC-156 — `pnpm exec` does not resolve a
 * workspace package's own bin entries).
 *
 * Phase 1 surface: Overview Mode with placeholder panes. Gated by
 * AI_SDLC_TUI=experimental (RFC-0023 §14).
 */
import { runTui } from '../dist/tui/index.js';

runTui().catch((err) => {
  process.stderr.write(`[cli-tui] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
