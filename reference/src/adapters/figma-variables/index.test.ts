import { describe, it, expect } from 'vitest';
import { figmaVariablesToDtcg, type FigmaVariablesResponse } from './figma-to-dtcg.js';
import { createFigmaVariablesProvider, type FigmaHttpClient } from './index.js';
import type { DesignTokenSet } from '../interfaces.js';

const mockFigmaResponse: FigmaVariablesResponse = {
  status: 200,
  error: false,
  meta: {
    variables: {
      'var-1': {
        id: 'var-1',
        name: 'color/primary',
        key: 'key-1',
        resolvedType: 'COLOR',
        valuesByMode: {
          'mode-1': { r: 0.231, g: 0.51, b: 0.965, a: 1 },
        },
        description: 'Primary brand color',
      },
      'var-2': {
        id: 'var-2',
        name: 'spacing/md',
        key: 'key-2',
        resolvedType: 'FLOAT',
        valuesByMode: {
          'mode-1': 16,
        },
      },
      'var-3': {
        id: 'var-3',
        name: 'color/text/primary',
        key: 'key-3',
        resolvedType: 'COLOR',
        valuesByMode: {
          'mode-1': { type: 'VARIABLE_ALIAS', id: 'var-1' },
        },
      },
      'var-4': {
        id: 'var-4',
        name: 'enabled',
        key: 'key-4',
        resolvedType: 'BOOLEAN',
        valuesByMode: {
          'mode-1': true,
        },
      },
    },
    variableCollections: {
      'col-1': {
        id: 'col-1',
        name: 'Tokens',
        modes: [{ modeId: 'mode-1', name: 'Default' }],
        variableIds: ['var-1', 'var-2', 'var-3', 'var-4'],
      },
    },
  },
};

describe('figmaVariablesToDtcg', () => {
  it('converts Figma colors to hex', () => {
    const tokens = figmaVariablesToDtcg(mockFigmaResponse);
    const colorPrimary = tokens.color as Record<string, unknown>;
    const primary = colorPrimary?.primary as { $type: string; $value: string };
    expect(primary.$type).toBe('color');
    expect(primary.$value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('converts FLOAT variables to numbers', () => {
    const tokens = figmaVariablesToDtcg(mockFigmaResponse);
    const spacing = tokens.spacing as Record<string, unknown>;
    const md = spacing?.md as { $type: string; $value: number };
    expect(md.$type).toBe('number');
    expect(md.$value).toBe(16);
  });

  it('converts VARIABLE_ALIAS to DTCG reference format', () => {
    const tokens = figmaVariablesToDtcg(mockFigmaResponse);
    const color = tokens.color as Record<string, unknown>;
    const text = color?.text as Record<string, unknown>;
    const primary = text?.primary as { $type: string; $value: string };
    expect(primary.$value).toBe('{color.primary}');
  });

  it('converts BOOLEAN variables', () => {
    const tokens = figmaVariablesToDtcg(mockFigmaResponse);
    const enabled = tokens.enabled as unknown as { $type: string; $value: boolean };
    expect(enabled.$type).toBe('boolean');
    expect(enabled.$value).toBe(true);
  });

  it('preserves descriptions', () => {
    const tokens = figmaVariablesToDtcg(mockFigmaResponse);
    const color = tokens.color as Record<string, unknown>;
    const primary = color?.primary as { $description?: string };
    expect(primary.$description).toBe('Primary brand color');
  });

  it('handles specific mode selection', () => {
    const multiModeResponse: FigmaVariablesResponse = {
      ...mockFigmaResponse,
      meta: {
        ...mockFigmaResponse.meta,
        variableCollections: {
          'col-1': {
            id: 'col-1',
            name: 'Tokens',
            modes: [
              { modeId: 'mode-1', name: 'Light' },
              { modeId: 'mode-2', name: 'Dark' },
            ],
            variableIds: ['var-1'],
          },
        },
        variables: {
          'var-1': {
            ...mockFigmaResponse.meta.variables['var-1'],
            valuesByMode: {
              'mode-1': { r: 1, g: 1, b: 1, a: 1 },
              'mode-2': { r: 0, g: 0, b: 0, a: 1 },
            },
          },
        },
      },
    };

    const lightTokens = figmaVariablesToDtcg(multiModeResponse, { mode: 'Light' });
    const darkTokens = figmaVariablesToDtcg(multiModeResponse, { mode: 'Dark' });

    const lightColor = (lightTokens.color as Record<string, unknown>)?.primary as {
      $value: string;
    };
    const darkColor = (darkTokens.color as Record<string, unknown>)?.primary as {
      $value: string;
    };

    expect(lightColor.$value).toBe('#ffffff');
    expect(darkColor.$value).toBe('#000000');
  });
});

describe('createFigmaVariablesProvider', () => {
  function createMockClient(response: FigmaVariablesResponse): FigmaHttpClient {
    return {
      async get(_url, _headers) {
        return { status: 200, data: response };
      },
      async post(_url, _body, _headers) {
        return { status: 200, data: {} };
      },
    };
  }

  it('fetches tokens via HTTP client', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    const tokens = await provider.getTokens();
    expect(tokens).toHaveProperty('color');
    expect(tokens).toHaveProperty('spacing');
  });

  it('filters tokens by category', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    const tokens = await provider.getTokens({ categories: ['color'] });
    expect(tokens).toHaveProperty('color');
    expect(tokens).not.toHaveProperty('spacing');
  });

  it('diffs token snapshots', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    const baseline = await provider.getTokens();
    const current = { ...baseline };
    const diff = await provider.diffTokens(baseline, current);
    expect(diff.changes).toHaveLength(0);
  });

  it('pushTokens returns not-supported message', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    const result = await provider.pushTokens({});
    expect(result.success).toBe(false);
    expect(result.message).toContain('Figma Plugin API');
  });

  it('detects breaking changes by major version', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    const breaking = await provider.detectBreakingChange('1.0.0', '2.0.0');
    expect(breaking.isBreaking).toBe(true);

    const nonBreaking = await provider.detectBreakingChange('1.0.0', '1.1.0');
    expect(nonBreaking.isBreaking).toBe(false);
  });

  it('returns a schema version', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    await provider.getTokens(); // populate snapshot
    const version = await provider.getSchemaVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('subscribes and unsubscribes to change events', () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    let called = false;
    const unsub = provider.onTokensChanged(() => {
      called = true;
    });
    expect(typeof unsub).toBe('function');
    unsub();
    expect(called).toBe(false);
  });

  it('subscribes and unsubscribes to deletion events', () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    let called = false;
    const unsub = provider.onTokensDeleted(() => {
      called = true;
    });
    expect(typeof unsub).toBe('function');
    unsub();
    expect(called).toBe(false);
  });

  it('detects deletions between baseline and current', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    const baseline = await provider.getTokens();
    // Remove the spacing group entirely
    const current = { color: baseline.color } as DesignTokenSet;
    const deletions = await provider.detectDeletions(baseline, current);
    expect(deletions.length).toBeGreaterThan(0);
  });

  it('getSchemaVersion returns 0.0.0 when no snapshot exists', async () => {
    const provider = createFigmaVariablesProvider({
      fileKey: 'test-file',
      apiToken: 'test-token',
      httpClient: createMockClient(mockFigmaResponse),
    });

    // Without calling getTokens first, lastSnapshot is null
    const version = await provider.getSchemaVersion();
    expect(version).toBe('0.0.0');
  });
});
