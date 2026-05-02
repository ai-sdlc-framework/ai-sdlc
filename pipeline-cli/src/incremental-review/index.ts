/**
 * Barrel re-export for the incremental-review module (AISDLC-142). The
 * implementation lives in `./incremental.ts` so the coverage tracker
 * (which excludes `src/star-star/index.ts` per `vitest.config.ts`) still
 * reports on the actual logic.
 */
export * from './incremental.js';
