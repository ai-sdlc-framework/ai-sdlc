/**
 * Shared dependency injection types for tools and resources.
 */

import type { StateStore } from '@ai-sdlc/orchestrator/state';
import type { CostTracker, AiSdlcConfig } from '@ai-sdlc/orchestrator';
import type { SessionManager } from './session.js';

export interface RepoContext {
  name: string;
  path: string; // absolute path
  store: StateStore;
  costTracker: CostTracker;
  config?: AiSdlcConfig;
}

export interface WorkspaceContext {
  workspacePath: string;
  repos: RepoContext[];
  /** Shared workspace-level store for cross-repo knowledge. */
  sharedStore: StateStore;
}

export interface ServerDeps {
  store: StateStore;
  costTracker: CostTracker;
  sessions: SessionManager;
  repoPath: string;
  /** Loaded AI-SDLC config (if available). */
  config?: AiSdlcConfig;
  /** Workspace context when running in multi-repo mode. */
  workspace?: WorkspaceContext;
}
