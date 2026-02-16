/**
 * JSON output formatter — machine-readable JSON output.
 */

export function formatJson(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2);
}
