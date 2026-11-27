#!/usr/bin/env node
/**
 * Bin shim for `cli-file` (AISDLC-801). Forwards to `dist/cli/file.js`.
 */
import { runFileCli } from '../dist/cli/file.js';

runFileCli()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[cli-file] error: ${err?.message ?? String(err)}\n`);
    process.exit(2);
  });
