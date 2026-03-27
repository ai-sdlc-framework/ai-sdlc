import { describe, it, expect } from 'vitest';
import { generateOpenShellPolicy, serializePolicy } from './openshell-policy.js';
import type { SandboxConstraints } from './interfaces.js';

function makeConstraints(overrides?: Partial<SandboxConstraints>): SandboxConstraints {
  return {
    maxMemoryMb: 512,
    maxCpuPercent: 80,
    networkPolicy: 'egress-only',
    timeoutMs: 1_800_000,
    allowedPaths: [],
    ...overrides,
  };
}

describe('generateOpenShellPolicy', () => {
  it('generates a valid policy with defaults (level 0)', () => {
    const policy = generateOpenShellPolicy({ constraints: makeConstraints() });

    expect(policy.version).toBe(1);
    expect(policy.filesystem_policy.include_workdir).toBe(false);
    expect(policy.filesystem_policy.read_only).toContain('/usr');
    expect(policy.filesystem_policy.read_only).toContain('/etc');
    expect(policy.filesystem_policy.read_write).toContain('/tmp');
    expect(policy.filesystem_policy.read_write).toContain('/sandbox');
    expect(policy.landlock.compatibility).toBe('hard_requirement');
    expect(policy.process.run_as_user).toBe('sandbox');
    expect(policy.process.run_as_group).toBe('sandbox');
    // Level 0 has no network
    expect(Object.keys(policy.network_policies)).toHaveLength(0);
  });

  it('includes workDir in read_write when specified', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints(),
      workDir: '/home/runner/work/repo',
    });

    expect(policy.filesystem_policy.include_workdir).toBe(false);
    expect(policy.filesystem_policy.read_write).toContain('/home/runner/work/repo');
  });

  it('does not duplicate workDir if already in read_write', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ allowedPaths: ['/sandbox'] }),
      workDir: '/sandbox',
    });

    const count = policy.filesystem_policy.read_write.filter((p) => p === '/sandbox').length;
    expect(count).toBe(1);
  });

  it('adds allowedPaths from constraints to read_write', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ allowedPaths: ['/data/models', '/opt/tools'] }),
    });

    expect(policy.filesystem_policy.read_write).toContain('/data/models');
    expect(policy.filesystem_policy.read_write).toContain('/opt/tools');
  });

  it('adds extra read-only and read-write paths', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints(),
      extraReadOnlyPaths: ['/opt/shared'],
      extraReadWritePaths: ['/var/cache'],
    });

    expect(policy.filesystem_policy.read_only).toContain('/opt/shared');
    expect(policy.filesystem_policy.read_write).toContain('/var/cache');
  });

  it('generates empty network_policies for networkPolicy "none"', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ networkPolicy: 'none' }),
    });

    expect(Object.keys(policy.network_policies)).toHaveLength(0);
  });

  it('generates DNS + configured endpoints for egress-only', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ networkPolicy: 'egress-only' }),
      autonomyLevel: 1,
      networkEndpoints: {
        github_api: [{ host: 'api.github.com', port: 443, access: 'read-only' }],
      },
    });

    expect(policy.network_policies['dns']).toBeDefined();
    expect(policy.network_policies['dns'].name).toBe('dns-resolution');
    expect(policy.network_policies['github_api']).toBeDefined();
    expect(policy.network_policies['github_api'].endpoints[0].host).toBe('api.github.com');
    expect(policy.network_policies['github_api'].endpoints[0].access).toBe('read-only');
  });

  it('defaults endpoint access to "full" for networkPolicy "full"', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ networkPolicy: 'full' }),
      autonomyLevel: 2,
      networkEndpoints: {
        api: [{ host: 'example.com', port: 443 }],
      },
    });

    expect(policy.network_policies['api'].endpoints[0].access).toBe('full');
  });

  it('defaults endpoint access to "read-write" for egress-only', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ networkPolicy: 'egress-only' }),
      autonomyLevel: 1,
      networkEndpoints: {
        api: [{ host: 'example.com', port: 443 }],
      },
    });

    expect(policy.network_policies['api'].endpoints[0].access).toBe('read-write');
  });

  it('includes DNS policy for egress-only without custom endpoints', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ networkPolicy: 'egress-only' }),
      autonomyLevel: 1,
    });

    expect(policy.network_policies['dns']).toBeDefined();
    expect(Object.keys(policy.network_policies)).toHaveLength(1);
  });

  describe('autonomy level adjustments', () => {
    it('level 0 uses hard_requirement Landlock and no network', () => {
      const policy = generateOpenShellPolicy({
        constraints: makeConstraints({ networkPolicy: 'egress-only' }),
        autonomyLevel: 0,
      });

      expect(policy.landlock.compatibility).toBe('hard_requirement');
      expect(Object.keys(policy.network_policies)).toHaveLength(0);
    });

    it('level 1 uses best_effort Landlock and configured network', () => {
      const policy = generateOpenShellPolicy({
        constraints: makeConstraints({ networkPolicy: 'egress-only' }),
        autonomyLevel: 1,
        networkEndpoints: {
          github: [{ host: 'api.github.com', port: 443 }],
        },
      });

      expect(policy.landlock.compatibility).toBe('best_effort');
      expect(policy.network_policies['github']).toBeDefined();
      expect(policy.network_policies['dns']).toBeDefined();
    });

    it('level 2+ uses best_effort Landlock and full configured network', () => {
      const policy = generateOpenShellPolicy({
        constraints: makeConstraints({ networkPolicy: 'full' }),
        autonomyLevel: 3,
        networkEndpoints: {
          api: [{ host: 'example.com', port: 443 }],
        },
      });

      expect(policy.landlock.compatibility).toBe('best_effort');
      expect(policy.network_policies['api'].endpoints[0].access).toBe('full');
    });

    it('defaults to level 0 when autonomyLevel is not specified', () => {
      const policy = generateOpenShellPolicy({
        constraints: makeConstraints({ networkPolicy: 'egress-only' }),
      });

      expect(policy.landlock.compatibility).toBe('hard_requirement');
      expect(Object.keys(policy.network_policies)).toHaveLength(0);
    });
  });
});

