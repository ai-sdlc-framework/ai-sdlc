#!/usr/bin/env node
/**
 * Bin shim for `cli-classify-pr` (AISDLC-141). Forwards to the compiled router.
 * Compiled entry lives in `dist/cli/classify-pr.js` after `pnpm build`.
 *
 * Wraps the deterministic classifier ruleset (RFC-0010 §12) so Step 7 of the
 * slash command body and the `analyze` job in `.github/workflows/ai-sdlc-review.yml`
 * can decide which subset of the 3 reviewers to spawn instead of always firing
 * the full fan-out.
 */
import { runClassifyPrCli } from '../dist/cli/classify-pr.js';

runClassifyPrCli().catch((err) => {
  process.stderr.write(`[cli-classify-pr] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
