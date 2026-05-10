#!/usr/bin/env node
/**
 * Bin shim for `cli-tui-corpus` (AISDLC-178.7 / RFC-0023 §13 Phase 7).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/tui/corpus/aggregate.js` after `pnpm build`.
 *
 * The CLI aggregates TUI usage events from `$ARTIFACTS_DIR/_tui/events.jsonl`
 * into a soak-window report and recommendation envelope. See
 * `pipeline-cli/src/tui/corpus/aggregate.ts` for the full contract and
 * `docs/operations/operator-tui-promotion.md` for how the recommendation
 * drives the AI_SDLC_TUI default-on promotion decision.
 *
 * Usage:
 *   node pipeline-cli/bin/cli-tui-corpus.mjs aggregate $ARTIFACTS_DIR/_tui/events.jsonl
 *   node pipeline-cli/bin/cli-tui-corpus.mjs aggregate ./tui-corpus --format table
 */
import { runTuiCorpusCli } from '../dist/tui/corpus/aggregate.js';

runTuiCorpusCli().catch((err) => {
  process.stderr.write(`[cli-tui-corpus] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
