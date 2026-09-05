/**
 * Tests for `ai-sdlc doctor` (AISDLC-560).
 *
 * Every fixture uses `mkdtempSync` under `os.tmpdir()` — never a shared
 * `/tmp` marker path — and is cleaned up in `afterEach` so parallel test
 * runs never collide (see feedback_shared_tmp_marker_dir_pollution.md).
 * The `gh` subprocess is always a stub `DoctorAdapters.runCommand`; no
 * real network or `gh` CLI is invoked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import {
  checkAttestationGovernance,
  checkBranchProtection,
  detectAttestationArtifacts,
  renderDoctorReport,
  createDoctorCommand,
  type DoctorAdapters,
} from './doctor.js';
import type { DoctorCheckAdapters } from './doctor-checks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-doctor-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A runCommand stub that always reports "gh not available". */
function noGh(): DoctorAdapters['runCommand'] {
  return () => ({ stdout: '', exitCode: 1 });
}

/** A runCommand stub that resolves owner/repo, then returns the given protection body. */
function ghWithProtection(protectionBody: unknown): DoctorAdapters['runCommand'] {
  return (cmd, args) => {
    if (cmd !== 'gh') return { stdout: '', exitCode: 1 };
    if (args[0] === 'repo' && args[1] === 'view') {
      return { stdout: 'acme/widgets\n', exitCode: 0 };
    }
    if (args[0] === 'api') {
      return { stdout: JSON.stringify(protectionBody), exitCode: 0 };
    }
    return { stdout: '', exitCode: 1 };
  };
}

describe('detectAttestationArtifacts', () => {
  it('reports all-absent on an empty repo', () => {
    const result = detectAttestationArtifacts(tmpDir, { exists: (p) => existsSync(p) });
    expect(result.trustedReviewers).toBe(false);
    expect(result.attestationsDir).toBe(false);
    expect(result.verifyWorkflow).toBe(false);
  });

  it('detects each artifact independently', () => {
    mkdirSync(join(tmpDir, '.ai-sdlc', 'attestations'), { recursive: true });
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), 'reviewers: []\n');
    writeFileSync(join(tmpDir, '.github', 'workflows', 'verify-attestation.yml'), 'name: x\n');

    const result = detectAttestationArtifacts(tmpDir, {
      exists: (p) => existsSync(p),
    });
    expect(result.trustedReviewers).toBe(true);
    expect(result.attestationsDir).toBe(true);
    expect(result.verifyWorkflow).toBe(true);
  });
});

describe('checkBranchProtection', () => {
  it('reports checked:false when gh is unavailable', () => {
    const result = checkBranchProtection(tmpDir, { runCommand: noGh() });
    expect(result.checked).toBe(false);
    expect(result.requiresApprovingReview).toBe(false);
    expect(result.requiresPrReady).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('reports checked:false when the protection API call fails (no branch protection configured)', () => {
    const runCommand: DoctorAdapters['runCommand'] = (cmd, args) => {
      if (args[0] === 'repo') return { stdout: 'acme/widgets\n', exitCode: 0 };
      return { stdout: '', exitCode: 1 };
    };
    const result = checkBranchProtection(tmpDir, { runCommand });
    expect(result.checked).toBe(false);
    expect(result.error).toContain('protection');
  });

  it('reports requiresApprovingReview + requiresPrReady true when both are configured', () => {
    const result = checkBranchProtection(tmpDir, {
      runCommand: ghWithProtection({
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ['ai-sdlc/pr-ready', 'Backlog Drift'] },
      }),
    });
    expect(result.checked).toBe(true);
    expect(result.requiresApprovingReview).toBe(true);
    expect(result.requiresPrReady).toBe(true);
  });

  it('reports requiresApprovingReview false when the required count is 0', () => {
    const result = checkBranchProtection(tmpDir, {
      runCommand: ghWithProtection({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        required_status_checks: { contexts: ['ai-sdlc/pr-ready'] },
      }),
    });
    expect(result.requiresApprovingReview).toBe(false);
  });

  it('reports requiresPrReady false when ai-sdlc/pr-ready is not a required context', () => {
    const result = checkBranchProtection(tmpDir, {
      runCommand: ghWithProtection({
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ['some-other-check'] },
      }),
    });
    expect(result.requiresPrReady).toBe(false);
  });

  it('reports checked:false when the protection response is not valid JSON', () => {
    const runCommand: DoctorAdapters['runCommand'] = (cmd, args) => {
      if (args[0] === 'repo') return { stdout: 'acme/widgets\n', exitCode: 0 };
      if (args[0] === 'api') return { stdout: 'not json', exitCode: 0 };
      return { stdout: '', exitCode: 1 };
    };
    const result = checkBranchProtection(tmpDir, { runCommand });
    expect(result.checked).toBe(false);
    expect(result.error).toContain('JSON');
  });
});

