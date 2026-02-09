import { describe, it, expect } from 'vitest';
import {
  parseGitAdapterRef,
  buildRawUrl,
  createStubGitAdapterFetcher,
  resolveGitAdapter,
} from './git-resolver.js';

const VALID_METADATA_YAML = `
name: my-adapter
displayName: My Adapter
description: A test adapter
version: "1.0.0"
stability: stable
interfaces:
  - IssueTracker@v1
owner: acme-org
specVersions:
  - v1alpha1
`;

describe('parseGitAdapterRef()', () => {
  it('parses a valid github reference', () => {
    const ref = parseGitAdapterRef('github.com/acme/my-adapter@v1.0.0');
    expect(ref).toEqual({
      host: 'github.com',
      org: 'acme',
      repo: 'my-adapter',
      ref: 'v1.0.0',
    });
  });

  it('parses a reference with branch name', () => {
    const ref = parseGitAdapterRef('github.com/org/repo@main');
    expect(ref).toEqual({
      host: 'github.com',
      org: 'org',
      repo: 'repo',
      ref: 'main',
    });
  });

  it('throws for invalid reference format', () => {
    expect(() => parseGitAdapterRef('not-valid')).toThrow('Invalid git adapter reference');
  });

  it('throws for reference without version', () => {
    expect(() => parseGitAdapterRef('github.com/org/repo')).toThrow(
      'Invalid git adapter reference',
    );
  });
});

describe('buildRawUrl()', () => {
  it('builds a raw.githubusercontent.com URL for github.com', () => {
    const url = buildRawUrl({
      host: 'github.com',
      org: 'acme',
      repo: 'my-adapter',
      ref: 'v1.0.0',
    });
    expect(url).toBe('https://raw.githubusercontent.com/acme/my-adapter/v1.0.0/metadata.yaml');
  });

  it('throws for unsupported host', () => {
    expect(() => buildRawUrl({ host: 'gitlab.com', org: 'org', repo: 'repo', ref: 'v1' })).toThrow(
      'Unsupported git host',
    );
  });
});

describe('resolveGitAdapter()', () => {
  it('resolves valid adapter metadata', async () => {
    const url = 'https://raw.githubusercontent.com/acme/my-adapter/v1.0.0/metadata.yaml';
    const fetcher = createStubGitAdapterFetcher(new Map([[url, VALID_METADATA_YAML]]));

    const result = await resolveGitAdapter('github.com/acme/my-adapter@v1.0.0', fetcher);
    expect(result.error).toBeUndefined();
    expect(result.metadata).not.toBeNull();
    expect(result.metadata!.name).toBe('my-adapter');
    expect(result.metadata!.version).toBe('1.0.0');
  });

  it('returns error for invalid reference', async () => {
    const fetcher = createStubGitAdapterFetcher(new Map());
    const result = await resolveGitAdapter('bad-ref', fetcher);
    expect(result.metadata).toBeNull();
    expect(result.error).toContain('Invalid git adapter reference');
  });

  it('returns error when fetch fails (404)', async () => {
    const fetcher = createStubGitAdapterFetcher(new Map());
    const result = await resolveGitAdapter('github.com/acme/missing@v1.0.0', fetcher);
    expect(result.metadata).toBeNull();
    expect(result.error).toContain('Failed to fetch');
  });

  it('returns error for invalid YAML', async () => {
    const url = 'https://raw.githubusercontent.com/acme/bad/v1.0.0/metadata.yaml';
    const fetcher = createStubGitAdapterFetcher(new Map([[url, ':::not yaml']]));
    const result = await resolveGitAdapter('github.com/acme/bad@v1.0.0', fetcher);
    expect(result.metadata).toBeNull();
    expect(result.error).toContain('Invalid YAML');
  });

  it('returns error for metadata that fails validation', async () => {
    const url = 'https://raw.githubusercontent.com/acme/invalid/v1.0.0/metadata.yaml';
    const invalidYaml = `
name: INVALID_NAME
displayName: Test
version: "1.0.0"
stability: stable
interfaces: []
owner: test
specVersions: []
`;
    const fetcher = createStubGitAdapterFetcher(new Map([[url, invalidYaml]]));
    const result = await resolveGitAdapter('github.com/acme/invalid@v1.0.0', fetcher);
    expect(result.metadata).toBeNull();
    expect(result.error).toContain('Validation failed');
  });

  it('returns error for unsupported host', async () => {
    const fetcher = createStubGitAdapterFetcher(new Map());
    const result = await resolveGitAdapter('gitlab.com/org/repo@v1', fetcher);
    expect(result.metadata).toBeNull();
    expect(result.error).toContain('Unsupported git host');
  });
});
