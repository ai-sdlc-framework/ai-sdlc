#!/usr/bin/env node
/**
 * Bin shim for `cli-dor-corpus` (AISDLC-161 / RFC-0011 §5.5 + §8.4).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/dor-corpus.js` after `pnpm build`.
 *
 * The CLI aggregates downloaded DoR calibration JSONL artifacts (produced
 * by `.github/workflows/dor-ingress.yml`) into a per-gate FP-rate report
 * + recommendation envelope. See `pipeline-cli/src/cli/dor-corpus.ts` for
 * the full contract and `docs/operations/dor-promotion.md` for how the
 * recommendation drives the AISDLC-115.9 promotion decision.
 */
import { runDorCorpusCli } from '../dist/cli/dor-corpus.js';

runDorCorpusCli().catch((err) => {
  process.stderr.write(`[cli-dor-corpus] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
