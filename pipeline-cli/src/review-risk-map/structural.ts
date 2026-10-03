/**
 * Stage 1 of the staged review: structural facts per hunk (changed symbols,
 * callers and callees, test files that reference the changed symbols,
 * patch-coverage lines, consumers of a changed schema).
 *
 * The facts come from an injected {@link StructuralProvider}. The default
 * provider returns `undefined`, which records `structural: unavailable` and
 * ranks the hunk as high risk. That is deliberate: the path gate and the task
 * dependency graph that already exist are not a parser or a call graph, so
 * nothing here can honestly name a hunk's symbols or callers. A provider backed
 * by a real extractor plugs in without changing the map.
 *
 * @module review-risk-map/structural
 */

import type { FileClass } from '../review-plan/types.js';

/** What a provider is told about a hunk. The text is already redacted. */
export interface StructuralHunkRef {
  id: string;
  file: string;
  fileClass: FileClass;
  startLine: number;
  endLine: number;
  text: string;
}

export interface HunkStructuralFacts {
  symbols: readonly string[];
  callers: readonly string[];
  callees: readonly string[];
  referencingTests: readonly string[];
  /** Lines of the hunk that patch coverage reports. */
  coverageLines: readonly number[];
  schemaConsumers: readonly string[];
}

export interface StructuralProvider {
  /** Facts for a hunk, or `undefined` when none can be produced (unsupported or unreadable). */
  factsFor(
    hunk: StructuralHunkRef,
  ): HunkStructuralFacts | undefined | Promise<HunkStructuralFacts | undefined>;
}

/** The default provider: no structural facts for any hunk. */
export const unavailableStructuralProvider: StructuralProvider = {
  factsFor: () => undefined,
};

const MAX_STRINGS = 1000;
const MAX_LINES = 10_000;
const MAX_STRING_LENGTH = 1024;

function cleanStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const s of v) {
    if (typeof s === 'string' && s.length > 0 && s.length <= MAX_STRING_LENGTH) out.add(s);
    if (out.size >= MAX_STRINGS) break;
  }
  return [...out];
}

function cleanLines(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const n of v) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) out.add(n);
    if (out.size >= MAX_LINES) break;
  }
  return [...out].sort((a, b) => a - b);
}

/** Validate what a provider returned. Anything that is not a facts object is unavailable. */
export function normalizeFacts(raw: unknown): HunkStructuralFacts | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    symbols: cleanStrings(r.symbols),
    callers: cleanStrings(r.callers),
    callees: cleanStrings(r.callees),
    referencingTests: cleanStrings(r.referencingTests),
    coverageLines: cleanLines(r.coverageLines),
    schemaConsumers: cleanStrings(r.schemaConsumers),
  };
}

/**
 * Ask the provider about every hunk. A provider that throws, or returns something
 * other than a facts object, leaves that hunk's structural facts unavailable.
 */
export async function collectStructural(
  hunks: readonly StructuralHunkRef[],
  provider: StructuralProvider,
): Promise<Map<string, HunkStructuralFacts | undefined>> {
  const out = new Map<string, HunkStructuralFacts | undefined>();
  for (const h of hunks) {
    try {
      out.set(h.id, normalizeFacts(await provider.factsFor(h)));
    } catch {
      out.set(h.id, undefined);
    }
  }
  return out;
}