describe('serializePolicy', () => {
  it('serializes a policy to valid YAML-like string', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints(),
      autonomyLevel: 1,
      workDir: '/workspace',
    });

    const yaml = serializePolicy(policy);

    expect(yaml).toContain('version: 1');
    expect(yaml).toContain('filesystem_policy:');
    expect(yaml).toContain('include_workdir: false');
    expect(yaml).toContain('  - /usr');
    expect(yaml).toContain('  - /workspace');
    expect(yaml).toContain('landlock:');
    expect(yaml).toContain('  compatibility: best_effort');
    expect(yaml).toContain('process:');
    expect(yaml).toContain('  run_as_user: sandbox');
  });

  it('includes network_policies section when present', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ networkPolicy: 'egress-only' }),
      autonomyLevel: 1,
      networkEndpoints: {
        github: [{ host: 'api.github.com', port: 443, access: 'read-only' }],
      },
    });

    const yaml = serializePolicy(policy);

    expect(yaml).toContain('network_policies:');
    expect(yaml).toContain('  github:');
    expect(yaml).toContain('    name: github');
    expect(yaml).toContain('      - host: api.github.com');
    expect(yaml).toContain('        port: 443');
    expect(yaml).toContain('        protocol: rest');
    expect(yaml).toContain('        access: read-only');
  });

  it('omits network_policies section when empty', () => {
    const policy = generateOpenShellPolicy({
      constraints: makeConstraints({ networkPolicy: 'none' }),
    });

    const yaml = serializePolicy(policy);

    expect(yaml).not.toContain('network_policies:');
  });
});
