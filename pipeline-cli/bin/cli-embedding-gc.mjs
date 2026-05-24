#!/usr/bin/env node
/**
 * Bin shim for `cli-embedding-gc` (AISDLC-338 / RFC-0019 Phase 2).
 * Forwards to the compiled embedding GC CLI router.
 * The router lives in `dist/cli/embedding-gc.js` after `pnpm build`.
 *
 * Invoke via:
 *   node pipeline-cli/bin/cli-embedding-gc.mjs run --artifacts-dir <dir>
 *   node pipeline-cli/bin/cli-embedding-gc.mjs stats --artifacts-dir <dir>
 */
import { runEmbeddingGcCli } from '../dist/cli/embedding-gc.js';

runEmbeddingGcCli().catch((err) => {
  process.stderr.write(`[cli-embedding-gc] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
