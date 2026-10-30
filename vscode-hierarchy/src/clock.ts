/** Clock seam (AISDLC-769): production code reads the time through `now()`. */
export function now(): Date {
  return new Date();
}
