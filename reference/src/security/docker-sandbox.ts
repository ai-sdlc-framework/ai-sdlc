/**
 * Docker container sandbox provider (stub).
 * Implements the Sandbox interface using Docker container isolation.
 * This is a stub that shells out to `docker run` — production deployments
 * would use the Docker Engine API directly.
 */

import type { Sandbox, SandboxConstraints, SandboxStatus } from './interfaces.js';

/** Function that executes a shell command and returns stdout. */
export type ShellExec = (command: string) => Promise<string>;

export interface DockerSandboxConfig {
  /** Docker image to use for sandboxes. */
  image: string;
  /** Optional Docker network to attach (defaults to 'none'). */
  network?: string;
}

/**
 * Create a Docker-backed sandbox provider.
 *
 * @param exec - Shell execution function (e.g., wrapping child_process.execSync).
 * @param config - Docker configuration.
 */
export function createDockerSandbox(exec: ShellExec, config: DockerSandboxConfig): Sandbox {
  const containers = new Map<string, string>(); // sandboxId → containerId

  return {
    async isolate(taskId: string, constraints: SandboxConstraints): Promise<string> {
      const sandboxId = `docker-${taskId}-${Date.now()}`;
      const network = constraints.networkPolicy === 'none' ? 'none' : (config.network ?? 'bridge');
      const memoryFlag = `--memory=${constraints.maxMemoryMb}m`;
      const cpuFlag = `--cpus=${(constraints.maxCpuPercent / 100).toFixed(2)}`;
      const networkFlag = `--network=${network}`;

      const cmd = `docker run -d ${memoryFlag} ${cpuFlag} ${networkFlag} --name ${sandboxId} ${config.image} sleep ${Math.ceil(constraints.timeoutMs / 1000)}`;
      const containerId = (await exec(cmd)).trim();
      containers.set(sandboxId, containerId);
      return sandboxId;
    },

    async destroy(sandboxId: string): Promise<void> {
      const containerId = containers.get(sandboxId);
      if (!containerId) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }
      await exec(`docker rm -f ${containerId}`);
      containers.delete(sandboxId);
    },

    async getStatus(sandboxId: string): Promise<SandboxStatus> {
      const containerId = containers.get(sandboxId);
      if (!containerId) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }
      const state = (await exec(`docker inspect -f '{{.State.Status}}' ${containerId}`)).trim();
      switch (state) {
        case 'running':
          return 'running';
        case 'created':
          return 'idle';
        case 'exited':
        case 'dead':
        case 'removing':
          return 'terminated';
        default:
          return 'error';
      }
    },
  };
}
