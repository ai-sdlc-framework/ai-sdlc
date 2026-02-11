/**
 * Environment variable-backed SecretStore.
 * Wraps process.env behind the SecretStore interface.
 * Secret names are converted from kebab-case to UPPER_SNAKE_CASE.
 */

import type { SecretStore } from './interfaces.js';

/**
 * Convert a kebab-case secret name to UPPER_SNAKE_CASE env var name.
 * e.g., "github-token" → "GITHUB_TOKEN"
 */
function toEnvVar(name: string): string {
  return name.replace(/-/g, '_').toUpperCase();
}

/**
 * Create a SecretStore backed by environment variables.
 *
 * @param env - The environment object to read from (defaults to process.env).
 */
export function createEnvSecretStore(
  env: Record<string, string | undefined> = process.env,
): SecretStore {
  return {
    get(name: string): string | undefined {
      return env[toEnvVar(name)];
    },

    getRequired(name: string): string {
      const envVar = toEnvVar(name);
      const value = env[envVar];
      if (!value) {
        throw new Error(`Secret "${name}" not found: environment variable ${envVar} is not set`);
      }
      return value;
    },
  };
}
