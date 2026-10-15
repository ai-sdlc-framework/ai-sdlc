#!/usr/bin/env node
/**
 * Bin shim for `cli-init` (AISDLC-910): scaffold the required consumer
 * configuration from the manifest. Forwards to `dist/cli/init.js`.
 */
import { runInitCli } from '../dist/cli/init.js';

runInitCli()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[cli-init] error: ${err?.message ?? String(err)}\n`);
    process.exit(2);
  });
