import { describe, it, expect } from 'vitest';
import { readParallelismMode, isParallelismEnabled, FLAG_NAME } from './parallelism-flag.js';

describe('readParallelismMode', () => {
  it('returns on when the env var is unset (default-on, AISDLC-116)', () => {
    expect(readParallelismMode({})).toBe('on');
  });

  it('returns on when the env var is empty string', () => {
    expect(readParallelismMode({ [FLAG_NAME]: '' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: '   ' })).toBe('on');
  });

  it('preserves explicit "experimental" opt-in (backwards compat)', () => {
    expect(readParallelismMode({ [FLAG_NAME]: 'experimental' })).toBe('experimental');
  });

  it('case-insensitive and trims whitespace', () => {
    expect(readParallelismMode({ [FLAG_NAME]: '  EXPERIMENTAL ' })).toBe('experimental');
    expect(readParallelismMode({ [FLAG_NAME]: 'On' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: '  OFF ' })).toBe('off');
  });

  it('treats "on", "true", "1" as on', () => {
    expect(readParallelismMode({ [FLAG_NAME]: 'on' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: 'true' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: '1' })).toBe('on');
  });

  it('treats "off", "disabled", "false", "0" as off (explicit opt-out)', () => {
    expect(readParallelismMode({ [FLAG_NAME]: 'off' })).toBe('off');
    expect(readParallelismMode({ [FLAG_NAME]: 'disabled' })).toBe('off');
    expect(readParallelismMode({ [FLAG_NAME]: 'false' })).toBe('off');
    expect(readParallelismMode({ [FLAG_NAME]: '0' })).toBe('off');
  });

  it('treats unknown values as on (fail-on; default-on era)', () => {
    // Pre-AISDLC-116 these were treated as 'off' (fail-safe). Post-promotion,
    // the default is 'on' so unknown values fail-on rather than silently
    // disabling parallelism — protects against typos like 'enable' or 'yes'.
    expect(readParallelismMode({ [FLAG_NAME]: 'maybe' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: 'enable' })).toBe('on');
    expect(readParallelismMode({ [FLAG_NAME]: 'yes' })).toBe('on');
  });
});

describe('isParallelismEnabled', () => {
  it('true by default (AISDLC-116 default-on promotion)', () => {
    expect(isParallelismEnabled({})).toBe(true);
  });

  it('true when experimental or on', () => {
    expect(isParallelismEnabled({ [FLAG_NAME]: 'experimental' })).toBe(true);
    expect(isParallelismEnabled({ [FLAG_NAME]: 'on' })).toBe(true);
  });

  it('false when explicitly opted out', () => {
    expect(isParallelismEnabled({ [FLAG_NAME]: 'off' })).toBe(false);
    expect(isParallelismEnabled({ [FLAG_NAME]: 'disabled' })).toBe(false);
    expect(isParallelismEnabled({ [FLAG_NAME]: 'false' })).toBe(false);
    expect(isParallelismEnabled({ [FLAG_NAME]: '0' })).toBe(false);
  });
});
