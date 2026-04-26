import { describe, it, expect } from 'vitest';
import { readParallelismMode, isParallelismEnabled, FLAG_NAME } from './parallelism-flag.js';

describe('readParallelismMode', () => {
  it('returns off when the env var is unset', () => {
    expect(readParallelismMode({})).toBe('off');
  });

  it('returns experimental for "experimental"', () => {
    expect(readParallelismMode({ [FLAG_NAME]: 'experimental' })).toBe('experimental');
  });

  it('case-insensitive and trims whitespace', () => {
    expect(readParallelismMode({ [FLAG_NAME]: '  EXPERIMENTAL ' })).toBe('experimental');
    expect(readParallelismMode({ [FLAG_NAME]: 'On' })).toBe('on');
  });

  it('treats "on", "true", "1" as on', () => {
    expect(readParallelismMode({ [FLAG_NAME]: 'on' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: 'true' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: '1' })).toBe('on');
  });

  it('treats unknown values as off (fail-safe)', () => {
    expect(readParallelismMode({ [FLAG_NAME]: 'maybe' })).toBe('off');
    expect(readParallelismMode({ [FLAG_NAME]: '0' })).toBe('off');
  });
});

describe('isParallelismEnabled', () => {
  it('false when off', () => {
    expect(isParallelismEnabled({})).toBe(false);
  });

  it('true when experimental or on', () => {
    expect(isParallelismEnabled({ [FLAG_NAME]: 'experimental' })).toBe(true);
    expect(isParallelismEnabled({ [FLAG_NAME]: 'on' })).toBe(true);
  });
});
