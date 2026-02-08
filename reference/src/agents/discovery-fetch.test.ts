import { describe, it, expect } from 'vitest';
import {
  createAgentDiscovery,
  createStubAgentCardFetcher,
  type A2AAgentCard,
} from './discovery.js';

const testCard: A2AAgentCard = {
  name: 'remote-builder',
  description: 'A remote build agent',
  url: 'https://agents.example.com',
  skills: [{ id: 'build', description: 'Build projects', tags: ['ci'] }],
  tools: ['npm', 'tsc'],
};

describe('A2A agent card discovery', () => {
  it('stub fetcher resolves card', async () => {
    const cards = new Map<string, A2AAgentCard>();
    cards.set('https://agents.example.com', testCard);
    const fetcher = createStubAgentCardFetcher(cards);

    const card = await fetcher.fetch('https://agents.example.com');
    expect(card).toBeDefined();
    expect(card!.name).toBe('remote-builder');
  });

  it('discover registers agent from fetched card', async () => {
    const cards = new Map<string, A2AAgentCard>();
    cards.set('https://agents.example.com', testCard);
    const fetcher = createStubAgentCardFetcher(cards);

    const discovery = createAgentDiscovery({ fetcher });
    const role = await discovery.discover('https://agents.example.com');

    expect(role).toBeDefined();
    expect(role!.metadata.name).toBe('remote-builder');
    expect(role!.metadata.labels?.['ai-sdlc.io/discovered']).toBe('true');

    // Should also be resolvable after discovery
    const resolved = discovery.resolve('remote-builder');
    expect(resolved).toBeDefined();
    expect(resolved!.spec.tools).toEqual(['npm', 'tsc']);
  });

  it('fetch failure returns undefined', async () => {
    const cards = new Map<string, A2AAgentCard>();
    const fetcher = createStubAgentCardFetcher(cards);

    const discovery = createAgentDiscovery({ fetcher });
    const role = await discovery.discover('https://unknown.example.com');
    expect(role).toBeUndefined();
  });

  it('endpoint URL normalization strips trailing slash', async () => {
    const cards = new Map<string, A2AAgentCard>();
    cards.set('https://agents.example.com', testCard);
    const fetcher = createStubAgentCardFetcher(cards);

    const discovery = createAgentDiscovery({ fetcher });
    const role = await discovery.discover('https://agents.example.com/');
    expect(role).toBeDefined();
    expect(role!.metadata.name).toBe('remote-builder');
  });

  it('no fetcher returns undefined', async () => {
    const discovery = createAgentDiscovery();
    const role = await discovery.discover('https://agents.example.com');
    expect(role).toBeUndefined();
  });

  it('discovered agent has correct skills mapping', async () => {
    const cards = new Map<string, A2AAgentCard>();
    cards.set('https://agents.example.com', testCard);
    const fetcher = createStubAgentCardFetcher(cards);

    const discovery = createAgentDiscovery({ fetcher });
    const role = await discovery.discover('https://agents.example.com');

    expect(role!.spec.skills).toHaveLength(1);
    expect(role!.spec.skills![0].id).toBe('build');
    expect(role!.spec.skills![0].tags).toEqual(['ci']);
  });
});
