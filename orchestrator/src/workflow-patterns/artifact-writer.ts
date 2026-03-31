/**
 * Artifact writer — generates files for approved pattern proposals.
 * Never overwrites existing files.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface WriteResult {
  success: boolean;
  filePath: string;
  error?: string;
}

/**
 * Write a proposal artifact to the filesystem.
 * Creates parent directories if needed.
 * Returns error if file already exists (never overwrites).
 */
export function writeArtifact(
  projectDir: string,
  relativePath: string,
  content: string,
): WriteResult {
  const fullPath = join(projectDir, relativePath);

  if (existsSync(fullPath)) {
    return {
      success: false,
      filePath: fullPath,
      error: `File already exists: ${relativePath}`,
    };
  }

  try {
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    return { success: true, filePath: fullPath };
  } catch (err) {
    return {
      success: false,
      filePath: fullPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
