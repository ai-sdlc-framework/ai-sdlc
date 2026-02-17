/**
 * Shared dependency injection types for tools and resources.
 */

import type { StateStore } from '@ai-sdlc/orchestrator/state';
import type { CostTracker } from '@ai-sdlc/orchestrator';
import type { SessionManager } from './session.js';

export interface ServerDeps {
  store: StateStore;
  costTracker: CostTracker;
  sessions: SessionManager;
  repoPath: string;
}
