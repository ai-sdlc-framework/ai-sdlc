/**
 * GitHub adapter stub.
 *
 * Implements SourceControl and CIPipeline interfaces.
 * This is a placeholder — production implementations should use the
 * GitHub REST/GraphQL API via @octokit.
 */

import type { SourceControl, CIPipeline } from '../interfaces.js';

export type GitHubConfig = {
  org: string;
  repo?: string;
  token?: { secretRef: string };
};

export function createGitHubSourceControl(_config: GitHubConfig): SourceControl {
  throw new Error('GitHub SourceControl adapter not yet implemented');
}

export function createGitHubCIPipeline(_config: GitHubConfig): CIPipeline {
  throw new Error('GitHub CIPipeline adapter not yet implemented');
}
