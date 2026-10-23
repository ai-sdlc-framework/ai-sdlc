/**
 * Workflow document digest (RFC-0056 phase 3, OQ-4). The engine records which
 * document drove a run; `sign-v6` copies it into the envelope as `workflowDigest`
 * and the verifier recomputes it from `baseSha`.
 *
 * @module workflow/digest
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** Where an adopter's Workflow document lives, read from the base branch only. */
export const WORKFLOW_PATH = '.ai-sdlc/workflow.yaml';

/** `path` of a run that used the plugin default because the base branch has no document. */
export const BUILTIN_WORKFLOW_PATH = 'builtin:execute-task';

export interface WorkflowDigest {
  path: string;
  sha256: string;
  baseSha: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The digest of the run recorded in a `next-step` state file, or `undefined` when
 * the file is missing, unreadable, or holds no engine records (the Machine ran).
 */
export function workflowDigestFromStateFile(statePath: string): WorkflowDigest | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      workflow?: { path?: string; sha256?: string; baseSha?: string; records?: unknown[] };
    };
    const wf = state.workflow;
    if (!wf || !Array.isArray(wf.records) || wf.records.length === 0) return undefined;
    if (!wf.path || !wf.sha256 || !wf.baseSha) return undefined;
    return { path: wf.path, sha256: wf.sha256, baseSha: wf.baseSha };
  } catch {
    return undefined;
  }
}
