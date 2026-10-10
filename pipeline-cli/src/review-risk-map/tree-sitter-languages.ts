/**
 * Language registry and grammar loading for the tree-sitter structural provider.
 *
 * Grammars are WASM files from the `tree-sitter-wasms` package, loaded through
 * `web-tree-sitter`. Nothing is downloaded: a grammar that is not installed, or that
 * does not load, makes files of that language unavailable (reason `no-grammar`).
 *
 * To add a language, see `docs/operations/staged-review-structural-provider.md`.
 *
 * @module review-risk-map/tree-sitter-languages
 */

import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

/** A grammar the provider can load. */
export type GrammarId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go';

/** Languages that share a call namespace: a TypeScript file can call a JavaScript one. */
export type LanguageFamily = 'ecmascript' | 'python' | 'go';

export interface LanguageSpec {
  grammar: GrammarId;
  family: LanguageFamily;
  /** File name of the grammar inside `tree-sitter-wasms/out/`. */
  wasm: string;
}

const SPECS: Record<GrammarId, LanguageSpec> = {
  typescript: { grammar: 'typescript', family: 'ecmascript', wasm: 'tree-sitter-typescript.wasm' },
  tsx: { grammar: 'tsx', family: 'ecmascript', wasm: 'tree-sitter-tsx.wasm' },
  javascript: { grammar: 'javascript', family: 'ecmascript', wasm: 'tree-sitter-javascript.wasm' },
  python: { grammar: 'python', family: 'python', wasm: 'tree-sitter-python.wasm' },
  go: { grammar: 'go', family: 'go', wasm: 'tree-sitter-go.wasm' },
};

const EXTENSIONS: Record<string, GrammarId> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
};

/** Extensions the provider has a grammar for, in a stable order. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(EXTENSIONS);

/** The language spec for a file path, or `undefined` for an extension with no grammar. */
export function languageForPath(path: string): LanguageSpec | undefined {
  const grammar = EXTENSIONS[extname(path).toLowerCase()];
  return grammar ? SPECS[grammar] : undefined;
}

/** Whether `path` looks like a test file (by convention, in any supported language). */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|spec)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.(py|go)$/.test(path)
  );
}

const nodeRequire = createRequire(import.meta.url);

/** Absolute path of an installed grammar's WASM file, or `undefined` when it is not installed. */
export function installedGrammarPath(spec: LanguageSpec): string | undefined {
  try {
    return nodeRequire.resolve(`tree-sitter-wasms/out/${spec.wasm}`);
  } catch {
    return undefined;
  }
}

let runtimeReady: Promise<void> | undefined;

/** Initialise the WASM runtime once per process. A failed init is retried on the next call. */
export function ensureParserRuntime(): Promise<void> {
  runtimeReady ??= Parser.init().catch((err: unknown) => {
    runtimeReady = undefined;
    throw err;
  });
  return runtimeReady;
}

/**
 * Loads grammars on demand and remembers the result, including failure.
 * `overrides` points a grammar at a different file, which is how a test simulates a
 * missing grammar and how an adopter supplies one the package does not ship.
 */
export class GrammarLoader {
  private readonly loaded = new Map<GrammarId, Promise<Language | undefined>>();

  constructor(private readonly overrides: Partial<Record<GrammarId, string>> = {}) {}

  load(spec: LanguageSpec): Promise<Language | undefined> {
    let p = this.loaded.get(spec.grammar);
    if (!p) {
      p = this.loadUncached(spec);
      this.loaded.set(spec.grammar, p);
    }
    return p;
  }

  private async loadUncached(spec: LanguageSpec): Promise<Language | undefined> {
    const path = this.overrides[spec.grammar] ?? installedGrammarPath(spec);
    if (!path) return undefined;
    try {
      await ensureParserRuntime();
      return await Language.load(path);
    } catch {
      return undefined;
    }
  }
}
