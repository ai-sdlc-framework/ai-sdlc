#!/usr/bin/env node
/**
 * Bin shim for `cli-dor-check` (AISDLC-370).
 * Pre-push DoR gate. Forwards to the compiled router at
 * `dist/cli/dor-check.js` after `pnpm build`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runDorCheckCli } from '../dist/cli/dor-check.js';

runDorCheckCli()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[cli-dor-check] error: ${err?.message ?? String(err)}\n`);
    process.exit(2);
  });
