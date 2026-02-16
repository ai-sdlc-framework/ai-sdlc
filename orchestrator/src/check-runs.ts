/**
 * GitHub Check Run integration via `gh` CLI.
 * Creates one check run per gate result. Falls back gracefully when `gh` is unavailable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_GH_CLI_TIMEOUT_MS } from './defaults.js';

const execFileAsync = promisify(execFile);

export interface CheckRunInput {
  name: string;
  headSha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
  title?: string;
  summary?: string;
}

async function ghApiCall(
  method: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const args = ['api', endpoint, '--method', method];
    for (const [key, value] of Object.entries(body)) {
      args.push('-f', `${key}=${String(value)}`);
    }
    await execFileAsync('gh', args, { timeout: DEFAULT_GH_CLI_TIMEOUT_MS });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Create a GitHub Check Run for a gate result.
 */
export async function createCheckRun(input: CheckRunInput): Promise<{ success: boolean; error?: string }> {
  const body: Record<string, unknown> = {
    name: input.name,
    head_sha: input.headSha,
    status: input.status,
  };
  if (input.conclusion) body.conclusion = input.conclusion;
  if (input.title || input.summary) {
    body['output[title]'] = input.title ?? input.name;
    body['output[summary]'] = input.summary ?? '';
  }

  return ghApiCall('POST', 'repos/{owner}/{repo}/check-runs', body);
}

/**
 * Update an existing GitHub Check Run.
 */
export async function updateCheckRun(
  checkRunId: number,
  input: Partial<CheckRunInput>,
): Promise<{ success: boolean; error?: string }> {
  const body: Record<string, unknown> = {};
  if (input.status) body.status = input.status;
  if (input.conclusion) body.conclusion = input.conclusion;
  if (input.title || input.summary) {
    body['output[title]'] = input.title ?? '';
    body['output[summary]'] = input.summary ?? '';
  }

  return ghApiCall('PATCH', `repos/{owner}/{repo}/check-runs/${checkRunId}`, body);
}

export interface GateResult {
  gate: string;
  verdict: 'pass' | 'fail' | 'skip';
  message?: string;
}

/**
 * Report gate results as GitHub Check Runs.
 * Creates one check run per gate result. Falls back silently on failure.
 */
export async function reportGateCheckRuns(
  headSha: string,
  gateResults: GateResult[],
): Promise<void> {
  for (const result of gateResults) {
    const conclusion = result.verdict === 'pass' ? 'success'
      : result.verdict === 'fail' ? 'failure'
        : 'neutral';

    await createCheckRun({
      name: `AI-SDLC: ${result.gate}`,
      headSha,
      status: 'completed',
      conclusion,
      title: `Gate: ${result.gate}`,
      summary: result.message ?? `Gate ${result.gate}: ${result.verdict}`,
    });
  }
}
