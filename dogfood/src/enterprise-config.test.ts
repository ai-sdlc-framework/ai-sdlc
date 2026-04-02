import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseSimpleYaml,
  loadEnterpriseConfig,
  loadEnterprisePlugins,
} from './enterprise-config.js';

// Mock enterprise plugins (not installed in test env)
vi.mock('@ai-sdlc-enterprise/plugins', () => {
  throw new Error('not installed');
});

// ── parseSimpleYaml ────────────────────────────────────────────────

describe('parseSimpleYaml', () => {
  it('returns empty object for empty input', () => {
    expect(parseSimpleYaml('')).toEqual({});
  });

  it('returns empty object for comments-only input', () => {
    const yaml = `
# This is a comment
  # Indented comment
# Another comment
`;
    expect(parseSimpleYaml(yaml)).toEqual({});
  });

  it('returns empty object for whitespace-only input', () => {
    expect(parseSimpleYaml('   \n\n   \n')).toEqual({});
  });

  it('parses flat key-value pairs', () => {
    const yaml = `licenseKey: abc-123
name: my-project`;
    expect(parseSimpleYaml(yaml)).toEqual({
      licenseKey: 'abc-123',
      name: 'my-project',
    });
  });

  it('parses boolean values as actual booleans', () => {
    const yaml = `enabled: true
disabled: false
notBool: truthy`;
    const result = parseSimpleYaml(yaml);
    expect(result.enabled).toBe(true);
    expect(result.disabled).toBe(false);
    expect(result.notBool).toBe('truthy');
  });

  it('strips surrounding quotes from values', () => {
    const yaml = `single: 'hello world'
double: "goodbye world"`;
    const result = parseSimpleYaml(yaml);
    expect(result.single).toBe('hello world');
    expect(result.double).toBe('goodbye world');
  });

  it('parses nested sections', () => {
    const yaml = `audit:
  endpoint: https://audit.example.com
  tokenEnvVar: AUDIT_TOKEN`;
    const result = parseSimpleYaml(yaml);
    expect(result.audit).toEqual({
      endpoint: 'https://audit.example.com',
      tokenEnvVar: 'AUDIT_TOKEN',
    });
  });

  it('parses multiple nested sections', () => {
    const yaml = `audit:
  endpoint: https://audit.example.com
telemetry:
  endpoint: https://telemetry.example.com
  headers: x-custom=1`;
    const result = parseSimpleYaml(yaml);
    expect(result.audit).toEqual({ endpoint: 'https://audit.example.com' });
    expect(result.telemetry).toEqual({
      endpoint: 'https://telemetry.example.com',
      headers: 'x-custom=1',
    });
  });

  it('handles mix of flat keys and nested sections', () => {
    const yaml = `licenseKey: lic-999
audit:
  endpoint: https://audit.example.com
policy:
  endpoint: https://policy.example.com
  failOpen: true`;
    const result = parseSimpleYaml(yaml);
    expect(result.licenseKey).toBe('lic-999');
    expect(result.audit).toEqual({ endpoint: 'https://audit.example.com' });
    expect(result.policy).toEqual({
      endpoint: 'https://policy.example.com',
      failOpen: true,
    });
  });

  it('parses booleans inside nested sections', () => {
    const yaml = `policy:
  failOpen: false`;
    const result = parseSimpleYaml(yaml);
    expect((result.policy as Record<string, unknown>).failOpen).toBe(false);
  });

  it('ignores comment lines interspersed with data', () => {
    const yaml = `# top comment
licenseKey: abc
# mid comment
audit:
  # nested comment
  endpoint: https://audit.example.com`;
    const result = parseSimpleYaml(yaml);
    expect(result.licenseKey).toBe('abc');
    expect(result.audit).toEqual({ endpoint: 'https://audit.example.com' });
  });

  it('flushes previous section when a flat key follows a section', () => {
    const yaml = `audit:
  endpoint: https://audit.example.com
licenseKey: xyz`;
    const result = parseSimpleYaml(yaml);
    expect(result.audit).toEqual({ endpoint: 'https://audit.example.com' });
    expect(result.licenseKey).toBe('xyz');
  });
});

// ── loadEnterpriseConfig ───────────────────────────────────────────

