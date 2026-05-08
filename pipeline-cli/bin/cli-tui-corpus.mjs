#!/usr/bin/env node
/**
 * Bin shim for `cli-tui-corpus` (AISDLC-178.7 / RFC-0023 §13 Phase 7).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/tui-corpus.js` after `pnpm build`.
 *
 * The CLI aggregates downloaded operator-TUI artifacts (sessions,
 * pane-opens, decisions, captures, TuiCrashed) into a soak report and
 * recommendation envelope. See `pipeline-cli/src/cli/tui-corpus.ts` for
 * the full contract and `docs/operations/operator-tui-promotion.md` for
 * how the recommendation drives the AI_SDLC_TUI default-on promotion
 * decision.
 */
import { runTuiCorpusCli } from '../dist/cli/tui-corpus.js';

runTuiCorpusCli().catch((err) => {
  process.stderr.write(`[cli-tui-corpus] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
