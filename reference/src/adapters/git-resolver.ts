/**
 * Git-based adapter resolver.
 * Resolves adapter metadata from git repository references (PRD §9.3).
 *
 * Format: `github.com/<org>/<repo>@<ref>`
 * Fetches `metadata.yaml` from the repository's raw content endpoint.
 */

import { parseMetadataYaml } from './scanner.js';
import { validateAdapterMetadata, type AdapterMetadata } from './registry.js';

/** Parsed git adapter reference. */
export interface GitAdapterReference {
  host: string;
  org: string;
  repo: string;
  ref: string;
}

/** Abstraction for fetching raw file content from a git host. */
export interface GitAdapterFetcher {
  fetch(url: string): Promise<string | null>;
}

/** Result of resolving an adapter from a git reference. */
export interface GitResolveResult {
  metadata: AdapterMetadata | null;
  error?: string;
}

const GIT_REF_PATTERN = /^([^/]+)\/([^/]+)\/([^@]+)@(.+)$/;

/**
 * Parse a git adapter reference string.
 * Expected format: `github.com/org/repo@v1.0.0`
 */
export function parseGitAdapterRef(ref: string): GitAdapterReference {
  const match = GIT_REF_PATTERN.exec(ref);
  if (!match) {
    throw new Error(
      `Invalid git adapter reference "${ref}": expected format <host>/<org>/<repo>@<ref>`,
    );
  }
  return {
    host: match[1],
    org: match[2],
    repo: match[3],
    ref: match[4],
  };
}

/**
 * Build the raw content URL for a metadata.yaml file.
 * Currently supports github.com via raw.githubusercontent.com.
 */
export function buildRawUrl(parsed: GitAdapterReference): string {
  if (parsed.host === 'github.com') {
    return `https://raw.githubusercontent.com/${parsed.org}/${parsed.repo}/${parsed.ref}/metadata.yaml`;
  }
  throw new Error(`Unsupported git host: ${parsed.host}`);
}

/**
 * Create a real HTTP fetcher for git-hosted adapter metadata.
 * Uses the global fetch API.
 */
export function createGitAdapterFetcher(): GitAdapterFetcher {
  return {
    async fetch(url: string): Promise<string | null> {
      const response = await globalThis.fetch(url);
      if (!response.ok) return null;
      return response.text();
    },
  };
}

/**
 * Create a stub fetcher for testing.
 * Maps URLs to YAML content strings.
 */
export function createStubGitAdapterFetcher(entries: Map<string, string>): GitAdapterFetcher {
  return {
    async fetch(url: string): Promise<string | null> {
      return entries.get(url) ?? null;
    },
  };
}

/**
 * Resolve adapter metadata from a git reference.
 * Parses the reference, fetches metadata.yaml, validates it.
 */
export async function resolveGitAdapter(
  ref: string,
  fetcher: GitAdapterFetcher,
): Promise<GitResolveResult> {
  let parsed: GitAdapterReference;
  try {
    parsed = parseGitAdapterRef(ref);
  } catch (err) {
    return { metadata: null, error: err instanceof Error ? err.message : String(err) };
  }

  let url: string;
  try {
    url = buildRawUrl(parsed);
  } catch (err) {
    return { metadata: null, error: err instanceof Error ? err.message : String(err) };
  }

  const content = await fetcher.fetch(url);
  if (content === null) {
    return { metadata: null, error: `Failed to fetch metadata from ${url}` };
  }

  let metadata: AdapterMetadata;
  try {
    metadata = parseMetadataYaml(content);
  } catch (err) {
    return {
      metadata: null,
      error: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validation = validateAdapterMetadata(metadata);
  if (!validation.valid) {
    return { metadata: null, error: `Validation failed: ${validation.errors.join('; ')}` };
  }

  return { metadata };
}