describe('loadEnterpriseConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ent-config-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when .enterprise.yaml does not exist', () => {
    expect(loadEnterpriseConfig(tmpDir)).toBeNull();
  });

  it('returns parsed config for a valid file', () => {
    const yaml = `licenseKey: lic-42
audit:
  endpoint: https://audit.example.com
  tokenEnvVar: MY_TOKEN
telemetry:
  endpoint: https://telemetry.example.com
policy:
  endpoint: https://policy.example.com
  failOpen: true
siem:
  provider: splunk
  endpoint: https://siem.example.com
  tokenEnvVar: SIEM_TOKEN`;

    writeFileSync(join(tmpDir, '.enterprise.yaml'), yaml, 'utf-8');
    const config = loadEnterpriseConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.licenseKey).toBe('lic-42');
    expect(config!.audit).toEqual({
      endpoint: 'https://audit.example.com',
      tokenEnvVar: 'MY_TOKEN',
    });
    expect(config!.telemetry).toEqual({ endpoint: 'https://telemetry.example.com' });
    expect(config!.policy).toEqual({
      endpoint: 'https://policy.example.com',
      failOpen: true,
    });
    expect(config!.siem).toEqual({
      provider: 'splunk',
      endpoint: 'https://siem.example.com',
      tokenEnvVar: 'SIEM_TOKEN',
    });
  });

  it('returns config with only flat keys (no sections)', () => {
    writeFileSync(join(tmpDir, '.enterprise.yaml'), 'licenseKey: key-only\n', 'utf-8');
    const config = loadEnterpriseConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.licenseKey).toBe('key-only');
  });

  it('returns empty config object for an empty file', () => {
    writeFileSync(join(tmpDir, '.enterprise.yaml'), '', 'utf-8');
    const config = loadEnterpriseConfig(tmpDir);
    expect(config).toEqual({});
  });

  it('returns config for a comments-only file', () => {
    writeFileSync(join(tmpDir, '.enterprise.yaml'), '# just comments\n', 'utf-8');
    const config = loadEnterpriseConfig(tmpDir);
    expect(config).toEqual({});
  });
});

// ── loadEnterprisePlugins ──────────────────────────────────────────

describe('loadEnterprisePlugins', () => {
  let tmpDir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ent-plugins-'));
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array and logs OSS message when config is missing', async () => {
    const plugins = await loadEnterprisePlugins(tmpDir);
    expect(plugins).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('running OSS only'));
  });

  it('returns empty array when enterprise package is not installed', async () => {
    writeFileSync(join(tmpDir, '.enterprise.yaml'), 'licenseKey: lic-1\n', 'utf-8');
    const plugins = await loadEnterprisePlugins(tmpDir);
    expect(plugins).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Enterprise plugins not available'),
    );
  });

  it('sets AI_SDLC_LICENSE_KEY env var from config when not already set', async () => {
    const original = process.env['AI_SDLC_LICENSE_KEY'];
    delete process.env['AI_SDLC_LICENSE_KEY'];

    writeFileSync(join(tmpDir, '.enterprise.yaml'), 'licenseKey: injected-key\n', 'utf-8');
    await loadEnterprisePlugins(tmpDir);
    expect(process.env['AI_SDLC_LICENSE_KEY']).toBe('injected-key');

    // Restore
    if (original !== undefined) {
      process.env['AI_SDLC_LICENSE_KEY'] = original;
    } else {
      delete process.env['AI_SDLC_LICENSE_KEY'];
    }
  });

  it('does not overwrite AI_SDLC_LICENSE_KEY if already set', async () => {
    const original = process.env['AI_SDLC_LICENSE_KEY'];
    process.env['AI_SDLC_LICENSE_KEY'] = 'existing-key';

    writeFileSync(join(tmpDir, '.enterprise.yaml'), 'licenseKey: new-key\n', 'utf-8');
    await loadEnterprisePlugins(tmpDir);
    expect(process.env['AI_SDLC_LICENSE_KEY']).toBe('existing-key');

    // Restore
    if (original !== undefined) {
      process.env['AI_SDLC_LICENSE_KEY'] = original;
    } else {
      delete process.env['AI_SDLC_LICENSE_KEY'];
    }
  });
});
