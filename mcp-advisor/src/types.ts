/**
 * Shared dependency injection types for tools and resources.
 */

import type { StateStore } from '@ai-sdlc/orchestrator/state';
import type { CostTracker, AiSdlcConfig } from '@ai-sdlc/orchestrator';
import type { SessionManager } from './session.js';

export interface ServerDeps {
  store: StateStore;
  costTracker: CostTracker;
  sessions: SessionManager;
  repoPath: string;
  /** Loaded AI-SDLC config (if available). */
  config?: AiSdlcConfig;
}
