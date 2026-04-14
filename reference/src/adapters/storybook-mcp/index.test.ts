import { describe, it, expect } from 'vitest';
import { createStorybookMcpCatalog, type StorybookHttpClient } from './index.js';
import type { ComponentManifest, StoryEntry } from '../interfaces.js';

const sampleManifest: ComponentManifest = {
  version: '1.0.0',
  components: [
    {
      name: 'Button',
      category: 'inputs',
      capabilities: ['click', 'submit'],
      tokenBindings: ['color.primary'],
    },
    { name: 'Card', category: 'containers', capabilities: ['layout', 'display'] },
    { name: 'Modal', category: 'overlays', capabilities: ['dialog', 'focus-trap'] },
    { name: 'TextInput', category: 'inputs', capabilities: ['text-input', 'validation'] },
  ],
};

const sampleStories: StoryEntry[] = [
  { id: 'button--default', name: 'Default', componentName: 'Button', kind: 'inputs' },
  { id: 'button--primary', name: 'Primary', componentName: 'Button', kind: 'inputs' },
];

function createMockClient(): StorybookHttpClient {
  return {
    async get(url, _headers) {
      if (url.includes('/manifest')) {
        return { status: 200, data: sampleManifest };
      }
      if (url.includes('/stories')) {
        const component = new URL(url).searchParams.get('component');
        const stories = sampleStories.filter((s) => s.componentName === component);
        return { status: 200, data: { stories } };
      }
      return { status: 404, data: {} };
    },
  };
}

describe('createStorybookMcpCatalog', () => {
  it('fetches manifest from MCP endpoint', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const manifest = await catalog.getManifest();
    expect(manifest.components).toHaveLength(4);
    expect(manifest.version).toBe('1.0.0');
  });

  it('caches manifest on subsequent calls', async () => {
    let fetchCount = 0;
    const client: StorybookHttpClient = {
      async get(url, headers) {
        fetchCount++;
        return createMockClient().get(url, headers);
      },
    };
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: client,
      refreshIntervalMs: 60000,
    });
    await catalog.getManifest();
    await catalog.getManifest();
    expect(fetchCount).toBe(1); // second call uses cache
  });

  it('resolves components by name', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const matches = await catalog.resolveComponent({ name: 'Button' });
    expect(matches).toHaveLength(1);
    expect(matches[0].component.name).toBe('Button');
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it('resolves components by category', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const matches = await catalog.resolveComponent({ category: 'inputs' });
    expect(matches).toHaveLength(2); // Button and TextInput
  });

  it('resolves by capabilities', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const matches = await catalog.resolveComponent({ capabilities: ['focus-trap'] });
    expect(matches).toHaveLength(1);
    expect(matches[0].component.name).toBe('Modal');
  });

  it('returns empty for no match', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const matches = await catalog.resolveComponent({ name: 'Nonexistent' });
    expect(matches).toHaveLength(0);
  });

  it('evaluates composition feasibility', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const plan = await catalog.canCompose({
      description: 'Need click and layout',
      capabilities: ['click', 'layout'],
    });
    expect(plan.feasible).toBe(true);
    expect(plan.components.length).toBeGreaterThanOrEqual(2);
    expect(plan.gaps).toHaveLength(0);
  });

  it('reports gaps for unsatisfiable requirements', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const plan = await catalog.canCompose({
      description: 'Need video playback',
      capabilities: ['video-playback'],
    });
    expect(plan.feasible).toBe(false);
    expect(plan.gaps).toContain('video-playback');
  });

  it('fetches stories for a component', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const stories = await catalog.getStories('Button');
    expect(stories).toHaveLength(2);
  });

  it('validates code against catalog (non-strict)', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const result = await catalog.validateAgainstCatalog(
      'const x = Button; const y = CustomWidget;',
    );
    expect(result.reusedComponents).toContain('Button');
    expect(result.newComponents).toContain('CustomWidget');
    expect(result.valid).toBe(true); // non-strict mode
  });

  it('validates code against catalog (strict)', async () => {
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      httpClient: createMockClient(),
    });
    const result = await catalog.validateAgainstCatalog(
      'const x = Button; const y = CustomWidget;',
      { strict: true },
    );
    expect(result.valid).toBe(false); // strict: new components not allowed
  });

  it('adds Bearer token to requests', async () => {
    let capturedHeaders: Record<string, string> = {};
    const client: StorybookHttpClient = {
      async get(_url, headers) {
        capturedHeaders = headers;
        return { status: 200, data: sampleManifest };
      },
    };
    const catalog = createStorybookMcpCatalog({
      endpoint: 'https://storybook.test/mcp',
      token: 'my-secret-token',
      httpClient: client,
    });
    await catalog.getManifest();
    expect(capturedHeaders['Authorization']).toBe('Bearer my-secret-token');
  });
});
