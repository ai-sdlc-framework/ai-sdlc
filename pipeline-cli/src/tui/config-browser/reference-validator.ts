/**
 * `@ai-sdlc/reference` schema-validator delegate — RFC-0023 §9.
 *
 * Adapter from the reference library's `validateResource` shape to the
 * config-browser's `SchemaValidator` interface. Kept in its own module so
 * the core `validator.ts` stays free of the reference dep (lighter test
 * setup; faster cold imports for unit tests).
 *
 * The delegate is dynamic-imported so a missing dep at runtime degrades
 * to "no schema validation available" rather than crashing the TUI.
 */

import type { SchemaValidator, YamlValidationIssue } from './validator.js';

type ReferenceValidationError = { path: string; message: string; keyword: string };

interface ReferenceModule {
  validateResource: (data: unknown) => {
    valid: boolean;
    errors?: ReferenceValidationError[];
  };
}

let cachedReference: ReferenceModule | null | undefined;

async function getReference(): Promise<ReferenceModule | null> {
  if (cachedReference !== undefined) return cachedReference;
  try {
    const mod = (await import('@ai-sdlc/reference')) as unknown as ReferenceModule;
    cachedReference = mod;
  } catch {
    cachedReference = null;
  }
  return cachedReference;
}

/**
 * Async loader that returns a SchemaValidator usable from `validateYaml`.
 * Returns null when the dep isn't available.
 *
 * Intentionally async — callers can pre-load before rendering and pass
 * the cached delegate down via context, or call inline + await.
 */
export async function loadReferenceSchemaValidator(): Promise<SchemaValidator | null> {
  const ref = await getReference();
  if (!ref) return null;

  return (kind, document) => {
    // The reference validator infers kind from the document, so we delegate
    // entirely. The `kind` argument is informational here — it has already
    // been read off the document by the caller.
    void kind;
    const result = ref.validateResource(document);
    if (result.valid) return [];
    return (result.errors ?? []).map(
      (e): Omit<YamlValidationIssue, 'source' | 'line' | 'column'> => ({
        message: e.message,
        path: e.path || '/',
      }),
    );
  };
}

/**
 * Reset the module-level cache. Tests use this to swap mocks without
 * leaving state from a previous test polluting the next.
 */
export function __resetReferenceCacheForTests(): void {
  cachedReference = undefined;
}
