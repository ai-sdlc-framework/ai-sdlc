import { describe, it, expect } from 'vitest';
import { createStubComponentCatalog } from './component-catalog.js';
import type { ComponentEntry, StoryEntry } from '../interfaces.js';

const sampleComponents: ComponentEntry[] = [
  {
    name: 'Button',
    category: 'inputs',
    capabilities: ['click', 'submit'],
    tokenBindings: ['color.primary'],
  },
  {
    name: 'Card',
    category: 'containers',
    capabilities: ['layout', 'display'],
  },
  {
    name: 'Modal',
    category: 'overlays',
    capabilities: ['dialog', 'focus-trap'],
  },
];

const sampleStories: StoryEntry[] = [
  { id: 'button--default', name: 'Default', componentName: 'Button', kind: 'inputs/Button' },
  { id: 'button--primary', name: 'Primary', componentName: 'Button', kind: 'inputs/Button' },
  { id: 'card--default', name: 'Default', componentName: 'Card', kind: 'containers/Card' },
];

describe('createStubComponentCatalog', () => {
  it('returns manifest with preloaded components', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const manifest = await catalog.getManifest();
    expect(manifest.components).toHaveLength(3);
    expect(manifest.version).toBe('1.0.0');
    expect(catalog.getManifestFetchCount()).toBe(1);
  });

  it('resolves components by name', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const matches = await catalog.resolveComponent({ name: 'Button' });
    expect(matches).toHaveLength(1);
    expect(matches[0].component.name).toBe('Button');
  });

  it('resolves components by category', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const matches = await catalog.resolveComponent({ category: 'containers' });
    expect(matches).toHaveLength(1);
    expect(matches[0].component.name).toBe('Card');
  });

  it('resolves components by capabilities', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const matches = await catalog.resolveComponent({ capabilities: ['focus-trap'] });
    expect(matches).toHaveLength(1);
    expect(matches[0].component.name).toBe('Modal');
  });

  it('returns empty when no match', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const matches = await catalog.resolveComponent({ name: 'Nonexistent' });
    expect(matches).toHaveLength(0);
  });

  it('evaluates composition feasibility', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const plan = await catalog.canCompose({
      description: 'Need a clickable card',
      capabilities: ['click', 'layout'],
    });
    expect(plan.feasible).toBe(true);
    expect(plan.components.length).toBeGreaterThan(0);
    expect(plan.gaps).toHaveLength(0);
  });

  it('reports gaps when composition is not feasible', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const plan = await catalog.canCompose({
      description: 'Need a video player',
      capabilities: ['video-playback'],
    });
    expect(plan.feasible).toBe(false);
    expect(plan.gaps).toContain('video-playback');
  });

  it('returns stories for a component', async () => {
    const catalog = createStubComponentCatalog({
      components: sampleComponents,
      stories: sampleStories,
    });
    const stories = await catalog.getStories('Button');
    expect(stories).toHaveLength(2);
  });

  it('validates code against catalog', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const result = await catalog.validateAgainstCatalog('const x = Button; const y = Card;');
    expect(result.reusedComponents).toContain('Button');
    expect(result.reusedComponents).toContain('Card');
    expect(result.valid).toBe(true);
  });

  it('detects new components not in catalog', async () => {
    const catalog = createStubComponentCatalog({ components: sampleComponents });
    const result = await catalog.validateAgainstCatalog(
      'const x = Button; const y = CustomWidget;',
    );
    expect(result.newComponents).toContain('CustomWidget');
    expect(result.valid).toBe(false);
  });

  it('adds components at runtime', async () => {
    const catalog = createStubComponentCatalog({ components: [] });
    catalog.addComponent({ name: 'NewComp', capabilities: ['test'] });
    const manifest = await catalog.getManifest();
    expect(manifest.components).toHaveLength(1);
  });
});
