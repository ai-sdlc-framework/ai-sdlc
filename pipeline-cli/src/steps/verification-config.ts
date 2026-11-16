/**
 * Load the per-repo `verification:` block (AISDLC-1263). Steps 5, 6, 10 and 11 read it here;
 * a missing or unreadable file keeps the pnpm defaults.
 *
 * @module steps/verification-config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import {
  VERIFICATION_CONFIG_PATH,
  detectVerificationDefaults,
  renderVerificationYaml,
  resolveVerification,
  type VerificationCommands,
} from './verify-defaults.js';

export function loadVerification(projectRoot: string): VerificationCommands {
  if (!projectRoot) return resolveVerification(undefined);
  const file = join(projectRoot, VERIFICATION_CONFIG_PATH);
  if (!existsSync(file)) return resolveVerification(undefined);
  try {
    const doc = yamlLoad(readFileSync(file, 'utf8')) as { verification?: unknown } | null;
    return resolveVerification(doc?.verification);
  } catch {
    return resolveVerification(undefined);
  }
}

/**
 * `init`: write the block with detected defaults (`package.json` -> pnpm, `pyproject.toml` ->
 * uv). Never overwrites an existing file; returns the repo-relative path when written.
 */
export function scaffoldVerification(projectDir: string): string | undefined {
  const file = join(projectDir, VERIFICATION_CONFIG_PATH);
  if (existsSync(file)) return undefined;
  const detected = detectVerificationDefaults((f) => existsSync(join(projectDir, f)));
  if (!detected) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderVerificationYaml(detected), 'utf8');
  return VERIFICATION_CONFIG_PATH;
}
