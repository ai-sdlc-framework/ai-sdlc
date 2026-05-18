#!/usr/bin/env node
/**
 * Bin shim for `cli-quality-corpus` (AISDLC-302 / RFC-0025 Phase 1 substrate).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/quality-corpus.js` after `pnpm build`.
 *
 * The CLI aggregates the framework-quality capture corpus
 * (`$ARTIFACTS_DIR/_quality/captures.jsonl`) into RFC-0025 §8
 * self-improvement metrics: reliability trend (week-over-week), MTTR
 * (first capture → fix done date, per OQ-8), recurrence rate (fixed bugs
 * that recurred within the configured window, OQ-3 placeholder), and
 * coverage rate (fraction of captures classified vs. ambiguous).
 *
 * See `pipeline-cli/src/cli/quality-corpus.ts` for the full contract and
 * `spec/rfcs/RFC-0025-framework-quality-monitoring.md` for the §8 metric
 * definitions.
 */
import { runQualityCorpusCli } from '../dist/cli/quality-corpus.js';

runQualityCorpusCli().catch((err) => {
  process.stderr.write(`[cli-quality-corpus] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
