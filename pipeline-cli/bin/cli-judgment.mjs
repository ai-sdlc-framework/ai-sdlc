#!/usr/bin/env node
/**
 * Bin shim for `cli-judgment`: doctor, list, ask, eval and replay for the
 * judgment layer. Forwards to the compiled router in `dist/cli/judgment.js`
 * (built by `pnpm build`). See `pipeline-cli/README.md` for the contract.
 */
import { runJudgmentCli } from '../dist/cli/judgment.js';

runJudgmentCli()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`[cli-judgment] error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
