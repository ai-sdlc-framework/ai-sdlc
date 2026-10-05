import { describe, it, expect } from 'vitest';

describe('state/types', () => {
  it('is a type-only module that loads without runtime exports', async () => {
    const mod = await import('./types.js');
    expect(Object.keys(mod)).toEqual([]);
  });
});
