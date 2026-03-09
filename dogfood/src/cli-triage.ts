#!/usr/bin/env node
/**
 * CLI entry point for the security triage pipeline.
 *
 * Modes:
 *   Full:     triage --issue 42
 *   Analyze:  triage --title "..." --body "..." --dry-run
 *             Outputs verdict JSON to stdout (no tracker needed).
 */

import { executeTriage } from '@ai-sdlc/orchestrator';
import { resolveRepoRoot } from '@ai-sdlc/orchestrator';

interface TriageArgs {
  issueId?: string;
  title?: string;
  body?: string;
  dryRun: boolean;
}

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function parseArgs(argv: string[]): TriageArgs {
  const issueId = getArg(argv, '--issue')?.trim();
  const title = getArg(argv, '--title');
  const body = getArg(argv, '--body');
  const dryRun = argv.includes('--dry-run');

  if (!issueId && !title) {
    console.error('Usage: triage --issue <id>');
    console.error('       triage --title "..." --body "..." --dry-run');
    process.exit(1);
  }

  return { issueId, title, body, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const workDir = await resolveRepoRoot();

  // Analyze-only mode: pass title/body directly, skip tracker
  if (args.title) {
    const { SecurityTriageRunner } = await import('@ai-sdlc/orchestrator');
    const runner = new SecurityTriageRunner();
    const result = await runner.run({
      issueId: args.issueId ?? '0',
      issueTitle: args.title,
      issueBody: args.body ?? '',
      workDir,
      branch: 'main',
      constraints: { maxFilesPerChange: 0, requireTests: false, blockedPaths: ['**/*'] },
    });

    if (!result.success) {
      // Output error verdict as JSON so the report job can handle it
      const errorVerdict = {
        safe: false,
        riskScore: 7,
        findings: ['Triage pipeline error — treating as suspicious'],
        sanitizedDescription: '',
        rationale: result.error ?? 'Unknown error',
      };
      console.log(JSON.stringify(errorVerdict));
      process.exit(1);
    }

    // Output raw verdict JSON to stdout for the report job
    console.log(result.summary);
    return;
  }

  // Full mode: fetch issue from tracker, post comment, apply label
  try {
    const result = await executeTriage(args.issueId!, {
      workDir,
      dryRun: args.dryRun,
    });

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