describe('checkAttestationGovernance — three states', () => {
  it('state=neither on a repo with no attestation artifacts and no branch protection', () => {
    const adapters: DoctorAdapters = {
      exists: (p) => existsSync(p),
      runCommand: noGh(),
    };
    const result = checkAttestationGovernance(tmpDir, adapters);
    expect(result.state).toBe('neither');
    expect(result.artifactsPresent).toBe(false);
    expect(result.enforcementConfigured).toBe(false);
    expect(result.gap).toBeTruthy();
    expect(result.closingCommand).toBe('ai-sdlc init --add attestation');
  });

  it('state=artifacts-only when attestation files exist but no enforcement is detected (the reported defect)', () => {
    mkdirSync(join(tmpDir, '.ai-sdlc', 'attestations'), { recursive: true });
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), 'reviewers: []\n');
    writeFileSync(join(tmpDir, '.github', 'workflows', 'verify-attestation.yml'), 'name: x\n');

    const adapters: DoctorAdapters = {
      exists: (p) => existsSync(p),
      runCommand: noGh(),
    };
    const result = checkAttestationGovernance(tmpDir, adapters);
    expect(result.state).toBe('artifacts-only');
    expect(result.artifactsPresent).toBe(true);
    expect(result.enforcementConfigured).toBe(false);
    expect(result.gap).toContain('AUDIT-ONLY');
    expect(result.closingCommand).toBe('ai-sdlc init --add branch-protection');
  });

  it('state=fully-configured when artifacts are present AND branch protection requires review + pr-ready', () => {
    mkdirSync(join(tmpDir, '.ai-sdlc', 'attestations'), { recursive: true });
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), 'reviewers: []\n');

    const adapters: DoctorAdapters = {
      exists: (p) => existsSync(p),
      runCommand: ghWithProtection({
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ['ai-sdlc/pr-ready'] },
      }),
    };
    const result = checkAttestationGovernance(tmpDir, adapters);
    expect(result.state).toBe('fully-configured');
    expect(result.artifactsPresent).toBe(true);
    expect(result.enforcementConfigured).toBe(true);
    expect(result.gap).toBeUndefined();
  });

  it('state=artifacts-only (not fully-configured) when branch protection requires review but NOT ai-sdlc/pr-ready', () => {
    mkdirSync(join(tmpDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), 'reviewers: []\n');

    const adapters: DoctorAdapters = {
      exists: (p) => existsSync(p),
      runCommand: ghWithProtection({
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ['some-other-check'] },
      }),
    };
    const result = checkAttestationGovernance(tmpDir, adapters);
    expect(result.state).toBe('artifacts-only');
    expect(result.enforcementConfigured).toBe(false);
  });
});

