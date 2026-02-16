/**
 * State store singleton for API routes.
 * Reads the DB path from AI_SDLC_DB_PATH env var.
 * Falls back to in-memory database when the DB file path doesn't exist.
 */

import { StateStore } from '@ai-sdlc/orchestrator';

let _store: StateStore | null = null;

export function getStateStore(): StateStore {
  if (!_store) {
    const dbPath = process.env.AI_SDLC_DB_PATH ?? ':memory:';
    _store = StateStore.open(dbPath);
  }
  return _store;
}
