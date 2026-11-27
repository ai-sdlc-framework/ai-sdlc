#!/usr/bin/env node
/**
 * Bin shim for `cli-judgment`: doctor, list, ask, eval and replay for the
 * judgment layer. Forwards to the compiled router in `dist/cli/judgment.js`
 * (built by `pnpm build`). See `pipeline-cli/README.md` for the contract.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runJudgmentCli } from '../dist/cli/judgment.js';

runJudgmentCli()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`[cli-judgment] error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
