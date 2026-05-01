#!/usr/bin/env node
/**
 * Bin shim for `cli-deps` (AISDLC-117). Forwards to the compiled deps CLI
 * router. The router lives in `dist/cli/deps.js` after `pnpm build`.
 */
import { runDepsCli } from '../dist/cli/deps.js';

runDepsCli().catch((err) => {
  process.stderr.write(`[cli-deps] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
