/**
 * Minimal output formatter — single-line output for scripting.
 */

export function formatMinimal(data: Record<string, unknown>): string {
  const type = data.type as string;

  switch (type) {
    case 'run':
      return `PR: ${data.prUrl} (${data.filesChanged} files)`;
    case 'status':
      return `Pipeline: ${data.pipeline} | Runs: ${(data.recentRuns as unknown[]).length}`;
    case 'health': {
      const ok = data.configValid && (data.errors as string[]).length === 0;
      return ok ? 'OK' : `UNHEALTHY: ${(data.errors as string[]).join('; ')}`;
    }
    default:
      return JSON.stringify(data);
  }
}
