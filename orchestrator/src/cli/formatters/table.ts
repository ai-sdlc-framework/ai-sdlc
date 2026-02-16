/**
 * Table output formatter — human-readable tabular output.
 */

export function formatTable(data: Record<string, unknown>): string {
  const type = data.type as string;
  const lines: string[] = [];

  switch (type) {
    case 'run': {
      lines.push('Pipeline Run Result');
      lines.push('─'.repeat(40));
      lines.push(`Issue:      #${data.issueNumber}`);
      lines.push(`PR URL:     ${data.prUrl}`);
      lines.push(`Files:      ${data.filesChanged}`);
      lines.push(`Promotion:  ${data.promotionEligible ? 'eligible' : 'not eligible'}`);
      break;
    }
    case 'status': {
      lines.push(`Pipeline: ${data.pipeline}`);
      lines.push('─'.repeat(50));
      const runs = data.recentRuns as Array<Record<string, unknown>>;
      if (runs.length === 0) {
        lines.push('No recent runs.');
      } else {
        lines.push('Run ID'.padEnd(30) + 'Issue'.padEnd(10) + 'Status'.padEnd(12) + 'Started');
        lines.push('─'.repeat(70));
        for (const run of runs) {
          lines.push(
            String(run.runId ?? '').padEnd(30) +
            String(run.issueNumber ? `#${run.issueNumber}` : '-').padEnd(10) +
            String(run.status ?? '').padEnd(12) +
            String(run.startedAt ?? '-'),
          );
        }
      }
      break;
    }
    case 'health': {
      lines.push('Health Check');
      lines.push('─'.repeat(40));
      lines.push(`Config:      ${data.configValid ? 'valid' : 'INVALID'}`);
      lines.push(`State Store: ${data.stateStoreConnected ? 'connected' : 'not configured'}`);
      const errors = data.errors as string[];
      if (errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const e of errors) {
          lines.push(`  - ${e}`);
        }
      }
      break;
    }
    default: {
      // Generic key-value output
      for (const [key, value] of Object.entries(data)) {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
  }

  return lines.join('\n');
}
