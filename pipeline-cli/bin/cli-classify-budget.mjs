#!/usr/bin/env node
/**
 * Bin shim for `cli-classify-budget` (AISDLC-147 patch 2). Forwards to the
 * compiled router. Compiled entry lives in `dist/cli/classify-budget.js`
 * after `pnpm build`.
 *
 * Wraps the Anthropic API budget-exhaustion classifier so the report job in
 * `.github/workflows/ai-sdlc-review.yml` can suppress noisy CHANGES_REQUESTED
 * when ALL three reviewers fail with credit-exhausted errors.
 */
import { runClassifyBudgetCli } from '../dist/cli/classify-budget.js';

runClassifyBudgetCli().catch((err) => {
  process.stderr.write(`[cli-classify-budget] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
