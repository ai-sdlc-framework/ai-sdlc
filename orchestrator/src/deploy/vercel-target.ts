/**
 * Vercel deployment target — deploys via Vercel REST API v13.
 */

import type { DeploymentTarget, DeploymentResult, FetchFn } from './types.js';

export interface VercelConfig {
  /** Vercel API token. */
  token: string;
  /** Vercel project ID. */
  projectId: string;
  /** Vercel team ID (optional). */
  teamId?: string;
}

const VERCEL_API = 'https://api.vercel.com';

export function createVercelTarget(
  config: VercelConfig,
  opts?: { fetch?: FetchFn },
): DeploymentTarget {
  const httpFetch = opts?.fetch ?? globalThis.fetch;
  const deployments = new Map<string, DeploymentResult>();

  function headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    };
  }

  function teamParam(): string {
    return config.teamId ? `?teamId=${config.teamId}` : '';
  }

  return {
    async deploy(version: string, environment: string): Promise<DeploymentResult> {
      const id = `vercel-${Date.now()}-${environment}`;
      const result: DeploymentResult = {
        id,
        state: 'deploying',
        version,
        startedAt: new Date().toISOString(),
      };

      try {
        const res = await httpFetch(`${VERCEL_API}/v13/deployments${teamParam()}`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            name: config.projectId,
            target: environment === 'production' ? 'production' : 'preview',
            gitSource: { ref: version, type: 'branch' },
          }),
        });
        if (!res.ok) throw new Error(`Vercel deploy failed: ${res.status}`);
        const data = (await res.json()) as { id: string; url?: string; readyState: string };
        result.id = data.id ?? id;
        result.url = data.url ? `https://${data.url}` : undefined;
        result.state = mapVercelState(data.readyState);
        result.completedAt = new Date().toISOString();
      } catch (err) {
        result.state = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
        result.completedAt = new Date().toISOString();
      }

      deployments.set(result.id, result);
      return result;
    },

    async getStatus(id: string): Promise<DeploymentResult> {
      try {
        const res = await httpFetch(`${VERCEL_API}/v13/deployments/${id}${teamParam()}`, {
          headers: headers(),
        });
        if (!res.ok) {
          const cached = deployments.get(id);
          return cached ?? { id, state: 'pending', version: 'unknown', startedAt: '' };
        }
        const data = (await res.json()) as {
          readyState: string;
          url?: string;
          meta?: { version?: string };
        };
        return {
          id,
          state: mapVercelState(data.readyState),
          url: data.url ? `https://${data.url}` : undefined,
          version: data.meta?.version ?? 'unknown',
          startedAt: deployments.get(id)?.startedAt ?? '',
        };
      } catch {
        const cached = deployments.get(id);
        return cached ?? { id, state: 'pending', version: 'unknown', startedAt: '' };
      }
    },

    async rollback(id: string): Promise<DeploymentResult> {
      // Vercel rollback is done by promoting a previous deployment to production
      const rollbackId = `${id}-rollback`;
      const result: DeploymentResult = {
        id: rollbackId,
        state: 'deploying',
        version: deployments.get(id)?.version ?? 'unknown',
        startedAt: new Date().toISOString(),
      };

      try {
        // Promote-as-rollback: re-create the deployment
        const res = await httpFetch(`${VERCEL_API}/v13/deployments/${id}/promote${teamParam()}`, {
          method: 'POST',
          headers: headers(),
        });
        if (!res.ok) throw new Error(`Vercel rollback failed: ${res.status}`);
        result.state = 'rolled-back';
        result.completedAt = new Date().toISOString();
      } catch (err) {
        result.state = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
        result.completedAt = new Date().toISOString();
      }

      deployments.set(rollbackId, result);
      return result;
    },
  };
}

function mapVercelState(state: string): DeploymentResult['state'] {
  const map: Record<string, DeploymentResult['state']> = {
    QUEUED: 'pending',
    BUILDING: 'deploying',
    READY: 'healthy',
    ERROR: 'failed',
    CANCELED: 'failed',
  };
  return map[state] ?? 'pending';
}
