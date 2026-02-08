/**
 * Resolves a secretRef to an environment variable value.
 *
 * Converts kebab-case secret names to UPPER_SNAKE_CASE environment variable
 * names (e.g., `github-token` → `GITHUB_TOKEN`).
 */

export function resolveSecret(secretRef: string): string {
  const envVar = secretRef.replace(/-/g, '_').toUpperCase();
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`Secret "${secretRef}" not found: environment variable ${envVar} is not set`);
  }
  return value;
}