describe('renderDoctorReport', () => {
  it('names the gap explicitly and the closing command for artifacts-only (AC #3)', () => {
    const adapters: DoctorAdapters = {
      exists: () => true,
      runCommand: noGh(),
    };
    const result = checkAttestationGovernance(tmpDir, adapters);
    const lines = renderDoctorReport(result).join('\n');
    expect(lines).toContain('ARTIFACTS-ONLY');
    expect(lines).toContain('Gap:');
    expect(lines).toContain('never fails the build');
    expect(lines).toContain('Close it with: ai-sdlc init --add branch-protection');
  });

  it('reports the neither state plainly with no false claim of enforcement', () => {
    const adapters: DoctorAdapters = {
      exists: () => false,
      runCommand: noGh(),
    };
    const result = checkAttestationGovernance(tmpDir, adapters);
    const lines = renderDoctorReport(result).join('\n');
    expect(lines).toContain('NEITHER');
    expect(lines).toContain('Close it with: ai-sdlc init --add attestation');
  });

  it('reports fully-configured without a Gap section', () => {
    const adapters: DoctorAdapters = {
      exists: () => true,
      runCommand: ghWithProtection({
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ['ai-sdlc/pr-ready'] },
      }),
    };
    const result = checkAttestationGovernance(tmpDir, adapters);
    const lines = renderDoctorReport(result).join('\n');
    expect(lines).toContain('FULLY CONFIGURED');
    expect(lines).not.toContain('Gap:');
  });
});

describe('doctorCommand — CLI action (end-to-end via the command builder, AISDLC-578 registry)', () => {
  let cwdBefore: string;

  beforeEach(() => {
    cwdBefore = process.cwd();
    process.chdir(tmpDir);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    process.exitCode = undefined;
  });

  /** Build a `program` wired with the `doctor` subcommand for `parseAsync`. */
  function buildProgram(buildAdapters: () => DoctorCheckAdapters): Command {
    const program = new Command();
    program.option('-f, --format <type>', '', 'table');
    program.exitOverride();

    const doctorCommand = createDoctorCommand(buildAdapters);
    doctorCommand.exitOverride();
    program.addCommand(doctorCommand);
    return program;
  }

  /** A minimal, fully-hermetic adapter set — plugin never resolves, gh never available. */
  function baseAdapters(overrides: Partial<DoctorCheckAdapters> = {}): DoctorCheckAdapters {
    return {
      exists: (p) => existsSync(p),
      readFile: (p) => {
        try {
          return existsSync(p) ? readFileSync(p, 'utf-8') : null;
        } catch {
          return null;
        }
      },
      writeFile: () => {},
      listDir: () => [],
      homeDir: () => join(tmpDir, '__home__'),
      env: {},
      runCommand: noGh(),
      ...overrides,
    };
  }

  it('--format json prints results + summary; exits 0 when nothing fails (plugin/gh unavailable = warn, not fail)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = buildProgram(() => baseAdapters());
    await program.parseAsync(['--format', 'json', 'doctor'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.summary.total).toBe(parsed.results.length);
    // No plugin install + no gh + no attestation artifacts on a bare tmpDir
    // → every check degrades to warn (skip/absent), never fail.
    expect(parsed.summary.fail).toBe(0);
    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
  });

  it('--strict promotes warn-only results to a non-zero exit', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = buildProgram(() => baseAdapters());
    await program.parseAsync(['--format', 'json', 'doctor', '--strict'], { from: 'user' });

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.summary.warn).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it('exits non-zero when a manifest-agreement check fails', async () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ version: '0.9.0' }),
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = buildProgram(() => baseAdapters());
    await program.parseAsync(['--format', 'json', 'doctor'], { from: 'user' });

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.summary.fail).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it('default (table) format renders the aggregate report via renderFullDoctorReport', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = buildProgram(() => baseAdapters());
    await program.parseAsync(['doctor'], { from: 'user' });

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('AI-SDLC Doctor');
    expect(allOutput).toMatch(/\d+ pass, \d+ warn, \d+ fail/);

    logSpy.mockRestore();
  });

  it('--format minimal routes through formatMinimal (not the full table render)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = buildProgram(() => baseAdapters());
    await program.parseAsync(['--format', 'minimal', 'doctor'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = logSpy.mock.calls[0][0] as string;
    expect(out).toMatch(/^Doctor: \d+ pass, \d+ warn, \d+ fail \(\d+ checks\)$/);
    expect(out).not.toContain('AI-SDLC Doctor');

    logSpy.mockRestore();
  });

  it('--fix runs registered fixers and prints their outcome before the report', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = buildProgram(() => baseAdapters());
    await program.parseAsync(['doctor', '--fix'], { from: 'user' });

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('[fix]');

    logSpy.mockRestore();
  });
});
