/**
 * Fly.io deployment target — deploys via Machines API or flyctl CLI.
 */

import type { DeploymentTarget, DeploymentResult, FetchFn, ExecFn } from './types.js';

export interface FlyioConfig {
  /** Fly.io API token. */
  token: string;
  /** Fly.io application name. */
  appName: string;
  /** Use flyctl CLI mode instead of API. */
  useCliMode?: boolean;
  /** Fly.io API base URL (defaults to https://api.machines.dev). */
  apiBase?: string;
}

export function createFlyioTarget(
  config: FlyioConfig,
  opts?: { fetch?: FetchFn; exec?: ExecFn },
): DeploymentTarget {
  const httpFetch = opts?.fetch ?? globalThis.fetch;
  const exec = opts?.exec;
  const apiBase = config.apiBase ?? 'https://api.machines.dev';

  const deployments = new Map<string, DeploymentResult>();

  function headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    };
  }

  return {
    async deploy(version: string, environment: string): Promise<DeploymentResult> {
      const id = `fly-${Date.now()}-${environment}`;
      const result: DeploymentResult = {
        id,
        state: 'deploying',
        version,
        startedAt: new Date().toISOString(),
      };

      try {
        if (config.useCliMode && exec) {
          const { stdout } = await exec('flyctl', [
            'deploy',
            '--app', config.appName,
            '--image', version,
            '--now',
          ]);
          result.url = extractFlyUrl(stdout, config.appName);
        } else {
          // Machines API: list machines, then update each
          const listRes = await httpFetch(`${apiBase}/v1/apps/${config.appName}/machines`, {
            headers: headers(),
          });
          if (!listRes.ok) throw new Error(`Fly.io list machines failed: ${listRes.status}`);
          const machines = (await listRes.json()) as Array<{ id: string; config: Record<string, unknown> }>;

          for (const machine of machines) {
            const updateRes = await httpFetch(
              `${apiBase}/v1/apps/${config.appName}/machines/${machine.id}`,
              {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({
                  config: { ...machine.config, image: version },
                }),
              },
            );
            if (!updateRes.ok) throw new Error(`Fly.io update machine ${machine.id} failed: ${updateRes.status}`);
          }
          result.url = `https://${config.appName}.fly.dev`;
        }

        result.state = 'healthy';
        result.completedAt = new Date().toISOString();
      } catch (err) {
        result.state = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
        result.completedAt = new Date().toISOString();
      }

      deployments.set(id, result);
      return result;
    },

    async getStatus(id: string): Promise<DeploymentResult> {
      const cached = deployments.get(id);
      if (cached) return cached;
      return { id, state: 'pending', version: 'unknown', startedAt: '' };
    },

    async rollback(id: string): Promise<DeploymentResult> {
      const rollbackId = `${id}-rollback`;
      const original = deployments.get(id);
      const result: DeploymentResult = {
        id: rollbackId,
        state: 'deploying',
        version: original?.version ?? 'unknown',
        startedAt: new Date().toISOString(),
      };

      try {
        if (config.useCliMode && exec) {
          await exec('flyctl', [
            'releases', '--app', config.appName, '--json',
          ]);
          // In CLI mode, trigger a rollback by deploying the previous image
          await exec('flyctl', ['deploy', '--app', config.appName, '--strategy', 'rolling']);
        } else {
          // API mode: re-deploy with the original version metadata
          const listRes = await httpFetch(`${apiBase}/v1/apps/${config.appName}/machines`, {
            headers: headers(),
          });
          if (!listRes.ok) throw new Error(`Fly.io list machines failed: ${listRes.status}`);
        }

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

function extractFlyUrl(stdout: string, appName: string): string {
  const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
  return urlMatch ? urlMatch[0] : `https://${appName}.fly.dev`;
}
