#!/usr/bin/env node
/**
 * Bin shim for `cli-embedding-bump` (AISDLC-339 / RFC-0019 Phase 3).
 * Forwards to the compiled embedding-bump CLI router.
 * The router lives in `dist/cli/embedding-bump.js` after `pnpm build`.
 *
 * Invoke via:
 *   node pipeline-cli/bin/cli-embedding-bump.mjs dry-run --from <old> --to <new>
 *   node pipeline-cli/bin/cli-embedding-bump.mjs execute --from <old> --to <new>
 */
import { runEmbeddingBumpCli } from '../dist/cli/embedding-bump.js';

runEmbeddingBumpCli().catch((err) => {
  process.stderr.write(`[cli-embedding-bump] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
