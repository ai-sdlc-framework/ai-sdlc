/**
 * The default verification command list (AISDLC-1086). One list for the dispatch manifest
 * (`dispatch/enqueue.ts`), `execute-pipeline` and `next-step`. Import-free on purpose: the
 * dispatch board loads it without pulling in the process runner.
 *
 * @module steps/verify-defaults
 */

export const DEFAULT_VERIFY_COMMANDS = [
  'pnpm build',
  'pnpm test',
  'pnpm lint',
  'pnpm format:check',
] as const;
