/**
 * GitHub Codespaces sandbox provider.
 * Implements the Sandbox interface using GitHub Codespaces API,
 * providing real container isolation via devcontainers.
 * <!-- Source: PRD Section 15 -->
 */

import type { Sandbox, SandboxConstraints, SandboxStatus } from './interfaces.js';

/** Minimal Octokit-like interface for Codespaces operations. */
export interface CodespacesClient {
  codespaces: {
    createWithRepoForAuthenticatedUser(params: {
      owner: string;
      repo: string;
      ref?: string;
      machine?: string;
      devcontainer_path?: string;
      idle_timeout_minutes?: number;
      display_name?: string;
    }): Promise<{ data: { id: number; name: string; state: string } }>;

    getForAuthenticatedUser(params: {
      codespace_name: string;
    }): Promise<{ data: { id: number; name: string; state: string } }>;

    deleteForAuthenticatedUser(params: { codespace_name: string }): Promise<{ status: number }>;

    stopForAuthenticatedUser(params: {
      codespace_name: string;
    }): Promise<{ data: { id: number; name: string; state: string } }>;
  };
}

export interface GitHubSandboxConfig {
  owner: string;
  repo: string;
  ref?: string;
  devcontainerPath?: string;
  defaultMachine?: string;
}

/**
 * Map Codespaces API state to our SandboxStatus.
 */
function mapCodespaceState(state: string): SandboxStatus {
  switch (state) {
    case 'Available':
    case 'Starting':
    case 'Rebuilding':
      return 'running';
    case 'ShuttingDown':
    case 'ShutDown':
    case 'Deleted':
      return 'terminated';
    case 'Failed':
      return 'error';
    case 'Queued':
    case 'Awaiting':
    case 'Created':
      return 'idle';
    default:
      return 'idle';
  }
}

/**
 * Compute idle timeout from sandbox constraints.
 * Converts timeoutMs to minutes (minimum 5, maximum 240 per GitHub API).
 */
function computeIdleTimeout(constraints: SandboxConstraints): number {
  const minutes = Math.ceil(constraints.timeoutMs / 60_000);
  return Math.max(5, Math.min(240, minutes));
}

/**
 * Select machine type based on resource constraints.
 */
function selectMachine(constraints: SandboxConstraints, defaultMachine?: string): string {
  if (defaultMachine) return defaultMachine;
  // Map CPU/memory constraints to GitHub Codespaces machine tiers
  if (constraints.maxCpuPercent <= 25 && constraints.maxMemoryMb <= 4096) {
    return 'basicLinux32gb';
  }
  if (constraints.maxCpuPercent <= 50 && constraints.maxMemoryMb <= 8192) {
    return 'standardLinux32gb';
  }
  return 'premiumLinux';
}

/**
 * Create a GitHub Codespaces-backed sandbox provider.
 *
 * Each `isolate()` call creates a new Codespace in the configured repository.
 * The devcontainer configuration controls the runtime environment.
 * `destroy()` stops and deletes the Codespace.
 */
export function createGitHubSandbox(
  client: CodespacesClient,
  config: GitHubSandboxConfig,
): Sandbox {
  const sandboxMap = new Map<string, string>(); // sandboxId → codespaceName

  return {
    async isolate(taskId: string, constraints: SandboxConstraints): Promise<string> {
      const displayName = `sandbox-${taskId}`;
      const idleTimeout = computeIdleTimeout(constraints);
      const machine = selectMachine(constraints, config.defaultMachine);

      const response = await client.codespaces.createWithRepoForAuthenticatedUser({
        owner: config.owner,
        repo: config.repo,
        ref: config.ref,
        machine,
        devcontainer_path: config.devcontainerPath,
        idle_timeout_minutes: idleTimeout,
        display_name: displayName,
      });

      const sandboxId = `cs-${response.data.id}`;
      sandboxMap.set(sandboxId, response.data.name);
      return sandboxId;
    },

    async destroy(sandboxId: string): Promise<void> {
      const codespaceName = sandboxMap.get(sandboxId);
      if (!codespaceName) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }

      // Stop first, then delete
      try {
        await client.codespaces.stopForAuthenticatedUser({
          codespace_name: codespaceName,
        });
      } catch {
        // Codespace may already be stopped
      }

      await client.codespaces.deleteForAuthenticatedUser({
        codespace_name: codespaceName,
      });

      sandboxMap.delete(sandboxId);
    },

    async getStatus(sandboxId: string): Promise<SandboxStatus> {
      const codespaceName = sandboxMap.get(sandboxId);
      if (!codespaceName) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }

      const response = await client.codespaces.getForAuthenticatedUser({
        codespace_name: codespaceName,
      });

      return mapCodespaceState(response.data.state);
    },
  };
}
