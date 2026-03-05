/**
 * Per-file config validation — validates YAML files individually and
 * returns structured results instead of throwing on first error.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateResource, type ResourceKind } from '@ai-sdlc/reference';

export interface FileValidationResult {
  file: string;
  kind: string | null;
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Validate config files in the given directory.
 * Returns one result per file instead of failing on the first error.
 */
export function validateConfigFiles(
  configDir: string,
  fileFilter?: string,
): FileValidationResult[] {
  const dir = resolve(configDir);
  const results: FileValidationResult[] = [];

  if (!existsSync(dir)) {
    results.push({
      file: configDir,
      kind: null,
      valid: false,
      errors: [{ path: '/', message: `Config directory not found: ${dir}` }],
    });
    return results;
  }

  let files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  // Skip non-resource YAML files
  files = files.filter((f) => f !== 'manifest.yaml');

  if (fileFilter) {
    files = files.filter((f) => f === fileFilter);
    if (files.length === 0) {
      results.push({
        file: fileFilter,
        kind: null,
        valid: false,
        errors: [{ path: '/', message: `File not found in config directory: ${fileFilter}` }],
      });
      return results;
    }
  }

  for (const file of files) {
    try {
      const raw = readFileSync(resolve(dir, file), 'utf-8');
      const doc: unknown = parseYaml(raw);

      const result = validateResource(doc);
      const kind =
        typeof doc === 'object' && doc !== null && 'kind' in doc
          ? ((doc as { kind: string }).kind as ResourceKind)
          : null;

      if (result.valid) {
        results.push({ file, kind, valid: true, errors: [] });
      } else {
        results.push({
          file,
          kind,
          valid: false,
          errors: (result.errors ?? []).map((e) => ({ path: e.path, message: e.message })),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        file,
        kind: null,
        valid: false,
        errors: [{ path: '/', message }],
      });
    }
  }

  return results;
}
