#!/usr/bin/env node
/**
 * Bin shim for `cli-orchestrator-corpus` (AISDLC-169.5 / RFC-0015 §11 Phase 5).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/orchestrator-corpus.js` after `pnpm build`.
 *
 * The CLI aggregates downloaded orchestrator events.jsonl artifacts into
 * an unattended-completion + quota-burn report and recommendation
 * envelope. See `pipeline-cli/src/cli/orchestrator-corpus.ts` for the
 * full contract and `docs/operations/orchestrator-promotion.md` for how
 * the recommendation drives the AI_SDLC_AUTONOMOUS_ORCHESTRATOR
 * default-on promotion decision.
 */
import { runOrchestratorCorpusCli } from '../dist/cli/orchestrator-corpus.js';

runOrchestratorCorpusCli().catch((err) => {
  process.stderr.write(`[cli-orchestrator-corpus] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
