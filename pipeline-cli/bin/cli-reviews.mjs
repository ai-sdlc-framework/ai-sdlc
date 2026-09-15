#!/usr/bin/env node
/**
 * Bin shim for `cli-reviews` (AISDLC-616).
 *
 * Reviewer marginal-value analysis over the append-only reviews ledger
 * (`.ai-sdlc/reviews/*.jsonl`): per-role block rate, sole-blocker rate,
 * cross-reviewer finding overlap, and McNemar-style discordant-pair counts.
 *
 * Subcommands:
 *   analyze [--repo-root ...] [--json]
 *
 * Compiled entry lives in `dist/cli/reviews.js` after `pnpm build`.
 */
import { runReviewsCli } from '../dist/cli/reviews.js';

runReviewsCli().catch((err) => {
  process.stderr.write(`[cli-reviews] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
