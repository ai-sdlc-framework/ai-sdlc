#!/usr/bin/env node
/**
 * CLI entry point for the security triage pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood triage --issue 42
 */

import { executeTriage } from '@ai-sdlc/orchestrator';
import { resolveRepoRoot } from '@ai-sdlc/orchestrator';

function parseArgs(argv: string[]): { issueId: string } {
  const idx = argv.indexOf('--issue');
  if (idx === -1 || idx + 1 >= argv.length) {
    console.error('Usage: triage --issue <id>');
    process.exit(1);
  }
  const issueId = argv[idx + 1].trim();
  if (!issueId) {
    console.error(`Invalid issue ID: ${argv[idx + 1]}`);
    process.exit(1);
  }
  return { issueId };
}

async function main(): Promise<void> {
  const { issueId } = parseArgs(process.argv);
  const workDir = await resolveRepoRoot();

  try {
    const result = await executeTriage(issueId, { workDir });

    console.log('\n── Security Triage Result ──');
    console.log(`Issue:      ${result.issueId}`);
    console.log(`Risk Score: ${result.verdict.riskScore}/10`);
    console.log(`Safe:       ${result.verdict.safe}`);
    console.log(`Rejected:   ${result.rejected}`);
    if (result.labelApplied) {
      console.log(`Label:      ${result.labelApplied}`);
    }
    if (result.verdict.findings.length > 0) {
      console.log('Findings:');
      for (const f of result.verdict.findings) {
        console.log(`  - ${f}`);
      }
    }
    console.log(`Rationale:  ${result.verdict.rationale}`);

    if (result.error) {
      console.error(`\nError: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
