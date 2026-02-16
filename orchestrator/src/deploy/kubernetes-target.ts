/**
 * Kubernetes deployment target — deploys via K8s API or kubectl CLI.
 */

import type { DeploymentTarget, DeploymentResult, FetchFn, ExecFn } from './types.js';

export interface KubernetesConfig {
  /** K8s API server URL (for API mode). */
  apiServer?: string;
  /** Bearer token for K8s API auth. */
  token?: string;
  /** Namespace to deploy into. */
  namespace: string;
  /** Deployment name. */
  deploymentName: string;
  /** Container name within the deployment. */
  containerName: string;
  /** Image repository (e.g. 'registry.io/app'). */
  imageRepo: string;
  /** Use kubectl CLI mode instead of API. */
  useCliMode?: boolean;
}

export function createKubernetesTarget(
  config: KubernetesConfig,
  opts?: { fetch?: FetchFn; exec?: ExecFn },
): DeploymentTarget {
  const httpFetch = opts?.fetch ?? globalThis.fetch;
  const exec = opts?.exec;

  const deployments = new Map<string, DeploymentResult>();

  function apiUrl(path: string): string {
    return `${config.apiServer}/apis/apps/v1/namespaces/${config.namespace}${path}`;
  }

  function headers(): Record<string, string> {
    return {
      'Content-Type': 'application/strategic-merge-patch+json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    };
  }

  return {
    async deploy(version: string, environment: string): Promise<DeploymentResult> {
      const id = `k8s-${Date.now()}-${environment}`;
      const image = `${config.imageRepo}:${version}`;
      const result: DeploymentResult = {
        id,
        state: 'deploying',
        version,
        startedAt: new Date().toISOString(),
      };

      try {
        if (config.useCliMode && exec) {
          await exec('kubectl', [
            'set', 'image',
            `deployment/${config.deploymentName}`,
            `${config.containerName}=${image}`,
            '-n', config.namespace,
          ]);
          await exec('kubectl', [
            'rollout', 'status',
            `deployment/${config.deploymentName}`,
            '-n', config.namespace,
            '--timeout=120s',
          ]);
        } else {
          const patch = {
            spec: {
              template: {
                spec: {
                  containers: [{ name: config.containerName, image }],
                },
              },
            },
          };
          const res = await httpFetch(apiUrl(`/deployments/${config.deploymentName}`), {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify(patch),
          });
          if (!res.ok) throw new Error(`K8s API error: ${res.status}`);
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
      const original = deployments.get(id);
      const rollbackId = `${id}-rollback`;
      const result: DeploymentResult = {
        id: rollbackId,
        state: 'deploying',
        version: original?.version ?? 'unknown',
        startedAt: new Date().toISOString(),
      };

      try {
        if (config.useCliMode && exec) {
          await exec('kubectl', [
            'rollout', 'undo',
            `deployment/${config.deploymentName}`,
            '-n', config.namespace,
          ]);
        } else {
          const res = await httpFetch(
            apiUrl(`/deployments/${config.deploymentName}`) + '?dryRun=false',
            { method: 'PATCH', headers: headers(), body: JSON.stringify({ spec: { template: { metadata: { annotations: { 'ai-sdlc/rollback': 'true' } } } } }) },
          );
          if (!res.ok) throw new Error(`K8s rollback API error: ${res.status}`);
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
