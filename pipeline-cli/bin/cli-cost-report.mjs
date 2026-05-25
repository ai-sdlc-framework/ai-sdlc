#!/usr/bin/env node
/**
 * Bin shim for `cli-cost-report` (AISDLC-340 / RFC-0019 §10 OQ-7 re-walkthrough).
 *
 * Unified cost report aggregating LLM input/output tokens, embeddingTokens,
 * and SubscriptionLedger window consumption with explicit costModel labels.
 *
 * Invoke via:
 *   node pipeline-cli/bin/cli-cost-report.mjs --unified \
 *     --cost-ledger-jsonl /path/to/cost-ledger.jsonl \
 *     --ledger-dir       /path/to/.ai-sdlc/artifacts/_ledger
 *
 * See docs/operations/embedding-providers.md#unified-cost-report.
 */
import { runCostReportCli } from '../dist/cli/cost-report.js';

runCostReportCli().catch((err) => {
  process.stderr.write(`[cli-cost-report] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
