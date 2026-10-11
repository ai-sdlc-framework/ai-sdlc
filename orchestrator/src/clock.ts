/**
 * Clock seam (AISDLC-769). Production code reads the time through `now()`
 * instead of calling `new Date()` / `Date.now()` directly, so a test can pin it
 * with `setClock()` (or `vi.useFakeTimers({ now })`). The clock-discipline gate
 * (`scripts/check-clock-discipline.mjs`) fails on new direct reads elsewhere.
 *
 * @module clock
 */

export type Clock = () => Date;

const systemClock: Clock = () => new Date();

let current: Clock = systemClock;

/** The current time. */
export function now(): Date {
  return current();
}

/** Replace the clock (tests). Returns a function that restores the previous one. */
export function setClock(clock: Clock): () => void {
  const previous = current;
  current = clock;
  return () => {
    current = previous;
  };
}
