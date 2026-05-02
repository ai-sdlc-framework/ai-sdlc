#!/usr/bin/env node
/**
 * Bin shim for `cli-incremental-decide` (AISDLC-142). Forwards to the
 * compiled router. Compiled entry lives in `dist/cli/incremental-decide.js`
 * after `pnpm build`.
 *
 * Wraps the incremental-review primitives so Step 7 of the slash command
 * body and the `analyze` job in `.github/workflows/ai-sdlc-review.yml` can
 * decide on each push whether to skip / delta-only / full review. Composes
 * ON TOP of the AISDLC-141 classifier (cli-classify-pr).
 */
import { runIncrementalDecideCli } from '../dist/cli/incremental-decide.js';

runIncrementalDecideCli().catch((err) => {
  process.stderr.write(`[cli-incremental-decide] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
