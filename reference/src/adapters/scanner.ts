/**
 * Local filesystem adapter scanner.
 * Reads adapter metadata.yaml files from a directory structure.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AdapterMetadata } from './registry.js';
import { validateAdapterMetadata } from './registry.js';

export interface ScanOptions {
  /** Base directory containing adapter subdirectories. */
  basePath: string;
  /** Whether to skip adapters with invalid metadata. Default: true. */
  skipInvalid?: boolean;
}

export interface ScanResult {
  adapters: AdapterMetadata[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Parse a metadata YAML string into AdapterMetadata.
 */
export function parseMetadataYaml(content: string): AdapterMetadata {
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML: expected an object');
  }
  return parsed as AdapterMetadata;
}

/**
 * Scan a directory for adapter metadata.yaml files.
 * Expects structure: `<basePath>/<adapter-name>/metadata.yaml`
 */
export async function scanLocalAdapters(options: ScanOptions): Promise<ScanResult> {
  const { basePath, skipInvalid = true } = options;
  const adapters: AdapterMetadata[] = [];
  const errors: ScanResult['errors'] = [];

  let entries: string[];
  try {
    const dirEntries = await readdir(basePath, { withFileTypes: true });
    entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    return {
      adapters: [],
      errors: [
        {
          path: basePath,
          error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  for (const dirName of entries) {
    const metadataPath = join(basePath, dirName, 'metadata.yaml');
    try {
      const content = await readFile(metadataPath, 'utf-8');
      const metadata = parseMetadataYaml(content);
      const validation = validateAdapterMetadata(metadata);
      if (validation.valid) {
        adapters.push(metadata);
      } else if (!skipInvalid) {
        errors.push({ path: metadataPath, error: validation.errors.join('; ') });
      } else {
        errors.push({ path: metadataPath, error: validation.errors.join('; ') });
      }
    } catch (err) {
      errors.push({
        path: metadataPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { adapters, errors };
}
