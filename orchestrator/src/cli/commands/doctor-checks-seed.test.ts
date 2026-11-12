/**
 * Hermetic tests for the AISDLC-582 doctor checks 4, 5, 6, 8, 9, 10 and the
 * `Backlog Drift` branch-protection signal (check 7 extension).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkAgentRoleConfig,
  checkDorConfig,
  checkHuskyPrePushGate,
  fixHuskyPrePushGate,
  checkFeatureFlags,
  checkFeatureWorkflows,
  checkAttestationGovernanceCheck,
  DOCTOR_CHECKS,
  type DoctorCheckAdapters,
  type DoctorRunContext,
} from './doctor-checks.js';
import { fetchBranchProtectionStatus } from './branch-protection-shared.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-doctor-seed-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeAdapters(overrides: Partial<DoctorCheckAdapters> = {}): DoctorCheckAdapters {
  return {
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf-8');
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    homeDir: () => join(tmpDir, '__home__'),
    env: {},
    runCommand: () => ({ stdout: '', exitCode: 1 }),
    ...overrides,
  };
}

function ctxOf(overrides: Partial<DoctorCheckAdapters> = {}): DoctorRunContext {
  return { projectDir: tmpDir, adapters: makeAdapters(overrides) };
}

function put(rel: string, content: string): void {
  const p = join(tmpDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

const VALID_AGENT_ROLE = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: dev
spec:
  role: developer
  goal: ship tasks
  tools: [Read]
`;

const VALID_DOR = `apiVersion: ai-sdlc.io/v1alpha1
kind: DorConfig
metadata:
  name: dor
spec:
  evaluationMode: warn-only
`;

describe('registry', () => {
  it('registers checks 4, 5, 8, 9, 10', () => {
    const ids = DOCTOR_CHECKS.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'agent-role-config',
        'dor-config',
        'husky-pre-push-gate',
        'feature-flags',
        'feature-workflows',
      ]),
    );
  });
});

describe('check 4: agent-role config', () => {
  it('warns when missing', () => {
    const r = checkAgentRoleConfig(ctxOf());
    expect(r.severity).toBe('warn');
    expect(r.remediation).toMatch(/ai-sdlc init/);
  });
  it('passes a valid file', () => {
    put('.ai-sdlc/agent-role.yaml', VALID_AGENT_ROLE);
    expect(checkAgentRoleConfig(ctxOf()).severity).toBe('pass');
  });
  it('fails a schema violation with a remediation', () => {
    put('.ai-sdlc/agent-role.yaml', VALID_AGENT_ROLE.replace('  goal: ship tasks\n', ''));
    const r = checkAgentRoleConfig(ctxOf());
    expect(r.severity).toBe('fail');
    expect(r.title).toMatch(/schema validation/);
    expect(r.remediation).toMatch(/agent-role.schema.json/);
  });
  it('fails unparseable YAML', () => {
    put('.ai-sdlc/agent-role.yaml', 'a: [unclosed\n');
    const r = checkAgentRoleConfig(ctxOf());
    expect(r.severity).toBe('fail');
    expect(r.title).toMatch(/not parseable/);
  });
});

describe('check 5: dor config', () => {
  it('passes (skipped) when DoR is not enabled', () => {
    expect(checkDorConfig(ctxOf()).severity).toBe('pass');
  });
  it('warns when the workflow exists but the config is missing', () => {
    put('.github/workflows/dor-ingress.yml', 'name: x\n');
    expect(checkDorConfig(ctxOf()).severity).toBe('warn');
  });
  it('passes a valid config', () => {
    put('.ai-sdlc/dor-config.yaml', VALID_DOR);
    expect(checkDorConfig(ctxOf()).severity).toBe('pass');
  });
  it('fails an invalid evaluationMode', () => {
    put('.ai-sdlc/dor-config.yaml', VALID_DOR.replace('warn-only', 'bogus'));
    const r = checkDorConfig(ctxOf());
    expect(r.severity).toBe('fail');
    expect(r.remediation).toMatch(/dor-config.v1.schema.json/);
  });
});

describe('check 8: husky pre-push gate', () => {
  it('passes when attestation is not enabled', () => {
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
  });
  it('fails when attestation is enabled and no hook exists', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('fail');
  });
  it('fails when the hook lacks the sign snippet', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.husky/pre-push', 'npm test\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('fail');
  });
  it('passes when the hook references the sign snippet', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.husky/pre-push', '# ai-sdlc:attestation-sign-block\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
  });
  it('passes for a non-husky .git/hooks/pre-push', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.git/hooks/pre-push', '# ai-sdlc:attestation-sign-block\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
  });
  it('reports a stale attestation-sign reference and --fix rewrites it (AISDLC-1261)', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put(
      '.husky/pre-push',
      'echo keep\n# ai-sdlc:attestation-sign-block\nbash "$H/scripts/check-attestation-sign.sh"\n# end ai-sdlc:attestation-sign-block\n',
    );
    const r = checkHuskyPrePushGate(ctxOf());
    expect(r.severity).toBe('fail');
    expect(r.title).toBe('pre-push: stale attestation-sign reference');
    expect(fixHuskyPrePushGate(ctxOf()).applied).toBe(true);
    const text = readFileSync(join(tmpDir, '.husky/pre-push'), 'utf-8');
    expect(text).toContain('echo keep');
    expect(text).not.toContain('check-attestation-sign');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
  });
  it('--fix refuses when the stale reference sits outside the ai-sdlc block', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.husky/pre-push', 'bash scripts/check-attestation-sign.sh\n');
    expect(fixHuskyPrePushGate(ctxOf()).applied).toBe(false);
  });
  it('fix appends the snippet to an existing hook, idempotently', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.husky/pre-push', 'npm test');
    const first = fixHuskyPrePushGate(ctxOf());
    expect(first.applied).toBe(true);
    const text = readFileSync(join(tmpDir, '.husky/pre-push'), 'utf-8');
    expect(text.startsWith('npm test\n')).toBe(true);
    expect(text).toContain('ai-sdlc:attestation-sign-block');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
    expect(fixHuskyPrePushGate(ctxOf()).applied).toBe(false);
    expect(readFileSync(join(tmpDir, '.husky/pre-push'), 'utf-8')).toBe(text);
  });
  it('fix creates the hook when .husky/ exists but the hook does not', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    mkdirSync(join(tmpDir, '.husky'));
    expect(fixHuskyPrePushGate(ctxOf()).applied).toBe(true);
    expect(existsSync(join(tmpDir, '.husky/pre-push'))).toBe(true);
  });
  it('fix does nothing without a .husky directory', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    const r = fixHuskyPrePushGate(ctxOf());
    expect(r.applied).toBe(false);
    expect(existsSync(join(tmpDir, '.husky'))).toBe(false);
  });
});

describe('check 9: feature flags', () => {
  it('passes with defaults', () => {
    expect(checkFeatureFlags(ctxOf()).severity).toBe('pass');
  });
  it('passes with truthy / legacy values', () => {
    const env = { AI_SDLC_DEPS_COMPOSITION: 'on', AI_SDLC_AUTONOMOUS_ORCHESTRATOR: 'experimental' };
    expect(checkFeatureFlags(ctxOf({ env })).severity).toBe('pass');
  });
  it('warns on an opt-out value, naming the flag', () => {
    const r = checkFeatureFlags(ctxOf({ env: { AI_SDLC_DEPS_COMPOSITION: 'OFF' } }));
    expect(r.severity).toBe('warn');
    expect(r.title).toContain('AI_SDLC_DEPS_COMPOSITION');
    expect(r.remediation).toMatch(/Unset/);
  });
});

describe('check 10: feature workflows', () => {
  it('passes with nothing enabled', () => {
    expect(checkFeatureWorkflows(ctxOf()).severity).toBe('pass');
  });
  it('warns for each enabled feature missing its workflow', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    put('.ai-sdlc/dor-config.yaml', VALID_DOR);
    const r = checkFeatureWorkflows(ctxOf());
    expect(r.severity).toBe('warn');
    expect(r.title).toContain('verify-attestation.yml');
    expect(r.title).toContain('dor-ingress.yml');
    expect(r.remediation).toMatch(/init --add workflows/);
  });
  it('passes when the workflow files exist', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    expect(checkFeatureWorkflows(ctxOf()).severity).toBe('pass');
  });
});

describe('Backlog Drift required context (check 7 extension)', () => {
  const protection = (contexts: string[]) => ({
    runCommand: (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'repo') return { stdout: 'acme/w', exitCode: 0 };
      return {
        stdout: JSON.stringify({
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_status_checks: { contexts },
        }),
        exitCode: 0,
      };
    },
  });

  it('fetchBranchProtectionStatus reports requiresBacklogDrift', () => {
    expect(
      fetchBranchProtectionStatus(protection(['ai-sdlc/pr-ready', 'Backlog Drift']))
        .requiresBacklogDrift,
    ).toBe(true);
  });

  function governanceCtx(contexts: string[]): DoctorRunContext {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    return ctxOf(protection(contexts));
  }

  it('warns when a backlog repo lacks the Backlog Drift context', () => {
    mkdirSync(join(tmpDir, 'backlog'));
    const r = checkAttestationGovernanceCheck(governanceCtx(['ai-sdlc/pr-ready']));
    expect(r.severity).toBe('warn');
    expect(r.title).toMatch(/Backlog Drift/);
  });
  it('passes when both contexts are required', () => {
    mkdirSync(join(tmpDir, 'backlog'));
    expect(
      checkAttestationGovernanceCheck(governanceCtx(['ai-sdlc/pr-ready', 'Backlog Drift']))
        .severity,
    ).toBe('pass');
  });
  it('does not nag a repo without a backlog directory', () => {
    expect(checkAttestationGovernanceCheck(governanceCtx(['ai-sdlc/pr-ready'])).severity).toBe(
      'pass',
    );
  });
});
