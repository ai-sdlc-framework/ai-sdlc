/**
 * Linear adapter stub.
 *
 * Implements the IssueTracker interface.
 * This is a placeholder — production implementations should use the
 * Linear SDK (@linear/sdk).
 */

import type { IssueTracker } from '../interfaces.js';

export type LinearConfig = {
  teamId: string;
  apiKey?: { secretRef: string };
  defaultLabels?: string[];
};

export function createLinearIssueTracker(_config: LinearConfig): IssueTracker {
  throw new Error('Linear IssueTracker adapter not yet implemented');
}
