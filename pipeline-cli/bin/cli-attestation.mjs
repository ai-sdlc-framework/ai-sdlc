#!/usr/bin/env node
/**
 * Bin shim for `cli-attestation` (RFC-0042 / AISDLC-383.1 + 383.2).
 *
 * Operator surfaces for the proof-of-execution attestation workflow:
 * inspecting reviewer-subagent transcript files (Phase 1.1) and computing
 * Merkle roots / inclusion proofs over the committed leaf index (Phase 1.2).
 *
 * Subcommands:
 *   transcripts list [<task-id>]  — list captured transcripts
 *   merkle-root                   — print current Merkle root + leaf count
 *   merkle-proof <index>          — print inclusion proof for a leaf
 *
 * Compiled entry lives in `dist/cli/attestation.js` after `pnpm build`.
 * See docs/operations/transcript-management.md for retention + GC runbook.
 */
import { runAttestationCli } from '../dist/cli/attestation.js';

runAttestationCli().catch((err) => {
  process.stderr.write(`[cli-attestation] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
