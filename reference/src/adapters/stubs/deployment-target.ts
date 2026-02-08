/**
 * Stub DeploymentTarget adapter for testing.
 * In-memory deployment state tracking.
 */

import type {
  DeploymentTarget,
  DeployInput,
  Deployment,
  DeploymentStatus,
  DeployFilter,
  DeployEvent,
  EventStream,
} from '../interfaces.js';

export interface StubDeploymentTargetAdapter extends DeploymentTarget {
  /** Get all deployments. */
  getDeployments(): Map<string, DeploymentStatus>;
}

export function createStubDeploymentTarget(): StubDeploymentTargetAdapter {
  const deployments = new Map<string, DeploymentStatus>();
  let nextId = 1;

  return {
    async deploy(input: DeployInput): Promise<Deployment> {
      const id = `deploy-${nextId++}`;
      const status: DeploymentStatus = {
        id,
        status: 'succeeded',
        environment: input.environment,
        timestamp: new Date().toISOString(),
      };
      deployments.set(id, status);
      return {
        id,
        status: 'succeeded',
        environment: input.environment,
        url: `https://deploy.test/${input.environment}/${id}`,
      };
    },

    async getDeploymentStatus(id: string): Promise<DeploymentStatus> {
      const status = deployments.get(id);
      if (!status) throw new Error(`Deployment "${id}" not found`);
      return status;
    },

    async rollback(id: string): Promise<Deployment> {
      const status = deployments.get(id);
      if (!status) throw new Error(`Deployment "${id}" not found`);
      const updated: DeploymentStatus = {
        ...status,
        status: 'rolled-back',
        timestamp: new Date().toISOString(),
      };
      deployments.set(id, updated);
      return {
        id,
        status: 'rolled-back',
        environment: status.environment,
      };
    },

    watchDeploymentEvents(_filter: DeployFilter): EventStream<DeployEvent> {
      // Return an empty async iterator
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined as unknown as DeployEvent };
            },
          };
        },
      };
    },

    getDeployments(): Map<string, DeploymentStatus> {
      return new Map(deployments);
    },
  };
}
