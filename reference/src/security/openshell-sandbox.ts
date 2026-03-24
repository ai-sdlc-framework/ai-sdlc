/**
 * NVIDIA OpenShell sandbox provider.
 * Implements the Sandbox interface using OpenShell CLI for kernel-level
 * agent isolation with Landlock filesystem policies, seccomp syscall
 * filtering, and network policy enforcement.
 *
 * @see https://github.com/NVIDIA/OpenShell
 * @see https://docs.nvidia.com/openshell/latest/index.html
 */

import type { Sandbox, SandboxConstraints, SandboxStatus } from './interfaces.js';
import {
  generateOpenShellPolicy,
  serializePolicy,
  type PolicyGenerationOptions,
} from './openshell-policy.js';

/** Function that executes a shell command and returns stdout. */
export type ShellExec = (command: string) => Promise<string>;

/** Credential to auto-create as an OpenShell provider before sandbox creation. */
export interface ProviderCredential {
  /** Provider name (e.g., 'claude', 'github'). */
  name: string;
  /** Provider type: 'claude' | 'github' | 'openai' | 'nvidia' | 'generic'. */
  type: string;
  /** If true, auto-discover from current shell environment. */
  fromExisting?: boolean;
  /** Explicit key=value pairs (only used when fromExisting is false). */
  credentials?: Record<string, string>;
}

export interface OpenShellSandboxConfig {
  /** Paths the agent is blocked from accessing (from AgentRole.spec.constraints.blockedPaths). */
  blockedPaths?: string[];
  /** Working directory to mount into the sandbox. */
  workDir?: string;
  /** Named network endpoints to allow (mapped from Pipeline.spec.credentials). */
  networkEndpoints?: PolicyGenerationOptions['networkEndpoints'];
  /** OpenShell providers to attach (credential names). */
  providers?: string[];
  /** Credentials to auto-create as OpenShell providers before sandbox creation. */
  autoProviders?: ProviderCredential[];
  /** Path to openshell binary (defaults to 'openshell'). */
  binaryPath?: string;
}

/**
 * Check if the OpenShell CLI is available.
 */
export async function isOpenShellAvailable(exec: ShellExec): Promise<boolean> {
  try {
    await exec('openshell --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an OpenShell-backed sandbox provider.
 *
 * @param exec - Shell execution function (e.g., wrapping child_process.exec).
 * @param config - OpenShell sandbox configuration.
 */
export function createOpenShellSandbox(
  exec: ShellExec,
  config: OpenShellSandboxConfig = {},
): Sandbox {
  const sandboxes = new Map<string, string>(); // sandboxId → openshell sandbox name
  const bin = config.binaryPath ?? 'openshell';

  return {
    async isolate(taskId: string, constraints: SandboxConstraints): Promise<string> {
      const sandboxName = `aisdlc-${taskId}-${Date.now()}`;
      const sandboxId = sandboxName;

      // Generate policy YAML
      const policy = generateOpenShellPolicy({
        constraints,
        blockedPaths: config.blockedPaths,
        workDir: config.workDir,
        networkEndpoints: config.networkEndpoints,
      });
      const policyYaml = serializePolicy(policy);

      // Write policy to temp file
      const policyPath = `/tmp/${sandboxName}-policy.yaml`;
      await exec(`cat > ${policyPath} << 'POLICY_EOF'\n${policyYaml}POLICY_EOF`);

      // Auto-create credential providers if configured
      const providerNames = [...(config.providers ?? [])];
      for (const ap of config.autoProviders ?? []) {
        try {
          if (ap.fromExisting !== false) {
            await exec(
              `${bin} provider create --name ${ap.name} --type ${ap.type} --from-existing`,
            );
          } else if (ap.credentials) {
            const credArgs = Object.entries(ap.credentials)
              .map(([k, v]) => `--credential ${k}=${v}`)
              .join(' ');
            await exec(`${bin} provider create --name ${ap.name} --type ${ap.type} ${credArgs}`);
          }
          if (!providerNames.includes(ap.name)) {
            providerNames.push(ap.name);
          }
        } catch {
          // Provider may already exist — continue
        }
      }

      // Build sandbox create command
      const args = [`sandbox create`, `--name ${sandboxName}`, `--policy ${policyPath}`, `--keep`];

      // Attach credential providers
      for (const provider of providerNames) {
        args.push(`--provider ${provider}`);
      }

      // Create the sandbox (without launching an agent — we'll exec into it later)
      args.push('-- sleep infinity');
      await exec(`${bin} ${args.join(' ')}`);

      // Upload working directory if specified
      if (config.workDir) {
        await exec(`${bin} sandbox upload ${sandboxName} ${config.workDir} /sandbox/workdir`);
      }

      sandboxes.set(sandboxId, sandboxName);

      // Clean up temp policy file
      await exec(`rm -f ${policyPath}`).catch(() => {});

      return sandboxId;
    },

    async destroy(sandboxId: string): Promise<void> {
      const name = sandboxes.get(sandboxId);
      if (!name) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }

      // Download results if workDir was specified
      if (config.workDir) {
        await exec(`${bin} sandbox download ${name} /sandbox/workdir ${config.workDir}`).catch(
          () => {},
        );
      }

      await exec(`${bin} sandbox delete ${name}`);
      sandboxes.delete(sandboxId);
    },

    async getStatus(sandboxId: string): Promise<SandboxStatus> {
      const name = sandboxes.get(sandboxId);
      if (!name) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }

      try {
        const output = await exec(`${bin} sandbox get ${name}`);
        if (output.includes('Running') || output.includes('running')) {
          return 'running';
        }
        if (output.includes('Stopped') || output.includes('stopped') || output.includes('exited')) {
          return 'terminated';
        }
        return 'idle';
      } catch {
        return 'error';
      }
    },
  };
}

/**
 * Build the command prefix for executing a command inside an OpenShell sandbox.
 * Used by runners to spawn agents within the isolated environment.
 *
 * @param sandboxName - The sandbox identifier.
 * @param binaryPath - Path to the openshell binary.
 * @returns The command prefix array to prepend to the agent command.
 */
export function buildSandboxExecPrefix(sandboxName: string, binaryPath = 'openshell'): string[] {
  return [binaryPath, 'sandbox', 'connect', sandboxName, '--'];
}
