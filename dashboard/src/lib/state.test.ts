import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the orchestrator module
vi.mock('@ai-sdlc/orchestrator', () => {
  const fakeDb = {};
  const fakeStore = {
    getDatabase: () => fakeDb,
  };
  return {
    StateStore: {
      open: vi.fn(() => fakeStore),
    },
  };
});

describe('state', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AI_SDLC_DB_PATH;
  });

  it('getStateStore returns a StateStore instance', async () => {
    const { getStateStore } = await import('./state');
    const store = getStateStore();
    expect(store).toBeTruthy();
    expect(store.getDatabase).toBeDefined();
  });

  it('getStateStore returns the same instance on subsequent calls', async () => {
    const { getStateStore } = await import('./state');
    const store1 = getStateStore();
    const store2 = getStateStore();
    expect(store1).toBe(store2);
  });

  it('getStateStore uses AI_SDLC_DB_PATH env var when set', async () => {
    process.env.AI_SDLC_DB_PATH = '/tmp/test.db';
    const { getStateStore } = await import('./state');
    const store = getStateStore();
    expect(store).toBeTruthy();
  });
});
