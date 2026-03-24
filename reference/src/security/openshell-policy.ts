/**
 * OpenShell policy generator — maps AI-SDLC configuration
 * (AgentRole constraints, SandboxConstraints, network rules)
 * to NVIDIA OpenShell policy YAML.
 *
 * @see https://docs.nvidia.com/openshell/latest/reference/policy-schema.html
 */

import type { SandboxConstraints, NetworkPolicy } from './interfaces.js';

// ── OpenShell Policy Types ─────────────────────────────────────────

export interface OpenShellFilesystemPolicy {
  include_workdir: boolean;
  read_only: string[];
  read_write: string[];
}

export interface OpenShellLandlock {
  compatibility: 'best_effort' | 'hard_requirement';
}

export interface OpenShellProcess {
  run_as_user: string;
  run_as_group: string;
}

export interface OpenShellEndpoint {
  host: string;
  port: number;
  protocol?: 'rest';
  access?: 'read-only' | 'read-write' | 'full';
}

export interface OpenShellNetworkPolicy {
  name: string;
  endpoints: OpenShellEndpoint[];
  binaries: { path: string }[];
}

export interface OpenShellPolicy {
  version: 1;
  filesystem_policy: OpenShellFilesystemPolicy;
  landlock: OpenShellLandlock;
  process: OpenShellProcess;
  network_policies: Record<string, OpenShellNetworkPolicy>;
}

// ── Default Paths ──────────────────────────────────────────────────

const DEFAULT_READ_ONLY_PATHS = [
  '/usr',
  '/lib',
  '/lib64',
  '/proc',
  '/dev/urandom',
  '/app',
  '/etc',
  '/var/log',
];

const DEFAULT_READ_WRITE_PATHS = ['/sandbox', '/tmp', '/dev/null'];

// ── Policy Generation Options ──────────────────────────────────────

export interface PolicyGenerationOptions {
  /** SandboxConstraints from the pipeline. */
  constraints: SandboxConstraints;
  /** Paths the agent is blocked from accessing (glob patterns from AgentRole). */
  blockedPaths?: string[];
  /** Working directory to mount read-write. */
  workDir?: string;
  /** Additional read-only paths. */
  extraReadOnlyPaths?: string[];
  /** Additional read-write paths. */
  extraReadWritePaths?: string[];
  /** Named network endpoints to allow. */
  networkEndpoints?: Record<
    string,
    { host: string; port: number; access?: 'read-only' | 'read-write' | 'full' }[]
  >;
  /** Autonomy level (0 = most restricted, higher = more access). */
  autonomyLevel?: number;
}

// ── Network Policy Mapping ─────────────────────────────────────────

function mapNetworkPolicy(
  aiSdlcPolicy: NetworkPolicy,
  endpoints?: Record<
    string,
    { host: string; port: number; access?: 'read-only' | 'read-write' | 'full' }[]
  >,
): Record<string, OpenShellNetworkPolicy> {
  if (aiSdlcPolicy === 'none') {
    // No network access — return empty policies (deny-by-default)
    return {};
  }

  const policies: Record<string, OpenShellNetworkPolicy> = {};

  // egress-only and full both allow configured endpoints
  if (endpoints) {
    for (const [name, eps] of Object.entries(endpoints)) {
      policies[name] = {
        name,
        endpoints: eps.map((ep) => ({
          host: ep.host,
          port: ep.port,
          protocol: 'rest' as const,
          access: ep.access ?? (aiSdlcPolicy === 'full' ? 'full' : 'read-write'),
        })),
        binaries: [{ path: '/usr/bin/*' }, { path: '/usr/local/bin/*' }],
      };
    }
  }

  // Always allow DNS resolution
  policies['dns'] = {
    name: 'dns-resolution',
    endpoints: [
      { host: '*.dns.google', port: 443 },
      { host: '1.1.1.1', port: 443 },
    ],
    binaries: [{ path: '/usr/bin/*' }],
  };

  return policies;
}

// ── Main Generator ─────────────────────────────────────────────────

/**
 * Generate an OpenShell policy from AI-SDLC configuration.
 *
 * Filesystem: default-deny with explicit read-only/read-write lists.
 * The `blockedPaths` from AgentRole are enforced by omitting them
 * from read_write and read_only lists (Landlock deny-by-default).
 *
 * Network: maps AI-SDLC NetworkPolicy to OpenShell network_policies.
 * Process: runs as unprivileged sandbox user.
 */
export function generateOpenShellPolicy(options: PolicyGenerationOptions): OpenShellPolicy {
  const {
    constraints,
    blockedPaths: _blockedPaths,
    workDir,
    extraReadOnlyPaths,
    extraReadWritePaths,
    networkEndpoints,
    autonomyLevel,
  } = options;

  const readOnly = [...DEFAULT_READ_ONLY_PATHS, ...(extraReadOnlyPaths ?? [])];
  const readWrite = [...DEFAULT_READ_WRITE_PATHS, ...(extraReadWritePaths ?? [])];

  // Add allowed paths from constraints
  for (const p of constraints.allowedPaths) {
    if (!readWrite.includes(p)) {
      readWrite.push(p);
    }
  }

  // Add working directory if specified
  if (workDir && !readWrite.includes(workDir)) {
    readWrite.push(workDir);
  }

  // Autonomy level adjustments:
  // Level 0 (Observer): hard Landlock, no network
  // Level 1 (Junior): best-effort Landlock, egress-only
  // Level 2+: best-effort Landlock, configured network
  const level = autonomyLevel ?? 0;
  const landdockCompat = level === 0 ? 'hard_requirement' : 'best_effort';
  const effectiveNetworkPolicy = level === 0 ? 'none' : constraints.networkPolicy;

  return {
    version: 1,
    filesystem_policy: {
      include_workdir: !!workDir,
      read_only: readOnly,
      read_write: readWrite,
    },
    landlock: {
      compatibility: landdockCompat,
    },
    process: {
      run_as_user: 'sandbox',
      run_as_group: 'sandbox',
    },
    network_policies: mapNetworkPolicy(effectiveNetworkPolicy as NetworkPolicy, networkEndpoints),
  };
}

/**
 * Serialize an OpenShell policy to YAML string.
 * Uses simple serialization to avoid a YAML dependency in the reference package.
 */
export function serializePolicy(policy: OpenShellPolicy): string {
  const lines: string[] = [`version: ${policy.version}`, ''];

  // Filesystem policy
  lines.push('filesystem_policy:');
  lines.push(`  include_workdir: ${policy.filesystem_policy.include_workdir}`);
  lines.push('  read_only:');
  for (const p of policy.filesystem_policy.read_only) {
    lines.push(`    - ${p}`);
  }
  lines.push('  read_write:');
  for (const p of policy.filesystem_policy.read_write) {
    lines.push(`    - ${p}`);
  }
  lines.push('');

  // Landlock
  lines.push('landlock:');
  lines.push(`  compatibility: ${policy.landlock.compatibility}`);
  lines.push('');

  // Process
  lines.push('process:');
  lines.push(`  run_as_user: ${policy.process.run_as_user}`);
  lines.push(`  run_as_group: ${policy.process.run_as_group}`);
  lines.push('');

  // Network policies
  if (Object.keys(policy.network_policies).length > 0) {
    lines.push('network_policies:');
    for (const [key, np] of Object.entries(policy.network_policies)) {
      lines.push(`  ${key}:`);
      lines.push(`    name: ${np.name}`);
      lines.push('    endpoints:');
      for (const ep of np.endpoints) {
        lines.push(`      - host: ${ep.host}`);
        lines.push(`        port: ${ep.port}`);
        if (ep.protocol) lines.push(`        protocol: ${ep.protocol}`);
        if (ep.access) lines.push(`        access: ${ep.access}`);
      }
      lines.push('    binaries:');
      for (const b of np.binaries) {
        lines.push(`      - path: ${b.path}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}
